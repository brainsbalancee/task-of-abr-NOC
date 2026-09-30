# Agent context — Task 2-b

Task: Build the authed staff surface end-to-end (UI + 8 API routes).

Files created:
- `src/components/staff/types.ts` — shared client/server types
  (StaffUser, StaffListItem, StaffListResponse, QueueStats,
  StaffTicketDetail, StaffMessageView, PatchTicketRequest, etc.).
- `src/components/staff/staff-portal.tsx` — the staff UI (overwrote
  the stub from Task 2-a in full). Single root component manages three
  views: login, queue (dashboard), ticket detail. On mount calls
  `GET /api/staff/me` to restore an existing session.
- `src/app/api/staff/login/route.ts` — POST login (rate-limited, signed
  session cookie, same generic 401 for unknown user vs wrong password,
  dummy-hash compare for timing parity, audit `auth.login`).
- `src/app/api/staff/logout/route.ts` — POST logout (idempotent,
  clears cookie, audit `auth.logout` only if there was a session).
- `src/app/api/staff/me/route.ts` — GET me (401 if no session).
- `src/app/api/staff/tickets/route.ts` — GET list with filters
  (status/priority/category/q/assignee), pagination (page+pageSize,
  capped at 100), and an unfiltered stats block (open/pending/
  resolvedToday/unassigned). Default ordering: open+pending first,
  then createdAt desc, implemented as a two-query window fetch
  (Prisma's orderBy DSL can't express "open/pending first" without
  raw SQL — we keep the `include` shape intact instead of going raw).
- `src/app/api/staff/tickets/[id]/route.ts` — GET (ticket + messages
  + assignee + customer, oldest messages first) + PATCH (any subset
  of status/priority/category/assigneeId with strict enum validation).
- `src/app/api/staff/tickets/[id]/reply/route.ts` — POST staff reply.
  Transactional: creates the `TicketMessage` (authorRole: 'staff',
  staffId, aiDrafted) AND flips the ticket status to 'pending' in a
  single `db.$transaction`. Audit `ticket.reply` with meta (ticketId,
  aiDrafted, length — never the body text itself).
- `src/app/api/staff/tickets/[id]/draft/route.ts` — POST AI draft.
  Rate-limited per-staff (20/min via `RATE_LIMITS.aiDraft`). Builds
  the conversation transcript (customer/staff/ai mapped; system
  dropped). Calls `draftStaffReply` from `@/lib/ai`. Returns
  `{ draft: string | null }` — null when the AI was unavailable so
  the UI shows a graceful fallback.

## Verification

All endpoints verified via curl against the running dev server on
port 3000:

- `POST /api/staff/login` with valid creds → 200 + `Set-Cookie` +
  `{ok:true, data:{id,email,name,role}}`.
- `POST /api/staff/login` with wrong password → 401 + identical body
  `{ok:false, error:"Wrong email or password"}` whether the email is
  unknown OR the password is wrong (no enumeration signal).
- `POST /api/staff/login` with missing fields → 400.
- `POST /api/staff/login` returning 401 returns the body on every
  call — confirmed via 3 consecutive unknown-user attempts (the trap
  from task 2-a — module-level `Response` constants get consumed —
  was avoided by using a factory function `genericError()` instead).
- `POST /api/staff/logout` → 200 + `Set-Cookie: helpdesk_staff_session=;
  Max-Age=0; Expires=...` + `{ok:true}`. Idempotent.
- `GET /api/staff/me` without cookie → 401. With valid cookie → 200
  + `{ok:true, data:{...}}`.
- `GET /api/staff/tickets?page=1&pageSize=25` → 200 with 4 tickets
  (open first, then pending, then resolved), plus stats
  `{open:2, pending:1, resolvedToday:1, unassigned:2}` (unfiltered
  counts reflecting true queue state, not the filtered view).
