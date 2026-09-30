# Agent context — Task 2-a

Task: Build customer-facing portal UI (3 tabs) + 3 customer API routes with security hardening.

Files created:
- `src/components/customer/types.ts` — shared client/server types (TicketDetail, ChatMessage, etc.)
- `src/components/customer/customer-portal.tsx` — the 3-tab customer surface (submit / lookup / chat)
- `src/app/api/tickets/route.ts` — POST submit
- `src/app/api/tickets/lookup/route.ts` — GET single-ticket lookup (constant-time token compare)
- `src/app/api/chat/route.ts` — POST AI chatbot (drops client-supplied system messages)
- `src/components/staff/staff-portal.tsx` — minimal STUB so page.tsx resolves its import.
  Task 2-b (staff surface) should OVERWRITE this file in full — do not build on top of it.

All endpoints verified via curl against the running dev server:
- POST /api/tickets with valid body → 201 with `{ref, lookupToken}`
- POST /api/tickets with invalid body → 422 with `fields` per-field errors
- GET /api/tickets/lookup with valid ref+token → 200 with ticket detail + messages
- GET /api/tickets/lookup with wrong token → identical 404 (no enumeration leak)
- GET /api/tickets/lookup with nonexistent ref → identical 404
- POST /api/chat with a user message → 200 with AI reply
- POST /api/chat with a `system` message → silently dropped, AI replies normally
- POST /api/chat with empty body → 400

Known caveats:
- `src/app/page.tsx` has a pre-existing lint error (`react-hooks/set-state-in-effect`
  on line 24, `setSurface(readInitialSurface())`). The task instructions forbid
  modifying page.tsx, so this was left untouched. All my own files lint clean.
- The lookup route originally cached a `NOT_FOUND` Response at module level —
  that worked on the first request but sent an empty body on every subsequent
  request (Next.js reads the body stream once). Fixed by converting to a
  `notFound()` factory that builds a fresh Response per call. Same trap
  applies to ANY module-level `Response` constant; don't reintroduce it.
- Rate-limit countdowns are implemented as a `<RetryCountdown>` component
  (not a hook) so the linter's `set-state-in-effect` rule doesn't fire and
  there's no cascading render on mount.

Schema contract for downstream agents (staff surface):
- Ticket has `ref` (public, e.g. "HD-AB12CD"), `lookupToken` (secret),
  `subject`, `body`, `status` (open|pending|resolved|closed), `priority`
  (low|normal|high|urgent), `category` (general|billing|bug|account|feature),
  `customerEmail`, `customerName`, `assigneeId` (nullable).
- TicketMessage has `authorRole` (customer|staff|ai|system), `staffId`
  (nullable, set only for staff messages), `body`, `aiDrafted` (boolean).
- A new ticket has exactly one system message: "Ticket created by customer."
