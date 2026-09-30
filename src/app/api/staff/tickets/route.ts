/**
 * GET /api/staff/tickets
 *
 * The staff queue. Returns paginated ticket metadata + a stats block
 * (open / pending / resolved-today / unassigned / median-first-reply-today
 * / oldest-unassigned-age / stale-count) for the dashboard cards. Message
 * bodies are NOT returned here — they're fetched per ticket on detail view.
 * This keeps the queue payload small even when there are hundreds of
 * tickets.
 *
 * Hardening:
 *  - Gated by `getStaffFromRequest` — 401 if not authed.
 *  - Filters are validated against fixed enum sets; unknown values
 *    are silently ignored (no SQL/Prisma injection risk).
 *  - `q` (search) uses Prisma's `contains` — no raw SQL.
 *  - `pageSize` is capped at 100.
 *  - Default ordering: open + pending first (case statement), then
 *    createdAt desc. Newest action on top.
 *  - Staleness is computed via the shared `computeStaleness` helper in
 *    `src/lib/sla.ts` so the queue and (future) detail view share logic.
 */

import { NextRequest } from 'next/server'

import { db } from '@/lib/db'
import { json, getStaffFromRequest } from '@/lib/api'
import { computeStaleness } from '@/lib/sla'

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

  // ---- Per-ticket first staff reply time (for staleness + median) ----
  // One groupBy query across ALL tickets — we use this for both the
  // visible page (to compute staleness on each row) AND the unfiltered
  // stats block (median first reply today + stale count). groupBy is
  // cheap: it scans the TicketMessage index on (ticketId, createdAt).
  const firstReplyRows = await db.ticketMessage.groupBy({
    by: ['ticketId'],
    where: { authorRole: 'staff' },
    _min: { createdAt: true },
  })
  const firstReplyByTicket: Map<string, Date | null> = new Map()
  for (const r of firstReplyRows) {
    firstReplyByTicket.set(
      r.ticketId,
      r._min.createdAt ? new Date(r._min.createdAt) : null,
    )
  }

  // Helper for staleness — single source of truth, shared with the stats.
  const stalenessOf = (t: {
    status: string
    assigneeId: string | null
    id: string
    createdAt: Date
    updatedAt: Date
  }) =>
    computeStaleness({
      status: t.status,
      assigneeId: t.assigneeId,
      lastStaffReplyAt: firstReplyByTicket.get(t.id) ?? null,
      createdAt: t.createdAt,
      updatedAt: t.updatedAt,
    })

  // ---- Stats ----------------------------------------------------------
  // Compute stats based on the UNFILTERED queue (so the dashboard cards
  // always reflect the true queue state, not the filtered view).
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  // UTC midnight — used for the "median first reply today" stat per the
  // brief's spec ("today (UTC)").
  const startOfTodayUTC = new Date()
  startOfTodayUTC.setUTCHours(0, 0, 0, 0)

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

  // ---- Median first reply (today, UTC) -------------------------------
  // For every ticket that had its first staff reply today, compute
  // (firstReply - ticket.createdAt) in ms and take the median.
  const todayPairs: { id: string; firstReplyAt: Date }[] = []
  for (const [id, t] of firstReplyByTicket.entries()) {
    if (t && t.getTime() >= startOfTodayUTC.getTime()) {
      todayPairs.push({ id, firstReplyAt: t })
    }
  }

  let medianFirstResponseMsToday = 0
  if (todayPairs.length > 0) {
    const ticketsToday = await db.ticket.findMany({
      where: { id: { in: todayPairs.map((p) => p.id) } },
      select: { id: true, createdAt: true },
    })
    const createdAtById = new Map(ticketsToday.map((t) => [t.id, t.createdAt]))
    const deltas = todayPairs
      .map(({ id, firstReplyAt }) => {
        const created = createdAtById.get(id)
        if (!created) return null
        return firstReplyAt.getTime() - created.getTime()
      })
      .filter((d): d is number => d !== null && d >= 0)
      .sort((a, b) => a - b)
    if (deltas.length > 0) {
      const mid = Math.floor(deltas.length / 2)
      medianFirstResponseMsToday =
        deltas.length % 2 === 0
          ? Math.round((deltas[mid - 1] + deltas[mid]) / 2)
          : deltas[mid]
    }
  }

  // ---- Oldest unassigned open ticket age -----------------------------
  const oldestUnassigned = await db.ticket.findFirst({
    where: { assigneeId: null, status: 'open' },
    orderBy: { createdAt: 'asc' },
    select: { createdAt: true },
  })
  const oldestUnassignedAgeMs = oldestUnassigned
    ? Math.max(0, Date.now() - oldestUnassigned.createdAt.getTime())
    : 0

  // ---- Stale count (over the whole queue) ----------------------------
  // Fetch all open+pending tickets (resolved/closed are never stale per
  // computeStaleness). For the demo volumes this is fine; at scale we'd
  // push the computation into SQL.
  const staleCandidates = await db.ticket.findMany({
    where: { status: { in: ['open', 'pending'] } },
    select: {
      id: true,
      status: true,
      assigneeId: true,
      createdAt: true,
      updatedAt: true,
    },
  })
  let staleCount = 0
  for (const t of staleCandidates) {
    if (stalenessOf(t).stale) staleCount += 1
  }

  const stats = {
    open: openCount,
    pending: pendingCount,
    resolvedToday: resolvedTodayCount,
    unassigned: unassignedCount,
    medianFirstResponseMsToday,
    oldestUnassignedAgeMs,
    staleCount,
  }

  return json({
    ok: true,
    data: {
      tickets: tickets.map((t) => {
        const s = stalenessOf(t)
        return {
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
          stale: s.stale,
          staleReason: s.reason,
        }
      }),
      total,
      page,
      pageSize,
      stats,
    },
  })
}
