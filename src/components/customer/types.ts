/**
 * Shared types for the customer surface.
 *
 * These mirror the shape that the customer API routes return. Keeping them
 * in one place keeps the UI in sync with the contract — if the API changes,
 * the type-checker complains here.
 *
 * NOTE: server-only types (Prisma models) are intentionally NOT imported.
 * We re-declare the minimal shape here so the client bundle stays light.
 */

export type TicketCategory =
  | 'general'
  | 'billing'
  | 'bug'
  | 'account'
  | 'feature'

export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent'

export type TicketStatus = 'open' | 'pending' | 'resolved' | 'closed'

export type MessageAuthorRole = 'customer' | 'staff' | 'ai' | 'system'

export type ChatRole = 'user' | 'assistant'

export type ChatMessage = {
  role: ChatRole
  content: string
}

/** A single message in a ticket thread, as returned by the lookup endpoint. */
export type TicketMessageView = {
  id: string
  authorRole: MessageAuthorRole
  body: string
  createdAt: string // ISO 8601
  aiDrafted: boolean
}

/** Full ticket detail returned by GET /api/tickets/lookup. */
export type TicketDetail = {
  ref: string
  subject: string
  body: string
  status: TicketStatus
  priority: TicketPriority
  category: TicketCategory
  customerName: string | null
  createdAt: string // ISO 8601
  messages: TicketMessageView[]
}

/** Successful submit response. */
export type SubmitResult = {
  ref: string
  lookupToken: string
}

/** Successful chat response. `reply` is null when the AI was unavailable. */
export type ChatResult = {
  reply: string | null
  error?: 'unavailable'
}

/**
 * Error payload returned by the API on a 422. `fields` maps field name →
 * human message, so the UI can render inline errors next to each input.
 */
export type FieldErrors = Record<string, string>
