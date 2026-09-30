/**
 * Seed script.
 *
 * Run with: bun run src/lib/seed.ts
 *
 * Creates:
 *  - 1 staff demo user (email: agent@helpdesk.local / password: staff-demo-1234)
 *  - 1 admin staff user (email: admin@helpdesk.local / password: staff-admin-1234)
 *  - 3 sample tickets with messages, in different statuses and categories
 *
 * Idempotent: re-running won't duplicate.
 */

import { db } from '@/lib/db'
import { hashPassword } from '@/lib/auth'
import { generateTicketRef, generateLookupToken } from '@/lib/api'

async function main() {
  console.log('→ Seeding staff users…')
  const agentPassword = await hashPassword('staff-demo-1234')
  const adminPassword = await hashPassword('staff-admin-1234')

  const agent = await db.staffUser.upsert({
    where: { email: 'agent@helpdesk.local' },
    update: {},
    create: {
      email: 'agent@helpdesk.local',
      name: 'Demo Agent',
      passwordHash: agentPassword,
      role: 'agent',
    },
  })

  const admin = await db.staffUser.upsert({
    where: { email: 'admin@helpdesk.local' },
    update: {},
    create: {
      email: 'admin@helpdesk.local',
      name: 'Demo Admin',
      passwordHash: adminPassword,
      role: 'admin',
    },
  })

  console.log('→ Upserting customers…')
  const customers = [
    { email: 'jordan@example.com', name: 'Jordan Park' },
    { email: 'sam@example.com', name: 'Sam Rivera' },
    { email: 'casey@example.com', name: 'Casey Wu' },
  ]
  for (const c of customers) {
    await db.customer.upsert({
      where: { email: c.email },
      update: {},
      create: c,
    })
  }

  console.log('→ Creating sample tickets…')
  const sampleTickets = [
    {
      subject: 'Cannot export my dashboard as PDF',
      body: "I click Export → PDF and the spinner just spins forever. Tried Chrome and Firefox. This is the third time this week. My team has a board meeting Friday and I need the report.",
      status: 'open',
      priority: 'high',
      category: 'bug',
      customerEmail: 'jordan@example.com',
      customerName: 'Jordan Park',
      messages: [
        { authorRole: 'system', body: 'Ticket created by customer.' },
      ],
    },
    {
      subject: 'Question about the Team plan pricing',
      body: "Hi — we're a 9-person team and considering switching from a competitor. Do you offer annual billing with a discount, and is there an education/non-profit rate?",
      status: 'pending',
      priority: 'normal',
      category: 'billing',
      customerEmail: 'sam@example.com',
      customerName: 'Sam Rivera',
      messages: [
        { authorRole: 'system', body: 'Ticket created by customer.' },
        { authorRole: 'staff', staffId: agent.id, body: "Hi Sam — thanks for reaching out. We do offer annual billing at a 15% discount vs. monthly. Let me confirm the non-profit rate with our team and get back to you within one business day." },
        { authorRole: 'customer', body: 'Thanks — annual at 15% off sounds great. I will wait on the non-profit piece.' },
      ],
    },
    {
      subject: 'Add Jira integration please',
      body: "Our team lives in Jira. It would be incredible if I could push a Northwind report straight into a Jira ticket. Even a basic webhook would be a start.",
      status: 'resolved',
      priority: 'low',
      category: 'feature',
      customerEmail: 'casey@example.com',
      customerName: 'Casey Wu',
      messages: [
        { authorRole: 'system', body: 'Ticket created by customer.' },
        { authorRole: 'staff', staffId: admin.id, body: 'Hi Casey — great suggestion. We have a webhook on our roadmap for Q3. I will link your ticket to the feature request so you get notified when it ships. Closing this as resolved for now; we will reopen when there is a beta.' },
        { authorRole: 'customer', body: 'Perfect, thank you!' },
      ],
    },
  ]

  // Always (re)create these tickets so re-seeding gives a clean demo state.
  // In a real app we'd never delete customer data; here it's seed data.
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
        assigneeId: t.messages.some((m) => m.staffId) ? t.messages.find((m) => m.staffId)?.staffId : null,
        messages: {
          create: t.messages.map((m) => ({
            authorRole: m.authorRole,
            body: m.body,
            staffId: m.staffId ?? null,
          })),
        },
      },
    })
    console.log(`   • ${created.ref}  ${created.subject}  [${created.status}]`)
  }

  console.log('\n✅ Seed complete.')
  console.log('\nDemo accounts:')
  console.log('  Agent:  agent@helpdesk.local  /  staff-demo-1234')
  console.log('  Admin:  admin@helpdesk.local  /  staff-admin-1234')
  console.log('\n(Note: the seed script created demo tickets whose lookup tokens are')
  console.log(' written to the DB but not printed. Use the staff UI to view them.)')
}

main()
  .catch((e) => {
    console.error('Seed failed:', e)
    process.exit(1)
  })
  .finally(async () => {
    await db.$disconnect()
  })
