/**
 * Unit tests for the pure SLA helpers in `src/lib/sla.ts`.
 *
 * These are the highest-value tests in the project: the staleness rules are
 * the part of the system that actually tells staff "this ticket is falling
 * through the cracks", and a wrong rule either misses at-risk tickets
 * (silent failure for the customer) or cries wolf (staff learn to ignore
 * the queue). The function is pure — no DB, no network — so we can pin
 * every rule + boundary + the priority order deterministically using the
 * `now` parameter rather than waiting around in real time.
 *
 * Run: `bun test`
 */

import { describe, it, expect } from 'bun:test'
import { computeStaleness, formatDurationMs } from '@/lib/sla'

const HOUR = 60 * 60 * 1000
const MIN = 60 * 1000

// Fixed "now" so the tests are deterministic. The numbers below use this
// anchor; we never call `new Date()` inside the assertions.
const NOW = new Date('2024-09-15T12:00:00Z')

function dateAt(offsetMs: number): Date {
  return new Date(NOW.getTime() - offsetMs)
}

describe('computeStaleness — stale cases (one rule at a time)', () => {
  it('rule 1: unassigned open ticket older than 1h is stale (unassigned reason)', () => {
    const r = computeStaleness({
      status: 'open',
      assigneeId: null,
      lastStaffReplyAt: null,
      createdAt: dateAt(2 * HOUR),
      updatedAt: dateAt(2 * HOUR),
      now: NOW,
    })
    expect(r.stale).toBe(true)
    expect(r.reason).toBe(
      'Unassigned for over an hour — no one has picked it up yet.',
    )
  })

  it('rule 2: open ticket with no staff reply for >4h is stale (no-reply reason)', () => {
    // Assigned, so rule 1 (unassigned) doesn't fire — we want rule 2.
    const r = computeStaleness({
      status: 'open',
      assigneeId: 'staff-1',
      lastStaffReplyAt: null,
      createdAt: dateAt(5 * HOUR),
      updatedAt: dateAt(5 * HOUR),
      now: NOW,
    })
    expect(r.stale).toBe(true)
    expect(r.reason).toBe(
      'Open for over 4 hours with no staff reply — no agent has acknowledged it.',
    )
  })

  it('rule 3: open ticket inactive for >24h is stale (open-inactive reason)', () => {
    // Assigned + has staff reply, so rules 1 and 2 don't fire — we want rule 3.
    const r = computeStaleness({
      status: 'open',
      assigneeId: 'staff-1',
      lastStaffReplyAt: dateAt(25 * HOUR), // staff replied 25h ago
      createdAt: dateAt(30 * HOUR),
      updatedAt: dateAt(25 * HOUR), // no activity for 25h → inactive > 24h
      now: NOW,
    })
    expect(r.stale).toBe(true)
    expect(r.reason).toBe(
      'Open with no activity for over 24 hours — may need a nudge.',
    )
  })

  it('rule 4: pending ticket inactive for >72h is stale (pending-inactive reason)', () => {
    const r = computeStaleness({
      status: 'pending',
      assigneeId: 'staff-1',
      lastStaffReplyAt: dateAt(80 * HOUR),
      createdAt: dateAt(90 * HOUR),
      updatedAt: dateAt(80 * HOUR), // inactive for 80h → > 72h
      now: NOW,
    })
    expect(r.stale).toBe(true)
    expect(r.reason).toBe(
      'Awaiting customer reply for over 72 hours — customer may have given up.',
    )
  })
})

