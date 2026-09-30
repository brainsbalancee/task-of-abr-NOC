/**
 * POST /api/tickets/[ref]/reply
 *
 * Customer follow-up reply on their own ticket. The customer is unauthed —
 * the `lookupToken` they were given at submission time is their credential,
 * exactly like the lookup endpoint. We mirror that route's auth posture:
 *
 *  - Rate limited per IP via `RATE_LIMITS.ticketLookup` (20 / min), key
 *    `ip:reply:${ip}`. `cleanupRateLimitMap()` runs after each call.
 *  - Same 404 response whether the ticket doesn't exist OR the token is
 *    wrong. No way to distinguish "no such ref" from "wrong token" → can't
 *    probe for valid refs.
 *  - Token comparison is constant-time via `constantTimeEqual` (wraps
 *    `crypto.timingSafeEqual`). If lengths differ it returns false — we
 *    still return the same 404.
 *  - Body validated via `validateMessageBody` (length, shape, control
 *    chars) — same validator the staff reply route uses.
 *  - If the ticket status is `closed` OR `resolved`, return 409 with a
 *    friendly "please open a new ticket" message. We do not auto-reopen
 *    via this endpoint — staff should reopen if appropriate.
 *  - In a `db.$transaction`: write the `TicketMessage` (authorRole
 *    'customer', staffId null, aiDrafted false) AND flip the ticket
 *    status to `open` (customer just replied → staff need to look again).
 *    `updatedAt` is bumped explicitly. Either both write or neither.
 *  - Returns `{ok:true, data:{messageId}}` with 201. On any unexpected
 *    error we return a generic 500 — never leak DB internals.
 *
 * No-Response-cache: the lookup route documented the Next.js trap where a
 * module-level Response constant sends an empty body on the second call.
 * We use a factory function for the 404 here too.
 */

import { NextRequest } from 'next/server'

import { db } from '@/lib/db'
import { json, rateLimitedResponse } from '@/lib/api'
import { constantTimeEqual } from '@/lib/auth'
import { validateMessageBody } from '@/lib/sanitize'
import {
  rateLimit,
  RATE_LIMITS,
  getClientIp,
  cleanupRateLimitMap,
} from '@/lib/rate-limit'

// Factory — fresh Response per call (see file header for why).
const notFound = () =>
  json(
    { ok: false, error: "We couldn't find a ticket with those details." },
    404,
  )

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ ref: string }> },
) {
  // ---- Rate limit ------------------------------------------------------
  const ip = getClientIp(req)
  const rl = rateLimit(`ip:reply:${ip}`, RATE_LIMITS.ticketLookup)
  cleanupRateLimitMap()
  if (!rl.ok) return rateLimitedResponse(rl.resetAt)

  // ---- Resolve path param ---------------------------------------------
  const { ref: rawRef } = await ctx.params
  const ref = rawRef.trim().toUpperCase()

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
  const obj = body as Record<string, unknown>
  const token = typeof obj.token === 'string' ? obj.token.trim() : ''

  if (!ref || !token) return notFound()

  // ---- Find ticket ----------------------------------------------------
  const ticket = await db.ticket.findUnique({
    where: { ref },
    select: { id: true, lookupToken: true, status: true },
  })

  // Same response whether the ticket is missing OR the token is wrong —
  // never reveal which. Constant-time compare so timing can't distinguish
  // "wrong length" from "right length, wrong content".
  if (!ticket) return notFound()
  if (!constantTimeEqual(ticket.lookupToken, token)) return notFound()

  // ---- Validate body text --------------------------------------------
  const v = validateMessageBody(obj.body)
  if (!v.ok) {
    return json({ ok: false, error: v.error }, 422)
  }

  // ---- Closed / resolved: refuse to reopen via this endpoint ----------
  if (ticket.status === 'closed' || ticket.status === 'resolved') {
    return json(
      {
        ok: false,
        error:
          'This ticket is closed. Please open a new ticket if you need more help.',
      },
      409,
    )
  }

  // ---- Persist (transactional) ---------------------------------------
  try {
    const created = await db.$transaction(async (tx) => {
      const message = await tx.ticketMessage.create({
        data: {
          ticketId: ticket.id,
          authorRole: 'customer',
          staffId: null,
          body: v.body,
          aiDrafted: false,
        },
      })
      // Flip status to 'open' (customer just replied → staff need to look
      // again) and bump `updatedAt`.
      await tx.ticket.update({
        where: { id: ticket.id },
        data: {
          status: 'open',
          updatedAt: new Date(),
        },
      })
      return message
    })

    return json({ ok: true, data: { messageId: created.id } }, 201)
  } catch (e) {
    console.error('[api/tickets/[ref]/reply] failed:', e)
    return json(
      { ok: false, error: 'Something went wrong. Please try again.' },
      500,
    )
  }
}
