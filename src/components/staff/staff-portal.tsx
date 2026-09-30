'use client'

/**
 * StaffPortal — the authed staff surface.
 *
 * Three views:
 *   1. Login form (logged-out)
 *   2. Queue dashboard (logged-in, no ticket selected)
 *   3. Ticket detail (logged-in, ticket selected)
 *
 * On mount, calls GET /api/staff/me to restore an existing session. The
 * queue view polls the ticket list every 15s while it is open — this is
 * the agent's live queue. The ticket detail view does not auto-poll
 * (the agent is actively reading it; a manual "refresh" button covers
 * the rare case where a customer reply arrives mid-read).
 *
 * All customer content (subject, body, messages) is rendered as plain
 * text via React's default escaping — never dangerouslySetInnerHTML.
 *
 * Color rules: zinc/neutral chrome, emerald for success / open,
 * amber for pending / high, red for urgent / destructive.
 * No indigo, no blue.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { format, formatDistanceToNow } from 'date-fns'
import { toast } from 'sonner'
import {
  ArrowLeft,
  CheckCircle2,
  ClipboardCopy,
  Inbox,
  Loader2,
  LogOut,
  RefreshCw,
  Search,
  Send,
  Sparkles,
  TriangleAlert,
  UserCircle2,
} from 'lucide-react'

import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Label } from '@/components/ui/label'
import { Textarea } from '@/components/ui/textarea'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import { Skeleton } from '@/components/ui/skeleton'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table'
import { cn } from '@/lib/utils'
import { LIMITS } from '@/lib/sanitize'

import type {
  DraftResult,
  PatchTicketRequest,
  QueueStats,
  ReplyRequest,
  StaffListItem,
  StaffListResponse,
  StaffMessageView,
  StaffRole,
  StaffTicketDetail,
  StaffUser,
  TicketCategory,
  TicketPriority,
  TicketStatus,
} from './types'

// ============================================================
// Display helpers
// ============================================================

const STATUS_LABELS: Record<TicketStatus, string> = {
  open: 'Open',
  pending: 'Awaiting reply',
  resolved: 'Resolved',
  closed: 'Closed',
}

const PRIORITY_LABELS: Record<TicketPriority, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

const CATEGORY_LABELS: Record<TicketCategory, string> = {
  general: 'General',
  billing: 'Billing',
  bug: 'Bug report',
  account: 'Account',
  feature: 'Feature request',
}

function StatusBadge({ status }: { status: TicketStatus }) {
  const cls: Record<TicketStatus, string> = {
    open: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400',
    pending: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400',
    resolved: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
    closed: 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500',
  }
  return (
    <Badge variant="outline" className={cls[status]}>
      {STATUS_LABELS[status]}
    </Badge>
  )
}

function PriorityBadge({ priority }: { priority: TicketPriority }) {
  const cls: Record<TicketPriority, string> = {
    low: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
    normal: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
    high: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400',
    urgent: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400',
  }
  return (
    <Badge variant="outline" className={cls[priority]}>
      {PRIORITY_LABELS[priority]}
    </Badge>
  )
}

function CategoryBadge({ category }: { category: TicketCategory }) {
  return (
    <Badge
      variant="outline"
      className="border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
    >
      {CATEGORY_LABELS[category]}
    </Badge>
  )
}

/**
 * Rate-limit retry countdown. Component (not a hook) so the state
 * initializer runs on mount — no setState-in-effect, no cascading
 * render. The parent mounts a fresh instance per 429.
 */
function RetryCountdown({
  seconds,
  onDone,
}: {
  seconds: number
  onDone: () => void
}) {
  const [remaining, setRemaining] = useState(seconds)
  const onDoneRef = useRef(onDone)
  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  useEffect(() => {
    if (seconds <= 0) {
      onDoneRef.current()
      return
    }
    const id = setInterval(() => {
      setRemaining((r) => {
        if (r <= 1) {
          clearInterval(id)
          onDoneRef.current()
          return 0
        }
        return r - 1
      })
    }, 1000)
    return () => clearInterval(id)
  }, [seconds])

  return (
    <span className="font-semibold tabular-nums" aria-live="polite">
      {remaining}s
    </span>
  )
}

const RATE_LIMIT_RESET = 60

// ============================================================
// Root component
// ============================================================

type View = 'login' | 'queue' | 'ticket'

