# Task 3-fixes — full-stack-developer (brief-gap fixes)

This file is the work record for the brief-gap fix task. Read in conjunction with
the worklog entries from tasks 2-a (customer surface) and 2-b (staff surface)
which established the contracts this task extends.

## Plan

The brief calls for 7 features. Priority order:
1. Customer reply (Feature 1) — explicit brief requirement, blocks the full-workflow test
2. Full-workflow integration test (Feature 7) — explicit brief requirement
3. SLA/staleness (Feature 2) — needed by the test indirectly
4. Response-time stats (Feature 3) — small addition on top of #2
5. Assign-to-colleague (Feature 4)
6. Customer history context (Feature 5)
7. Enriched seed data (Feature 6)

## Files I will create

- `src/app/api/tickets/reply/route.ts` — customer reply POST (Feature 1)
- `src/lib/sla.ts` — staleness computation helper (Feature 2)
- `src/app/api/staff/users/route.ts` — staff list for assign-to-colleague (Feature 4)
- `tests/full-workflow.test.ts` — bun:test end-to-end (Feature 7)
- `tests/README.md` — what we test / what we don't (Feature 7)

## Files I will modify

- `src/app/api/staff/tickets/route.ts` — add stale/staleReason to list items, median/staleCount stats (F2 + F3)
- `src/app/api/staff/tickets/[id]/route.ts` — add customerHistory to detail (F5)
- `src/components/staff/staff-portal.tsx` — stale badge + tooltip, stale-only filter, 2 new stat cards, assign-to-colleague dropdown, customer history collapsible (F2/F3/F4/F5)
- `src/components/customer/customer-portal.tsx` — reply box in TicketDetailCard (F1)
- `src/components/staff/types.ts` — extend StaffListItem + StaffTicketDetail + QueueStats (F2/F3/F5)
- `src/lib/seed.ts` — more staff + 8 more customers + 10 more tickets (F6)
- `package.json` — add "test" script (F7)

## Rules I will keep

- `json()` from `@/lib/api` for all responses
- `getStaffFromRequest(req)` gates staff endpoints
- `lookupToken` + `constantTimeEqual` for customer endpoints
- `rateLimit(key, RATE_LIMITS.X)` + `cleanupRateLimitMap()` after
- `validateMessageBody` for body validation
- Plain-text rendering only — NEVER `dangerouslySetInnerHTML`
- Color: zinc neutrals + emerald/amber. No indigo, no blue.

## Notes for downstream agents

- I extend `src/lib/sanitize.ts` if I need a new validator. I don't need to — `validateMessageBody` already exists for ticket reply bodies.
- I do NOT modify `src/app/page.tsx`, `src/lib/*.ts` (other than extending `sanitize.ts` if needed), `prisma/schema.prisma`, or `SCOPE.md`.
- The dev server is running on port 3000. I check `tail -5 /home/z/my-project/dev.log` after each code change.
