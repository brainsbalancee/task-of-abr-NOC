/**
 * Input sanitization for the customer surface.
 *
 * The customer surface is open to anyone on the internet — they can type
 * whatever they like into it. The risks that actually matter here are:
 *
 *  1. Stored XSS — a customer submits a ticket whose body, when later
 *     rendered to a staff member, executes JS in the staff member's
 *     browser. Staff have privileged access, so this is the worst case.
 *  2. Format-string / template-injection against downstream consumers
 *     (e.g. the LLM, or future email/SMS gateways).
 *  3. Length bombs — a 10MB body that exhausts DB storage and slow-LMs.
 *  4. Control characters / homoglyphs that confuse audit logs.
 *
 * Strategy:
 *  - We never trust the client. Lengths are enforced server-side.
 *  - We store the body as plain text (no HTML), and the staff UI renders it
 *    as plain text via {`...`} not dangerouslySetInnerHTML. Defense in depth.
 *  - We strip control chars and null bytes; we collapse long runs of
 *    whitespace; we cap total length.
 *  - We do NOT try to "allow some HTML" — that path leads to sanitizer
 *    bypasses. Plain text is the safe default for a ticketing system.
 */

const MAX_SUBJECT = 200
const MAX_BODY = 10_000
const MAX_NAME = 100
const MAX_EMAIL = 254 // RFC 5321

export type SanitizedTicketInput = {
  subject: string
  body: string
  customerName: string | null
  customerEmail: string
}

export type ValidationError = {
  field: string
  message: string
}

// RFC 5322 simplified — good enough for input shape, real validation is the
// email's job of the receiving domain. We do NOT send emails in this build,
// so we only need to reject obviously-wrong shapes.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

// Allow letters, numbers, spaces, basic punctuation. Reject zero-width and
// control chars. This is intentionally permissive on content (we don't
// censor words) but strict on invisible characters.
const STRIP_RE = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F\u200B-\u200F\u2028\u2029\u202E]/g

function normalize(s: unknown, max: number): string {
  if (typeof s !== 'string') return ''
  return s
    .replace(STRIP_RE, '')
    .replace(/\r\n/g, '\n')
    .replace(/\s{4,}/g, '   ') // collapse 4+ whitespace to 3
    .slice(0, max)
    .trim()
}

export function validateTicketInput(raw: {
  subject?: unknown
  body?: unknown
  customerName?: unknown
  customerEmail?: unknown
}): { ok: true; data: SanitizedTicketInput } | { ok: false; errors: ValidationError[] } {
  const errors: ValidationError[] = []
  const subject = normalize(raw.subject, MAX_SUBJECT)
  const body = normalize(raw.body, MAX_BODY)
  const customerName = normalize(raw.customerName, MAX_NAME) || null
  const customerEmail = normalize(raw.customerEmail, MAX_EMAIL)

  if (!subject) errors.push({ field: 'subject', message: 'Subject is required.' })
  if (subject.length < 3) errors.push({ field: 'subject', message: 'Subject must be at least 3 characters.' })
  if (!body) errors.push({ field: 'body', message: 'Please describe your issue.' })
  if (body.length < 10) errors.push({ field: 'body', message: 'Please give us a bit more detail (at least 10 characters).' })
  if (!customerEmail) errors.push({ field: 'customerEmail', message: 'Email is required.' })
  if (customerEmail && !EMAIL_RE.test(customerEmail)) {
    errors.push({ field: 'customerEmail', message: 'That email address does not look right.' })
  }

  if (errors.length) return { ok: false, errors }

  return { ok: true, data: { subject, body, customerName, customerEmail } }
}

export function validateMessageBody(raw: unknown): { ok: true; body: string } | { ok: false; error: string } {
  const body = normalize(raw, MAX_BODY)
  if (!body) return { ok: false, error: 'Message cannot be empty.' }
  if (body.length < 1) return { ok: false, error: 'Message cannot be empty.' }
  return { ok: true, body }
}

/** Length constants exported so the UI can show counters. */
export const LIMITS = {
  MAX_SUBJECT,
  MAX_BODY,
  MAX_NAME,
  MAX_EMAIL,
} as const
