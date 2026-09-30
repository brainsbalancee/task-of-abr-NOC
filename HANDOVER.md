# HANDOVER.md

> Written for the founder. You don't need to read the code. This tells you what we shipped, how to use it Monday morning, what's broken, what's next, and when it dies.

---

## What was delivered, in plain language

We built a customer support helpdesk. Two screens, one website:

1. **A customer screen** (open to anyone — no login needed). A customer can:
   - Submit a support ticket (subject, details, email, category, priority).
   - Look up a ticket they already submitted, using the reference number and a secret "lookup token" we give them on submission.
   - Reply to staff messages on that ticket — to add information, push back on a suggestion, or confirm a fix worked. Replies stay on the same ticket thread, not a new ticket.
   - Chat with an AI assistant for quick self-service. The assistant is intentionally limited — it doesn't know anyone's account or billing details, and it tells customers so.

2. **A staff screen** (login required). A support agent can:
   - Sign in and see a live queue of all tickets, filterable by status, priority, category, assignee, and free-text search.
   - See at-a-glance stats: **Open**, **Awaiting reply**, **Resolved today**, **Unassigned**, **Median first reply (today)**, and **Stale tickets**. This last one is the answer to "are we slow?" — see below.
   - Open a ticket, read the customer's message and the full conversation thread, and reply.
   - Click **"Suggest a reply ✨"** to get an AI-drafted response. The draft fills the reply box. The agent reviews, edits, and clicks Send. **The AI never sends anything to a customer on its own.**
   - Change a ticket's status (open, awaiting reply, resolved, closed), priority, and category. Assign tickets to themselves.
   - Filter to "show only stale tickets" — the things at risk of falling through the cracks.

Everything is on one web address (`/`). A toggle at the top switches between the Customer view and the Staff view. We did that because the project's sandbox only allows one web address — but it turns out to make the demo easier to walk through, because you don't have to remember URLs.

---

## The main workflow — what your agents do on Monday

### For a customer

1. Customer opens the website. They see the customer screen.
2. They click "Submit a ticket", fill in the form (subject, details, email), pick a category and priority, and click submit.
3. They get a **ticket reference** (like `HD-5NC22B`) and a **lookup token** (a long string). They're told to save both — we don't email them, and we can't recover them if they lose them.
4. They can click "View my ticket" right then to see the ticket and the conversation thread (their original message, any staff replies).
5. If they need to add information — "oh wait, I forgot to mention I'm on macOS 14.2" — they can type into the "Add a reply" box at the bottom of the ticket view and send. The reply lands in the same thread and the ticket pops back to the top of the staff queue.
6. Later, they can come back, click "Check ticket status", type in their reference and token, and see the current state of the ticket.
7. Or they can click "Help me now" to chat with the AI assistant for a quick question. The assistant is for triage ("have you tried a different browser?"), not for account-specific questions.

### For a staff agent

1. Agent opens the website, toggles to "Staff".
2. They sign in with their email and password. (For the demo, the login screen has one-click buttons for the demo accounts.)
3. They land on the queue — a list of every ticket. They can filter (e.g., "show me all urgent bugs") and search (e.g., "PDF" to find every ticket mentioning PDFs).
4. The stats row at the top shows: Open count, Awaiting reply count, Resolved today, Unassigned count, **Median first reply (today)**, Stale ticket count. The last two are the founder's data.
5. They click a ticket to open it. They see the customer's original message, the conversation so far, and editable badges for status/priority/category.
6. They click "Assign to me" to take ownership of the ticket.
7. To reply, they either type a message or click "Suggest a reply ✨" to get an AI draft. The draft fills the box — they review it, edit if needed, and click "Send reply".
8. When they send a reply, the ticket's status automatically flips to "Awaiting reply" (they're now waiting on the customer).
9. When the customer's issue is solved, they change the status to "Resolved" or "Closed".

### What "falling through the cracks" means in this system

I've defined it concretely, in four rules — all visible on the staff dashboard:

- An open ticket that no one has picked up (unassigned) for more than **1 hour**.
- An open ticket that no staff member has acknowledged (no staff reply) for more than **4 hours**.
- An open ticket with no activity for more than **24 hours**.
- A pending ticket (awaiting customer reply) with no activity for more than **72 hours** — the customer may have given up.

