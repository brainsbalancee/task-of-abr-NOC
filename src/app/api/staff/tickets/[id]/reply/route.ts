/**
 * POST /api/staff/tickets/[id]/reply
 *
 * Creates a staff message in the ticket thread AND flips the ticket's
 * status to 'pending' (since the staff just replied and is now waiting
 * on the customer). Both writes happen in a single `db.$transaction`
 * so we never have a reply message without a status change (or vice
 * versa).
 *
 * Body: { body: string, aiDrafted: boolean }
 *
 * Hardening:
 *  - Gated by `getStaffFromRequest` — 401 if not authed.
 *  - Body validated via `validateMessageBody` (length, control chars).
 *  - `aiDrafted` defaults to false if absent or not a boolean — never
 *    trust the client flag blindly.
 *  - Audit log records ticketId, aiDrafted, and body LENGTH (not the
 *    body itself — we don't log customer/staff PII in audit).
 */

import { NextRequest } from 'next/server'

import { db } from '@/lib/db'
import {
  json,
  getStaffFromRequest,
  recordAudit,
} from '@/lib/api'
import { validateMessageBody } from '@/lib/sanitize'
import { getClientIp } from '@/lib/rate-limit'

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

  // ---- Validate body text --------------------------------------------
  const v = validateMessageBody(obj.body)
  if (!v.ok) {
    return json({ ok: false, error: v.error }, 422)
  }
  // aiDrafted defaults to false — never trust an absent/wrong shape.
  const aiDrafted =
    typeof obj.aiDrafted === 'boolean' ? obj.aiDrafted : false

  // ---- Persist (transactional) ---------------------------------------
  try {
    // Confirm ticket exists first — clean 404 instead of P2003.
    const ticket = await db.ticket.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!ticket) {
      return json({ ok: false, error: 'Ticket not found.' }, 404)
    }

    const message = await db.$transaction(async (tx) => {
      const created = await tx.ticketMessage.create({
        data: {
          ticketId: id,
          authorRole: 'staff',
          staffId: auth.id,
          body: v.body,
          aiDrafted,
        },
      })
      // Staff just replied → ticket is now waiting on the customer.
      await tx.ticket.update({
        where: { id },
        data: { status: 'pending' },
      })
      return created
    })

    await recordAudit({
      staffId: auth.id,
      action: 'ticket.reply',
      targetId: id,
      meta: { ticketId: id, aiDrafted, length: v.body.length },
      ip: getClientIp(req),
    })

    return json({
      ok: true,
      data: {
        id: message.id,
        authorRole: message.authorRole,
        body: message.body,
        createdAt: message.createdAt.toISOString(),
        aiDrafted: message.aiDrafted,
        staffId: message.staffId,
        staffName: auth.name,
        staffRole: auth.role as 'agent' | 'admin',
      },
    }, 201)
  } catch (e) {
    console.error('[api/staff/tickets/[id]/reply] failed:', e)
    return json(
      { ok: false, error: 'Could not send your reply.' },
      500,
    )
  }
}
