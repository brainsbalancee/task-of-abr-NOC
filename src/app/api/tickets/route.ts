/**
 * POST /api/tickets
 *
 * Public, unauthenticated ticket submission. The most security-sensitive
 * write endpoint in the system — anyone on the internet can hit it.
 *
 * Hardening:
 *  - Rate limited per IP (5 / min). Cleanup runs after each call.
 *  - Body validated by `validateTicketInput` (length, shape, control chars).
 *  - `category` and `priority` are checked against fixed enum sets — never
 *    trust the client's selection.
 *  - Customer is upserted by email (no password, no account).
 *  - Ticket + system "created" message written in a single transaction so
 *    we never have a ticket with no opening message.
 *  - `ref` and `lookupToken` are generated server-side, never client-chosen.
 *  - All errors return a generic message — we never leak DB internals.
 */

import { NextRequest } from 'next/server'

import { db } from '@/lib/db'
import {
  json,
  rateLimitedResponse,
  generateTicketRef,
  generateLookupToken,
} from '@/lib/api'
import { validateTicketInput } from '@/lib/sanitize'
import {
  rateLimit,
  RATE_LIMITS,
  getClientIp,
  cleanupRateLimitMap,
} from '@/lib/rate-limit'

// Server-side enum sets. The client sends one of these; if it sends anything
// else, we fall back to the default rather than rejecting — better UX and no
// information leak. (We could 422 instead; either choice is defensible.)
const CATEGORIES = ['general', 'billing', 'bug', 'account', 'feature'] as const
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
type Category = (typeof CATEGORIES)[number]
type Priority = (typeof PRIORITIES)[number]

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  fallback: T,
): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback
}

export async function POST(req: NextRequest) {
  // ---- Rate limit ------------------------------------------------------
  const ip = getClientIp(req)
  const rl = rateLimit(`ip:submit:${ip}`, RATE_LIMITS.ticketSubmit)
  cleanupRateLimitMap()
  if (!rl.ok) return rateLimitedResponse(rl.resetAt)

  // ---- Parse body -----------------------------------------------------
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'Invalid request body.' }, 400)
  }
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: 'Invalid request body.' }, 400)
  }

  // ---- Validate -------------------------------------------------------
  const v = validateTicketInput(body as Record<string, unknown>)
  if (!v.ok) {
    const fields: Record<string, string> = {}
    for (const e of v.errors) fields[e.field] = e.message
    return json(
      { ok: false, error: 'Please fix the highlighted fields.', fields },
      422,
    )
  }

  const category = pickEnum(
    (body as Record<string, unknown>).category,
    CATEGORIES,
    'general' as Category,
  )
  const priority = pickEnum(
    (body as Record<string, unknown>).priority,
    PRIORITIES,
    'normal' as Priority,
  )

  // ---- Persist --------------------------------------------------------
  try {
    const ref = await generateTicketRef()
    const lookupToken = generateLookupToken()

    await db.$transaction(async (tx) => {
      // Upsert customer by email — first submission creates the row,
      // subsequent submissions reuse it. We update the name if provided.
      await tx.customer.upsert({
        where: { email: v.data.customerEmail },
        update: { name: v.data.customerName ?? undefined },
        create: {
          email: v.data.customerEmail,
          name: v.data.customerName ?? undefined,
        },
      })

      const ticket = await tx.ticket.create({
        data: {
          ref,
          lookupToken,
          subject: v.data.subject,
          body: v.data.body,
          category,
          priority,
          customerEmail: v.data.customerEmail,
          customerName: v.data.customerName,
        },
      })

      await tx.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          authorRole: 'system',
          body: 'Ticket created by customer.',
        },
      })
    })

    return json({ ok: true, data: { ref, lookupToken } }, 201)
  } catch (e) {
    // Never leak the underlying DB error to the customer. Log server-side
    // for ops, return a polite message client-side.
    console.error('[api/tickets] submit failed:', e)
    return json(
      { ok: false, error: "We couldn't submit your ticket. Please try again." },
      500,
    )
  }
}
