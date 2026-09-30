# DECISIONS.md

Each entry: **Decision / Reason / Alternative considered / Trade-off accepted**. The last two are decisions I now think were wrong or would revisit. They're marked with ⚠.

---

## 1. Both surfaces on a single `/` route, toggled by a header tab

**Reason.** The project sandbox constraint forbids writing any page route other than `/`. To make both surfaces reachable from the preview, they have to live on `/`. I made it work with a hash-based toggle (`#customer` / `#staff`) that survives reloads and lets reviewers deep-link.

**Alternative considered.** Separate `/staff` and `/customer` page routes. Cleaner URL space, easier to bookmark, easier to put behind different middleware (e.g. IP-allow-list for `/staff`). The constraint overruled it.

**Trade-off accepted.** Less clean URLs. The hash fragment survives reloads, but it's not as nice as a real path. The reviewer demo benefits from the toggle, though — you don't have to remember URLs.

---

## 2. Plain-text rendering for all customer input, no markdown, no HTML allowlist

**Reason.** Stored XSS is the worst-case risk on this surface (customer input rendered into a privileged staff browser — see [SCOPE.md](./SCOPE.md) Risk 1). Plain text + React's default escaping is a defense in depth that survives a single-layer bug. There is no `dangerouslySetInnerHTML` anywhere on either surface.

**Alternative considered.** `remark` + `rehype-sanitize` to allow a safe subset of markdown. The classic path. The problem: sanitizer-bypass CVEs are a steady drip in the security advisories, and "the customer can bold their text" is not worth that risk surface.

**Trade-off accepted.** Customers can't format their tickets with rich text. They can paste a URL as plain text; it just isn't a clickable link in the staff UI. For a support tool, the UX cost is small and the security win is large.

---

## 3. In-memory token-bucket rate limiting, per-IP, per-bucket

**Reason.** Single-process Node server in a sandbox. In-memory is correct for that topology — no extra moving parts, fails closed (if the map is lost, the worst case is a fresh quota, never a permanently-locked-out user). Stricter budgets on the expensive/abuse-prone endpoints: ticket submit 5/min, AI chat 10/min, login 10/min, ticket lookup 20/min, AI draft 20/min.

**Alternative considered.** Redis. The right call the moment there's more than one Node instance, or the moment this deploy needs to survive a restart without losing quotas. The wrong call for a sandbox demo.

**Trade-off accepted.** A multi-instance deploy has per-instance limits (effectively N× the limit for an attacker who can hit any instance). Bounded map growth with periodic cleanup so memory doesn't leak.

---

## 4. Cookie-based staff session (HMAC-signed token), not JWT

**Reason.** A signed token = `base64(staffId) + "." + HMAC(staffId)`. Tampering with `staffId` invalidates the HMAC. One DB lookup per request to fetch the staff record. Cookie attributes: `HttpOnly`, `SameSite=Strict`, `Secure` in prod, 12-hour TTL.

**Alternative considered.** JWT. JWTs shine for distributed auth across many services — stateless verification without a DB lookup. We have one service. The cost of a DB lookup per request is trivial. The win of cookie + server-side revocation is real.

**Trade-off accepted.** Logout clears the cookie client-side but the HMAC token is technically valid until its 12h TTL expires. (A server-side session table or a `tokenVersion` counter on `StaffUser` would fix this; not worth the complexity at this scale.)

---

## 5. scrypt for password hashing, not bcrypt

**Reason.** Node has `crypto.scrypt` built in. bcrypt needs native bindings and a build step. For a sandboxed demo with a 6-hour box, avoiding native build deps is worth the ~10ms/hash cost vs bcrypt's tuned cost factor.

**Alternative considered.** bcrypt. Industry standard, well-audited. Native build deps in a sandbox are friction for no real win at this scale.

**Trade-off accepted.** scrypt is less commonly seen in tutorials. It's fine — it's an industry standard (used by 1Password, etc.) and `crypto.scryptSync` is just as well-tuned.