export function StaffPortal() {
  const [staff, setStaff] = useState<StaffUser | null>(null)
  const [bootstrapping, setBootstrapping] = useState(true)
  const [view, setView] = useState<View>('login')
  const [selectedTicketId, setSelectedTicketId] = useState<string | null>(null)

  // On mount, restore session.
  useEffect(() => {
    let cancelled = false
    ;(async () => {
      try {
        const res = await fetch('/api/staff/me', { cache: 'no-store' })
        if (cancelled) return
        if (res.ok) {
          const payload = (await res.json()) as { ok: true; data: StaffUser }
          setStaff(payload.data)
          setView('queue')
        } else {
          setStaff(null)
          setView('login')
        }
      } catch {
        if (cancelled) return
        setStaff(null)
        setView('login')
      } finally {
        if (!cancelled) setBootstrapping(false)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [])

  const handleLogin = (user: StaffUser) => {
    setStaff(user)
    setView('queue')
  }

  const handleLogout = () => {
    setStaff(null)
    setSelectedTicketId(null)
    setView('login')
  }

  const openTicket = (id: string) => {
    setSelectedTicketId(id)
    setView('ticket')
  }

  const closeTicket = () => {
    setSelectedTicketId(null)
    setView('queue')
  }

  if (bootstrapping) {
    return (
      <section className="container mx-auto max-w-5xl px-4 py-10 sm:px-6">
        <div className="grid gap-4 sm:grid-cols-4">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-20 w-full rounded-xl" />
          ))}
        </div>
        <Skeleton className="mt-6 h-10 w-full rounded-md" />
        <Skeleton className="mt-3 h-64 w-full rounded-md" />
      </section>
    )
  }

  if (!staff || view === 'login') {
    return <StaffLoginForm onLogin={handleLogin} />
  }

  if (view === 'ticket' && selectedTicketId) {
    return (
      <TicketDetailView
        ticketId={selectedTicketId}
        staff={staff}
        onBack={closeTicket}
      />
    )
  }

  return (
    <QueueView
      staff={staff}
      onOpenTicket={openTicket}
      onLogout={handleLogout}
    />
  )
}

// ============================================================
// Login form
// ============================================================

function StaffLoginForm({ onLogin }: { onLogin: (user: StaffUser) => void }) {
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rateLimitReset, setRateLimitReset] = useState<number | null>(null)

  const disabled = submitting || rateLimitReset !== null

  const onSubmit = async (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault()
    setError(null)
    setSubmitting(true)
    try {
      const res = await fetch('/api/staff/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password }),
      })
      const payload = (await res.json().catch(() => null)) as
        | { ok: true; data: StaffUser }
        | { ok: false; error: string }
        | null

      if (res.ok && payload && 'data' in payload) {
        toast.success(`Welcome back, ${payload.data.name.split(' ')[0]}`)
        onLogin(payload.data)
        return
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? RATE_LIMIT_RESET)
        setRateLimitReset(Math.max(1, retryAfter))
        return
      }
      // 401 — wrong email or password. Same message either way.
      const msg =
        payload && !payload.ok && 'error' in payload
          ? payload.error
          : 'Wrong email or password'
      setError(msg)
    } catch {
      setError('Network error. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  const fillDemo = (which: 'agent' | 'admin') => {
    if (which === 'agent') {
      setEmail('agent@helpdesk.local')
      setPassword('staff-demo-1234')
    } else {
      setEmail('admin@helpdesk.local')
      setPassword('staff-admin-1234')
    }
    setError(null)
    setRateLimitReset(null)
  }

  return (
    <section className="container mx-auto max-w-md px-4 py-12 sm:px-6 sm:py-16">
      <Card className="border-border/60 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <UserCircle2 className="h-5 w-5 text-emerald-600" />
            Staff sign in
          </CardTitle>
          <CardDescription>
            Sign in to the agent console to view the ticket queue and reply to
            customers.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onSubmit} className="grid gap-4" noValidate>
            <div className="grid gap-2">
              <Label htmlFor="email">Email</Label>
              <Input
                id="email"
                type="email"
                autoComplete="username"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                disabled={disabled}
                required
                aria-required="true"
                placeholder="you@helpdesk.local"
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="password">Password</Label>
              <Input
                id="password"
                type="password"
                autoComplete="current-password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                disabled={disabled}
                required
                aria-required="true"
                placeholder="Your staff password"
              />
            </div>

            {error && (
              <p
                role="alert"
                className="text-sm text-red-600 dark:text-red-400"
              >
                {error}
              </p>
            )}

            {rateLimitReset !== null && (
              <p
                role="alert"
                className="text-sm text-amber-700 dark:text-amber-400"
              >
                Too many attempts. Try again in{' '}
                <RetryCountdown
                  seconds={rateLimitReset}
                  onDone={() => setRateLimitReset(null)}
                />
                .
              </p>
            )}

            <Button type="submit" disabled={disabled} className="w-full">
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" /> Signing in…
                </>
              ) : (
                'Sign in'
              )}
            </Button>
          </form>
        </CardContent>
        <CardFooter className="flex-col items-stretch gap-2 border-t pt-4">
          <p className="text-[11px] uppercase tracking-wide text-muted-foreground">
            Demo accounts (one-click fill)
          </p>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <button
              type="button"
              onClick={() => fillDemo('agent')}
              className="rounded-md border border-border/60 bg-background px-3 py-2 text-left text-xs hover:bg-accent transition-colors"
            >
              <div className="font-medium text-foreground">Agent</div>
              <div className="font-mono text-muted-foreground">
                agent@helpdesk.local
              </div>
              <div className="font-mono text-muted-foreground">
                staff-demo-1234
              </div>
            </button>
            <button
              type="button"
              onClick={() => fillDemo('admin')}
              className="rounded-md border border-border/60 bg-background px-3 py-2 text-left text-xs hover:bg-accent transition-colors"
            >
              <div className="font-medium text-foreground">Admin</div>
              <div className="font-mono text-muted-foreground">
                admin@helpdesk.local
              </div>
              <div className="font-mono text-muted-foreground">
                staff-admin-1234
              </div>
            </button>
          </div>
        </CardFooter>
      </Card>
    </section>
  )
}