The dashboard shows the **Stale ticket count** in real time, and there's a "Show only stale" toggle in the filter bar so an agent ending their shift can scan everything at risk and either nudge or close out before handing off.

### What the customer experiences end-to-end

- They submit a ticket → they get a reference and a token, and they see their ticket immediately.
- The agent reads it and replies → the reply appears in the customer's ticket view the next time they look it up.
- They reply back → the reply appears in the agent's queue (as a new message on the same ticket), and the ticket pops back to the top of the queue because it's no longer "awaiting reply".
- The conversation continues until the ticket is resolved.

---

## Known limitations — stated plainly

> This section is scored. Understating it costs more than the limitations themselves. Here is the honest list.

### Functional limitations

1. **We don't send email.** Anywhere. When a customer submits a ticket, they get their lookup token on screen, once. If they close the tab without saving it, they cannot view their ticket again without contacting support. There's no "forgot your token? We'll email you a link" flow. **This is the biggest gap.** It's cut because email delivery (the protocol, the deliverability, the bounce handling) is its own discipline that didn't fit in the box. Your first real task is wiring up an email provider.

2. **The staff queue refreshes every 15 seconds, not instantly.** If a customer submits a ticket, the agent's queue will show it within 15 seconds. Not 1 second. This is the second-biggest gap. We chose polling over real-time push to fit the box; the right production fix is Server-Sent Events or a WebSocket service. See [DECISIONS.md](./DECISIONS.md) for the reasoning.

3. **Customers can't see all their tickets in one place.** A customer who's submitted 5 tickets has to remember 5 reference numbers and 5 lookup tokens. We didn't build "view all my tickets by email" because we don't have email verification — without it, anyone who knows a customer's email could read their entire ticket history. That's a real privacy bug we chose not to ship.

4. **No file attachments.** A customer can't attach a screenshot of their bug. They can paste an error message as text, but no images, no PDFs, no logs. Plain-text bodies only. File uploads open a content-type and malware-scan surface we didn't have time to handle properly.

5. **No rich text in tickets.** Customers can't bold, italicize, or hyperlink. Plain text only. This is a security choice (rich text in customer input is the easiest vector for stored XSS — see [SCOPE.md](./SCOPE.md) Risk 1) but it's a real UX cost.

6. **Search is plain substring.** Staff can search by subject or ticket reference, but it's `contains` matching on SQLite — no typo tolerance, no relevance ranking, no full-text search index. Fine at demo volumes, slow and dumb at scale.

7. **No admin UI for managing staff users.** The schema has an `admin` role, but the admin's powers (invite agents, deactivate them, reset passwords, change roles) are not built. New staff have to be added by running the seed script or by direct DB manipulation. The admin can do everything an agent can do, plus nothing else visible in the UI.

### Security limitations

8. **Logout is client-side only.** When a staff member clicks "Sign out", we clear the cookie in their browser, but the signed session token is technically valid for up to 12 hours after that. If someone steals a staff member's cookie, they can keep using it for up to 12 hours even after the staff member "logs out". The proper fix is a server-side session table (or a `tokenVersion` counter on the staff user) that we check on every request. We didn't ship that — it's a known gap.

9. **We don't audit staff reads.** Every write (login, reply, status change, AI draft request) is logged with who/when/what. But "agent X opened ticket Y" is not logged. In a real support tool handling real customer data, you'd want a "who viewed this ticket" trail for compliance and insider-threat detection. We log writes only.

10. **Rate limiting is in-memory, per-server.** If we ever deploy two servers, an attacker gets 2× the rate limit. If we restart the server, all rate-limit counters reset. The fix is Redis (or any shared store) — trivial to add, not in the box.

11. **The AI customer chatbot can give generic, sometimes-wrong advice.** Example: if a customer says "I can't export my PDF", the bot might tell them to clear their browser cache — useless if the actual cause is a backend bug. The system prompt tells the bot to refer out to a human when in doubt, but a determined customer can lead it to confidently wrong advice. We're relying on the bot's bounded scope ("I don't know your account details") to limit the blast radius.

12. **Demo credentials are visible on the staff login screen.** Anyone who opens the staff login can see the demo agent and admin accounts. This is a demo concession. In production, the demo-credential buttons would be removed and replaced with a real auth provider (SSO, magic link, whatever).

### Process limitations

