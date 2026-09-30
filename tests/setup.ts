/**
 * Test preload — runs before any test file's top-level imports are evaluated.
 *
 * Why this exists: the PrismaClient singleton in `src/lib/db.ts` reads
 * `process.env.DATABASE_URL` ONCE, at module-load time. If we let bun load
 * `.env` (which points at `file:./db/custom.db` — the demo DB the staff
 * UI reads from), every test that touches the DB would mutate the demo data
 * the reviewer sees in the Preview Panel. That's a bad day for everyone.
 *
 * So we override `DATABASE_URL` to a separate `db/test.db` BEFORE the db
 * module is imported. The workflow test then pushes the schema to that
 * file in its `beforeAll` and seeds the staff user, so the demo DB is
 * untouched.
 *
 * This file is registered as a test preload via `bunfig.toml`:
 *   [test]
 *   preload = ["./tests/setup.ts"]
 *
 * Choice rationale (vs alternatives):
 *  - We could push the schema here in the preload too, but that would run
 *    `prisma db push` for EVERY `bun test` invocation — even when only the
 *    unit tests (which never touch the DB) are running. The push takes
 *    ~2-3s, which is a real cost on the iterate-test loop. So we keep the
 *    env-only preload cheap, and do the heavier schema push inside the
 *    workflow test's `beforeAll` instead.
 *  - We could have used Prisma's programmatic `pushSchema` API to skip the
 *    CLI subprocess. That's faster but more fragile (the API surface isn't
 *    stable across Prisma versions) and the time-box didn't justify it.
 *    The `bun run db:push` subprocess is reliable and ~3s is fine.
 */

import { mkdirSync } from 'node:fs'

// Override the demo DB path. This MUST run before any test file imports
// `@/lib/db` (which constructs the PrismaClient singleton).
process.env.DATABASE_URL = 'file:./db/test.db'

// Make sure the db dir exists — Prisma won't create parent dirs for a
// `file:` datasource URL, and the workflow test's `db push` would fail
// otherwise.
try {
  mkdirSync('./db', { recursive: true })
} catch {
  // Already exists — fine.
}
