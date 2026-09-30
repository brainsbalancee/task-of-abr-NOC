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
  /** Median (first staff reply createdAt - ticket createdAt) for tickets
   * whose first staff reply landed today (UTC). 0 if no replies today. */
  medianFirstResponseMsToday: number
  /** Age in ms of the oldest unassigned open ticket. 0 if none unassigned. */
  oldestUnassignedAgeMs: number
  /** Count of stale tickets across the whole queue (open+pending). */
  staleCount: number
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
  /** True if this ticket matches a "falling through the cracks" rule.
   * See `computeStaleness` in `src/lib/sla.ts`. */
  stale: boolean
  /** Human-readable reason for staleness, or null if not stale. */
  staleReason: string | null
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
  /** Other tickets by the same customer (excluding this one), newest first. */
  customerHistory: CustomerHistoryEntry[]
}

/** A summary of another ticket by the same customer, shown in the detail
 * sidebar so staff have context without leaving the screen. */
export type CustomerHistoryEntry = {
  id: string
  ref: string
  subject: string
  status: TicketStatus
  priority: TicketPriority
  createdAt: string // ISO 8601
  updatedAt: string // ISO 8601
}

/** Public-safe staff user list (id/name/role only) returned by
 * GET /api/staff/users for the assign-to-colleague dropdown. */
export type StaffUserSummary = {
  id: string
  name: string
  role: StaffRole
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
