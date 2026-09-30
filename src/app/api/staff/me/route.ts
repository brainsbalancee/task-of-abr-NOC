/**
 * GET /api/staff/me
 *
 * Returns the currently authenticated staff user, or 401 if no session.
 * Used by the staff portal on mount to restore an existing session.
 */

import { NextRequest } from 'next/server'

import { json, getStaffFromRequest } from '@/lib/api'

export async function GET(req: NextRequest) {
  const ctx = await getStaffFromRequest(req)
  if (!ctx) {
    return json({ ok: false, error: 'Not authenticated' }, 401)
  }
  return json({
    ok: true,
    data: {
      id: ctx.id,
      email: ctx.email,
      name: ctx.name,
      role: ctx.role,
    },
  })
}
