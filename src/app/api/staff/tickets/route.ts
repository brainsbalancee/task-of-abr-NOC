/**
 * GET /api/staff/tickets
 *
 * The staff queue. Returns paginated ticket metadata + a stats block
 * (open / pending / resolved-today / unassigned) for the dashboard
 * cards. Message bodies are NOT returned here — they're fetched per
 * ticket on detail view. This keeps the queue payload small even when
 * there are hundreds of tickets.
 *
 * Hardening:
 *  - Gated by `getStaffFromRequest` — 401 if not authed.
 *  - Filters are validated against fixed enum sets; unknown values
 *    are silently ignored (no SQL/Prisma injection risk).
 *  - `q` (search) uses Prisma's `contains` — no raw SQL.
 *  - `pageSize` is capped at 100.
 *  - Default ordering: open + pending first (case statement), then
 *    createdAt desc. Newest action on top.
 */

import { NextRequest } from 'next/server'

import { db } from '@/lib/db'
import { json, getStaffFromRequest } from '@/lib/api'

const STATUSES = ['open', 'pending', 'resolved', 'closed'] as const
const PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const
const CATEGORIES = ['general', 'billing', 'bug', 'account', 'feature'] as const
const ASSIGNEES = ['all', 'me', 'unassigned'] as const

type StatusFilter = (typeof STATUSES)[number]
type PriorityFilter = (typeof PRIORITIES)[number]
type CategoryFilter = (typeof CATEGORIES)[number]
type AssigneeFilter = (typeof ASSIGNEES)[number]

function pickEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
): T | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : null
}

