/**
 * In-memory token-bucket rate limiter.
 *
 * Why in-memory: the spec is a single-process Next.js server in a sandbox.
 * A distributed store (Redis) would be the right call at scale, but for the
 * size of system we actually built (one Node process, low QPS) an in-memory
 * map is simpler, has no extra moving parts, and fails closed (if the map is
 * lost, the worst case is a fresh quota — never a permanently-locked-out user).
 *
 * The map is keyed by IP + route bucket so different endpoints get separate
 * budgets. Entries expire after 60s of inactivity to keep memory bounded.
 */

type Bucket = {
  tokens: number
  lastRefill: number
}

const buckets = new Map<string, Bucket>()
const REFILL_INTERVAL_MS = 60_000 // 1 minute
const CLEANUP_THRESHOLD = 10_000 // don't let the map grow unbounded

type RateLimitConfig = {
  /** Maximum tokens (requests) per refill interval. */
  capacity: number
  /** Refill interval in ms. */
  intervalMs: number
}

const DEFAULT_CONFIG: RateLimitConfig = {
  capacity: 60,
  intervalMs: REFILL_INTERVAL_MS,
}

// Stricter configs for the open, expensive, or abuse-prone endpoints.
export const RATE_LIMITS = {
  // Ticket submission is the most expensive "open" action (DB write + email).
  ticketSubmit: { capacity: 5, intervalMs: REFILL_INTERVAL_MS },
  // AI chat is the most expensive call per request (LLM inference).
  aiChat: { capacity: 10, intervalMs: REFILL_INTERVAL_MS },
  // Ticket status lookup — keep tight to prevent enumeration.
  ticketLookup: { capacity: 20, intervalMs: REFILL_INTERVAL_MS },
  // Staff login — strict to make brute force impractical.
  staffLogin: { capacity: 10, intervalMs: REFILL_INTERVAL_MS },
  aiDraft: { capacity: 20, intervalMs: REFILL_INTERVAL_MS },
} as const

export type RateLimitResult = {
  ok: boolean
  remaining: number
  /** Epoch ms when the bucket resets. */
  resetAt: number
}

export function rateLimit(
  key: string,
  config: RateLimitConfig = DEFAULT_CONFIG,
): RateLimitResult {
  const now = Date.now()
  const existing = buckets.get(key)

  if (!existing) {
    buckets.set(key, { tokens: config.capacity - 1, lastRefill: now })
    return {
      ok: true,
      remaining: config.capacity - 1,
      resetAt: now + config.intervalMs,
    }
  }

  // Refill: if enough time has passed, reset to capacity.
  const elapsed = now - existing.lastRefill
  if (elapsed >= config.intervalMs) {
    buckets.set(key, { tokens: config.capacity - 1, lastRefill: now })
    return {
      ok: true,
      remaining: config.capacity - 1,
      resetAt: now + config.intervalMs,
    }
  }

  if (existing.tokens <= 0) {
    return {
      ok: false,
      remaining: 0,
      resetAt: existing.lastRefill + config.intervalMs,
    }
  }

  existing.tokens -= 1
  return {
    ok: true,
    remaining: existing.tokens,
    resetAt: existing.lastRefill + config.intervalMs,
  }
}

/** Get client IP from request, falling through proxies conservatively. */
export function getClientIp(req: Request): string {
  // Caddy is the gateway. We trust X-Forwarded-For's first hop only.
  const xff = req.headers.get('x-forwarded-for')
  if (xff) {
    const first = xff.split(',')[0]?.trim()
    if (first) return first
  }
  return req.headers.get('x-real-ip') ?? 'unknown'
}

/** Periodic cleanup — call from any endpoint to bound memory. */
export function cleanupRateLimitMap() {
  if (buckets.size < CLEANUP_THRESHOLD) return
  const cutoff = Date.now() - REFILL_INTERVAL_MS * 2
  for (const [k, v] of buckets) {
    if (v.lastRefill < cutoff) buckets.delete(k)
  }
}
