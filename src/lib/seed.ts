/**
 * Seed script — expanded for realistic B2B SaaS demo data.
 *
 * Run with: bun run src/lib/seed.ts
 *
 * The company per the brief: a B2B SaaS with ~60 paying customers on plans
 * ranging from small to substantial, 2 support agents + the founder covering
 * evenings. The seed reflects that — varied customer domains (so it looks
 * like 60 different companies, not 60 people @example.com), realistic B2B
 * subject lines ("Bug: Dashboard export to PDF spins forever on Chrome 121",
 * not "test ticket 2"), and tickets at every stage of the lifecycle so the
 * staff queue actually demonstrates the dashboard cards:
 *
 *   - 4 open   (10min / 2h / 6h / 28h old — the 28h one is stale)
 *   - 3 pending (one stale at 80h by the pending-inactive-72h rule)
 *   - 3 resolved (2 today, 1 last week)
 *   - 2 closed  (older, fully done)
 *
 * Categories spread: 3 billing, 3 bug, 2 account, 2 feature, 2 general.
 * Priorities spread: 1 urgent (a billing issue for a substantial customer),
 * 3 high, 6 normal, 2 low.
 *
 * Idempotency: re-running this script wipes the ticket/customer/message/
 * audit-log tables and recreates them. The two staff demo users are
 * upserted (NOT deleted) so their cuids stay stable across re-seeds —
 * important because the staff session cookie is signed against the
 * staffUser.id, and re-creating the staff rows would invalidate every
 * outstanding staff session in the demo.
 *
 * NOTE: delete-all-then-recreate is acceptable for SEED data (this is a
 * demo DB the reviewer re-seeds at will). It is NEVER acceptable in
 * production — production seed scripts use upserts keyed on a natural key
 * (e.g. email), never destructive deletes. We make the destructive choice
 * here only because the alternative (upserting 12 tickets by some natural
 * key) would require inventing stable refs that the staff UI doesn't expose,
 * and the demo would drift from the spec on every re-run.
 *
 * Demo staff accounts (re-created on every run):
 *   Agent:  agent@helpdesk.local  /  staff-demo-1234
 *   Admin:  admin@helpdesk.local  /  staff-admin-1234
 */

import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { generateTicketRef, generateLookupToken } from '@/lib/api'

// ---- Time helpers ------------------------------------------------------
//
// The staleness rules in src/lib/sla.ts care about ABSOLUTE ages
// (1h, 4h, 24h, 72h), so we anchor each ticket at an explicit offset
// from `now` rather than relying on `default(now())`. That way the
// 28h-old ticket actually triggers the open-inactive-24h rule and the
// 80h-old pending one actually triggers the pending-inactive-72h rule,
// every time the reviewer re-seeds.
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR

function hoursAgo(h: number): Date {
  return new Date(Date.now() - h * HOUR)
}
function daysAgo(d: number): Date {
  return new Date(Date.now() - d * DAY)
}

// ---- Seed ---------------------------------------------------------------