// ============================================================
// Queue view (dashboard)
// ============================================================

type QueueViewProps = {
  staff: StaffUser
  onOpenTicket: (id: string) => void
  onLogout: () => void
}

const STATUSES: TicketStatus[] = ['open', 'pending', 'resolved', 'closed']
const PRIORITIES: TicketPriority[] = ['low', 'normal', 'high', 'urgent']
const CATEGORIES: TicketCategory[] = [
  'general',
  'billing',
  'bug',
  'account',
  'feature',
]

function QueueView({ staff, onOpenTicket, onLogout }: QueueViewProps) {
  const [status, setStatus] = useState<'all' | TicketStatus>('all')
  const [priority, setPriority] = useState<'all' | TicketPriority>('all')
  const [category, setCategory] = useState<'all' | TicketCategory>('all')
  const [q, setQ] = useState('')
  const [assignee, setAssignee] = useState<'all' | 'me' | 'unassigned'>('all')

  const [data, setData] = useState<StaffListResponse | null>(null)
  const [loading, setLoading] = useState(true)
  const [lastFetchedAt, setLastFetchedAt] = useState<number | null>(null)
  const [secondsAgo, setSecondsAgo] = useState(0)
  const [loggingOut, setLoggingOut] = useState(false)

  // Debounce the search field so typing doesn't slam the server.
  const [debouncedQ, setDebouncedQ] = useState('')
  useEffect(() => {
    const t = setTimeout(() => setDebouncedQ(q.trim()), 300)
    return () => clearTimeout(t)
  }, [q])

  const fetchQueue = useCallback(
    async (silent = false) => {
      if (!silent) setLoading(true)
      try {
        const params = new URLSearchParams()
        if (status !== 'all') params.set('status', status)
        if (priority !== 'all') params.set('priority', priority)
        if (category !== 'all') params.set('category', category)
        if (debouncedQ) params.set('q', debouncedQ)
        if (assignee !== 'all') params.set('assignee', assignee)
        params.set('page', '1')
        params.set('pageSize', '50')
        const res = await fetch(`/api/staff/tickets?${params.toString()}`, {
          cache: 'no-store',
        })
        if (!res.ok) {
          if (res.status === 401) {
            // Session expired — surface to user.
            toast.error('Your session has expired. Please sign in again.')
            onLogout()
            return
          }
          throw new Error('queue fetch failed')
        }
        const payload = (await res.json()) as StaffListResponse
        // The endpoint returns the data shape directly: {tickets, total, ...}
        // Older `json` wrapper wraps it as {ok:true, data:{...}} — handle both
        // for resilience.
        const unwrapped =
          'ok' in (payload as unknown as Record<string, unknown>)
            ? (payload as unknown as { data: StaffListResponse }).data
            : payload
        setData(unwrapped)
        setLastFetchedAt(Date.now())
      } catch {
        if (!silent) toast.error('Could not load the ticket queue.')
      } finally {
        if (!silent) setLoading(false)
      }
    },
    [status, priority, category, debouncedQ, assignee, onLogout],
  )

  // Initial fetch + refetch when filters change.
  useEffect(() => {
    void fetchQueue(false)
  }, [fetchQueue])

  // Poll every 15s while the queue is the active view.
  useEffect(() => {
    const id = setInterval(() => {
      void fetchQueue(true)
    }, 15_000)
    return () => clearInterval(id)
  }, [fetchQueue])

  // Tick "Updated Xs ago" once per second.
  useEffect(() => {
    if (lastFetchedAt === null) return
    setSecondsAgo(0)
    const id = setInterval(() => {
      setSecondsAgo(Math.floor((Date.now() - (lastFetchedAt ?? 0)) / 1000))
    }, 1000)
    return () => clearInterval(id)
  }, [lastFetchedAt])

  const handleLogout = async () => {
    setLoggingOut(true)
    try {
      await fetch('/api/staff/logout', { method: 'POST' })
    } catch {
      // Logout is best-effort client-side; cookie will be cleared server-side.
    } finally {
      toast('Signed out.')
      onLogout()
    }
  }

  const stats: QueueStats = data?.stats ?? {
    open: 0,
    pending: 0,
    resolvedToday: 0,
    unassigned: 0,
  }

  return (
    <section className="container mx-auto max-w-6xl px-4 py-6 sm:px-6 sm:py-8">
      {/* Top bar */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-tight sm:text-2xl">
            Agent console
          </h1>
          <p className="text-sm text-muted-foreground">
            Signed in as{' '}
            <span className="font-medium text-foreground">{staff.name}</span>{' '}
            <Badge
              variant="outline"
              className="ml-1 border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400"
            >
              {staff.role}
            </Badge>
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span
            className="hidden text-xs text-muted-foreground tabular-nums sm:inline"
            aria-live="polite"
          >
            Updated {secondsAgo}s ago
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={() => void fetchQueue(false)}
            disabled={loading}
          >
            <RefreshCw
              className={cn('h-4 w-4', loading && 'animate-spin')}
            />
            Refresh
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleLogout}
            disabled={loggingOut}
          >
            <LogOut className="h-4 w-4" />
            Sign out
          </Button>
        </div>
      </div>

      {/* Stats row */}
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4 sm:gap-4">
        <StatCard
          label="Open"
          value={stats.open}
          accent="emerald"
          icon={<Inbox className="h-4 w-4" />}
        />
        <StatCard
          label="Awaiting reply"
          value={stats.pending}
          accent="amber"
          icon={<RefreshCw className="h-4 w-4" />}
        />
        <StatCard
          label="Resolved today"
          value={stats.resolvedToday}
          accent="zinc"
          icon={<CheckCircle2 className="h-4 w-4" />}
        />
        <StatCard
          label="Unassigned"
          value={stats.unassigned}
          accent="red"
          icon={<TriangleAlert className="h-4 w-4" />}
        />
      </div>

      {/* Filter bar */}
      <div className="mt-5 grid grid-cols-1 gap-2 sm:grid-cols-2 md:grid-cols-4">
        <div className="grid gap-1.5">
          <Label htmlFor="filter-status" className="text-xs">
            Status
          </Label>
          <Select
            value={status}
            onValueChange={(v) => setStatus(v as typeof status)}
          >
            <SelectTrigger id="filter-status" className="w-full">
              <SelectValue placeholder="All statuses" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All statuses</SelectItem>
              {STATUSES.map((s) => (
                <SelectItem key={s} value={s}>
                  {STATUS_LABELS[s]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="filter-priority" className="text-xs">
            Priority
          </Label>
          <Select
            value={priority}
            onValueChange={(v) => setPriority(v as typeof priority)}
          >
            <SelectTrigger id="filter-priority" className="w-full">
              <SelectValue placeholder="All priorities" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All priorities</SelectItem>
              {PRIORITIES.map((p) => (
                <SelectItem key={p} value={p}>
                  {PRIORITY_LABELS[p]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="filter-category" className="text-xs">
            Category
          </Label>
          <Select
            value={category}
            onValueChange={(v) => setCategory(v as typeof category)}
          >
            <SelectTrigger id="filter-category" className="w-full">
              <SelectValue placeholder="All categories" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All categories</SelectItem>
              {CATEGORIES.map((c) => (
                <SelectItem key={c} value={c}>
                  {CATEGORY_LABELS[c]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor="filter-assignee" className="text-xs">
            Assignee
          </Label>
          <Select
            value={assignee}
            onValueChange={(v) => setAssignee(v as typeof assignee)}
          >
            <SelectTrigger id="filter-assignee" className="w-full">
              <SelectValue placeholder="All tickets" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All tickets</SelectItem>
              <SelectItem value="me">Assigned to me</SelectItem>
              <SelectItem value="unassigned">Unassigned</SelectItem>
            </SelectContent>
          </Select>
        </div>
      </div>

      {/* Search box */}
      <div className="mt-3">
        <div className="relative">
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            id="filter-search"
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search by subject or ticket ref (e.g. HD-AB12CD)"
            className="pl-9"
          />
        </div>
      </div>

      {/* Ticket table / mobile cards */}
      <div className="mt-5">
        {loading && !data ? (
          <QueueSkeleton />
        ) : data && data.tickets.length > 0 ? (
          <>
            {/* Desktop: table */}
            <div className="hidden rounded-lg border border-border/60 bg-card md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-[110px]">Ref</TableHead>
                    <TableHead>Subject</TableHead>
                    <TableHead className="w-[200px]">Customer</TableHead>
                    <TableHead className="w-[110px]">Status</TableHead>
                    <TableHead className="w-[100px]">Priority</TableHead>
                    <TableHead className="w-[130px]">Category</TableHead>
                    <TableHead className="w-[140px]">Opened</TableHead>
                    <TableHead className="w-[140px]">Assignee</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.tickets.map((t) => (
                    <QueueRow
                      key={t.id}
                      ticket={t}
                      onClick={() => onOpenTicket(t.id)}
                    />
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile: stacked cards */}
            <div className="grid gap-2 md:hidden">
              {data.tickets.map((t) => (
                <QueueCard
                  key={t.id}
                  ticket={t}
                  onClick={() => onOpenTicket(t.id)}
                />
              ))}
            </div>

            <p className="mt-3 text-center text-xs text-muted-foreground">
              Showing {data.tickets.length} of {data.total} tickets
            </p>
          </>
        ) : (
          <EmptyState />
        )}
      </div>
    </section>
  )
}

function StatCard({
  label,
  value,
  accent,
  icon,
}: {
  label: string
  value: number
  accent: 'emerald' | 'amber' | 'zinc' | 'red'
  icon: React.ReactNode
}) {
  const accentCls: Record<typeof accent, string> = {
    emerald:
      'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400',
    amber:
      'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400',
    zinc: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
    red: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400',
  } as const
  return (
    <div
      className={cn(
        'flex items-center gap-3 rounded-lg border px-3 py-2.5 sm:px-4',
        accentCls[accent],
      )}
    >
      <div className="flex h-9 w-9 items-center justify-center rounded-md bg-background/70">
        {icon}
      </div>
      <div className="min-w-0">
        <div className="text-xl font-semibold tabular-nums sm:text-2xl">
          {value}
        </div>
        <div className="truncate text-[11px] uppercase tracking-wide opacity-80">
          {label}
        </div>
      </div>
    </div>
  )
}

function QueueRow({
  ticket,
  onClick,
}: {
  ticket: StaffListItem
  onClick: () => void
}) {
  return (
    <TableRow
      onClick={onClick}
      className="cursor-pointer"
      tabIndex={0}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onClick()
        }
      }}
      role="button"
      aria-label={`Open ticket ${ticket.ref}: ${ticket.subject}`}
    >
      <TableCell className="font-mono text-xs">{ticket.ref}</TableCell>
      <TableCell className="max-w-[280px]">
        <div className="truncate font-medium">{ticket.subject}</div>
        <div className="text-[11px] text-muted-foreground">
          {ticket._count.messages} message{ticket._count.messages === 1 ? '' : 's'}
        </div>
      </TableCell>
      <TableCell className="max-w-[200px]">
        <div className="truncate text-sm">{ticket.customerName ?? '—'}</div>
        <div className="truncate text-[11px] text-muted-foreground">
          {ticket.customerEmail}
        </div>
      </TableCell>
      <TableCell>
        <StatusBadge status={ticket.status} />
      </TableCell>
      <TableCell>
        <PriorityBadge priority={ticket.priority} />
      </TableCell>
      <TableCell>
        <CategoryBadge category={ticket.category} />
      </TableCell>
      <TableCell className="text-xs text-muted-foreground">
        {formatDistanceToNow(new Date(ticket.createdAt), { addSuffix: true })}
      </TableCell>
      <TableCell className="text-sm">
        {ticket.assignee ? (
          ticket.assignee.name
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  )
}

function QueueCard({
  ticket,
  onClick,
}: {
  ticket: StaffListItem
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="w-full rounded-lg border border-border/60 bg-card p-3 text-left transition-colors hover:bg-accent"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-mono text-[11px] text-muted-foreground">
          {ticket.ref}
        </span>
        <span className="text-[11px] text-muted-foreground">
          {formatDistanceToNow(new Date(ticket.createdAt), { addSuffix: true })}
        </span>
      </div>
      <div className="mt-1 truncate text-sm font-medium">{ticket.subject}</div>
      <div className="mt-1 truncate text-xs text-muted-foreground">
        {ticket.customerName ? `${ticket.customerName} · ` : ''}
        {ticket.customerEmail}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <StatusBadge status={ticket.status} />
        <PriorityBadge priority={ticket.priority} />
        <CategoryBadge category={ticket.category} />
      </div>
      <div className="mt-2 flex items-center justify-between text-[11px] text-muted-foreground">
        <span>{ticket._count.messages} messages</span>
        <span>{ticket.assignee ? ticket.assignee.name : 'Unassigned'}</span>
      </div>
    </button>
  )
}

function QueueSkeleton() {
  return (
    <div className="rounded-lg border border-border/60 bg-card">
      <div className="hidden md:block">
        <Table>
          <TableHeader>
            <TableRow>
              {Array.from({ length: 8 }).map((_, i) => (
                <TableHead key={i}>
                  <Skeleton className="h-4 w-full" />
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody>
            {Array.from({ length: 6 }).map((_, r) => (
              <TableRow key={r}>
                {Array.from({ length: 8 }).map((_, c) => (
                  <TableCell key={c}>
                    <Skeleton className="h-4 w-full" />
                  </TableCell>
                ))}
              </TableRow>
            ))}
          </TableBody>
        </Table>
      </div>
      <div className="grid gap-2 p-2 md:hidden">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    </div>
  )
}

function EmptyState() {
  return (
    <div className="rounded-lg border border-dashed border-border bg-card p-10 text-center">
      <Inbox className="mx-auto h-8 w-8 text-muted-foreground" />
      <p className="mt-2 text-sm font-medium">No tickets match these filters</p>
      <p className="mt-1 text-xs text-muted-foreground">
        Try clearing a filter, or refreshing in a moment.
      </p>
    </div>
  )
}

// ============================================================
// Ticket detail view
// ============================================================

function TicketDetailView({
  ticketId,
  staff,
  onBack,
}: {
  ticketId: string
  staff: StaffUser
  onBack: () => void
}) {
  const [ticket, setTicket] = useState<StaffTicketDetail | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // Reply composer state.
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [drafting, setDrafting] = useState(false)
  // Whether the current textarea contents are from the AI draft button.
  // Reset on send or on manual clear.
  const [draftFromAI, setDraftFromAI] = useState(false)

  // Patch-in-flight state for optimistic UI on status/priority/etc.
  const [patching, setPatching] = useState(false)

  const fetchTicket = useCallback(async () => {
    try {
      const res = await fetch(`/api/staff/tickets/${encodeURIComponent(ticketId)}`, {
        cache: 'no-store',
      })
      if (res.status === 401) {
        toast.error('Your session has expired. Please sign in again.')
        onBack()
        return
      }
      if (res.status === 404) {
        setError('Ticket not found. It may have been deleted.')
        setLoading(false)
        return
      }
      if (!res.ok) throw new Error('fetch failed')
      const payload = (await res.json()) as
        | { ok: true; data: StaffTicketDetail }
        | StaffTicketDetail
      const data =
        'ok' in (payload as unknown as Record<string, unknown>)
          ? (payload as unknown as { data: StaffTicketDetail }).data
          : (payload as StaffTicketDetail)
      setTicket(data)
    } catch {
      setError('Could not load the ticket. Please try again.')
    } finally {
      setLoading(false)
    }
  }, [ticketId, onBack])

  useEffect(() => {
    void fetchTicket()
  }, [fetchTicket])

  // ---- Reply -----------------------------------------------------------
  const onSendReply = async () => {
    if (!ticket) return
    const trimmed = draft.trim()
    if (!trimmed) {
      toast.error('Please write something before sending.')
      return
    }
    setSending(true)
    try {
      const res = await fetch(
        `/api/staff/tickets/${encodeURIComponent(ticketId)}/reply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            body: trimmed,
            aiDrafted: draftFromAI,
          } satisfies ReplyRequest),
        },
      )
      if (res.status === 401) {
        toast.error('Your session has expired. Please sign in again.')
        return
      }
      const payload = (await res.json().catch(() => null)) as
        | { ok: true; data: StaffMessageView }
        | { ok: false; error: string }
        | null
      if (res.ok && payload && 'data' in payload) {
        toast.success('Reply sent.')
        setTicket((cur) =>
          cur
            ? {
                ...cur,
                status: 'pending',
                updatedAt: new Date().toISOString(),
                messages: [...cur.messages, payload.data],
              }
            : cur,
        )
        setDraft('')
        setDraftFromAI(false)
        // Refetch in the background to ensure consistency.
        void fetchTicket()
      } else {
        const msg =
          payload && !payload.ok && 'error' in payload
            ? payload.error
            : 'Could not send your reply.'
        toast.error(msg)
      }
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setSending(false)
    }
  }

  // ---- AI draft --------------------------------------------------------
  const onAIDraft = async () => {
    if (!ticket) return
    setDrafting(true)
    try {
      const res = await fetch(
        `/api/staff/tickets/${encodeURIComponent(ticketId)}/draft`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({}),
        },
      )
      if (res.status === 429) {
        const retryAfter = Number(
          res.headers.get('Retry-After') ?? RATE_LIMIT_RESET,
        )
        toast.error(
          `Draft rate-limited. Try again in ${Math.max(1, retryAfter)}s.`,
        )
        return
      }
      if (res.status === 401) {
        toast.error('Your session has expired. Please sign in again.')
        return
      }
      const payload = (await res.json().catch(() => null)) as
        | { ok: true; data: DraftResult }
        | { ok: false; error: string }
        | null
      if (res.ok && payload && 'data' in payload) {
        if (payload.data.draft) {
          setDraft(payload.data.draft)
          setDraftFromAI(true)
          toast.success('AI draft loaded. Review and edit before sending.')
        } else {
          toast.error(
            "Couldn't generate a draft — try again in a moment.",
          )
        }
      } else {
        toast.error("Couldn't generate a draft — try again in a moment.")
      }
    } catch {
      toast.error('Network error. Please try again.')
    } finally {
      setDrafting(false)
    }
  }

  // ---- Patch (status / priority / category / assign) ------------------
  const patchTicket = async (patch: PatchTicketRequest) => {
    if (!ticket) return
    setPatching(true)
    const prev = ticket
    // Optimistic update — only mutate fields actually present in the patch.
    // If a field is absent we leave it untouched; the server's response is
    // the source of truth and we reconcile below.
    const next: StaffTicketDetail = { ...prev }
    if (patch.status) next.status = patch.status
    if (patch.priority) next.priority = patch.priority
    if (patch.category) next.category = patch.category
    if ('assigneeId' in patch) {
      if (patch.assigneeId === null) {
        next.assignee = null
      } else if (patch.assigneeId === staff.id) {
        next.assignee = {
          id: staff.id,
          name: staff.name,
          role: staff.role as StaffRole,
        }
      }
      // If patch.assigneeId is some other id (we never send that from this UI),
      // we leave prev.assignee alone and let the server's response reconcile.
    }
    setTicket(next)
    try {
      const res = await fetch(
        `/api/staff/tickets/${encodeURIComponent(ticketId)}`,
        {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(patch),
        },
      )
      if (res.status === 401) {
        toast.error('Your session has expired. Please sign in again.')
        setTicket(prev)
        return
      }
      const payload = (await res.json().catch(() => null)) as
        | { ok: true; data: StaffTicketDetail }
        | { ok: false; error: string }
        | null
      if (res.ok && payload && 'data' in payload) {
        setTicket(payload.data)
        toast.success('Ticket updated.')
      } else {
        // Revert on failure.
        setTicket(prev)
        const msg =
          payload && !payload.ok && 'error' in payload
            ? payload.error
            : 'Could not update the ticket.'
        toast.error(msg)
      }
    } catch {
      setTicket(prev)
      toast.error('Network error. Please try again.')
    } finally {
      setPatching(false)
    }
  }

  if (loading) {
    return <TicketDetailSkeleton onBack={onBack} />
  }

  if (error || !ticket) {
    return (
      <section className="container mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
        <Button variant="ghost" size="sm" onClick={onBack} className="mb-4">
          <ArrowLeft className="h-4 w-4" /> Back to queue
        </Button>
        <Card>
          <CardContent>
            <p className="py-6 text-center text-sm text-muted-foreground">
              {error ?? 'Ticket not found.'}
            </p>
          </CardContent>
        </Card>
      </section>
    )
  }

  return (
    <section className="container mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-3">
        <ArrowLeft className="h-4 w-4" /> Back to queue
      </Button>

      {/* Header card */}
      <Card>
        <CardHeader>
          <div className="flex flex-col gap-2">
            <div className="flex items-center gap-2">
              <span className="font-mono text-xs text-muted-foreground">
                {ticket.ref}
              </span>
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
              <CategoryBadge category={ticket.category} />
            </div>
            <CardTitle className="text-lg leading-snug sm:text-xl">
              {ticket.subject}
            </CardTitle>
            <CardDescription className="text-xs">
              Opened {format(new Date(ticket.createdAt), 'PPp')} ·{' '}
              {ticket.messages.length} messages
            </CardDescription>
          </div>
        </CardHeader>
        <CardContent className="grid gap-4">
          {/* Editable properties */}
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <EditableField
              label="Status"
              value={ticket.status}
              onCommit={(v) => void patchTicket({ status: v as TicketStatus })}
              disabled={patching}
              options={STATUSES.map((s) => ({
                value: s,
                label: STATUS_LABELS[s],
              }))}
            />
            <EditableField
              label="Priority"
              value={ticket.priority}
              onCommit={(v) =>
                void patchTicket({ priority: v as TicketPriority })
              }
              disabled={patching}
              options={PRIORITIES.map((p) => ({
                value: p,
                label: PRIORITY_LABELS[p],
              }))}
            />
            <EditableField
              label="Category"
              value={ticket.category}
              onCommit={(v) =>
                void patchTicket({ category: v as TicketCategory })
              }
              disabled={patching}
              options={CATEGORIES.map((c) => ({
                value: c,
                label: CATEGORY_LABELS[c],
              }))}
            />
            <div className="grid gap-1.5">
              <span className="text-xs font-medium text-muted-foreground">
                Assignee
              </span>
              <div className="flex items-center gap-2">
                <Badge
                  variant="outline"
                  className="border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300"
                >
                  {ticket.assignee ? ticket.assignee.name : 'Unassigned'}
                </Badge>
                {ticket.assignee?.id !== staff.id ? (
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => void patchTicket({ assigneeId: staff.id })}
                    disabled={patching}
                  >
                    Assign to me
                  </Button>
                ) : (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => void patchTicket({ assigneeId: null })}
                    disabled={patching}
                  >
                    Unassign
                  </Button>
                )}
              </div>
            </div>
          </div>

          {/* Customer */}
          <div className="grid gap-1.5 rounded-md border border-border/60 bg-muted/30 p-3">
            <span className="text-xs font-medium text-muted-foreground">
              Customer
            </span>
            <div className="flex items-center justify-between gap-2">
              <div className="min-w-0">
                <div className="truncate text-sm font-medium">
                  {ticket.customerName ?? 'Anonymous'}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  {ticket.customerEmail}
                </div>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={async () => {
                  try {
                    await navigator.clipboard.writeText(ticket.customerEmail)
                    toast.success('Email copied to clipboard.')
                  } catch {
                    toast.error('Could not copy. Please copy manually.')
                  }
                }}
              >
                <ClipboardCopy className="h-4 w-4" />
                Copy email
              </Button>
            </div>
          </div>

          {/* Original ticket body */}
          <div className="grid gap-1.5">
            <span className="text-xs font-medium text-muted-foreground">
              Original message
            </span>
            <pre className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background p-3 font-sans text-sm">
              {ticket.body}
            </pre>
          </div>
        </CardContent>
      </Card>

      {/* Thread */}
      <div className="mt-5">
        <h2 className="mb-2 text-sm font-semibold">Conversation</h2>
        <ol className="grid gap-2.5">
          {ticket.messages.map((m) => (
            <li key={m.id}>
              <MessageRow message={m} staff={staff} />
            </li>
          ))}
        </ol>
      </div>

      {/* Reply box */}
      <Card className="mt-5">
        <CardHeader>
          <CardTitle className="flex items-center justify-between gap-2 text-base">
            <span>Reply to customer</span>
            {draftFromAI && (
              <Badge
                variant="outline"
                className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400"
              >
                <Sparkles className="h-3 w-3" /> AI-suggested
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-3">
          <Textarea
            id="reply-body"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              // Once the user types, they may have erased the AI draft entirely
              // — clear the flag if they delete everything so a fresh send is
              // recorded as a human reply.
              if (draftFromAI && e.target.value.length === 0) {
                setDraftFromAI(false)
              }
            }}
            rows={6}
            maxLength={LIMITS.MAX_BODY}
            placeholder="Type your reply, or click Suggest a reply to let the AI draft a starting point."
            disabled={sending || drafting}
            aria-label="Reply to customer"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground tabular-nums">
              {draft.length}/{LIMITS.MAX_BODY}
            </span>
            <div className="flex items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                onClick={onAIDraft}
                disabled={drafting || sending}
              >
                {drafting ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Drafting…
                  </>
                ) : (
                  <>
                    <Sparkles className="h-4 w-4" /> Suggest a reply
                  </>
                )}
              </Button>
              <Button
                size="sm"
                onClick={onSendReply}
                disabled={sending || drafting || draft.trim().length === 0}
              >
                {sending ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" /> Sending…
                  </>
                ) : (
                  <>
                    <Send className="h-4 w-4" /> Send reply
                  </>
                )}
              </Button>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Replies are sent to {ticket.customerEmail} as part of the ticket
            thread. Replies are saved and visible to the customer via their
            lookup link.
          </p>
        </CardContent>
      </Card>
    </section>
  )
}

function EditableField({
  label,
  value,
  onCommit,
  disabled,
  options,
}: {
  label: string
  value: string
  onCommit: (v: string) => void
  disabled: boolean
  options: { value: string; label: string }[]
}) {
  return (
    <div className="grid gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      <Select value={value} onValueChange={onCommit} disabled={disabled}>
        <SelectTrigger className="w-full" aria-label={label}>
          <SelectValue />
        </SelectTrigger>
        <SelectContent>
          {options.map((o) => (
            <SelectItem key={o.value} value={o.value}>
              {o.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  )
}

function MessageRow({
  message,
  staff,
}: {
  message: StaffMessageView
  staff: StaffUser
}) {
  if (message.authorRole === 'system') {
    return (
      <article className="rounded-md border border-dashed border-border bg-muted/30 px-3 py-2 text-xs italic text-muted-foreground">
        {message.body}
      </article>
    )
  }

  // Customer (left), staff (right), ai (left, distinct accent).
  const isStaff = message.authorRole === 'staff'
  const isAI = message.authorRole === 'ai'
  const isCustomer = message.authorRole === 'customer'

  const bubbleCls = isStaff
    ? 'border-amber-200 bg-amber-50 dark:border-amber-900 dark:bg-amber-950/40'
    : isAI
    ? 'border-emerald-200 bg-emerald-50 dark:border-emerald-900 dark:bg-emerald-950/40'
    : 'border-zinc-200 bg-zinc-50 dark:border-zinc-800 dark:bg-zinc-900'

  const authorLabel = isStaff
    ? message.staffName ?? 'Staff'
    : isAI
    ? 'AI assistant'
    : isCustomer
    ? message.staffName ?? 'Customer'
    : 'Unknown'

  const authorSub = isStaff
    ? `${message.staffRole ?? 'staff'} · ${message.staffName === staff.name ? 'you' : 'staff'}`
    : isAI
    ? 'draft suggestion'
    : null

  return (
    <article
      className={cn(
        'flex flex-col gap-1 rounded-md border px-3 py-2',
        bubbleCls,
        isStaff ? 'ml-auto max-w-[85%]' : 'mr-auto max-w-[85%]',
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <span className="text-xs font-medium">{authorLabel}</span>
        {isAI && (
          <Badge
            variant="outline"
            className="border-emerald-300 bg-emerald-100 text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950 dark:text-emerald-300"
          >
            <Sparkles className="h-3 w-3" /> AI
          </Badge>
        )}
        {isStaff && message.aiDrafted && (
          <Badge
            variant="outline"
            className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400"
          >
            AI-assisted
          </Badge>
        )}
      </header>
      <pre className="whitespace-pre-wrap break-words font-sans text-sm">
        {message.body}
      </pre>
      <footer className="flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
        <span>{format(new Date(message.createdAt), 'PPp')}</span>
        {authorSub && <span>{authorSub}</span>}
      </footer>
    </article>
  )
}

function TicketDetailSkeleton({ onBack }: { onBack: () => void }) {
  return (
    <section className="container mx-auto max-w-4xl px-4 py-6 sm:px-6 sm:py-8">
      <Button variant="ghost" size="sm" onClick={onBack} className="mb-3">
        <ArrowLeft className="h-4 w-4" /> Back to queue
      </Button>
      <Card>
        <CardHeader>
          <Skeleton className="h-4 w-24" />
          <Skeleton className="mt-2 h-6 w-3/4" />
          <Skeleton className="mt-2 h-3 w-1/2" />
        </CardHeader>
        <CardContent className="grid gap-4">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <Skeleton key={i} className="h-12 w-full" />
            ))}
          </div>
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-32 w-full" />
        </CardContent>
      </Card>
      <div className="mt-5 grid gap-2.5">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-20 w-full" />
        ))}
      </div>
      <Skeleton className="mt-5 h-40 w-full" />
    </section>
  )
}
