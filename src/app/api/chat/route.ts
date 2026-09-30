/**
 * POST /api/chat
 *
 * Public AI chatbot endpoint. Calls `chatReply` from `@/lib/ai`, which in
 * turn calls z-ai-web-dev-sdk. AI is an enhancement, not a dependency —
 * if the SDK fails or returns nothing, we return `{ reply: null, error:
 * 'unavailable' }` and the client shows a friendly fallback message.
 *
 * Hardening:
 *  - Rate limited per IP (10 / min) — LLM inference is expensive.
 *  - Body must be an array of { role, content } objects, length 1..20.
 *  - role must be 'user' or 'assistant' — any 'system' messages sent by
 *    the client are dropped. We never trust client-supplied system prompts.
 *  - content is capped at 2000 chars per message.
 *  - Cleanup runs after each call.
 */

import { NextRequest } from 'next/server'

import { json, rateLimitedResponse } from '@/lib/api'
import { chatReply, type ChatMessage } from '@/lib/ai'
import {
  rateLimit,
  RATE_LIMITS,
  getClientIp,
  cleanupRateLimitMap,
} from '@/lib/rate-limit'

const MAX_MESSAGES = 20
const MAX_CONTENT = 2000

export async function POST(req: NextRequest) {
  // ---- Rate limit ------------------------------------------------------
  const ip = getClientIp(req)
  const rl = rateLimit(`ip:chat:${ip}`, RATE_LIMITS.aiChat)
  cleanupRateLimitMap()
  if (!rl.ok) return rateLimitedResponse(rl.resetAt)

  // ---- Parse body -----------------------------------------------------
  let body: unknown
  try {
    body = await req.json()
  } catch {
    return json({ ok: false, error: 'Invalid request body.' }, 400)
  }

  const messagesRaw = (body as { messages?: unknown } | null)?.messages
  if (!Array.isArray(messagesRaw) || messagesRaw.length === 0) {
    return json({ ok: false, error: 'Please send at least one message.' }, 400)
  }
  if (messagesRaw.length > MAX_MESSAGES) {
    return json(
      {
        ok: false,
        error: `Please keep the conversation under ${MAX_MESSAGES} messages.`,
      },
      400,
    )
  }

  // ---- Normalize messages --------------------------------------------
  // Drop anything that isn't a { role: 'user'|'assistant', content: string }
  // with non-empty trimmed content. This silently filters 'system' messages
  // sent by the client — we never honor them.
  const messages: ChatMessage[] = []
  for (const m of messagesRaw) {
    if (!m || typeof m !== 'object') continue
    const role = (m as { role?: unknown }).role
    const content = (m as { content?: unknown }).content
    if (role !== 'user' && role !== 'assistant') continue
    if (typeof content !== 'string') continue
    const trimmed = content.slice(0, MAX_CONTENT).trim()
    if (!trimmed) continue
    messages.push({ role, content: trimmed })
  }

  if (messages.length === 0) {
    return json({ ok: false, error: 'Please send at least one message.' }, 400)
  }

  // ---- Call AI --------------------------------------------------------
  const reply = await chatReply(messages)
  if (reply === null) {
    return json({ ok: true, data: { reply: null, error: 'unavailable' } })
  }
  return json({ ok: true, data: { reply } })
}
