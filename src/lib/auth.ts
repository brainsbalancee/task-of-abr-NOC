/**
 * Staff authentication.
 *
 * Design decisions:
 *  - Cookie-based session (not JWT): a server-side session is harder to
 *    forge, easier to revoke, and the staff user count is small enough
 *    that we don't need stateless tokens. JWTs shine for distributed auth
 *    across many services; we have one service.
 *  - Signed session token = base64(staffId) + "." + HMAC(staffId).
 *    Tampering with staffId invalidates the HMAC. No DB lookup needed to
 *    validate; one DB lookup to fetch the staff record on each request.
 *  - Passwords hashed with Node's built-in scrypt (no native deps).
 *  - Constant-time comparison for both password and token verification.
 */

import crypto from 'node:crypto'

const SESSION_SECRET =
  process.env.SESSION_SECRET ||
  // Dev fallback only. The seed script will print a warning if this is used.
  'dev-only-fallback-secret-please-set-SESSION_SECRET-in-production'

const SESSION_COOKIE = 'helpdesk_staff_session'
const SESSION_TTL_MS = 1000 * 60 * 60 * 12 // 12 hours

function hmac(value: string): string {
  return crypto.createHmac('sha256', SESSION_SECRET).update(value).digest('base64url')
}

export function signSessionToken(staffId: string): string {
  const payload = Buffer.from(staffId).toString('base64url')
  return `${payload}.${hmac(staffId)}`
}

export function verifySessionToken(token: string | undefined | null): string | null {
  if (!token || typeof token !== 'string') return null
  const [payloadPart, sigPart] = token.split('.')
  if (!payloadPart || !sigPart) return null
  let staffId: string
  try {
    staffId = Buffer.from(payloadPart, 'base64url').toString('utf8')
  } catch {
    return null
  }
  const expected = hmac(staffId)
  // Constant-time compare.
  if (expected.length !== sigPart.length) return null
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sigPart))) return null
  return staffId
}

export function constantTimeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a)
  const bb = Buffer.from(b)
  if (ab.length !== bb.length) return false
  return crypto.timingSafeEqual(ab, bb)
}

export function hashPassword(password: string): string {
  // scrypt with random salt. Output format: scrypt$salt$hash
  const salt = crypto.randomBytes(16).toString('hex')
  const hash = crypto.scryptSync(password, salt, 64).toString('hex')
  return `scrypt$${salt}$${hash}`
}

export function verifyPassword(password: string, stored: string): boolean {
  const parts = stored.split('$')
  if (parts.length !== 3 || parts[0] !== 'scrypt') return false
  const salt = parts[1]
  const expected = parts[2]
  const actual = crypto.scryptSync(password, salt, 64).toString('hex')
  return constantTimeEqual(expected, actual)
}

export const SESSION = {
  COOKIE: SESSION_COOKIE,
  TTL_MS: SESSION_TTL_MS,
} as const

/**
 * Set the session cookie. HttpOnly + SameSite=Strict + (in prod) Secure.
 * Path=/ so logout clears it from any route.
 */
export function buildSessionCookieHeader(token: string, maxAgeMs = SESSION_TTL_MS): string {
  const attrs = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    `Max-Age=${Math.floor(maxAgeMs / 1000)}`,
  ]
  if (process.env.NODE_ENV === 'production') attrs.push('Secure')
  return attrs.join('; ')
}

export function buildExpiredSessionCookieHeader(): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
    'Max-Age=0',
    'Expires=Thu, 01 Jan 1970 00:00:00 GMT',
  ].join('; ')
}
