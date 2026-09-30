/**
 * Unit tests for the pure input-sanitization helpers in `src/lib/sanitize.ts`.
 *
 * The customer surface is open to anyone on the internet, so these validators
 * are the load-bearing wall against stored-XSS, length bombs, and invisible-
 * character tricks. Pure functions → fast deterministic tests with no DB.
 *
 * Run: `bun test`
 */

import { describe, it, expect } from 'bun:test'
import {
  validateTicketInput,
  validateMessageBody,
  LIMITS,
} from '@/lib/sanitize'

describe('validateTicketInput — rejection cases', () => {
  it('rejects empty subject', () => {
    const r = validateTicketInput({
      subject: '',
      body: 'This is a long enough body to pass.',
      customerEmail: 'a@b.com',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const fields = r.errors.map((e) => e.field)
      expect(fields).toContain('subject')
    }
  })

  it('rejects empty body', () => {
    const r = validateTicketInput({
      subject: 'A valid subject',
      body: '',
      customerEmail: 'a@b.com',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.map((e) => e.field)).toContain('body')
    }
  })

  it('rejects short body (< 10 chars)', () => {
    const r = validateTicketInput({
      subject: 'A valid subject',
      body: 'short', // 5 chars
      customerEmail: 'a@b.com',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.map((e) => e.field)).toContain('body')
    }
  })

  it('rejects invalid email (no @)', () => {
    const r = validateTicketInput({
      subject: 'A valid subject',
      body: 'This is a long enough body to pass.',
      customerEmail: 'not-an-email',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      expect(r.errors.map((e) => e.field)).toContain('customerEmail')
    }
  })

  it('rejects invalid email (no dot in domain)', () => {
    const r = validateTicketInput({
      subject: 'A valid subject',
      body: 'This is a long enough body to pass.',
      customerEmail: 'a@b',
    })
    expect(r.ok).toBe(false)
  })

  it('collects MULTIPLE errors at once (not just the first)', () => {
    const r = validateTicketInput({
      subject: '',
      body: '',
      customerEmail: 'bad',
    })
    expect(r.ok).toBe(false)
    if (!r.ok) {
      const fields = r.errors.map((e) => e.field)
      expect(fields).toContain('subject')
      expect(fields).toContain('body')
      expect(fields).toContain('customerEmail')
    }
  })
})

describe('validateTicketInput — success + transformation', () => {
  it('returns ok:true with sanitised data for valid input', () => {
    const r = validateTicketInput({
      subject: 'Cannot export dashboard to PDF',
      body: 'I click export and the spinner spins forever.',
      customerEmail: 'priya@acme-corp.com',
      customerName: 'Priya Shankar',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.subject).toBe('Cannot export dashboard to PDF')
      expect(r.data.body).toBe('I click export and the spinner spins forever.')
      expect(r.data.customerEmail).toBe('priya@acme-corp.com')
      expect(r.data.customerName).toBe('Priya Shankar')
    }
  })

  it('strips zero-width characters from subject + body', () => {
    // U+200B (zero-width space), U+200E (LRM mark)
    const r = validateTicketInput({
      subject: 'Hi\u200Bthere', // zero-width space injected
      body: 'This is a long enough body\u200E.',
      customerEmail: 'a@b.com',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.subject).toBe('Hithere')
      expect(r.data.body).toBe('This is a long enough body.')
    }
  })

  it('strips null bytes from body', () => {
    const r = validateTicketInput({
      subject: 'A valid subject',
      body: 'Hello\u0000 world this is long enough.',
      customerEmail: 'a@b.com',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.body).toBe('Hello world this is long enough.')
    }
  })

  it('enforces subject length cap (truncates to MAX_SUBJECT)', () => {
    const tooLong = 'x'.repeat(LIMITS.MAX_SUBJECT + 50)
    const r = validateTicketInput({
      subject: tooLong,
      body: 'This is a long enough body to pass.',
      customerEmail: 'a@b.com',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.subject.length).toBe(LIMITS.MAX_SUBJECT)
    }
  })

  it('enforces body length cap (truncates to MAX_BODY)', () => {
    const tooLong = 'y'.repeat(LIMITS.MAX_BODY + 100)
    const r = validateTicketInput({
      subject: 'A valid subject',
      body: tooLong,
      customerEmail: 'a@b.com',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.body.length).toBe(LIMITS.MAX_BODY)
    }
  })

  it('treats a non-string input as empty (defensive)', () => {
    const r = validateTicketInput({
      subject: 42,
      body: null,
      customerEmail: undefined,
    })
    expect(r.ok).toBe(false)
  })

  it('normalises customerName to null when empty/whitespace', () => {
    const r = validateTicketInput({
      subject: 'A valid subject',
      body: 'This is a long enough body to pass.',
      customerEmail: 'a@b.com',
      customerName: '   ',
    })
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.data.customerName).toBeNull()
    }
  })
})

describe('validateMessageBody', () => {
  it('rejects empty string', () => {
    const r = validateMessageBody('')
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.error).toBe('Message cannot be empty.')
  })

  it('rejects whitespace-only string (trims to empty)', () => {
    const r = validateMessageBody('   \n\t  ')
    expect(r.ok).toBe(false)
  })

  it('rejects non-string input', () => {
    const r = validateMessageBody(123)
    expect(r.ok).toBe(false)
  })

  it('accepts a valid body and returns it trimmed of control chars', () => {
    const r = validateMessageBody('Thanks — I am on macOS 14.2.')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.body).toBe('Thanks — I am on macOS 14.2.')
    }
  })

  it('strips zero-width + null bytes from an otherwise valid body', () => {
    const r = validateMessageBody('Hello\u0000\u200B world, this is long enough.')
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.body).toBe('Hello world, this is long enough.')
    }
  })

  it('enforces the 10000-char cap (truncates)', () => {
    const tooLong = 'z'.repeat(LIMITS.MAX_BODY + 100)
    const r = validateMessageBody(tooLong)
    expect(r.ok).toBe(true)
    if (r.ok) {
      expect(r.body.length).toBe(LIMITS.MAX_BODY)
    }
  })

  it('collapses long runs of whitespace (4+ → 3)', () => {
    // Four spaces should collapse to three.
    const r = validateMessageBody('hello     world, this is long enough.')
    expect(r.ok).toBe(true)
    if (r.ok) {
      // 5 spaces → collapsed to 3.
      expect(r.body).toBe('hello   world, this is long enough.')
    }
  })
})