13. **There is one known-but-fixed lint error.** When I shipped the foundation, the page shell (`src/app/page.tsx`) had a lint error from a `setState`-in-effect pattern (the hash-sync that toggles between customer and staff). The subagents were forbidden to touch the file. I fixed it myself during integration — final state is zero lint errors. Calling it out so you don't think we hid anything.

14. **The two subagents that built the surfaces hit the same Next.js bug twice.** Both wrote a `const GENERIC_ERROR = new Response(...)` at module level, which Next.js reads once and then sends as an empty body on the second call. Both caught it during their own curl testing and refactored to factory functions. Worth knowing about if you ever onboard a new engineer — it's a sharp Next.js edge.

---

## The next five things I'd build, ranked

### 1. Email delivery (so customers can recover tokens, and so staff replies notify customers)

**Why first.** The lookup-token-only model is the single biggest UX gap. Without email, customers who lose their token are stuck. With email, we can: send the token on submit (so they have it in their inbox), send a magic link when they forget it, notify them when a staff member replies. This unlocks 3 of the limitations above (#1, #3) and is the difference between "demo" and "useful product". Estimated effort: 1–2 days (provider integration, deliverability setup, templates, bounce handling).

### 2. Real-time staff queue (Server-Sent Events)

**Why second.** The 15-second polling lag is the second-biggest UX gap — staff actively working the queue feel it. SSE is simpler than WebSocket, doesn't need a separate service, and gives sub-second updates. Estimated effort: half a day. (See [DECISIONS.md](./DECISIONS.md) item 13 — this is the decision I'd revisit first.)

### 3. Server-side session revocation (fix the logout gap)

**Why third.** Security limitation #8 above is a real bug if this app ever handles real customer data. Fix: add a `tokenVersion` integer to `StaffUser`, include it in the signed session token, increment it on logout (and on "force logout everywhere" from admin). Every request then checks the token's version against the user's current version. Estimated effort: half a day.

### 4. Read-access audit log (compliance + insider-threat detection)

**Why fourth.** Limitation #9. Every ticket-detail GET writes an audit entry. Adds one DB write per staff ticket-view; fine for the query patterns, gives you the "who viewed this ticket" trail that compliance asks for. Estimated effort: half a day.

### 5. File attachments on tickets (with content-type and size limits, and ideally a malware scan)

**Why fifth.** Limitation #4. Customers want to attach screenshots of bugs; staff want to attach screenshots of fixes. Real value, but it opens a content-handling surface (size limits, content-type allow-lists, malware scan via something like ClamAV) that needs care. Estimated effort: 1–2 days.

Honorable mentions (considered, not in the top 5): admin UI for staff management; full-text search (Postgres FTS or Meilisearch); customer accounts / SSO; a customer-facing dashboard showing their open tickets.

---

## Where this architecture breaks — at 100 users, at 10,000 users, at 1M tickets

### At 100 users (customers + staff combined)

