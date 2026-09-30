# HelpDesk AI

A two-surface customer support helpdesk built as a take-home assignment. Customers can submit tickets, look them up later, and chat with an AI assistant for self-service. Staff sign in to a console to triage, reply, and get AI-suggested drafts.

The whole thing runs on a single `/` route. A header toggle switches between the **Customer** and **Staff** surfaces.

> Time-boxed to 6 hours. See [SCOPE.md](./SCOPE.md), [DECISIONS.md](./DECISIONS.md), [AI_USAGE.md](./AI_USAGE.md), and [HANDOVER.md](./HANDOVER.md) for the rationale, the limitations, and the founder-facing overview.

---

## Quick start

```bash
# 1. Install deps
bun install

# 2. Set up the local SQLite database
echo 'DATABASE_URL="file:./db/custom.db"' > .env
bun run db:push        # create schema
bun run db:generate    # generate Prisma client

# 3. Seed demo data (staff users + sample tickets)
bun run src/lib/seed.ts

# 4. Run the dev server
bun run dev
# → http://localhost:3000
```

The dev server prints to `dev.log` as well as stdout. If the page doesn't render, check `dev.log` first.

### Lint

```bash
bun run lint
```

---

## Demo accounts

The seed script creates two staff accounts and three sample tickets:

| Role  | Email                      | Password           |
| ----- | -------------------------- | ------------------- |
| Agent | `agent@helpdesk.local`     | `staff-demo-1234`   |
| Admin | `admin@helpdesk.local`     | `staff-admin-1234`  |

The staff login screen has one-click buttons that pre-fill these for you, so you don't have to retype them.

### How to use it as a customer

1. Open the app. You land on the Customer surface.
2. Click **Submit a ticket**. Fill in subject, details, email, optional name, category, priority. Submit.
3. You get a **ticket reference** (e.g. `HD-5NC22B`) and a **lookup token** (an 80-character unguessable string). Save both — we don't email them in this build, and we can't recover them if you lose them.
4. Click **View my ticket** to switch to the status tab and see your ticket, the conversation thread, and any staff replies.
5. Or click **Help me now** to chat with the AI assistant for quick self-service. The assistant doesn't know your account or billing details.

### How to use it as staff

1. Toggle to **Staff** in the header.
2. Sign in with one of the demo accounts (one-click buttons do this for you).
3. You land on the **queue** — a live list of tickets, filterable by status / priority / category / assignee / search. Stats row shows Open / Awaiting reply / Resolved today / Unassigned.
4. Click any ticket to open the **detail view**: customer's original message, full conversation thread, status/priority/category dropdowns, and an "Assign to me" button.
5. In the reply box, either type your reply or click **Suggest a reply ✨** to let the AI draft one. The draft fills the box — review, edit, and click **Send reply**. The draft is never sent automatically; staff always have the final word.
6. Sending a reply flips the ticket to "Awaiting reply" (pending) status — the staff member is now waiting on the customer.

---

## Architecture overview