---

## 6. Two-query window fetch for "open + pending first" queue ordering

**Reason.** The staff queue should show open + pending tickets before resolved/closed. Prisma's `orderBy` doesn't do conditional ordering on SQLite without raw SQL. Raw SQL would break the `include: { assignee, _count: { messages } }` shape, forcing me to manually reconstruct the relations.

**Alternative considered.** Raw SQL with a `CASE WHEN status IN ('open','pending') THEN 0 ELSE 1 END` ordering clause, then a separate fetch of assignees + message counts. Loses Prisma's relation loading. ~2× the code for ~1 query instead of 2.

**Trade-off accepted.** Two queries instead of one. At demo volumes (5 tickets) the second query is free. At 10k tickets it's a separate query that hits the same index — still fast.

---

## 7. Polling every 15s for the staff queue, not WebSocket / SSE

**Reason.** Time box. WebSocket would mean a separate `mini-service` (per project rules), a different port, a Caddy gateway query param, a socket.io client setup, and reconnection logic. That's ~90 minutes of work for a marginal UX win on a demo. The customer surface doesn't need real-time at all — they look up status on demand. The staff queue at 15s polling is the one wart.

**Alternative considered.** Server-Sent Events. Simpler than full WebSocket, no separate service needed (you can stream from a Next.js route handler). Would have been ~30 minutes. I should have done it.

**Trade-off accepted.** 15-second latency on queue updates. An agent actively working the queue will sometimes see a ticket a few seconds after it's submitted. Fine for the demo; would not be fine in production. (See "Two I'd revisit" below.)

---

## 8. Lookup token is the only way for unauthed customers to view their ticket (no "view all my tickets by email")

**Reason.** Without email verification, anyone who knows a customer's email could read their entire ticket history. That's a real privacy bug, not a hypothetical one — customer support tickets often contain PII, billing context, and account details.

**Alternative considered.** "View all my tickets by email" with a magic-link email to verify ownership. The right design, but it requires an email provider and deliverability work — both cut for the box.

**Trade-off accepted.** Customers have to save the per-ticket lookup token. If they lose it, they have to contact support to view their ticket. Annoying, but the alternative is a privacy bug.

---

## 9. AI draft is never auto-sent — staff always review and click Send

**Reason.** AI should augment, never decide. The model can draft, the human ships. Every AI-drafted message has `aiDrafted: true` recorded for later quality review, but the human is in the loop for every reply that goes to a customer.

**Alternative considered.** Trust-score threshold for auto-send — "if the model is >95% confident, send it; otherwise show the draft for review." Tempting, but the model can be confidently wrong, and the cost of a bad auto-reply (refunds promised, security advice, wrong pricing) is much higher than the cost of a human clicking Send. Never.

**Trade-off accepted.** Every reply requires a click, even for trivial high-confidence drafts. The staff UX is slightly slower than a hypothetical "auto-send" mode. That's the right cost.

---

## 10. Customer chatbot: hardcoded system prompt in backend, client-supplied system messages dropped

**Reason.** Prompt-injection is the novel risk on AI-augmented apps (see [SCOPE.md](./SCOPE.md) Risk 3). Trusting the client's `role` field is a bug. The server is the only thing that knows the system prompt; the client only ever sends `user` and `assistant` turns.

**Alternative considered.** Per-customer system prompts (e.g., injecting their plan, ticket history) for a more personalized bot. Tempting, but it leaks customer data into the bot's context and raises the prompt-injection stakes. The right path is: bot is intentionally unhelpful on anything account-specific, refers out to a human agent.

**Trade-off accepted.** The bot can't help with "what's my plan" or "am I billed for X" — it has to say "I don't know your account or billing details" and refer out. The bot is useful for triage ("have you tried a different browser?") and that's it.

---

## 11. Same 404 response for "no such ref" and "wrong token" on ticket lookup

