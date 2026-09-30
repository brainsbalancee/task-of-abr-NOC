/**
 * GET /api/staff/users
 *
 * Returns the list of active staff users (id, name, role) — used by the
 * "Reassign to..." dropdown in the ticket detail view so an agent can
 * hand a ticket off to a colleague at the end of a shift.
 *
 * Gated by `getStaffFromRequest`. Only the three fields the dropdown needs
 * are returned — never passwords or email addresses (the dropdown doesn't
 * need them, and minimising the response reduces blast radius if a token
 * leaks).
 *
 * Sorted by name for a stable dropdown.
 */

import { NextRequest } from 'next/server'

import { db } from '@/lib/db'
import { json, getStaffFromRequest } from '@/lib/api'

export async function GET(req: NextRequest) {
  const ctx = await getStaffFromRequest(req)
  if (!ctx) {
    return json({ ok: false, error: 'Not authenticated' }, 401)
  }

  const users = await db.staffUser.findMany({
    select: { id: true, name: true, role: true },
    orderBy: { name: 'asc' },
  })

  return json({
    ok: true,
    data: {
      users: users.map((u) => ({
        id: u.id,
        name: u.name,
        role: u.role as 'agent' | 'admin',
      })),
    },
  })
}
