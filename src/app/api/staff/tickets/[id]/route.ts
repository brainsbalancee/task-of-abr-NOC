/**
 * GET    /api/staff/tickets/[id]
 * PATCH  /api/staff/tickets/[id]
 *
 * `id` is the Prisma internal cuid (NOT the public `ref`). Keeping
 * staff URLs on internal ids means we never expose the public-facing
 * `ref` in staff URLs — consistent API surface, no dual addressing.
 *
 * GET returns the ticket + all messages (oldest first) + customer +
 * assignee. Customer fields returned are scoped to THIS ticket only —
 * we never leak a different ticket's customer data alongside.
 *
 * PATCH accepts any subset of {status, priority, category, assigneeId}
 * with strict server-side enum validation. assigneeId (if non-null)
 * must reference an existing StaffUser; null means unassign.
 */

import { NextRequest } from 'next/server'

import { db } from '@/lib/db'
import {
  json,
  getStaffFromRequest,
  recordAudit,
} from '@/lib/api'
import { getClientIp } from '@/lib/rate-limit'

const STATUSES = ['open', 'pending', 'resolved', 'closed'] as const
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
const CATEGORIES = ['general', 'billing', 'bug', 'account', 'feature'] as const

function isEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): value is T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
}

// Shape a ticket for the client. Centralised so GET and PATCH return
// the same shape.
//
// Note: TicketMessage has `staffId` (plain String) but no Prisma relation
// to StaffUser (the schema doesn't model it — keeping the surface
// minimal). We resolve staff names server-side by collecting the
// distinct staffIds referenced in the thread and looking them up in
// one extra query, then merging them onto the message payload.
async function fetchTicketShape(id: string) {
  const ticket = await db.ticket.findUnique({
    where: { id },
    include: {
      assignee: { select: { id: true, name: true, role: true } },
      messages: {
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          authorRole: true,
          body: true,
          createdAt: true,
          aiDrafted: true,
          staffId: true,
        },
      },
    },
  })
  if (!ticket) return null

  // Resolve staff names for any message with a staffId. Single query,
  // even if the thread has many staff replies.
  const staffIds = Array.from(
    new Set(
      ticket.messages
        .map((m) => m.staffId)
        .filter((s): s is string => s !== null),
    ),
  )
  const staffRecords =
    staffIds.length > 0
      ? await db.staffUser.findMany({
          where: { id: { in: staffIds } },
          select: { id: true, name: true, role: true },
        })
      : []
  const staffById = new Map(staffRecords.map((s) => [s.id, s]))

  // ---- Customer history context ---------------------------------------
  // Other tickets by the same customer (excluding this one), newest first,
  // limited to 5. Lets the answering staff see at a glance if this is a
  // recurring issue or a high-touch customer — without leaving the screen.
  const customerHistory = await db.ticket.findMany({
    where: {
      customerEmail: ticket.customerEmail,
      id: { not: ticket.id },
    },
    orderBy: { createdAt: 'desc' },
    take: 5,
    select: {
      id: true,
      ref: true,
      subject: true,
      status: true,
      priority: true,
      createdAt: true,
      updatedAt: true,
    },
  })

  return {
    id: ticket.id,
    ref: ticket.ref,
    subject: ticket.subject,
    body: ticket.body,
    status: ticket.status,
    priority: ticket.priority,
    category: ticket.category,
    customerEmail: ticket.customerEmail,
    customerName: ticket.customerName,
    assignee: ticket.assignee
      ? {
          id: ticket.assignee.id,
          name: ticket.assignee.name,
          role: ticket.assignee.role,
        }
      : null,
    createdAt: ticket.createdAt.toISOString(),
    updatedAt: ticket.updatedAt.toISOString(),
    messages: ticket.messages.map((m) => {
      const staff = m.staffId ? staffById.get(m.staffId) : null
      return {
        id: m.id,
        authorRole: m.authorRole,
        body: m.body,
        createdAt: m.createdAt.toISOString(),
        aiDrafted: m.aiDrafted,
        staffId: m.staffId,
        staffName: staff?.name ?? null,
        staffRole: (staff?.role as 'agent' | 'admin' | null) ?? null,
      }
    }),
    customerHistory: customerHistory.map((h) => ({
      id: h.id,
      ref: h.ref,
      subject: h.subject,
      status: h.status,
      priority: h.priority,
      createdAt: h.createdAt.toISOString(),
      updatedAt: h.updatedAt.toISOString(),
    })),
  }
}

export async function GET(
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
  const ticket = await fetchTicketShape(id)
  if (!ticket) {
    return json({ ok: false, error: 'Ticket not found.' }, 404)
  }
  return json({ ok: true, data: ticket })
}

export async function PATCH(
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

  // ---- Validate present fields ---------------------------------------
  const update: Record<string, unknown> = {}
  const auditEntries: string[] = []

  if ('status' in obj) {
    if (!isEnum(obj.status, STATUSES)) {
      return json({ ok: false, error: 'Invalid status.' }, 422)
    }
    update.status = obj.status
    auditEntries.push(`status=${obj.status}`)
  }
  if ('priority' in obj) {
    if (!isEnum(obj.priority, PRIORITIES)) {
      return json({ ok: false, error: 'Invalid priority.' }, 422)
    }
    update.priority = obj.priority
    auditEntries.push(`priority=${obj.priority}`)
  }
  if ('category' in obj) {
    if (!isEnum(obj.category, CATEGORIES)) {
      return json({ ok: false, error: 'Invalid category.' }, 422)
    }
    update.category = obj.category
    auditEntries.push(`category=${obj.category}`)
  }
  if ('assigneeId' in obj) {
    const value = obj.assigneeId
    if (value === null) {
      update.assigneeId = null
      auditEntries.push('assignee=null')
    } else if (typeof value === 'string' && value.length > 0) {
      // Confirm the assignee exists. We never trust an arbitrary id.
      const staff = await db.staffUser.findUnique({
        where: { id: value },
        select: { id: true, name: true },
      })
      if (!staff) {
        return json({ ok: false, error: 'Unknown assignee.' }, 422)
      }
      update.assigneeId = value
      auditEntries.push(`assignee=${value}`)
    } else {
      return json(
        { ok: false, error: 'assigneeId must be a string or null.' },
        422,
      )
    }
  }

  if (Object.keys(update).length === 0) {
    // Nothing to change — return the current ticket shape.
    const current = await fetchTicketShape(id)
    if (!current) {
      return json({ ok: false, error: 'Ticket not found.' }, 404)
    }
    return json({ ok: true, data: current })
  }

  // ---- Persist --------------------------------------------------------
  try {
    // Confirm ticket exists before updating (so we can return a clean
    // 404 instead of letting Prisma throw a P2025).
    const existing = await db.ticket.findUnique({
      where: { id },
      select: { id: true },
    })
    if (!existing) {
      return json({ ok: false, error: 'Ticket not found.' }, 404)
    }
    await db.ticket.update({ where: { id }, data: update })

    await recordAudit({
      staffId: auth.id,
      action: 'ticket.update',
      targetId: id,
      meta: { changes: auditEntries },
      ip: getClientIp(req),
    })

    const updated = await fetchTicketShape(id)
    return json({ ok: true, data: updated })
  } catch (e) {
    console.error('[api/staff/tickets/[id]] PATCH failed:', e)
    return json(
      { ok: false, error: 'Could not update the ticket.' },
      500,
    )
  }
}