async function main() {
  console.log('→ Seeding staff users (upserted — stable ids across re-seeds)…')
  const agentPassword = await hashPassword('staff-demo-1234')
  const adminPassword = await hashPassword('staff-admin-1234')

  const agent = await db.staffUser.upsert({
    where: { email: 'agent@helpdesk.local' },
    update: {
      // Refresh the password hash too, so a previous run with a different
      // SESSION_SECRET (which doesn't actually affect scrypt, but cheap
      // insurance) doesn't lock the reviewer out.
      passwordHash: agentPassword,
      name: 'Rhys Coleman',
      role: 'agent',
    },
    create: {
      email: 'agent@helpdesk.local',
      name: 'Rhys Coleman',
      passwordHash: agentPassword,
      role: 'agent',
    },
  })

  const admin = await db.staffUser.upsert({
    where: { email: 'admin@helpdesk.local' },
    update: {
      passwordHash: adminPassword,
      name: 'Mira Chen',
      role: 'admin',
    },
    create: {
      email: 'admin@helpdesk.local',
      name: 'Mira Chen',
      passwordHash: adminPassword,
      role: 'admin',
    },
  })

  // ---- Wipe ticket / customer / message / audit tables ----------------
  // Destructive but safe for seed data — see the file header note.
  console.log('→ Wiping ticket / customer / message / audit tables…')
  await db.auditLog.deleteMany({})
  await db.ticketMessage.deleteMany({})
  await db.ticket.deleteMany({})
  await db.customer.deleteMany({})

  // ---- Upsert customers ------------------------------------------------
  // 6 distinct B2B contacts across 5 different company domains — looks
  // like the kind of customer list a 60-customer SaaS would have. A
  // couple of customers have multiple tickets so the staff detail view's
  // "customer history" panel has something to show.
  console.log('→ Upserting customers…')
  const customers = [
    { email: 'priya@acme-corp.com', name: 'Priya Shankar' },
    { email: 'casey@brightpath.io', name: 'Casey Wu' },
    { email: 'marcus@brightpath.io', name: 'Marcus Webb' },
    { email: 'diego@summit-analytics.co', name: 'Diego Santos' },
    { email: 'elena@northvolt-energy.com', name: 'Elena Petrova' },
    { email: 'sam@orbital-labs.io', name: 'Sam Rivera' },
    { email: 'tobias@meridian-health.io', name: 'Tobias Klein' },
    { email: 'jordan@meridian-health.io', name: 'Jordan Park' },
  ]
  for (const c of customers) {
    await db.customer.upsert({
      where: { email: c.email },
      update: { name: c.name },
      create: c,
    })
  }

  // ---- 12 sample tickets ----------------------------------------------
  //
  // Spread:
  //   status     count  ages
  //   open           4  10min / 2h / 6h / 28h
  //   pending       3  2h / 18h / 80h (stale)
  //   resolved      3  4h / 6h / 10d
  //   closed        2  20d / 35d
  //
  //   category  count
  //   billing      3  (tickets 5, 6, 11)
  //   bug          3  (tickets 1, 4, 8)
  //   account      2  (tickets 7, 12)
  //   feature      2  (tickets 2, 9)
  //   general      2  (tickets 3, 10)
  //
  //   priority  count
  //   urgent      1  (ticket 5 — billing issue for a substantial customer)
  //   high        3  (tickets 1, 4, 7)
  //   normal      6  (tickets 2, 6, 8, 9, 11, 12)
  //   low         2  (tickets 3, 10)
  //
  // Unassigned open: 4 of 4 open tickets. The "Unassigned" stat card on
  // the staff queue shows a real number, and the "stale only" filter has
  // content (the 2h, 6h, and 28h open tickets all match rule 1 —
  // unassigned > 1h).
  console.log('→ Creating 12 sample tickets…')

  type SeedMessage = {
    authorRole: string
    body: string
    staffId?: string | null
    createdAt: Date
  }
  type SeedTicket = {
    subject: string
    body: string
    status: string
    priority: string
    category: string
    customerEmail: string
    customerName: string
    assigneeId: string | null
    createdAt: Date
    updatedAt: Date
    messages: SeedMessage[]
  }

  const sampleTickets: SeedTicket[] = [
    // === OPEN (4) ========================================================
    // 1. Fresh bug report, unassigned, NOT stale (age 10min < 1h).
    {
      subject: 'Bug: Dashboard export to PDF spins forever on Chrome 121',
      body:
        "I click Export then PDF and the spinner just spins forever. Tried Chrome 121 and Firefox. This is the third time this week. My team has a board meeting Friday and I need the report.",
      status: 'open',
      priority: 'high',
      category: 'bug',
      customerEmail: 'priya@acme-corp.com',
      customerName: 'Priya Shankar',
      assigneeId: null,
      createdAt: hoursAgo(10 / 60),
      updatedAt: hoursAgo(10 / 60),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: hoursAgo(10 / 60),
        },
      ],
    },
    // 2. Feature request, unassigned, STALE by rule 1 (unassigned > 1h).
    {
      subject:
        'Feature request: Jira integration - push Northwind reports as Jira tickets',
      body:
        "Our team lives in Jira. It would be incredible if I could push a Northwind report straight into a Jira ticket. Even a basic webhook would be a start. We currently export to CSV and manually import, which is error-prone and nobody on the team enjoys doing it.",
      status: 'open',
      priority: 'normal',
      category: 'feature',
      customerEmail: 'casey@brightpath.io',
      customerName: 'Casey Wu',
      assigneeId: null,
      createdAt: hoursAgo(2),
      updatedAt: hoursAgo(2),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: hoursAgo(2),
        },
      ],
    },
    // 3. How-to question, unassigned, STALE by rule 1.
    {
      subject: 'How do I add a new admin user to our workspace?',
      body:
        "I am the workspace owner but I cannot find the option to add a new admin. The docs say there should be an 'Admins' section under Settings, but mine only shows 'Members'. Has the UI changed recently? I have checked the changelog but don't see anything about it.",
      status: 'open',
      priority: 'low',
      category: 'general',
      customerEmail: 'marcus@brightpath.io',
      customerName: 'Marcus Webb',
      assigneeId: null,
      createdAt: hoursAgo(6),
      updatedAt: hoursAgo(6),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: hoursAgo(6),
        },
      ],
    },
    // 4. Webhook bug, unassigned, STALE by rule 1 (rule 3 also matches
    //    since inactive > 24h, but rule 1 fires first by the priority
    //    order documented in src/lib/sla.ts). The realistic case: a
    //    ticket no one has picked up in 28h is stale because no one
    //    picked it up — that's the most actionable signal.
    {
      subject: 'Bug: webhook deliveries failing silently for our account since 2 days',
      body:
        "We rely on your webhooks to trigger our billing pipeline. Since Tuesday they have been failing silently - the delivery dashboard shows 200 OK responses but our endpoint never receives them. This is causing downstream billing errors for our customers. We have checked our endpoint and it is up. Please investigate urgently.",
      status: 'open',
      priority: 'high',
      category: 'bug',
      customerEmail: 'diego@summit-analytics.co',
      customerName: 'Diego Santos',
      assigneeId: null,
      createdAt: hoursAgo(28),
      updatedAt: hoursAgo(28),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: hoursAgo(28),
        },
      ],
    },

    // === PENDING (3) =====================================================
    // Pending = staff replied, awaiting customer. Each ends with a STAFF
    // message (which is what flipped the status to pending).

    // 5. Urgent production-down billing issue for a substantial customer.
    //    Staff replied 1h ago, customer hasn't yet — pending, NOT stale
    //    (inactive 1h < 72h).
    {
      subject: 'Urgent: production down - API returning 502s for our entire account',
      body:
        "All our production services are throwing 502s from your API as of 9am EST. We are a large account (Northvolt Energy, on the Enterprise plan) and this is causing customer-visible outages on our side. Please page someone immediately.",
      status: 'pending',
      priority: 'urgent',
      category: 'billing',
      customerEmail: 'elena@northvolt-energy.com',
      customerName: 'Elena Petrova',
      assigneeId: agent.id,
      createdAt: hoursAgo(2),
      updatedAt: hoursAgo(1),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: hoursAgo(2),
        },
        {
          authorRole: 'staff',
          staffId: agent.id,
          body:
            "Hi Elena - Rhys from support. I can see the 502s in our edge logs starting 09:02 EST. We have identified a failing API gateway and the on-call engineer is rolling back now. I will update you here within 15 minutes. If you need to reach me directly I am at agent@helpdesk.local.",
          createdAt: hoursAgo(1),
        },
      ],
    },
    // 6. Renewal / pricing question, staff answered 79h ago, customer
    //    never replied. STALE by rule 4 (pending inactive > 72h).
    {
      subject: 'Renewal question: any discount for annual prepay on the Team plan?',
      body:
        "Hi - we are a 9-person team and considering switching from a competitor. Do you offer annual billing with a discount, and is there an education/non-profit rate? Our renewal is coming up on the 15th and we want to make a decision before then.",
      status: 'pending',
      priority: 'normal',
      category: 'billing',
      customerEmail: 'sam@orbital-labs.io',
      customerName: 'Sam Rivera',
      assigneeId: agent.id,
      createdAt: hoursAgo(80),
      updatedAt: hoursAgo(79),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: hoursAgo(80),
        },
        {
          authorRole: 'staff',
          staffId: agent.id,
          body:
            "Hi Sam - thanks for reaching out. We do offer annual billing at a 15% discount vs. monthly. For non-profit and education we have a separate 30% off rate - drop a note to billing@helpdesk.local with your org's documentation and we will apply it. Let me know if you have any other questions before the 15th!",
          createdAt: hoursAgo(79),
        },
      ],
    },
    // 7. SSO breakage, high priority. Staff replied 17h ago, customer
    //    hasn't yet — pending, NOT stale (inactive 17h < 72h).
    {
      subject: 'Account: cannot SSO with our Okta instance since this morning',
      body:
        "Our Okta SSO has been working for months but stopped this morning at 8am. Users get an error: 'SAML response signature validation failed'. Nothing changed on our side - we have not rotated any certificates. We have 80 users locked out of their dashboards. This is high-impact for us.",
      status: 'pending',
      priority: 'high',
      category: 'account',
      customerEmail: 'tobias@meridian-health.io',
      customerName: 'Tobias Klein',
      assigneeId: admin.id,
      createdAt: hoursAgo(18),
      updatedAt: hoursAgo(17),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: hoursAgo(18),
        },
        {
          authorRole: 'staff',
          staffId: admin.id,
          body:
            "Hi Tobias - Mira from support. We rolled out a certificate rotation on our SP metadata last night. The fingerprint changed and Okta is still pinning the old one. I am rolling back the rotation now and will re-coordinate with your IT team for a planned re-cut. Apologies for the early-morning disruption - I will update here within 30 minutes.",
          createdAt: hoursAgo(17),
        },
      ],
    },

    // === RESOLVED (3) ====================================================
    // Each ends with a customer 'thanks' followed by a system 'resolved'
    // message. Two resolved today, one resolved last week.

    // 8. Resolved today - off-by-one pagination bug.
    {
      subject: 'Bug: CSV export missing the last row when total = 100',
      body:
        "When I export exactly 100 rows of any report, the last row is missing from the CSV. 99 rows works fine. 101 rows works fine. Reproduced in Chrome 121 and Firefox. Reports < 100 rows seem unaffected. This is breaking our weekly finance reconciliation.",
      status: 'resolved',
      priority: 'normal',
      category: 'bug',
      customerEmail: 'jordan@meridian-health.io',
      customerName: 'Jordan Park',
      assigneeId: agent.id,
      createdAt: hoursAgo(4),
      updatedAt: hoursAgo(0.5),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: hoursAgo(4),
        },
        {
          authorRole: 'staff',
          staffId: agent.id,
          body:
            "Hi Jordan - reproduced. Off-by-one in our pagination boundary - when the page size divides the total exactly, we drop the trailing empty page that should still contain the last row. Hotfix going out now, will update once it's live.",
          createdAt: hoursAgo(3),
        },
        {
          authorRole: 'customer',
          body:
            "Thanks - just confirmed the export now includes row 100. Appreciate the quick turnaround.",
          createdAt: hoursAgo(1),
        },
        {
          authorRole: 'system',
          body: 'Ticket marked as resolved.',
          createdAt: hoursAgo(0.5),
        },
      ],
    },
    // 9. Resolved today - feature request, linked to roadmap.
    {
      subject: 'Add Jira integration please',
      body:
        "Our team lives in Jira. It would be incredible if I could push a Northwind report straight into a Jira ticket. Even a basic webhook would be a start. We currently export to CSV and manually import, which is error-prone and nobody on the team enjoys doing it.",
      status: 'resolved',
      priority: 'normal',
      category: 'feature',
      customerEmail: 'casey@brightpath.io',
      customerName: 'Casey Wu',
      assigneeId: admin.id,
      createdAt: hoursAgo(6),
      updatedAt: hoursAgo(1),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: hoursAgo(6),
        },
        {
          authorRole: 'staff',
          staffId: admin.id,
          body:
            "Hi Casey - great suggestion, and the third request this month so it's clearly a real gap. We have a Jira webhook on our roadmap for Q3. I have linked your ticket to the feature request internally so you will get a notification when there is a beta to try. Closing this as resolved for now; we will reopen when there is a beta.",
          createdAt: hoursAgo(5),
        },
        {
          authorRole: 'customer',
          body:
            "Perfect, thank you! Looking forward to the beta.",
          createdAt: hoursAgo(2),
        },
        {
          authorRole: 'system',
          body: 'Ticket marked as resolved.',
          createdAt: hoursAgo(1),
        },
      ],
    },
    // 10. Resolved last week - how-to question with a UI change answer.
    {
      subject: 'How do I add a new admin user to our workspace?',
      body:
        "I am the workspace owner but I cannot find the option to add a new admin. The docs say there should be an 'Admins' section under Settings, but mine only shows 'Members'. Has the UI changed recently?",
      status: 'resolved',
      priority: 'low',
      category: 'general',
      customerEmail: 'priya@acme-corp.com',
      customerName: 'Priya Shankar',
      assigneeId: agent.id,
      createdAt: daysAgo(10),
      updatedAt: daysAgo(9),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: daysAgo(10),
        },
        {
          authorRole: 'staff',
          staffId: agent.id,
          body:
            "Hi Priya - yes, the UI was renamed in v3.2 (released two weeks ago). Admins are now managed under Settings > Members, then click the role dropdown next to the user you want to promote. I have updated the docs to reflect this - the docs site should refresh within the hour.",
          createdAt: daysAgo(9.5),
        },
        {
          authorRole: 'customer',
          body: 'Found it, thank you! Maybe pin this to the release notes for other workspace owners.',
          createdAt: daysAgo(9),
        },
        {
          authorRole: 'system',
          body: 'Ticket marked as resolved.',
          createdAt: daysAgo(9),
        },
      ],
    },

    // === CLOSED (2) ======================================================
    // Closed = resolved + auto-closed after a period of inactivity.
    // (The system doesn't actually auto-close in this build; we seed them
    // as already-closed to populate the queue's Closed filter.)

    // 11. Closed - billing card-update from a few weeks back.
    {
      subject: 'Billing: need to update our payment method before renewal on Oct 15',
      body:
        "Our company credit card expired. We need to update the payment method before our renewal on Oct 15 to avoid service interruption. Where do I do this? The billing section in settings doesn't seem to have a 'change card' option.",
      status: 'closed',
      priority: 'normal',
      category: 'billing',
      customerEmail: 'marcus@brightpath.io',
      customerName: 'Marcus Webb',
      assigneeId: admin.id,
      createdAt: daysAgo(20),
      updatedAt: daysAgo(10),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: daysAgo(20),
        },
        {
          authorRole: 'staff',
          staffId: admin.id,
          body:
            "Hi Marcus - the card-update form is under Settings > Billing > Payment method. Click 'Replace card' and the new card will be charged on the next renewal. Let me know if you run into any issues.",
          createdAt: daysAgo(19),
        },
        {
          authorRole: 'customer',
          body: 'Done, thank you. Confirmed the new card is on file.',
          createdAt: daysAgo(18),
        },
        {
          authorRole: 'system',
          body: 'Ticket marked as resolved.',
          createdAt: daysAgo(17),
        },
        {
          authorRole: 'system',
          body: 'Ticket auto-closed after 7 days of inactivity.',
          createdAt: daysAgo(10),
        },
      ],
    },
    // 12. Closed - old pricing question (same customer as ticket 6, so
    //     the staff detail view's customer-history panel has cross-ticket
    //     context to show).
    {
      subject: 'Question about the Team plan pricing',
      body:
        "We are a 9-person team and considering switching from a competitor. Do you offer annual billing with a discount, and is there an education rate?",
      status: 'closed',
      priority: 'normal',
      category: 'account',
      customerEmail: 'sam@orbital-labs.io',
      customerName: 'Sam Rivera',
      assigneeId: agent.id,
      createdAt: daysAgo(35),
      updatedAt: daysAgo(25),
      messages: [
        {
          authorRole: 'system',
          body: 'Ticket created by customer.',
          createdAt: daysAgo(35),
        },
        {
          authorRole: 'staff',
          staffId: agent.id,
          body:
            "Hi - yes, we offer annual billing at 15% off the monthly rate. For education there is a separate 30% discount; just email billing@helpdesk.local with your .edu domain proof and we will apply it to your account. Happy to walk you through the comparison if useful.",
          createdAt: daysAgo(34),
        },
        {
          authorRole: 'customer',
          body: 'Great, thank you. We will discuss internally and get back to you.',
          createdAt: daysAgo(33),
        },
        {
          authorRole: 'system',
          body: 'Ticket marked as resolved.',
          createdAt: daysAgo(32),
        },
        {
          authorRole: 'system',
          body: 'Ticket auto-closed after 7 days of inactivity.',
          createdAt: daysAgo(25),
        },
      ],
    },
  ]

  for (const t of sampleTickets) {
    const ref = await generateTicketRef()
    const lookupToken = generateLookupToken()
    const created = await db.ticket.create({
      data: {
        ref,
        lookupToken,
        subject: t.subject,
        body: t.body,
        status: t.status,
        priority: t.priority,
        category: t.category,
        customerEmail: t.customerEmail,
        customerName: t.customerName,
        assigneeId: t.assigneeId,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
        messages: {
          create: t.messages.map((m) => ({
            authorRole: m.authorRole,
            body: m.body,
            staffId: m.staffId ?? null,
            createdAt: m.createdAt,
          })),
        },
      },
    })
    console.log(
      `   - ${created.ref}  [${created.status.padEnd(8)} ${created.priority.padEnd(6)} ${created.category.padEnd(8)}]  ${created.subject}`,
    )
  }

  console.log('\n✅ Seed complete. 12 tickets, 8 customers, 2 staff users.')
  console.log('\nDemo staff accounts:')
  console.log('  Agent:  agent@helpdesk.local  /  staff-demo-1234  (Rhys Coleman)')
  console.log('  Admin:  admin@helpdesk.local  /  staff-admin-1234  (Mira Chen)')
  console.log('\nNote: the seed script created demo tickets whose lookup tokens are')
  console.log('written to the DB but not printed. Use the staff UI to view them.')
}

main()
  .catch((e) => {
    console.error('Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