```
src/
├── app/
│   ├── page.tsx                 # Shell. Hash-based toggle: #customer | #staff
│   ├── layout.tsx              # Root layout, fonts, toaster
│   ├── globals.css              # Tailwind + shadcn theme
│   └── api/
│       ├── tickets/
│       │   ├── route.ts         # POST  /api/tickets        — submit (public, rate-limited)
│       │   └── lookup/route.ts  # GET   /api/tickets/lookup — status view (public, rate-limited)
│       ├── chat/route.ts        # POST  /api/chat           — customer AI chatbot (public, rate-limited)
│       └── staff/
│           ├── login/route.ts   # POST  /api/staff/login    — staff login
│           ├── logout/route.ts  # POST  /api/staff/logout
│           ├── me/route.ts      # GET   /api/staff/me       — session check
│           └── tickets/
│               ├── route.ts                # GET /api/staff/tickets         — queue + stats
│               └── [id]/
│                   ├── route.ts            # GET/PATCH /api/staff/tickets/[id]
│                   ├── reply/route.ts      # POST /api/staff/tickets/[id]/reply
│                   └── draft/route.ts      # POST /api/staff/tickets/[id]/draft  — AI suggestion
├── components/
│   ├── customer/
│   │   ├── customer-portal.tsx  # 3-tab surface (Submit / Status / Help me now)
│   │   └── types.ts
│   ├── staff/
│   │   ├── staff-portal.tsx     # Login + queue + ticket detail + reply + AI draft
│   │   └── types.ts
│   └── ui/                      # shadcn primitives (already present)
└── lib/
    ├── db.ts                    # Prisma client singleton
    ├── auth.ts                  # scrypt hash, signed session token (HMAC), constant-time compare
    ├── rate-limit.ts            # In-memory token-bucket rate limiter (per-IP, per-bucket)
    ├── sanitize.ts              # Server-side input validation + control-char stripping
    ├── ai.ts                    # z-ai-web-dev-sdk wrapper (chatReply + draftStaffReply) — backend only
    ├── api.ts                   # Shared API helpers (json, getStaffFromRequest, recordAudit, generateTicketRef)
    └── seed.ts                  # Demo data seeder (idempotent)
```

### Data model

- **Customer** — keyed by email. Created on first ticket submission. No password — customers are unauthed.
- **Ticket** — subject, body (plain text), status, priority, category, customerEmail, assigneeId, plus:
  - `ref` — public-facing short reference like `HD-AB12CD` (6 chars from a 32-char alphabet, no ambiguous chars).
  - `lookupToken` — unguessable 80-char secret returned once on submission, required to view the ticket without an account. Equivalent to a magic link.
- **TicketMessage** — authorRole: `customer` | `staff` | `ai` | `system`. `aiDrafted` boolean tracks whether a staff reply was based on an AI draft (for quality review).
- **StaffUser** — email, scrypt-hashed password, role (`agent` | `admin`).
- **AuditLog** — append-only log of staff actions (auth, reply, status changes, AI draft requests). Stores action + lengths + field-change names only — never body text.

### Security posture (summary — see [SCOPE.md](./SCOPE.md) for the full analysis)

- **Customer surface is the threat model.** Anyone on the internet can type into it. We assume adversarial input on every endpoint.
- **Stored XSS is the worst-case attack** (customer input rendered into a privileged staff browser). We mitigate by storing and rendering all customer input as plain text — zero `dangerouslySetInnerHTML` on either surface. React's default escaping is the second layer.
- **Ticket enumeration** is closed by returning the same 404 response for "no such ref" and "wrong token", plus constant-time token comparison and per-IP rate limits.
- **AI prompt-injection** on the customer chatbot is mitigated by dropping client-supplied `system` messages server-side, hardcoding the system prompt in the backend, and instructing the model not to reveal instructions or make promises.
- **Rate limiting** is in-memory token-bucket, per-IP, per-bucket. Stricter budgets on the expensive/abuse-prone endpoints (ticket submit, AI chat, login, ticket lookup, AI draft).

---

## What's NOT here (on purpose — see [SCOPE.md](./SCOPE.md))

- Email notifications (the lookup token is shown once on submit; we don't email it in this build).
- Customer accounts / SSO.
- Real-time WebSocket push (staff queue polls every 15s).
- File attachments.
- A full-text search index (search is substring `contains` on SQLite).
- Rate limiting backed by Redis (in-memory only — fine for single-process, see HANDOVER.md for scale notes).
- A read-access audit log for staff (we log writes only — see HANDOVER.md limitations).

---

## Tech stack

- **Framework**: Next.js 16 (App Router, Turbopack)
- **Language**: TypeScript 5
- **Styling**: Tailwind CSS 4 + shadcn/ui (New York style)
- **DB**: Prisma ORM + SQLite
- **AI**: z-ai-web-dev-sdk (LLM chat completions; backend only)
- **Forms**: react-hook-form + zod
- **Toasts**: sonner
- **Icons**: lucide-react
- **Verification**: agent-browser for end-to-end UI testing
