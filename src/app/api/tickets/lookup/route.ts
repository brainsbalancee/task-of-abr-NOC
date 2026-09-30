/**
 * GET /api/tickets/lookup?ref=...&token=...
 *
 * Public ticket status lookup. The customer needs their ticket `ref` AND the
 * `lookupToken` they were given at submission time. The token is the only
 * thing standing between an attacker and the customer's ticket content, so:
 *
 *  - Rate limited per IP (20 / min) to slow enumeration.
 *  - Same 404 response whether the ticket doesn't exist OR the token is
 *    wrong. No way to distinguish "no such ref" from "wrong token" → can't
 *    probe for valid refs.
 *  - Token comparison is constant-time via `constantTimeEqual` (which uses
 *    crypto.timingSafeEqual under the hood). If lengths differ it returns
 *    false — we still return the same 404.
 *  - We only return what the customer already knows: the ticket body,
 *    subject, status, and the message thread. We omit `lookupToken`,
 *    `customerEmail`, `assigneeId`, and any staff-only metadata.
 *  - We do NOT return other tickets by the same email — that would require
 *    email verification, which the public surface doesn't have. See
 *    worklog for the decision rationale.
 */

import { NextRequest } from 'next/server'

import { db } from '@/lib/db'
import { json, rateLimitedResponse } from '@/lib/api'
import { constantTimeEqual } from '@/lib/auth'
import {
  rateLimit,
  RATE_LIMITS,
  getClientIp,
  cleanupRateLimitMap,
} from '@/lib/rate-limit'

// Factory — each call returns a fresh Response. We must NOT cache a single
// Response at module level, because Next.js reads the body stream once;
// reusing the same Response across requests would send an empty body after
// the first call.
const notFound = () =>
  json(
    { ok: false, error: "We couldn't find a ticket with those details." },
    404,
  )

export async function GET(req: NextRequest) {
  // ---- Rate limit ------------------------------------------------------
  const ip = getClientIp(req)
  const rl = rateLimit(`ip:lookup:${ip}`, RATE_LIMITS.ticketLookup)
  cleanupRateLimitMap()
  if (!rl.ok) return rateLimitedResponse(rl.resetAt)

  // ---- Parse query string --------------------------------------------
  const url = new URL(req.url)
  const ref = (url.searchParams.get('ref') ?? '').trim().toUpperCase()
  const token = (url.searchParams.get('token') ?? '').trim()

  if (!ref || !token) return notFound()

  // ---- Find ticket ----------------------------------------------------
  const ticket = await db.ticket.findUnique({
    where: { ref },
    include: {
      messages: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          authorRole: true,
          body: true,
          createdAt: true,
          aiDrafted: true,
        },
      },
    },
  })

  // Same response whether the ticket is missing or the token is wrong —
  // never reveal which.
  if (!ticket) return notFound()
  if (!constantTimeEqual(ticket.lookupToken, token)) return notFound()

  // ---- Return sanitized view -----------------------------------------
  return json({
    ok: true,
    data: {
      ref: ticket.ref,
      subject: ticket.subject,
      body: ticket.body,
      status: ticket.status,
      priority: ticket.priority,
      category: ticket.category,
      customerName: ticket.customerName,
      createdAt: ticket.createdAt.toISOString(),
      messages: ticket.messages.map((m) => ({
        id: m.id,
        authorRole: m.authorRole,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        aiDrafted: m.aiDrafted,
      })),
    },
  })
}
