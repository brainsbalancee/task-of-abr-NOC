# Tests

This project uses **bun's built-in test runner** (`bun:test`). No vitest, no jest — fewer moving parts.

## Run the suite

```bash
bun test
```

That single command picks up every `*.test.ts` file under `src/` and `tests/`. The full suite runs in a couple of seconds (plus a one-time `prisma db push` for the workflow test's separate test DB).

## What we test

### 1. Pure-function unit tests

These are the parts of the system where a bug would directly hurt a customer or a staff member, with no UI in the way to mask it. Pure functions = fast, deterministic, no DB.

- **`src/lib/__tests__/sla.test.ts`** — `computeStaleness` (the function that decides whether a ticket is "falling through the cracks") and `formatDurationMs` (the median-first-reply formatter). Covers all 4 staleness rules, all 4 not-stale cases, the priority order (first matching rule wins — a ticket that matches rule 1 + rule 2 returns the unassigned reason, not the no-reply reason), and the boundary edges (`>` vs `≥`).
- **`src/lib/__tests__/sanitize.test.ts`** — `validateTicketInput` and `validateMessageBody`. Covers empty-subject / empty-body / short-body / invalid-email rejection, control-character stripping (zero-width U+200B, null bytes U+0000), length caps, multi-error collection.
- **`src/lib/__tests__/auth.test.ts`** — `hashPassword` + `verifyPassword` round-trip, `signSessionToken` + `verifySessionToken` round-trip, the tampered-payload attack (swapped ID + original signature → reject), malformed token rejection, and `constantTimeEqual` on equal / unequal / unequal-length inputs.

### 2. One full-workflow integration test

**`tests/workflow.test.ts`** is the golden path through both surfaces — what the brief explicitly asked for. It imports the actual route handlers (`POST` / `GET` exports from `src/app/api/*/route.ts`) and calls them with mock `NextRequest` objects. No HTTP server is started; Next 16's route handlers are plain async functions that take a Request and return a Response, so this is both fast and faithful to the real code paths.

The 9 steps cover the entire customer → staff → customer reply loop:

1. Customer submits a ticket → asserts `{ref, lookupToken}` shape
2. Customer looks it up → asserts status `"open"`, one system message
3. Customer adds a follow-up reply → asserts 2 messages now, status stays `"open"`
4. Staff logs in → asserts `{id, email, name, role}` + `Set-Cookie` header
5. Staff lists tickets → asserts the new ticket appears as `"open"`
6. Staff opens the ticket detail → asserts the original body + 2-message thread
7. Staff replies → asserts status flips to `"pending"`, 3-message thread
8. Staff requests an AI draft → asserts the response shape (string OR null — LLM output is non-deterministic, so we don't assert content)
9. Customer re-looks up the ticket → asserts the staff reply is visible to the customer with `authorRole: "staff"`

**Test database isolation**: the `tests/setup.ts` preload sets `DATABASE_URL=file:./db/test.db` BEFORE the `@/lib/db` PrismaClient singleton is constructed. The workflow test's `beforeAll` pushes the schema to that file and seeds the demo staff agent. The demo DB (`db/custom.db`) that the reviewer sees in the Preview Panel is never touched.

---

## What we deliberately did NOT test — and why

The brief asks: *"Tell us what you chose not to test and why."* This is that list.

### UI rendering (React component tests)

We did not write React component tests (no React Testing Library, no Playwright component specs). At this scale — two surfaces, ~3k lines of our own UI code, one main golden path — the cost of maintaining component tests exceeds the value. The visual + interaction layer is instead covered by the **agent-browser end-to-end verification** documented in `worklog.md` (Task 3 step): an 11-step walkthrough that exercises both surfaces against a running dev server, asserts the customer→staff→customer reply loop end-to-end, and confirms no console errors / no hydration mismatches / sticky footer on all views. That verification covers what a component test would cover (does the right thing render in response to the right state) at a higher level of fidelity, because it goes through the real HTTP layer too.

The trade-off: agent-browser verification is run-on-demand, not on every commit. For a take-home project that's the right shape. For a long-lived codebase we'd add a small set of focused component tests around the highest-churn UI pieces (the queue table, the ticket detail thread) and leave the rest to integration + e2e.

### Prisma queries

We trust Prisma to translate our `findUnique` / `findMany` / `groupBy` / `$transaction` calls into correct SQL. Testing the generated SQL would be testing the framework, not our application. We DO test the *shape* of the data our queries return — via the workflow test (steps 5, 6, 9 assert specific fields on the ticket + message payloads). If a Prisma query started returning the wrong shape, the workflow test would fail loudly.

What we would test at scale (and didn't, because the demo volumes don't justify it): the N+1 patterns. The staff list endpoint runs a `groupBy` over `TicketMessage` to compute first-reply times — at 10k tickets that scan gets expensive. A query-perf test would lock that down. Noted in `HANDOVER.md` as a future investment.

### The LLM output itself

`draftStaffReply` (in `src/lib/ai.ts`) returns whatever the z-ai-web-dev-sdk produces. LLM output is non-deterministic across runs (temperature > 0), so asserting "the draft contains X" would make the test flaky — it would fail 10% of the time for no actionable reason.

What we DO test about the AI: the **degrade-gracefully contract**. The workflow test step 8 asserts `data.draft === null || typeof data.draft === 'string'`. That's the contract that matters to the UI: the route either returns a string the staff member can review, or it returns `null` and the UI shows the "couldn't generate a draft" fallback. The actual content quality is a human-review problem (the staff member reads it before sending anyway), not a test problem.

### Rate limiting under load

The in-memory token-bucket rate limiter (`src/lib/rate-limit.ts`) is ~50 lines and simple enough to reason about by reading it. A load test ("hit `/api/tickets` 1000x in 10s, assert that 5 succeed and 995 get 429") would test the implementation, not the behavior — and the behavior is obvious from the code. We'd revisit this if the limiter grew state or got more complex.

The bigger concern at scale isn't correctness, it's that an in-memory limiter doesn't work across multiple server processes (each process has its own bucket). That's an architectural note in `HANDOVER.md`, not a test gap.

### WebSocket / SSE

We don't use them. The system polls every 15s (staff queue) or on-demand (customer lookup). No real-time channel to test. `HANDOVER.md` flags "swap polling for WebSocket/SSE" as a top-5 next build — at that point we'd add a connection / reconnection test.

### Edge runtime specifics

We don't use the Edge runtime. Everything runs on the Node.js runtime (Prisma needs it; `crypto.scryptSync` needs it). Nothing to test here.

---

## Test infrastructure notes

- **Test runner**: `bun:test` (no extra dep). Run via `bun test`, configured in `bunfig.toml` to preload `tests/setup.ts`.
- **Test DB**: `db/test.db` (separate from the demo `db/custom.db`). Created fresh by `bun run db:push` in the workflow test's `beforeAll`. Safe to delete; it gets recreated on the next `bun test`.
- **Mock requests**: `new NextRequest(url, init)` — same class the real Next 16 runtime uses, so the route handlers see a request that quacks like the production one. The `[ref]` and `[id]` routes use Next 16's async-params pattern, so we pass `{ params: Promise.resolve({ ref }) }` as the second argument.
- **No tests run against the demo DB.** That's the whole point of the preload + the separate test DB — a `bun test` run won't blow away the tickets the reviewer is looking at in the Preview Panel.