- `GET /api/staff/tickets?q=PDF` → 200 with 1 matching ticket.
- `GET /api/staff/tickets/[id]` → 200 with ticket + messages (oldest
  first) + assignee + customer. Staff names on staff messages are
  resolved server-side (the schema has `staffId` but no Prisma
  relation to StaffUser — see "Decisions" below).
- `GET /api/staff/tickets/[id]` with bogus id → 404 JSON (clean, not
  a Prisma error leak).
- `PATCH /api/staff/tickets/[id] {priority:"urgent"}` → 200 + updated
  ticket. Optimistic UI on the client reflects this immediately.
- `PATCH /api/staff/tickets/[id] {assigneeId:"<my-id>"}` → 200 +
  updated ticket with assignee populated.
- `PATCH /api/staff/tickets/[id] {status:"nonsense"}` → 422 +
  `{ok:false, error:"Invalid status."}` (enum validated server-side).
- `PATCH /api/staff/tickets/[id] {assigneeId:"<unknown-id>"}` → 422
  + `"Unknown assignee."` (foreign key checked before write).
- `PATCH /api/staff/tickets/nope-nope {status:"open"}` → 404.
- `POST /api/staff/tickets/[id]/reply {body, aiDrafted:false}` → 200
  + created message with staffName/staffRole populated. Ticket status
  flipped to "pending" in the same transaction (verified by
  subsequent GET).
- `POST /api/staff/tickets/[id]/reply {body:"   "}` → 422 with
  "Message cannot be empty."
- `POST /api/staff/tickets/[id]/draft {}` → 200 + AI-generated draft
  string. Took ~2s (LLM inference). On a non-existent ticket → 404.
  On auth failure → 401. On rate-limit → 429 with `Retry-After`.

## UI verification

The StaffPortal is mounted by `src/app/page.tsx` when the user
switches the customer/staff tab to "Staff". The UI:

- On mount, fetches `/api/staff/me` and routes to the login view
  (no session) or the queue view (existing session).
- Login form has one-click "demo account" buttons that prefill the
  agent/admin credentials so a reviewer can sign in instantly.
- Queue view shows 4 stat cards (Open / Awaiting reply / Resolved
  today / Unassigned), a 4-column filter bar (status / priority /
  category / assignee), a debounced search box (300ms), a desktop
  table view (`md:table`) + mobile stacked card view (`md:hidden`),
  and a "Updated Xs ago" indicator that ticks every second.
- The queue polls `/api/staff/tickets` every 15 seconds while
  visible (with proper `setInterval` cleanup on unmount).
- Clicking a ticket row opens the detail view: editable status /
  priority / category / assignee fields (each commit hits PATCH with
  optimistic update), customer email with a copy-to-clipboard button,
  the original ticket body in a plain-text `<pre>`, and the message
  thread with per-role visual treatment (staff = amber accent,
  AI = emerald accent + "AI" badge, customer = neutral, system =
  muted italic dashed border).
- "Suggest a reply ✨" button calls the draft endpoint and populates
  the textarea without sending. The textarea shows an "AI-suggested"
  badge while the draft is loaded. Hitting "Send reply" posts with
  `aiDrafted:true`. Replies optimistically append to the thread and
  refetch in the background.
- All buttons have loading spinners during async ops. All errors are
  surfaced via `sonner` toasts (no `alert()` anywhere).
- Sticky footer is handled by the shell in `page.tsx` — the staff
  portal doesn't render its own footer.

## Key decisions

- **Internal-id URLs, not `ref` URLs.** Staff URLs use the Prisma
  `id` (cuid), not the public-facing `ref`. The `ref` is the
  customer's identifier; keeping staff APIs on internal ids gives a
  consistent surface and means staff URLs never leak the `ref` shape
  into logs/refs.
- **`json()` wrapper from `@/lib/api` for every response.** Every
  staff route returns `{ ok: true, data: ... }` or `{ ok: false,
  error: ... }` via the shared `json()` helper. The UI defensively
  handles both wrapped and unwrapped shapes for the queue (older
  contract) — slight over-defensiveness, but cheap.
