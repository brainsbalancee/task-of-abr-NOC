/**
 * POST /api/staff/tickets/[id]/draft
 *
 * AI-suggested reply draft. Calls `draftStaffReply` from `@/lib/ai`
 * with the ticket subject + body + conversation transcript. Returns
 * the draft string (or null if the AI was unavailable).
 *
 * The draft is NEVER sent to the customer automatically — the staff
 * member reviews it, edits, and explicitly hits "Send reply" which
 * calls the separate reply endpoint.
 *
 * Hardening:
 *  - Gated by `getStaffFromRequest` — 401 if not authed.
 *  - Rate limited per-staff (20 / min) — LLM inference is expensive.
 *  - Conversation is built oldest-first, mapped from authorRole:
 *      customer → 'customer'
 *      staff    → 'staff'
 *      ai       → 'ai'
 *    System messages are dropped — they're internal bookkeeping, not
 *    conversation the AI should parrot back.
 *  - If `draftStaffReply` returns null (SDK error / quota / network),
 *    we return `{ draft: null }` so the UI can show a friendly
 *    fallback. AI is an enhancement, not a dependency.
 *  - Audit log records the request, not the draft text (PII safe).
 */

import { NextRequest } from 'next/server'

import { db } from '@/lib/db'
import {
  json,
  rateLimitedResponse,
  getStaffFromRequest,
  recordAudit,
} from '@/lib/api'
import { draftStaffReply } from '@/lib/ai'
import {
  rateLimit,
  RATE_LIMITS,
  getClientIp,
  cleanupRateLimitMap,
} from '@/lib/rate-limit'

export async function POST(
  req: NextRequest,
  ctx: { params: Promise<{ id: string }> },
) {
  const auth = await getStaffFromRequest(req)
  if (!auth) {
    return json({ ok: false, error: 'Not authenticated' }, 401)
  }
  const { id } = await ctx.params
  if (!id) {
    return json({ ok: false, error: 'Missing ticket id.' }, 400)
  }

  // ---- Rate limit -----------------------------------------------------
  const rl = rateLimit(`staff:${auth.id}:draft`, RATE_LIMITS.aiDraft)
  cleanupRateLimitMap()
  if (!rl.ok) return rateLimitedResponse(rl.resetAt)

  // ---- Fetch ticket + messages --------------------------------------
  const ticket = await db.ticket.findUnique({
    where: { id },
    select: {
      subject: true,
      body: true,
      messages: {
        orderBy: { createdAt: 'asc' },
        select: {
          authorRole: true,
          body: true,
        },
      },
    },
  })
  if (!ticket) {
    return json({ ok: false, error: 'Ticket not found.' }, 404)
  }

  // ---- Build conversation transcript --------------------------------
  // Map authorRole values; drop 'system' (internal bookkeeping).
  const conversation = ticket.messages
    .filter((m) => m.authorRole !== 'system')
    .map((m) => ({
      role: m.authorRole as 'customer' | 'staff' | 'ai',
      body: m.body,
    }))

  // ---- Call AI -------------------------------------------------------
  const draft = await draftStaffReply({
    ticketSubject: ticket.subject,
    ticketBody: ticket.body,
    conversation,
  })

  // Best-effort audit — don't block on failure, don't log the draft text.
  await recordAudit({
    staffId: auth.id,
    action: 'ticket.draft',
    targetId: id,
    meta: { ok: draft !== null, length: draft?.length ?? 0 },
    ip: getClientIp(req),
  })

  return json({ ok: true, data: { draft } })
}