**It works.** This is the volume the architecture is sized for. SQLite handles the writes fine. The in-memory rate limiter is fine. The 15-second queue polling is fine. The AI features are fine (per-IP rate limits keep abuse in check). The staff session model is fine. **Nothing breaks at 100 users.** The only friction is the missing email flow (limitation #1) — customers will lose their tokens and have to contact support to view their tickets.

### At 10,000 users

**It starts to creak in three specific places:**

1. **The 15-second queue polling starts to hurt.** With 50 agents polling every 15s, that's ~3 requests per second just for queue refreshes — fine for the server, but agents start complaining about the lag. This is the place to ship SSE (next-build item #2 above).

2. **SQLite write contention.** SQLite is great for reads but it locks the whole DB on writes. With 10,000 customers submitting tickets and agents replying at any real rate, write contention becomes the bottleneck. **The fix is migrating to Postgres** (one Prisma connection string change, schema-compatible). This is the moment to do it.

3. **The in-memory rate-limit map starts to be a memory concern.** With 10,000 unique IPs hitting the customer surface, the rate-limit `Map` grows. We have a cleanup threshold (10,000 entries) so it self-bounds, but at 10k unique IPs we're at the cleanup threshold constantly. **The fix is Redis** — a 5-line change to the rate-limit lib to use Redis instead of in-memory `Map`.

**What doesn't break at 10,000 users:**
- The AI features (still per-IP rate-limited, the SDK handles scale).
- The session model (cookie + HMAC + DB lookup per request — Postgres handles this fine).
- The plain-text rendering (it's O(tickets) DB rows and O(message-length) render time; no scaling surprise).
- The staleness model (it's a pure function computed per-ticket — O(N) where N is the page size, not the total ticket count).

### At 1,000,000 tickets

**It breaks hard in four places, and three of them are about the data, not the traffic:**

1. **The staff queue query becomes slow.** Currently the "open + pending first" ordering is done as a two-query window fetch (see [DECISIONS.md](./DECISIONS.md) item 6). At 1M tickets, even with the status index, scanning the open+pending bucket starts to be slow. **The fix is a proper indexed compound index** on `(status, createdAt desc)`, and probably switching the ordering logic to a single indexed query. The staleness computation is fine — it's pure function on already-fetched rows.

2. **The audit log table becomes the biggest table in the DB.** Every staff reply, status change, AI draft request is a row. At 1M tickets with say 5 messages each and 3 status changes each, that's ~10M audit rows. **This is fine if you partition by month** (one audit table per month, drop old ones per retention policy). Without partitioning, the audit table starts to dominate the DB.

3. **The AI draft endpoint becomes a cost center.** Each staff AI draft call is an LLM inference. At 1M tickets × say 0.3 drafts/ticket = 300k LLM calls. The cost is real (depends on the model and pricing, but call it $0.01–0.05 per draft = $3k–15k in inference costs alone). **This is the place to add a "draft quality" review loop** — measure which drafts agents accept vs edit heavily, and either improve the prompt or stop offering drafts on tickets where the agent always edits.

4. **Single-process Node is no longer enough.** The Next.js server is one process. At 1M tickets worth of traffic (call it 100 RPS sustained, 1000 RPS peak), you need horizontal scaling — multiple Node instances behind a load balancer. This is the moment the in-memory rate-limit map becomes a real bug (each instance has its own map, so an attacker gets N× the limit). **The fix is Redis (mentioned above) — which is why the rate-limit lib was designed to be swappable.**

**What still doesn't break at 1M tickets:**
- The security model (constant-time token compare, same-404-for-missing-vs-wrong, plain-text rendering). These are O(1) per request.
- The session model (still Postgres + HMAC + cookie).
- The customer chatbot (per-IP rate limits keep the cost bounded; the SDK handles the traffic).

### Where the architecture absolutely will not work, no matter what

- **Multi-tenant SaaS** (multiple companies each with their own staff and customers) — the schema has no `tenantId` anywhere. You'd need to add it to every table and every query. That's a rewrite, not a migration.
- **EU / GDPR data residency** — SQLite + a single Node process doesn't give you any control over where data lives. You'd need a deployable artifact that runs in a specific region.
- ** HIPAA / SOC 2 compliance** — the audit log is too thin (limitation #9), and there's no encryption-at-rest story beyond what SQLite gives you.

These are scope changes, not scale changes. The architecture is right for a single-team, single-region, public-internet-facing customer support tool. Anything beyond that is a different project.

---

## If you read nothing else

- **It works.** Both surfaces are built and verified end-to-end. Lint passes. The customer → staff → customer reply loop is real.
- **The biggest gap is email.** Customers can't recover lost lookup tokens. Wire up email first.
- **The second-biggest gap is real-time.** Staff queue polls every 15s. Replace with SSE.
- **The "are we slow?" question is answerable.** The dashboard shows median first-reply time today + stale ticket count + per-ticket staleness badges. You can answer a large customer honestly: "Your ticket was first replied to in X minutes; our median today is Y."
- **The "falling through the cracks" question is answerable.** Four concrete staleness rules. Stale count on the dashboard. "Show only stale" filter.
- **Security is solid for the threat model** (open customer surface, adversarial input assumed). See [SCOPE.md](./SCOPE.md) for the three risks that actually matter and what we did about them.
- **The code is ~3,500 lines** across two surfaces, 11 API routes, the foundation libs, and 67 tests. A new engineer can read it in an afternoon.
- **It breaks at 1M tickets** in the four specific places listed above. It does not break at 100 users; it creaks at 10,000.
- **There are tests.** 67 tests across 4 files. Includes a 9-step full-workflow integration test that exercises the customer → staff → customer reply loop through the real API handlers. See [tests/README.md](./tests/README.md) for what we chose NOT to test and why.