**Reason.** Closing the enumeration vector. Constant-time comparison via `crypto.timingSafeEqual`. Same response body, same status code, same response time class. See [SCOPE.md](./SCOPE.md) Risk 2.

**Alternative considered.** Distinguish them — "no such ref" → 404, "wrong token" → 403. Slightly better error UX (the customer knows whether they typo'd the ref vs the token). The security cost is too high.

**Trade-off accepted.** Customer can't tell whether their ref or their token is wrong. They have to re-check both. Minor UX cost; major security win.

---

## 12. Demo credentials shown on the staff login screen

**Reason.** Take-home reviewers should not have to read the README to log in. One-click buttons prefill the agent/admin accounts. This is a demo-only concession.

**Alternative considered.** Hide the credentials behind a "show demo accounts" toggle so they're not visible at a glance. Marginal security win on a demo where the credentials are in the README anyway.

**Trade-off accepted.** Anyone who can open the URL can sign in as staff. This is a demo. The seed script's passwords (`staff-demo-1234`, `staff-admin-1234`) are clearly throwaway. In production, this would be behind a real auth provider and the demo hint would be gone.

---

## Two decisions I now think were wrong or would revisit

### ⚠ 13. Polling every 15s for the staff queue (revisit decision 7 above)

**What I'd change.** Replace polling with Server-Sent Events (SSE) streamed from a Next.js route handler. SSE is simpler than WebSocket, doesn't require a separate mini-service, and gives sub-second updates. The marginal cost over polling is ~30 minutes of work — well within the box. I went with polling because it was the safe default and I wanted to ship, but the 15s lag is the most-felt UX wart in the demo.

**Why it was wrong.** I overweighted "polling is simpler" and underweighted "the staff queue is the surface staff actually live in." Real-time updates on the queue is the difference between an agent grabbing a fresh ticket in 1s vs 15s. In a high-volume support team, 15s of lag compounds.

### ⚠ 14. The `TicketMessage.staffId` field is a plain String, not a Prisma relation

**What I'd change.** Add `staff StaffUser? @relation(fields: [staffId], references: [id])` to the `TicketMessage` model. Then the staff detail endpoint can `include: { staff: { select: { name: true } } }` instead of doing a separate `StaffUser.findMany` to resolve names. Saves one query per ticket-detail fetch, and the code is cleaner.

**Why it was wrong.** I was defensive about modifying the schema after the foundation was in place (the subagents were told not to touch it). The schema was perfectly correct as a plain String — Prisma doesn't require relations on FK columns. But the staff surface agent had to work around it with an extra query, which is a real wart that anyone reading the code will notice. The fix is one line. I should have caught it during the foundation phase.

### (A process decision I'd revisit, bonus)

**⚠ The orchestrator (me) should have stubbed shared files before dispatching subagents.** Task 2-a (customer surface) had to create a stub `src/components/staff/staff-portal.tsx` because `src/app/page.tsx` (which I'd already written) imported it, and the dev server wouldn't compile without it. Task 2-b (staff surface) was then told to overwrite the stub. That worked, but it's a process smell — the orchestrator should always stub shared files first, so subagents can be strictly additive. I noted this in the worklog. Next time I'd write empty stubs for every cross-agent import before dispatching.

---

## Non-decisions (things that were not real choices)

For honesty — these were forced by the project spec or by the time box, not real decisions:

- **Next.js 16 + TypeScript + Prisma + SQLite + shadcn/ui.** Project stack, non-negotiable.
- **No email provider.** Email deliverability is its own discipline (SPF, DKIM, DMARC, bounce handling). Out of scope for the box.
- **No customer accounts / SSO.** Same reason — auth provider integration is its own project.
- **z-ai-web-dev-sdk for the AI features.** Project skill, mandatory.
- **No mobile app.** The brief said two surfaces; a mobile app is a third surface. The web app is mobile-responsive via Tailwind, that's the mobile story.
