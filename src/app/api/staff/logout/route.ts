/**
 * POST /api/staff/logout
 *
 * Idempotent logout — clears the session cookie. Safe to call when not
 * authed (e.g. expired session, double-click). Writes an audit log only
 * if there is an actual staff context to attribute the action to.
 */

import { NextRequest } from 'next/server'

import { json, getStaffFromRequest, recordAudit } from '@/lib/api'
import { buildExpiredSessionCookieHeader } from '@/lib/auth'
import { getClientIp } from '@/lib/rate-limit'

export async function POST(req: NextRequest) {
  const ctx = await getStaffFromRequest(req)
  if (ctx) {
    await recordAudit({
      staffId: ctx.id,
      action: 'auth.logout',
      ip: getClientIp(req),
    })
  }
  // Always return ok, regardless of whether there was a session —
  // logout is idempotent and we don't want to leak auth state to a
  // caller who is probing.
  return json({ ok: true }, 200, {
    'Set-Cookie': buildExpiredSessionCookieHeader(),
  })
}
