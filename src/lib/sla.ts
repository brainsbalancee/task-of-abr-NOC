/**
 * SLA / staleness computation.
 *
 * My model of "falling through the cracks" (from the brief):
 *  - An open ticket no agent has acknowledged (no staff reply) for >4h.
 *  - An open ticket with no activity for >24h.
 *  - A pending ticket (awaiting customer reply) with no activity for >72h
 *    (the customer may have given up).
 *  - An unassigned open ticket older than 1h (no one's picked it up).
 *
 * The helper returns the FIRST matching reason in this priority order:
 *   1. unassigned-1h      — no one's picked it up
 *   2. no-reply-4h        — no agent has acknowledged an open ticket
 *   3. open-24h-inactive  — quiet open ticket
 *   4. pending-72h-inactive — customer may have given up on a pending ticket
 *
 * Pure function — no DB. The caller supplies the inputs (status, assigneeId,
 * lastStaffReplyAt, createdAt, updatedAt, now). This makes the function
 * trivial to unit-test and lets the queue + detail views share the same
 * logic without an extra round-trip.
 */

export type StaleResult = {
  stale: boolean
  reason: string | null
}

const HOUR_MS = 60 * 60 * 1000
const DAY_MS = 24 * HOUR_MS

const THRESHOLDS = {
  unassignedOpenHr: 1 * HOUR_MS,
  noStaffReplyHr: 4 * HOUR_MS,
  openInactiveHr: 24 * HOUR_MS,
  pendingInactiveHr: 72 * HOUR_MS,
} as const

const REASONS = {
  unassigned:
    'Unassigned for over an hour — no one has picked it up yet.',
  noReply:
    'Open for over 4 hours with no staff reply — no agent has acknowledged it.',
  openInactive:
    'Open with no activity for over 24 hours — may need a nudge.',
  pendingInactive:
    'Awaiting customer reply for over 72 hours — customer may have given up.',
} as const

export function computeStaleness(opts: {
  status: string
  assigneeId: string | null
  /** When the first staff reply landed. Null if no staff reply yet. */
  lastStaffReplyAt: Date | null
  createdAt: Date
  updatedAt: Date
  /** For testing — defaults to `new Date()` (now). */
  now?: Date
}): StaleResult {
  const now = opts.now ?? new Date()
  const ageMs = now.getTime() - opts.createdAt.getTime()
  const inactiveMs = now.getTime() - opts.updatedAt.getTime()

  // Closed / resolved tickets are never "stale" — they're done.
  if (opts.status === 'closed' || opts.status === 'resolved') {
    return { stale: false, reason: null }
  }

  // Rule 1: unassigned open ticket older than 1h.
  if (
    opts.status === 'open' &&
    opts.assigneeId === null &&
    ageMs > THRESHOLDS.unassignedOpenHr
  ) {
    return { stale: true, reason: REASONS.unassigned }
  }

  // Rule 2: open ticket with no staff reply for >4h.
  if (
    opts.status === 'open' &&
    opts.lastStaffReplyAt === null &&
    ageMs > THRESHOLDS.noStaffReplyHr
  ) {
    return { stale: true, reason: REASONS.noReply }
  }

  // Rule 3: open ticket inactive for >24h.
  if (
    opts.status === 'open' &&
    inactiveMs > THRESHOLDS.openInactiveHr
  ) {
    return { stale: true, reason: REASONS.openInactive }
  }

  // Rule 4: pending ticket (awaiting customer reply) inactive for >72h.
  if (
    opts.status === 'pending' &&
    inactiveMs > THRESHOLDS.pendingInactiveHr
  ) {
    return { stale: true, reason: REASONS.pendingInactive }
  }

  return { stale: false, reason: null }
}

/**
 * Format a millisecond duration as a compact human string like "12m 30s"
 * or "1h 5m". Used for the "median first reply (today)" stat card.
 * 0 → "—".
 */
export function formatDurationMs(ms: number): string {
  if (!ms || ms <= 0 || !Number.isFinite(ms)) return '—'
  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (hours > 0) return `${hours}h ${minutes}m`
  if (minutes > 0) return `${minutes}m ${seconds}s`
  return `${seconds}s`
}
