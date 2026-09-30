/**
 * POST /api/staff/login
 *
 * Staff login. Sets a signed session cookie via Set-Cookie (HttpOnly,
 * SameSite=Strict, Secure in production).
 *
 * Hardening:
 *  - Rate limited per IP (10 / min) — strict to make brute-force impractical.
 *  - The same 401 "Wrong email or password" is returned whether the email
 *    is unknown OR the password is wrong. No way to enumerate staff emails.
 *  - `verifyPassword` (scrypt + constant-time compare) runs even when the
 *    email is unknown — we hash a dummy stored value to keep timing
 *    roughly constant. (scrypt isn't free; we don't try to fully mask
 *    the difference, but we don't early-return either.)
 *  - Audit log `auth.login` on success.
 */

import { NextRequest } from 'next/server'

import { db } from '@/lib/db'
import {
  json,
  rateLimitedResponse,
  recordAudit,
} from '@/lib/api'
import {
  hashPassword,
  signSessionToken,
  verifyPassword,
  buildSessionCookieHeader,
} from '@/lib/auth'
import {
  rateLimit,
  RATE_LIMITS,
  getClientIp,
  cleanupRateLimitMap,
} from '@/lib/rate-limit'

// Pre-compute a dummy hash so the unknown-user path still does a real
// scrypt compare and stays close to the known-user timing.
let dummyHashCache: string | null = null
async function dummyHash(): Promise<string> {
  if (dummyHashCache) return dummyHashCache
  dummyHashCache = hashPassword('dummy-password-for-timing-equality')
  return dummyHashCache
}

// Factory — build a fresh Response per call. We must NOT cache a
// single Response at module level, because Next.js reads the body
// stream once; reusing the same Response across requests would send
// an empty body after the first call. (Same trap the customer lookup
// route originally fell into — see agent-ctx/2-a-customer-surface.md.)
const genericError = () =>
  json({ ok: false, error: 'Wrong email or password' }, 401)

export async function POST(req: NextRequest) {
  // ---- Rate limit ------------------------------------------------------
  const ip = getClientIp(req)
  const rl = rateLimit(`ip:login:${ip}`, RATE_LIMITS.staffLogin)
  cleanupRateLimitMap()
  if (!rl.ok) return rateLimitedResponse(rl.resetAt)

  // ---- Parse body -----------------------------------------------------
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'Invalid request body.' }, 400)
  }
  if (!body || typeof body !== 'object') {
    return json({ ok: false, error: 'Invalid request body.' }, 400)
  }

  const emailRaw = (body as { email?: unknown }).email
  const passwordRaw = (body as { password?: unknown }).password
  if (typeof emailRaw !== 'string' || typeof passwordRaw !== 'string') {
    return json({ ok: false, error: 'Email and password are required.' }, 400)
  }
  const email = emailRaw.trim().toLowerCase()
  const password = passwordRaw
  if (!email || !password) {
    return json({ ok: false, error: 'Email and password are required.' }, 400)
  }

  // ---- Lookup user ----------------------------------------------------
  const staff = await db.staffUser.findUnique({ where: { email } })

  // Always do a password compare — for unknown users, compare against a
  // dummy hash so timing is roughly equivalent to the known-user path.
  const storedHash = staff?.passwordHash ?? (await dummyHash())
  const ok = verifyPassword(password, storedHash)

  if (!staff || !ok) {
    return genericError()
  }

  // ---- Success --------------------------------------------------------
  const token = signSessionToken(staff.id)
  const cookie = buildSessionCookieHeader(token)

  await recordAudit({
    staffId: staff.id,
    action: 'auth.login',
    ip,
  })

  return json(
    {
      ok: true,
      data: {
        id: staff.id,
        email: staff.email,
        name: staff.name,
        role: staff.role,
      },
    },
    200,
    { 'Set-Cookie': cookie },
  )
}
