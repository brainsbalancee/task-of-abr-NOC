# Task 9 + 10 — Tests + Seed Expansion

**Agent**: full-stack-developer (tests + seed)
**Task**: Add unit tests for pure functions, add a full-workflow integration test, write tests/README.md explaining what was NOT tested and why, expand seed data to 12 realistic B2B SaaS tickets.

## Context picked up from previous agents

- `computeStaleness` and `formatDurationMs` in `src/lib/sla.ts` are pure → ideal unit-test target.
- `src/lib/sanitize.ts` exports `validateTicketInput` (returns `{ok, errors|data}`) and `validateMessageBody` (returns `{ok, body|error}`).
- `src/lib/auth.ts` exports `hashPassword`, `verifyPassword`, `signSessionToken`, `verifySessionToken`, `constantTimeEqual` — all pure (no DB).
- Route handlers can be called directly with a mock `Request` (no HTTP server). The handlers only touch `req.json()`, `req.headers`, `new URL(req.url)`. `[ref]`/`[id]` routes use `ctx: { params: Promise<{...}> }` (Next 16 async-params pattern).
- The `db` PrismaClient is a global singleton constructed at module load time. To point tests at a separate `db/test.db`, must set `process.env.DATABASE_URL` BEFORE the first import of `@/lib/db`. Use a `bunfig.toml` `[test].preload` to run a `tests/setup.ts` before any test file.

## Files I plan to write

- `src/lib/__tests__/sla.test.ts`
- `src/lib/__tests__/sanitize.test.ts`
- `src/lib/__tests__/auth.test.ts`
- `tests/setup.ts` (preload: set DATABASE_URL=test.db, ensure db dir)
- `tests/workflow.test.ts` (golden-path integration test; runs prisma db push + seeds staff user in beforeAll)
- `tests/README.md` (what was NOT tested + why)
- `bunfig.toml` (test preload)
- Modified `package.json` (add `test` script)
- Modified `src/lib/seed.ts` (expand to 12 tickets)

## Notes for downstream agents

- After running tests, the test DB (`db/test.db`) will exist. Safe to delete if it's in the way.
- The `bun test` command runs all `*.test.ts` files. The unit tests don't touch the DB; only `tests/workflow.test.ts` does, and it cleans up in `beforeEach`.
- The seed expansion is idempotent via delete-all-then-recreate (documented as acceptable for seed data, not production).