- **`GENERIC_ERROR` → `genericError()` factory.** I almost recreated
  the module-level-Response trap from Task 2-a. Caught it during
  curl testing (the second 401 returned an empty body). Refactored
  to a factory function that builds a fresh `Response` per call.
  Same trap, same fix as the lookup route — keep this in mind for
  any future error-response constant.
- **Two-query pagination for "open/pending first".** The task
  suggested a CASE statement in raw Prisma. I used a two-window
  fetch instead because (a) it keeps the `include: { assignee,
  _count }` shape intact (no manual JOIN), (b) the volumes are tiny,
  and (c) it's correct: active window (skip from start) fills first,
  rest window (skip past active bucket) fills the remaining slots.
- **Staff names resolved server-side, not in the UI.** The schema
  has `TicketMessage.staffId` (plain String) but no Prisma relation
  to StaffUser (the schema was kept minimal — see `prisma/schema.prisma`
  comment). I can't add a relation without modifying the schema
  (forbidden by the task). So `fetchTicketShape` collects the
  distinct staffIds from the thread, does one extra StaffUser
  findMany, and merges `staffName`/`staffRole` onto each message.
  One extra query, no N+1.
- **Audit logs never store body text.** `recordAudit` calls write
  metadata only — lengths and field-change strings (e.g.
  `["status=resolved", "priority=urgent"]`), never the reply body.
  This keeps customer/staff PII out of the audit trail.
- **Per-staff rate limit on AI draft.** The draft endpoint uses
  `RATE_LIMITS.aiDraft` keyed by `staff:<id>:draft` so a single
  agent can't blow through LLM inference budgets. Login uses
  `RATE_LIMITS.staffLogin` keyed by `ip:login:<ip>` (brute-force
  protection).
- **Constant-time error on login.** Whether the email is unknown OR
  the password is wrong, the response is identical (status 401, body
  "Wrong email or password"). The unknown-user path also runs a
  `verifyPassword` against a dummy hash to keep timing roughly
  constant. (scrypt timing isn't perfectly masked, but we don't
  early-return either.)

## Known limitations / caveats

- **Session revocation is stateless.** Logout clears the cookie
  client-side and writes an audit log, but the signed HMAC token
  itself remains technically valid until its 12h TTL. This is the
  documented tradeoff from `src/lib/auth.ts` ("easier to revoke"
  would require a server-side session table). In a real build, a
  token-version counter on StaffUser would let us invalidate
  outstanding sessions on password change / role demotion.
- **The queue polls every 15 seconds.** A WebSocket push would be
  nicer, but the project spec for Task 2-a explicitly kept polling
  to stay minimal for the time box. The "Updated Xs ago" indicator
  makes the polling visible to the agent.
- **Search is `contains` (substring), not full-text.** SQLite's
  `contains` is good enough for the demo volumes. At scale we'd want
  FTS5.
- **The optimistic PATCH revert isn't atomic.** If the user changes
  status, then immediately changes priority before the first PATCH
  returns, both in-flight requests race. The server processes them in
  order received, but the optimistic UI's `prev` snapshot may not
  match what's on the server. Edge case, not blocking — last response
  wins, and the UI eventually reconciles.
- **The shell's pre-existing lint error in `page.tsx:24`** is still
  there (forbidden to fix per task instructions). All my own files
  lint clean.
- **`assignee` field on staff messages.** Each staff message shows
  the staff member's name as resolved from `staffId`. For messages
  from the Demo Agent (the current user), the UI shows "you" in the
  sub-label — small UX nicety.
- **The `_count.messages` on list items includes system messages.**
  The system "Ticket created by customer." opener counts toward the
  message count. Could filter to non-system; left as-is since the
  spec said `_count { messages }`.
