/**
 * Shared helpers for API routes.
 *
 * - JSON responses with consistent error shape.
 * - Reading the staff session from the cookie and fetching the StaffUser.
 * - Writing audit log entries.
 */

import { db } from '@/lib/db'
import { verifySessionToken, SESSION } from '@/lib/auth'

export type ApiResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string; fields?: Record<string, string> }

export function json(res: ApiResult, status = 200, extraHeaders: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(res), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      ...extraHeaders,
    },
  })
}

export function rateLimitedResponse(resetAt: number): Response {
  const retryAfter = Math.max(1, Math.ceil((resetAt - Date.now()) / 1000))
  return json(
    { ok: false, error: 'Too many requests. Please slow down.' },
    429,
    { 'Retry-After': String(retryAfter) },
  )
}

export type StaffContext = {
  id: string
  email: string
  name: string
  role: string
}

/**
 * Read the staff session from the cookie. Returns null if not authenticated.
 * Use this to gate staff-only endpoints.
 */
export async function getStaffFromRequest(req: Request): Promise<StaffContext | null> {
  const cookie = req.headers.get('cookie') ?? ''
  const tokenMatch = cookie.match(new RegExp(`(?:^|;\\s*)${SESSION.COOKIE}=([^;]+)`))
  if (!tokenMatch) return null
  const staffId = verifySessionToken(tokenMatch[1])
  if (!staffId) return null
  const staff = await db.staffUser.findUnique({ where: { id: staffId } })
  if (!staff) return null
  return { id: staff.id, email: staff.email, name: staff.name, role: staff.role }
}

/**
 * Record an audit log entry. Never throws — audit failures must not break
 * the user flow, but they do get logged.
 */
export async function recordAudit(opts: {
  staffId: string
  action: string
  targetId?: string
  meta?: Record<string, unknown>
  ip?: string
}): Promise<void> {
  try {
    await db.auditLog.create({
      data: {
        staffId: opts.staffId,
        action: opts.action,
        targetId: opts.targetId ?? null,
        meta: opts.meta ? JSON.stringify(opts.meta) : null,
        ip: opts.ip ?? null,
      },
    })
  } catch (e) {
    console.error('[audit] failed to write log:', e)
  }
}

/**
 * Generate a public ticket reference like "HD-AB12CD".
 * Uses 6 alphanumeric chars from crypto.randomBytes — collision probability
 * at 36^6 = 2.2B is fine for the volumes we handle. We retry on collision.
 */
export async function generateTicketRef(): Promise<string> {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789' // no confusing chars
  for (let attempt = 0; attempt < 5; attempt++) {
    const bytes = new Uint8Array(6)
    crypto.getRandomValues(bytes)
    const code = Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
    const ref = `HD-${code}`
    const existing = await db.ticket.findUnique({ where: { ref }, select: { id: true } })
    if (!existing) return ref
  }
  throw new Error('Could not generate a unique ticket reference after 5 attempts')
}

/**
 * Generate an unguessable lookup token (43 chars of base64url entropy).
 * This is what the customer uses to view their ticket without an account.
 * The customer gets it ONCE on submission; we never email it in this build.
 */
export function generateLookupToken(): string {
  return crypto.randomUUID() + crypto.randomUUID().replace(/-/g, '')
}