describe('computeStaleness — not-stale cases', () => {
  it('fresh unassigned open ticket (1 min old) is NOT stale', () => {
    const r = computeStaleness({
      status: 'open',
      assigneeId: null,
      lastStaffReplyAt: null,
      createdAt: dateAt(1 * MIN),
      updatedAt: dateAt(1 * MIN),
      now: NOW,
    })
    expect(r.stale).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('resolved ticket is never stale (even if old + unassigned)', () => {
    const r = computeStaleness({
      status: 'resolved',
      assigneeId: null,
      lastStaffReplyAt: null,
      createdAt: dateAt(200 * HOUR),
      updatedAt: dateAt(200 * HOUR),
      now: NOW,
    })
    expect(r.stale).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('closed ticket is never stale', () => {
    const r = computeStaleness({
      status: 'closed',
      assigneeId: null,
      lastStaffReplyAt: null,
      createdAt: dateAt(500 * HOUR),
      updatedAt: dateAt(500 * HOUR),
      now: NOW,
    })
    expect(r.stale).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('pending ticket 1h old is NOT stale', () => {
    const r = computeStaleness({
      status: 'pending',
      assigneeId: 'staff-1',
      lastStaffReplyAt: dateAt(1 * HOUR),
      createdAt: dateAt(2 * HOUR),
      updatedAt: dateAt(1 * HOUR), // last staff reply was the last activity
      now: NOW,
    })
    expect(r.stale).toBe(false)
    expect(r.reason).toBeNull()
  })

  it('open ticket with a staff reply that is only 1h old is NOT stale', () => {
    const r = computeStaleness({
      status: 'open',
      assigneeId: 'staff-1',
      lastStaffReplyAt: dateAt(1 * HOUR),
      createdAt: dateAt(1 * HOUR),
      updatedAt: dateAt(1 * HOUR),
      now: NOW,
    })
    expect(r.stale).toBe(false)
    expect(r.reason).toBeNull()
  })
})

describe('computeStaleness — priority order (first matching rule wins)', () => {
  it('unassigned + 5h old → returns the unassigned reason, not the no-reply reason', () => {
    // This ticket matches rule 1 (unassigned > 1h) AND rule 2 (no staff reply > 4h).
    // Rule 1 fires first by design — picking up an unassigned ticket is the
    // most urgent action because no one is even aware of it yet.
    const r = computeStaleness({
      status: 'open',
      assigneeId: null,
      lastStaffReplyAt: null,
      createdAt: dateAt(5 * HOUR),
      updatedAt: dateAt(5 * HOUR),
      now: NOW,
    })
    expect(r.stale).toBe(true)
    expect(r.reason).toBe(
      'Unassigned for over an hour — no one has picked it up yet.',
    )
    // And NOT the no-reply reason:
    expect(r.reason).not.toBe(
      'Open for over 4 hours with no staff reply — no agent has acknowledged it.',
    )
  })

  it('assigned open + 5h no reply + 25h inactive → returns the no-reply reason, not open-inactive', () => {
    // Matches rule 2 (no staff reply > 4h) AND rule 3 (open inactive > 24h).
    // Rule 2 fires first — the no-reply situation is more actionable
    // (staff haven't acknowledged at all) than the inactive one (staff
    // replied but the conversation stalled).
    const r = computeStaleness({
      status: 'open',
      assigneeId: 'staff-1',
      lastStaffReplyAt: null,
      createdAt: dateAt(30 * HOUR),
      updatedAt: dateAt(25 * HOUR), // inactive 25h
      now: NOW,
    })
    expect(r.stale).toBe(true)
    expect(r.reason).toBe(
      'Open for over 4 hours with no staff reply — no agent has acknowledged it.',
    )
  })
})

describe('computeStaleness — boundary edges (> vs ≥)', () => {
  it('unassigned open ticket exactly 1h old is NOT stale (> not ≥)', () => {
    const r = computeStaleness({
      status: 'open',
      assigneeId: null,
      lastStaffReplyAt: null,
      createdAt: dateAt(1 * HOUR),
      updatedAt: dateAt(1 * HOUR),
      now: NOW,
    })
    expect(r.stale).toBe(false)
  })

  it('unassigned open ticket 1h + 1ms old IS stale', () => {
    const r = computeStaleness({
      status: 'open',
      assigneeId: null,
      lastStaffReplyAt: null,
      createdAt: dateAt(1 * HOUR + 1),
      updatedAt: dateAt(1 * HOUR + 1),
      now: NOW,
    })
    expect(r.stale).toBe(true)
  })
})

describe('formatDurationMs', () => {
  it('0 → "—" (no measurable duration)', () => {
    expect(formatDurationMs(0)).toBe('—')
  })

  it('30000ms → "30s"', () => {
    expect(formatDurationMs(30_000)).toBe('30s')
  })

  it('90000ms → "1m 30s"', () => {
    expect(formatDurationMs(90_000)).toBe('1m 30s')
  })

  it('3720000ms → "1h 2m" (hours hide seconds)', () => {
    expect(formatDurationMs(3_720_000)).toBe('1h 2m')
  })

  it('negative → "—" (clock skew, treat as no data)', () => {
    expect(formatDurationMs(-1000)).toBe('—')
  })

  it('NaN → "—"', () => {
    expect(formatDurationMs(Number.NaN)).toBe('—')
  })

  it('Infinity → "—" (Number.isFinite is false)', () => {
    expect(formatDurationMs(Number.POSITIVE_INFINITY)).toBe('—')
  })
})