export async function GET(req: NextRequest) {
  const ctx = await getStaffFromRequest(req)
  if (!ctx) {
    return json({ ok: false, error: 'Not authenticated' }, 401)
  }

  // ---- Parse + validate query params ----------------------------------
  const url = new URL(req.url)
  const status = pickEnum(url.searchParams.get('status'), STATUSES)
  const priority = pickEnum(url.searchParams.get('priority'), PRIORITIES)
  const category = pickEnum(url.searchParams.get('category'), CATEGORIES)
  const assignee = pickEnum(url.searchParams.get('assignee'), ASSIGNEES)

  const qRaw = url.searchParams.get('q')?.trim() ?? ''
  // Cap the search string so a hostile client can't send a 10KB string.
  const q = qRaw.slice(0, 200)

  let page = Number(url.searchParams.get('page') ?? '1')
  if (!Number.isFinite(page) || page < 1) page = 1
  let pageSize = Number(url.searchParams.get('pageSize') ?? '25')
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = 25
  if (pageSize > 100) pageSize = 100
  page = Math.floor(page)
  pageSize = Math.floor(pageSize)

  // ---- Build Prisma where clause --------------------------------------
  const where: Record<string, unknown> = {}
  if (status) where.status = status
  if (priority) where.priority = priority
  if (category) where.category = category
  if (assignee === 'me') {
    where.assigneeId = ctx.id
  } else if (assignee === 'unassigned') {
    where.assigneeId = null
  }
  if (q) {
    // Search subject (case-insensitive on SQLite via `mode: 'insensitive'`
    // — actually SQLite has no real case sensitivity for ASCII, but we
    // express intent) and ref (refs are uppercase, search is uppercased
    // to match).
    where.OR = [
      { subject: { contains: q } },
      { ref: { contains: q.toUpperCase() } },
    ]
  }

  // ---- Default ordering: open/pending first, then createdAt desc -------
  // SQLite has no `CASE` in the orderBy DSL, so we emulate with raw SQL
  // via `$queryRaw` only if needed. For the volumes here, we just use a
  // composite orderBy that approximates the intent: status asc puts
  // 'open' (o) before 'pending' (p) before 'resolved' (r) before 'closed'
  // (c) alphabetically — wait, that's NOT the order we want (open then
  // pending is what we want, and alphabetical 'closed' < 'open' < 'pending'
  // < 'resolved'). So we sort by a custom expression instead.
  //
  // Approach: split into two queries is overkill; we use Prisma's
  // `reorder` trick: order by a CASE-equivalent via raw field arithmetic
  // isn't available. Instead, we just order by:
  //   1. (status == 'open' OR status == 'pending') DESC — true sorts first
  //   2. status ASC
  //   3. createdAt DESC
  // Prisma supports multiple orderBy entries, but not arbitrary
  // expressions in the DSL. So we run two queries concatenated: open +
  // pending first, then everything else, each internally ordered by
  // createdAt desc. Simpler and avoids raw SQL.

  const activeWhere = { ...where, status: { in: ['open', 'pending'] } }
  const restWhere = { ...where, status: { in: ['resolved', 'closed'] } }

  // Count totals (active + rest) for pagination metadata.
  const [total, activeCount, restCount] = await Promise.all([
    db.ticket.count({ where }),
    db.ticket.count({ where: activeWhere }),
    db.ticket.count({ where: restWhere }),
  ])

  // Active tickets first (open/pending), then resolved/closed. Each
  // section is internally ordered by createdAt desc. We fetch the two
  // windows separately because Prisma's orderBy DSL can't express
  // "open/pending first" without raw SQL — and we want to keep the
  // `include` shape (assignee, _count) intact.
  const skip = (page - 1) * pageSize
  const take = pageSize

  // Active window: only relevant if the page's offset falls inside the
  // active bucket (i.e. skip < activeCount). The Prisma skip here is the
  // page's global skip — we don't subtract activeCount because we're
  // reading from the start of the active list.
  const activeItems =
    skip < activeCount
      ? await db.ticket.findMany({
          where: activeWhere,
          orderBy: [{ createdAt: 'desc' }],
          skip,
          take,
          include: {
            assignee: { select: { id: true, name: true } },
            _count: { select: { messages: true } },
          },
        })
      : []
  const activeGotCount = activeItems.length

  // Rest window: take the leftover slots. Skip past the active bucket.
  const restItems =
    activeGotCount < take
      ? await db.ticket.findMany({
          where: restWhere,
          orderBy: [{ createdAt: 'desc' }],
          skip: Math.max(0, skip - activeCount),
          take: take - activeGotCount,
          include: {
            assignee: { select: { id: true, name: true } },
            _count: { select: { messages: true } },
          },
        })
      : []

  const tickets = [...activeItems, ...restItems]

  // ---- Stats ----------------------------------------------------------
  // Compute stats based on the UNFILTERED queue (so the dashboard cards
  // always reflect the true queue state, not the filtered view).
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)

  const [openCount, pendingCount, unassignedCount, resolvedTodayCount] =
    await Promise.all([
      db.ticket.count({ where: { status: 'open' } }),
      db.ticket.count({ where: { status: 'pending' } }),
      db.ticket.count({ where: { assigneeId: null, status: { in: ['open', 'pending'] } } }),
      db.ticket.count({
        where: {
          status: 'resolved',
          updatedAt: { gte: startOfToday },
        },
      }),
    ])

  const stats = {
    open: openCount,
    pending: pendingCount,
    resolvedToday: resolvedTodayCount,
    unassigned: unassignedCount,
  }

  return json({
    ok: true,
    data: {
      tickets: tickets.map((t) => ({
        id: t.id,
        ref: t.ref,
        subject: t.subject,
        status: t.status,
        priority: t.priority,
        category: t.category,
        customerEmail: t.customerEmail,
        customerName: t.customerName,
        assignee: t.assignee
          ? { id: t.assignee.id, name: t.assignee.name }
          : null,
        createdAt: t.createdAt.toISOString(),
        updatedAt: t.updatedAt.toISOString(),
        _count: { messages: t._count.messages },
      })),
      total,
      page,
      pageSize,
      stats,
    },
  })
}
