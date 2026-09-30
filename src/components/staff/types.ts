/**
 * Shared types for the staff surface.
 *
 * These mirror the shape returned by the staff API routes. Keeping them
 * in one place lets the UI stay in sync with the contract — if the API
 * changes, the type-checker flags the call site. Server-only types
 * (Prisma models) are intentionally NOT imported so the client bundle
 * stays light.
 */

export type TicketStatus = 'open' | 'pending' | 'resolved' | 'closed'
export type TicketPriority = 'low' | 'normal' | 'high' | 'urgent'
export type TicketCategory = 'general' | 'billing' | 'bug' | 'account' | 'feature'
export type MessageAuthorRole = 'customer' | 'staff' | 'ai' | 'system'

export type StaffRole = 'agent' | 'admin'

/** Public-safe staff user — no password hash ever leaves the server. */
export type StaffUser = {
  id: string
  email: string
  name: string
  role: StaffRole
}

/** Stats row at the top of the queue dashboard. */
export type QueueStats = {
  open: number
  pending: number
  resolvedToday: number
  unassigned: number
}

/** Row in the ticket queue list. No message bodies — just metadata. */
export type StaffListItem = {
  id: string
  ref: string
  subject: string
  status: TicketStatus
  priority: TicketPriority
  category: TicketCategory
  customerEmail: string
  customerName: string | null
  assignee: { id: string; name: string } | null
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
  _count: { messages: number }
}

export type StaffListResponse = {
  tickets: StaffListItem[]
  total: number
  page: number
  pageSize: number
  stats: QueueStats
}

/** A single message in a ticket thread, as returned to staff. */
export type StaffMessageView = {
  id: string
  authorRole: MessageAuthorRole
  body: string
  createdAt: string // ISO 8601
  aiDrafted: boolean
  staffId: string | null
  staffName: string | null
  staffRole: StaffRole | null
}

/** Full ticket detail returned by GET /api/staff/tickets/[id]. */
export type StaffTicketDetail = {
  id: string
  ref: string
  subject: string
  body: string
  status: TicketStatus
  priority: TicketPriority
  category: TicketCategory
  customerEmail: string
  customerName: string | null
  assignee: { id: string; name: string; role: StaffRole } | null
  createdAt: string
  updatedAt: string
  messages: StaffMessageView[]
}

/** Reply/draft action request payloads. */
export type ReplyRequest = {
  body: string
  aiDrafted: boolean
}

export type DraftResult = {
  draft: string | null
}

/** PATCH /api/staff/tickets/[id] — any subset of fields. */
export type PatchTicketRequest = {
  status?: TicketStatus
  priority?: TicketPriority
  category?: TicketCategory
  assigneeId?: string | null
}
