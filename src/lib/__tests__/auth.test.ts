/**
 * Unit tests for the auth helpers in `src/lib/auth.ts`.
 *
 * These cover the security primitives the rest of the system trusts:
 *  - `hashPassword` / `verifyPassword` — staff login. Wrong password must
 *    return false; right password must round-trip.
 *  - `signSessionToken` / `verifySessionToken` — staff session cookie. A
 *    tampered payload (different ID, original signature) must be rejected,
 *    because that's the "stolen cookie, swapped identity" attack.
 *  - `constantTimeEqual` — the timing-safe comparison that backs both
 *    password verification and lookup-token comparison. Length-mismatch
 *    must short-circuit to false (it's a constant-time compare OF equal-
 *    length buffers; unequal lengths can't be compared safely).
 *
 * Pure functions (no DB, no real scrypt cost concerns for these volumes).
 *
 * Run: `bun test`
 */

import { describe, it, expect } from 'bun:test'
import {
  hashPassword,
  verifyPassword,
  signSessionToken,
  verifySessionToken,
  constantTimeEqual,
  SESSION,
} from '@/lib/auth'

describe('hashPassword + verifyPassword round-trip', () => {
  it('verifyPassword(pw, hashPassword(pw)) is true', () => {
    const pw = 'staff-demo-1234'
    const hash = hashPassword(pw)
    expect(verifyPassword(pw, hash)).toBe(true)
  })

  it('verifyPassword(wrongPw, hash) is false', () => {
    const hash = hashPassword('staff-demo-1234')
    expect(verifyPassword('totally-wrong-password', hash)).toBe(false)
  })

  it('two hashes of the same password are different (random salt)', () => {
    // scrypt uses a random 16-byte salt, so the stored strings differ even
    // for the same input. Both must still verify.
    const h1 = hashPassword('staff-demo-1234')
    const h2 = hashPassword('staff-demo-1234')
    expect(h1).not.toBe(h2)
    expect(verifyPassword('staff-demo-1234', h1)).toBe(true)
    expect(verifyPassword('staff-demo-1234', h2)).toBe(true)
  })

  it('stored hash uses the documented scrypt$salt$hash format', () => {
    const hash = hashPassword('any-password')
    const parts = hash.split('$')
    expect(parts.length).toBe(3)
    expect(parts[0]).toBe('scrypt')
    // salt + hash are hex strings of expected length
    expect(parts[1].length).toBe(32) // 16 bytes hex
    expect(parts[2].length).toBe(128) // 64 bytes hex
  })

  it('verifyPassword returns false on a malformed stored hash', () => {
    expect(verifyPassword('any', 'not-a-valid-hash')).toBe(false)
    expect(verifyPassword('any', 'scrypt$only-one-part')).toBe(false)
  })
})

describe('signSessionToken + verifySessionToken round-trip', () => {
  it('verifySessionToken(signSessionToken(id)) === id', () => {
    const id = 'clxstaff123abc'
    const token = signSessionToken(id)
    expect(verifySessionToken(token)).toBe(id)
  })

  it('returns null for undefined / null / non-string input', () => {
    expect(verifySessionToken(undefined)).toBeNull()
    expect(verifySessionToken(null)).toBeNull()
    expect(verifySessionToken(123 as unknown as string)).toBeNull()
    expect(verifySessionToken('')).toBeNull()
  })

  it('returns null for a malformed token (no separator)', () => {
    expect(verifySessionToken('just-a-string-with-no-dot')).toBeNull()
  })

  it('returns null for a token with empty payload or signature', () => {
    expect(verifySessionToken('.signature-only')).toBeNull()
    expect(verifySessionToken('payload-only.')).toBeNull()
    expect(verifySessionToken('.')).toBeNull()
  })

  it('rejects a tampered token: same signature, swapped payload (different ID)', () => {
    // Attacker steals a valid cookie for ID 'agent-A' and tries to swap
    // the payload to 'agent-B' to impersonate a different staff member.
    // The HMAC over the payload won't match, so the verify must reject.
    const validForA = signSessionToken('agent-A')
    const [payloadA, sigA] = validForA.split('.')
    // Construct a token with a different payload but the original signature.
    const payloadB = Buffer.from('agent-B').toString('base64url')
    const tampered = `${payloadB}.${sigA}`
    expect(tampered).not.toBe(validForA)
    // Sanity: payload A with sig A verifies fine.
    expect(verifySessionToken(`${payloadA}.${sigA}`)).toBe('agent-A')
    // Tampered payload must be rejected.
    expect(verifySessionToken(tampered)).toBeNull()
  })

  it('rejects a token whose signature was tampered (same payload, wrong sig)', () => {
    const valid = signSessionToken('agent-A')
    const [payload, sig] = valid.split('.')
    // Flip one character in the signature.
    const tamperedSig =
      sig[0] === 'a' ? 'b' + sig.slice(1) : 'a' + sig.slice(1)
    expect(verifySessionToken(`${payload}.${tamperedSig}`)).toBeNull()
  })

  it('uses the documented cookie name + 12h TTL', () => {
    // Sanity check that the constants we document in the README still match.
    expect(SESSION.COOKIE).toBe('helpdesk_staff_session')
    expect(SESSION.TTL_MS).toBe(12 * 60 * 60 * 1000)
  })
})

describe('constantTimeEqual', () => {
  it('returns true for equal strings', () => {
    expect(constantTimeEqual('abc', 'abc')).toBe(true)
  })

  it('returns false for unequal strings of the same length', () => {
    expect(constantTimeEqual('abc', 'abd')).toBe(false)
  })

  it('returns false for unequal-length strings (cannot be compared safely)', () => {
    expect(constantTimeEqual('ab', 'abc')).toBe(false)
    expect(constantTimeEqual('abcd', 'abc')).toBe(false)
  })

  it('returns true for empty-string equality (degenerate but defined)', () => {
    expect(constantTimeEqual('', '')).toBe(true)
  })

  it('returns false when only one side is empty', () => {
    expect(constantTimeEqual('', 'a')).toBe(false)
    expect(constantTimeEqual('a', '')).toBe(false)
  })

  it('is used by verifyPassword for the actual hash comparison', () => {
    // Indirect coverage: verifyPassword uses constantTimeEqual internally.
    // A wrong-password compare must not throw and must return false.
    const hash = hashPassword('correct-password')
    expect(() => verifyPassword('wrong-password', hash)).not.toThrow()
    expect(verifyPassword('wrong-password', hash)).toBe(false)
  })
})
