'use client'

/**
 * CustomerPortal — the public, unauthenticated customer surface.
 *
 * Three tabs:
 *   1. Submit a ticket   → POST /api/tickets
 *   2. Check ticket status → GET /api/tickets/lookup?ref=…&token=…
 *   3. Help me now        → POST /api/chat (AI chatbot)
 *
 * Security notes (mirrored on the API side):
 *  - All customer input is rendered as plain text. React's default escaping
 *    is our XSS defense — we never reach for dangerouslySetInnerHTML.
 *  - The `lookupToken` returned by the submit endpoint is the customer's
 *    only handle on their ticket. We display it once on submit and pre-fill
 *    the lookup form via in-memory state when they click "View my ticket".
 *    We never put it in a URL fragment the browser would persist or log.
 *  - Rate-limit (429) responses render a friendly countdown.
 */

import { useCallback, useEffect, useRef, useState } from 'react'
import { useForm } from 'react-hook-form'
import { zodResolver } from '@hookform/resolvers/zod'
import { z } from 'zod'
import { motion, AnimatePresence } from 'framer-motion'
import { format } from 'date-fns'
import { toast } from 'sonner'
import {
  AlertCircle,
  ArrowRight,
  Bot,
  CheckCircle2,
  ClipboardCopy,
  LifeBuoy,
  Loader2,
  MessageSquarePlus,
  Search,
  Send,
  Sparkles,
  Ticket as TicketIcon,
  TriangleAlert,
  User,
} from 'lucide-react'

import {
  Tabs,
  TabsList,
  TabsTrigger,
  TabsContent,
} from '@/components/ui/tabs'
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/card'
import { Input } from '@/components/ui/input'
import { Textarea } from '@/components/ui/textarea'
import { Label } from '@/components/ui/label'
import { Button } from '@/components/ui/button'
import { Badge } from '@/components/ui/badge'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert'

import { LIMITS } from '@/lib/sanitize'
import { cn } from '@/lib/utils'
import type {
  ChatMessage,
  ChatResult,
  FieldErrors,
  SubmitResult,
  TicketDetail,
  TicketMessageView,
} from './types'

// ============================================================
// Shared display helpers
// ============================================================

const STATUS_LABELS: Record<string, string> = {
  open: 'Open',
  pending: 'Awaiting reply',
  resolved: 'Resolved',
  closed: 'Closed',
}

const PRIORITY_LABELS: Record<string, string> = {
  low: 'Low',
  normal: 'Normal',
  high: 'High',
  urgent: 'Urgent',
}

const CATEGORY_LABELS: Record<string, string> = {
  general: 'General',
  billing: 'Billing',
  bug: 'Bug report',
  account: 'Account',
  feature: 'Feature request',
}

function StatusBadge({ status }: { status: string }) {
  const cls: Record<string, string> = {
    open: 'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400',
    pending: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400',
    resolved: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
    closed: 'border-zinc-200 bg-zinc-50 text-zinc-500 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-500',
  }
  return (
    <Badge variant="outline" className={cls[status] ?? cls.open}>
      {STATUS_LABELS[status] ?? status}
    </Badge>
  )
}

function PriorityBadge({ priority }: { priority: string }) {
  const cls: Record<string, string> = {
    low: 'border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400',
    normal: 'border-zinc-200 bg-zinc-50 text-zinc-700 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-300',
    high: 'border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400',
    urgent: 'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-400',
  }
  return (
    <Badge variant="outline" className={cls[priority] ?? cls.normal}>
      {PRIORITY_LABELS[priority] ?? priority}
    </Badge>
  )
}

function CategoryBadge({ category }: { category: string }) {
  return (
    <Badge variant="outline" className="border-zinc-200 bg-zinc-50 text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
      {CATEGORY_LABELS[category] ?? category}
    </Badge>
  )
}

/**
 * Rate-limit retry countdown.
 *
 * Implemented as a component (not a hook) so the state initializer runs on
 * mount — no synchronous setState-in-effect, which keeps the linter happy
 * and avoids a cascading render. The parent conditionally renders this
 * (only when `rateLimitReset` is set), so each 429 mounts a fresh countdown
 * with the right starting value.
 */
function RetryCountdown({
  seconds,
  onDone,
}: {
  seconds: number
  onDone: () => void
}) {
  const [remaining, setRemaining] = useState(seconds)
  // Hold onDone in a ref so the interval effect can stay mount-only.
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

// ============================================================
// Tab 1 — Submit a ticket
// ============================================================

const ticketSchema = z.object({
  subject: z
    .string()
    .min(3, 'Subject must be at least 3 characters.')
    .max(LIMITS.MAX_SUBJECT, `Subject must be under ${LIMITS.MAX_SUBJECT} characters.`),
  body: z
    .string()
    .min(10, 'Please give us a bit more detail (at least 10 characters).')
    .max(LIMITS.MAX_BODY, `Description must be under ${LIMITS.MAX_BODY} characters.`),
  customerEmail: z
    .string()
    .min(1, 'Email is required.')
    .email('That email address does not look right.'),
  customerName: z
    .string()
    .max(LIMITS.MAX_NAME, `Name must be under ${LIMITS.MAX_NAME} characters.`)
    .optional(),
})

type TicketFormValues = z.infer<typeof ticketSchema>

type SubmitTabProps = {
  onSubmitted: (result: SubmitResult) => void
}

function SubmitTicketForm({ onSubmitted }: SubmitTabProps) {
  const {
    register,
    handleSubmit,
    watch,
    reset,
    formState: { errors },
  } = useForm<TicketFormValues>({
    resolver: zodResolver(ticketSchema),
    defaultValues: {
      subject: '',
      body: '',
      customerEmail: '',
      customerName: '',
    },
  })

  const [category, setCategory] = useState<string>('general')
  const [priority, setPriority] = useState<string>('normal')
  const [submitting, setSubmitting] = useState(false)
  const [serverError, setServerError] = useState<string | null>(null)
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({})
  const [rateLimitReset, setRateLimitReset] = useState<number | null>(null)
  const [success, setSuccess] = useState<SubmitResult | null>(null)

  // Clear inline server field errors the moment the user edits that field.
  const clearFieldError = (field: string) => {
    if (fieldErrors[field]) {
      setFieldErrors((prev) => {
        const next = { ...prev }
        delete next[field]
        return next
      })
    }
  }

  const subjectLen = watch('subject')?.length ?? 0
  const bodyLen = watch('body')?.length ?? 0

  const onSubmit = async (values: TicketFormValues) => {
    setServerError(null)
    setFieldErrors({})
    setSubmitting(true)
    try {
      const res = await fetch('/api/tickets', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...values,
          category,
          priority,
        }),
      })
      const payload: unknown = await res.json().catch(() => null)
      if (res.ok && payload && typeof payload === 'object' && 'data' in payload) {
        const data = (payload as { data: SubmitResult }).data
        setSuccess(data)
        reset()
        setCategory('general')
        setPriority('normal')
        toast.success('Ticket submitted')
        return
      }
      // 422 with field errors
      if (res.status === 422 && payload && typeof payload === 'object' && 'fields' in payload) {
        const fields = (payload as { fields: FieldErrors }).fields ?? {}
        setFieldErrors(fields)
        return
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? '60')
        setRateLimitReset(Math.max(1, retryAfter))
        return
      }
      const msg =
        payload && typeof payload === 'object' && 'error' in payload
          ? String((payload as { error: unknown }).error)
          : "We couldn't submit your ticket. Please try again."
      setServerError(msg)
    } catch {
      setServerError('Network error. Please check your connection and try again.')
    } finally {
      setSubmitting(false)
    }
  }

  // ---- Success view -------------------------------------------------
  if (success) {
    return (
      <SubmitSuccessCard
        result={success}
        onReset={() => setSuccess(null)}
        onView={() => {
          setSuccess(null)
          onSubmitted(success)
        }}
      />
    )
  }

  // ---- Form view ----------------------------------------------------
  const disabled = submitting || rateLimitReset !== null

  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <MessageSquarePlus className="h-5 w-5 text-emerald-600" />
          Submit a ticket
        </CardTitle>
        <CardDescription>
          Tell us what's going on. An agent will reply as soon as possible.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <form
          onSubmit={handleSubmit(onSubmit)}
          className="grid gap-5"
          noValidate
        >
          {/* Subject */}
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="subject">Subject *</Label>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {subjectLen}/{LIMITS.MAX_SUBJECT}
              </span>
            </div>
            <Input
              id="subject"
              autoComplete="off"
              maxLength={LIMITS.MAX_SUBJECT}
              aria-invalid={!!errors.subject || !!fieldErrors.subject}
              disabled={disabled}
              {...register('subject', {
                onChange: () => clearFieldError('subject'),
              })}
              placeholder="A short summary of your issue"
            />
            <FieldError msg={errors.subject?.message ?? fieldErrors.subject ?? null} />
          </div>

          {/* Body */}
          <div className="grid gap-2">
            <div className="flex items-baseline justify-between">
              <Label htmlFor="body">Details *</Label>
              <span className="text-[11px] text-muted-foreground tabular-nums">
                {bodyLen}/{LIMITS.MAX_BODY}
              </span>
            </div>
            <Textarea
              id="body"
              rows={6}
              maxLength={LIMITS.MAX_BODY}
              aria-invalid={!!errors.body || !!fieldErrors.body}
              disabled={disabled}
              {...register('body', {
                onChange: () => clearFieldError('body'),
              })}
              placeholder="What were you trying to do? What happened instead? Any error messages you can paste here help."
            />
            <FieldError msg={errors.body?.message ?? fieldErrors.body ?? null} />
          </div>

          {/* Category + Priority */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="category">Category</Label>
              <Select
                value={category}
                onValueChange={setCategory}
                disabled={disabled}
              >
                <SelectTrigger id="category" className="w-full">
                  <SelectValue placeholder="Pick a category" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="general">General</SelectItem>
                  <SelectItem value="billing">Billing</SelectItem>
                  <SelectItem value="bug">Bug report</SelectItem>
                  <SelectItem value="account">Account</SelectItem>
                  <SelectItem value="feature">Feature request</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label htmlFor="priority">Priority</Label>
              <Select
                value={priority}
                onValueChange={setPriority}
                disabled={disabled}
              >
                <SelectTrigger id="priority" className="w-full">
                  <SelectValue placeholder="Pick a priority" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="low">Low — minor inconvenience</SelectItem>
                  <SelectItem value="normal">Normal — should work</SelectItem>
                  <SelectItem value="high">High — blocking work</SelectItem>
                  <SelectItem value="urgent">Urgent — outage / data loss</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {/* Email + Name */}
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label htmlFor="customerEmail">Email *</Label>
              <Input
                id="customerEmail"
                type="email"
                autoComplete="email"
                aria-invalid={!!errors.customerEmail || !!fieldErrors.customerEmail}
                disabled={disabled}
                {...register('customerEmail', {
                  onChange: () => clearFieldError('customerEmail'),
                })}
                placeholder="you@example.com"
              />
              <FieldError msg={errors.customerEmail?.message ?? fieldErrors.customerEmail ?? null} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="customerName">Name (optional)</Label>
              <Input
                id="customerName"
                autoComplete="name"
                disabled={disabled}
                {...register('customerName')}
                placeholder="What should we call you?"
              />
              <FieldError msg={errors.customerName?.message ?? null} />
            </div>
          </div>

          {/* Footer / actions */}
          {serverError && (
            <Alert variant="destructive">
              <AlertCircle className="h-4 w-4" />
              <AlertTitle>Couldn&apos;t submit</AlertTitle>
              <AlertDescription>{serverError}</AlertDescription>
            </Alert>
          )}
          {rateLimitReset !== null && (
            <Alert>
              <TriangleAlert className="h-4 w-4 text-amber-600" />
              <AlertTitle>Slow down a moment</AlertTitle>
              <AlertDescription>
                You&apos;ve submitted a few tickets in a row. Please wait{' '}
                <RetryCountdown
                  seconds={rateLimitReset}
                  onDone={() => setRateLimitReset(null)}
                />{' '}
                before submitting another.
              </AlertDescription>
            </Alert>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-end">
            <Button type="submit" disabled={disabled} className="sm:w-auto">
              {submitting ? (
                <>
                  <Loader2 className="h-4 w-4 animate-spin" />
                  Submitting…
                </>
              ) : (
                <>
                  Submit ticket
                  <ArrowRight className="h-4 w-4" />
                </>
              )}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            By submitting, you agree we may keep a record of this conversation to
            help you and improve our service. We don&apos;t share your details.
          </p>
        </form>
      </CardContent>
    </Card>
  )
}

function FieldError({ msg }: { msg: string | null | undefined }) {
  if (!msg) return null
  return (
    <p role="alert" className="text-xs text-destructive">
      {msg}
    </p>
  )
}

function SubmitSuccessCard({
  result,
  onReset,
  onView,
}: {
  result: SubmitResult
  onReset: () => void
  onView: () => void
}) {
  const [copied, setCopied] = useState<'ref' | 'token' | null>(null)
  const copy = async (which: 'ref' | 'token', value: string) => {
    try {
      await navigator.clipboard.writeText(value)
      setCopied(which)
      toast.success(which === 'ref' ? 'Reference copied' : 'Token copied')
      setTimeout(() => setCopied(null), 1500)
    } catch {
      toast.error('Could not copy — please copy manually')
    }
  }

  return (
    <Card className="border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/20">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <CheckCircle2 className="h-5 w-5 text-emerald-600" />
          Ticket submitted
        </CardTitle>
        <CardDescription>
          We&apos;ve logged your ticket. Save the details below so you can come
          back to it.
        </CardDescription>
      </CardHeader>
      <CardContent className="grid gap-5">
        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground">Ticket reference</Label>
          <div className="flex items-center gap-2">
            <code className="rounded-md border border-emerald-200 bg-background px-3 py-2 font-mono text-lg font-semibold tracking-wide dark:border-emerald-900">
              {result.ref}
            </code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => copy('ref', result.ref)}
              aria-label="Copy ticket reference"
            >
              <ClipboardCopy className="h-4 w-4" />
            </Button>
            {copied === 'ref' && (
              <CheckCircle2 className="h-4 w-4 text-emerald-600" />
            )}
          </div>
        </div>

        <div className="grid gap-2">
          <Label className="text-xs text-muted-foreground">Your lookup token</Label>
          <div className="flex items-start gap-2">
            <code className="block w-full break-all rounded-md border border-emerald-200 bg-background px-3 py-2 font-mono text-xs dark:border-emerald-900">
              {result.lookupToken}
            </code>
            <Button
              type="button"
              variant="outline"
              size="icon"
              onClick={() => copy('token', result.lookupToken)}
              aria-label="Copy lookup token"
              className="shrink-0"
            >
              <ClipboardCopy className="h-4 w-4" />
            </Button>
          </div>
        </div>

        <Alert>
          <TriangleAlert className="h-4 w-4 text-amber-600" />
          <AlertTitle>Save this token</AlertTitle>
          <AlertDescription>
            You&apos;ll need it (along with the reference) to check your ticket
            status. We don&apos;t email it in this build, and we can&apos;t
            recover it if you lose it.
          </AlertDescription>
        </Alert>

        <div className="flex flex-col gap-2 sm:flex-row sm:justify-end">
          <Button type="button" variant="ghost" onClick={onReset}>
            Submit another
          </Button>
          <Button type="button" onClick={onView}>
            View my ticket
            <ArrowRight className="h-4 w-4" />
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ============================================================
// Tab 2 — Check ticket status
// ============================================================

const lookupSchema = z.object({
  ref: z.string().min(1, 'Enter your ticket reference.'),
  token: z.string().min(1, 'Enter your lookup token.'),
})

type LookupFormValues = z.infer<typeof lookupSchema>

type LookupTabProps = {
  prefillRef?: string
  prefillToken?: string
  onSwitchToSubmit?: () => void
}

function LookupTicketForm({
  prefillRef = '',
  prefillToken = '',
  onSwitchToSubmit,
}: LookupTabProps) {
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LookupFormValues>({
    resolver: zodResolver(lookupSchema),
    defaultValues: { ref: prefillRef, token: prefillToken },
  })

  const [loading, setLoading] = useState(false)
  const [notFound, setNotFound] = useState(false)
  const [rateLimitReset, setRateLimitReset] = useState<number | null>(null)
  const [ticket, setTicket] = useState<TicketDetail | null>(null)
  // The lookup API deliberately omits `lookupToken` from its response (we
  // never echo it back). The customer-reply composer needs the token the
  // customer typed, so we capture it here at lookup time and thread it down.
  // Stays stable across re-renders until a new lookup replaces it.
  const [lookupTokenForReply, setLookupTokenForReply] = useState('')

  const doLookup = useCallback(async (values: LookupFormValues) => {
    setLoading(true)
    setNotFound(false)
    setTicket(null)
    setLookupTokenForReply('')
    try {
      const params = new URLSearchParams({
        ref: values.ref.trim().toUpperCase(),
        token: values.token.trim(),
      })
      const res = await fetch(`/api/tickets/lookup?${params.toString()}`, {
        method: 'GET',
      })
      const payload: unknown = await res.json().catch(() => null)
      if (res.ok && payload && typeof payload === 'object' && 'data' in payload) {
        setTicket((payload as { data: TicketDetail }).data)
        // Capture the token the customer just typed — needed for the
        // reply composer. Trim to match the API's own normalisation.
        setLookupTokenForReply(values.token.trim())
        return
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? '60')
        setRateLimitReset(Math.max(1, retryAfter))
        return
      }
      // 404 (no such ref OR wrong token) → same neutral message.
      setNotFound(true)
    } catch {
      setNotFound(true)
    } finally {
      setLoading(false)
    }
  }, [])

  // Auto-fetch when both prefill values are present (i.e. user just clicked
  // "View my ticket" on the submit tab). `didAutoFetch` guards against a
  // double-fire under React 18+ StrictMode in dev.
  const didAutoFetch = useRef(false)
  useEffect(() => {
    if (didAutoFetch.current) return
    if (prefillRef && prefillToken) {
      didAutoFetch.current = true
      void doLookup({ ref: prefillRef, token: prefillToken })
    }
  }, [prefillRef, prefillToken, doLookup])

  const disabled = loading || rateLimitReset !== null

  return (
    <div className="grid gap-4">
      <Card className="border-border/60 shadow-sm">
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-lg">
            <Search className="h-5 w-5 text-emerald-600" />
            Check ticket status
          </CardTitle>
          <CardDescription>
            Enter the reference and lookup token you got when you submitted
            your ticket.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form
            onSubmit={handleSubmit(doLookup)}
            className="grid gap-4"
            noValidate
          >
            <div className="grid gap-2">
              <Label htmlFor="ref">Ticket reference</Label>
              <Input
                id="ref"
                autoCapitalize="characters"
                autoComplete="off"
                disabled={disabled}
                aria-invalid={!!errors.ref}
                {...register('ref')}
                placeholder="HD-AB12CD"
              />
              <FieldError msg={errors.ref?.message ?? null} />
            </div>
            <div className="grid gap-2">
              <Label htmlFor="token">Lookup token</Label>
              <Input
                id="token"
                autoComplete="off"
                disabled={disabled}
                aria-invalid={!!errors.token}
                {...register('token')}
                placeholder="Paste the long token you were given"
                className="font-mono text-xs"
              />
              <FieldError msg={errors.token?.message ?? null} />
            </div>

            {notFound && (
              <Alert>
                <AlertCircle className="h-4 w-4" />
                <AlertTitle>We couldn&apos;t find that ticket</AlertTitle>
                <AlertDescription>
                  Check your reference and token and try again. The token is
                  case-sensitive — copy it exactly as it was shown to you.
                </AlertDescription>
              </Alert>
            )}
            {rateLimitReset !== null && (
              <Alert>
                <TriangleAlert className="h-4 w-4 text-amber-600" />
                <AlertTitle>Slow down a moment</AlertTitle>
                <AlertDescription>
                  Please wait{' '}
                  <RetryCountdown
                    seconds={rateLimitReset}
                    onDone={() => setRateLimitReset(null)}
                  />{' '}
                  before trying again.
                </AlertDescription>
              </Alert>
            )}

            <div className="flex justify-end">
              <Button type="submit" disabled={disabled}>
                {loading ? (
                  <>
                    <Loader2 className="h-4 w-4 animate-spin" />
                    Looking up…
                  </>
                ) : (
                  <>
                    <Search className="h-4 w-4" />
                    Look up ticket
                  </>
                )}
              </Button>
            </div>
          </form>
        </CardContent>
      </Card>

      {ticket && (
        <TicketDetailCard
          ticket={ticket}
          lookupToken={lookupTokenForReply}
          onReplySent={(msg) =>
            setTicket((cur) =>
              cur
                ? {
                    ...cur,
                    // Customer reply reopens the ticket (server does the same).
                    status: 'open',
                    messages: [...cur.messages, msg],
                  }
                : cur,
            )
          }
          onSwitchToSubmit={onSwitchToSubmit}
        />
      )}
    </div>
  )
}

// We need the raw token the customer typed (the API deliberately omits
// lookupToken from the response — never expose it back). Watch the field
// via `register` and grab its value when needed for the reply call.
type TicketDetailCardProps = {
  ticket: TicketDetail
  lookupToken: string
  onReplySent: (msg: TicketMessageView) => void
  onSwitchToSubmit?: () => void
}

function TicketDetailCard({
  ticket,
  lookupToken,
  onReplySent,
  onSwitchToSubmit,
}: TicketDetailCardProps) {
  const created = new Date(ticket.createdAt)
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.2 }}
    >
      <Card className="border-border/60 shadow-sm">
        <CardHeader>
          <div className="flex flex-wrap items-start gap-3">
            <div className="grid gap-1">
              <CardTitle className="text-lg leading-snug">
                {ticket.subject}
              </CardTitle>
              <CardDescription className="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span className="font-mono text-xs">{ticket.ref}</span>
                <span aria-hidden>·</span>
                <span>Opened {format(created, 'd MMM yyyy, h:mm a')}</span>
              </CardDescription>
            </div>
            <div className="ml-auto flex flex-wrap items-center gap-1.5">
              <StatusBadge status={ticket.status} />
              <PriorityBadge priority={ticket.priority} />
              <CategoryBadge category={ticket.category} />
            </div>
          </div>
        </CardHeader>
        <CardContent className="grid gap-6">
          <section className="grid gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Your original message
            </h3>
            <pre className="whitespace-pre-wrap break-words rounded-md border border-border/60 bg-muted/30 p-4 font-sans text-sm leading-relaxed">
              {ticket.body}
            </pre>
          </section>

          <section className="grid gap-3" aria-label="Message thread">
            <h3 className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">
              Conversation ({ticket.messages.length})
            </h3>
            {/* aria-live so screen readers announce new messages as they
                are appended (e.g. the customer's optimistic reply, or a
                staff reply picked up on a future refetch). */}
            <ol
              className="grid gap-3"
              aria-live="polite"
              aria-label="Conversation messages"
            >
              {ticket.messages.map((m) => (
                <li key={m.id}>
                  <MessageRow
                    role={m.authorRole}
                    body={m.body}
                    createdAt={new Date(m.createdAt)}
                    aiDrafted={m.aiDrafted}
                  />
                </li>
              ))}
            </ol>
          </section>

          {/* Reply box — only on tickets staff are still actively working.
              `resolved` and `closed` are both read-only from the customer
              side; the server enforces the same on POST (409). */}
          {ticket.status === 'open' || ticket.status === 'pending' ? (
            <ReplyComposer
              ref_={ticket.ref}
              lookupToken={lookupToken}
              onSent={onReplySent}
            />
          ) : (
            <ClosedTicketNote
              status={
                ticket.status === 'resolved' ? 'resolved' : 'closed'
              }
              onSwitchToSubmit={onSwitchToSubmit}
            />
          )}
        </CardContent>
      </Card>
    </motion.div>
  )
}

/**
 * Read-only ticket notice. Shown in place of the reply box when the
 * ticket is no longer accepting customer follow-ups (`closed` or
 * `resolved`). Offers a one-tap jump back to the Submit tab so the
 * customer can file a fresh ticket without losing context. Wording
 * varies slightly by status.
 */
function ClosedTicketNote({
  status = 'closed',
  onSwitchToSubmit,
}: {
  status?: 'closed' | 'resolved'
  onSwitchToSubmit?: () => void
}) {
  const isResolved = status === 'resolved'
  return (
    <Alert>
      <TicketIcon className="h-4 w-4 text-muted-foreground" />
      <AlertTitle>
        {isResolved ? 'This ticket is resolved' : 'This ticket is closed'}
      </AlertTitle>
      <AlertDescription className="flex flex-col gap-2">
        {isResolved ? (
          <span>
            We&apos;ve marked this ticket as resolved. If you still need
            help, please submit a new ticket above.
          </span>
        ) : (
          <span>
            If you still need help, please submit a new ticket above — we
            won&apos;t reopen closed tickets automatically.
          </span>
        )}
        {onSwitchToSubmit && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-fit"
            onClick={onSwitchToSubmit}
          >
            <MessageSquarePlus className="h-4 w-4" />
            Submit a new ticket
          </Button>
        )}
      </AlertDescription>
    </Alert>
  )
}

/**
 * Customer reply composer — a follow-up from the customer on their own
 * ticket. This is the customer-side mirror of the staff reply box, but
 * visually distinct (neutral zinc accent, smaller, with a "your reply is
 * visible to staff + anyone with the token" helper line) so it's clear
 * this is the customer's own follow-up, not a staff reply.
 *
 * Contract with the API (POST /api/tickets/[ref]/reply, body `{token, body}`):
 *  - 201 `{ok:true, data:{messageId}}` → build the message view
 *    client-side (the API returns only the id) and optimistic-append it
 *    to the thread via `onSent`, clear the textarea, success toast.
 *  - 404 (missing ref OR wrong token) → neutral toast: "We couldn't find
 *    that ticket. Try re-entering your reference and token." — do NOT
 *    distinguish (enumeration closure, same as the lookup endpoint).
 *  - 409 (ticket is closed/resolved) → toast with the server's message +
 *    hide the composer (re-render as the read-only note).
 *  - 422 (body validation) → inline error above the textarea.
 *  - 429 (rate limited) → RetryCountdown (same component the rest of the
 *    surface uses).
 *  - 5xx / network → toast "Something went wrong. Please try again."
 *    Keep the typed text so the user can retry without retyping.
 */
function ReplyComposer({
  ref_,
  lookupToken,
  onSent,
}: {
  ref_: string
  lookupToken: string
  onSent: (msg: TicketMessageView) => void
}) {
  const [body, setBody] = useState('')
  const [sending, setSending] = useState(false)
  const [fieldError, setFieldError] = useState<string | null>(null)
  const [rateLimitReset, setRateLimitReset] = useState<number | null>(null)
  const [closed, setClosed] = useState(false)

  const onSend = async () => {
    const trimmed = body.trim()
    if (!trimmed || sending || rateLimitReset !== null) return
    setSending(true)
    setFieldError(null)
    try {
      const res = await fetch(
        `/api/tickets/${encodeURIComponent(ref_)}/reply`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ token: lookupToken, body: trimmed }),
        },
      )
      const payload: unknown = await res.json().catch(() => null)

      if (
        res.status === 201 &&
        payload &&
        typeof payload === 'object' &&
        'data' in payload
      ) {
        const data = (payload as { data: { messageId: string } }).data
        // Optimistic append — the API returns only the id, so we build
        // the view client-side with the trimmed body the customer just
        // sent and the server's id (a subsequent lookup de-dupes by id).
        onSent({
          id: data.messageId,
          authorRole: 'customer',
          body: trimmed,
          createdAt: new Date().toISOString(),
          aiDrafted: false,
        })
        setBody('')
        toast.success("Reply sent — we'll get back to you.")
        return
      }
      if (
        res.status === 422 &&
        payload &&
        typeof payload === 'object' &&
        'error' in payload
      ) {
        const err = (payload as { error: unknown }).error
        setFieldError(
          typeof err === 'string' && err ? err : 'Please write a bit more.',
        )
        return
      }
      if (res.status === 409) {
        // Server says the ticket is now closed/resolved (race with a
        // staff close/resolve). Toast the server's message and hide the
        // composer so the read-only note renders in its place.
        toast.error(
          'This ticket is closed. Please open a new ticket if you need more help.',
        )
        setClosed(true)
        return
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? '60')
        setRateLimitReset(Math.max(1, retryAfter))
        return
      }
      if (res.status === 404) {
        // Missing ref OR wrong token — same neutral message as the lookup
        // endpoint. Do NOT distinguish (enumeration closure).
        toast.error(
          "We couldn't find that ticket. Try re-entering your reference and token.",
        )
        return
      }
      // 5xx / unknown
      toast.error('Something went wrong. Please try again.')
    } catch {
      toast.error('Something went wrong. Please try again.')
    } finally {
      setSending(false)
    }
  }

  if (closed) {
    return <ClosedTicketNote />
  }

  const disabled = sending || rateLimitReset !== null
  const empty = body.trim().length === 0

  return (
    <section
      className="grid gap-3 rounded-lg border border-border/60 bg-muted/20 p-4"
      aria-label="Add a reply"
    >
      <div className="grid gap-1">
        <Label
          htmlFor="reply-body"
          className="text-xs font-semibold uppercase tracking-wide text-muted-foreground"
        >
          Add a reply
        </Label>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Your reply will be visible to support staff working this ticket,
          and to anyone with this ticket&apos;s reference and lookup token.
        </p>
      </div>

      {fieldError && (
        <p role="alert" className="text-xs text-destructive">
          {fieldError}
        </p>
      )}

      <Textarea
        id="reply-body"
        value={body}
        onChange={(e) => {
          setBody(e.target.value)
          if (fieldError) setFieldError(null)
        }}
        rows={4}
        maxLength={LIMITS.MAX_BODY}
        placeholder="Type your reply…"
        disabled={disabled}
        aria-invalid={!!fieldError}
        className="resize-y"
      />

      <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
        <span className="text-[11px] text-muted-foreground tabular-nums">
          {body.length}/{LIMITS.MAX_BODY}
        </span>
        <Button
          type="button"
          size="sm"
          onClick={onSend}
          disabled={disabled || empty}
          className="sm:w-auto"
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

      {rateLimitReset !== null && (
        <Alert>
          <TriangleAlert className="h-4 w-4 text-amber-600" />
          <AlertDescription>
            You&apos;ve sent a few replies in a row. Please wait{' '}
            <RetryCountdown
              seconds={rateLimitReset}
              onDone={() => setRateLimitReset(null)}
            />{' '}
            before sending another.
          </AlertDescription>
        </Alert>
      )}
    </section>
  )
}

function MessageRow({
  role,
  body,
  createdAt,
  aiDrafted,
}: {
  role: string
  body: string
  createdAt: Date
  aiDrafted: boolean
}) {
  // Visual treatment per role. Customer = neutral, staff = amber accent,
  // AI = emerald accent + AI badge, system = subtle gray italic.
  const isStaff = role === 'staff'
  const isAi = role === 'ai'
  const isSystem = role === 'system'
  const isCustomer = role === 'customer'

  const authorLabel: Record<string, string> = {
    customer: 'You',
    staff: 'Support agent',
    ai: 'AI assistant',
    system: 'System',
  }

  return (
    <div
      className={cn(
        'rounded-lg border p-3',
        isStaff && 'border-amber-200 bg-amber-50/40 dark:border-amber-900 dark:bg-amber-950/10',
        isAi && 'border-emerald-200 bg-emerald-50/40 dark:border-emerald-900 dark:bg-emerald-950/10',
        isSystem && 'border-dashed border-border/60 bg-muted/20',
        isCustomer && 'border-border/60 bg-background',
      )}
    >
      <div className="mb-1.5 flex flex-wrap items-center gap-2">
        <span className="inline-flex items-center gap-1 text-xs font-medium">
          {isAi && <Bot className="h-3.5 w-3.5 text-emerald-600" />}
          {isStaff && <LifeBuoy className="h-3.5 w-3.5 text-amber-600" />}
          {isCustomer && <User className="h-3.5 w-3.5 text-muted-foreground" />}
          {isSystem && <TicketIcon className="h-3.5 w-3.5 text-muted-foreground" />}
          {authorLabel[role] ?? role}
        </span>
        {isAi && (
          <Badge variant="outline" className="border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400">
            AI
          </Badge>
        )}
        {isStaff && aiDrafted && (
          <Badge variant="outline" className="border-amber-200 bg-amber-50 text-amber-700 dark:border-amber-900 dark:bg-amber-950/40 dark:text-amber-400">
            AI-drafted
          </Badge>
        )}
        <span className="ml-auto text-[11px] text-muted-foreground tabular-nums">
          {format(createdAt, 'd MMM, h:mm a')}
        </span>
      </div>
      <pre
        className={cn(
          'whitespace-pre-wrap break-words font-sans text-sm leading-relaxed',
          isSystem && 'italic text-muted-foreground',
        )}
      >
        {body}
      </pre>
    </div>
  )
}

// ============================================================
// Tab 3 — AI chatbot
// ============================================================

type UiChatMessage = ChatMessage & { id: string; pending?: boolean }

function newId(): string {
  return Math.random().toString(36).slice(2, 10)
}

function ChatAssistant() {
  const [messages, setMessages] = useState<UiChatMessage[]>([])
  const [input, setInput] = useState('')
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [rateLimitReset, setRateLimitReset] = useState<number | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)

  // Auto-scroll to newest message.
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, sending])

  const send = useCallback(async () => {
    const text = input.trim()
    if (!text || sending || rateLimitReset !== null) return

    setError(null)
    const userMsg: UiChatMessage = { id: newId(), role: 'user', content: text }
    // Send only role+content to the API (UI-local id is dropped).
    const apiMessages: ChatMessage[] = [
      ...messages.map((m) => ({ role: m.role, content: m.content })),
      { role: 'user', content: text },
    ]
    setMessages((prev) => [...prev, userMsg])
    setInput('')
    setSending(true)

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ messages: apiMessages }),
      })
      const payload: unknown = await res.json().catch(() => null)
      if (res.ok && payload && typeof payload === 'object' && 'data' in payload) {
        const data = (payload as { data: ChatResult }).data
        if (data.reply) {
          setMessages((prev) => [
            ...prev,
            { id: newId(), role: 'assistant', content: data.reply as string },
          ])
        } else {
          // AI unavailable — graceful fallback message in-thread.
          setMessages((prev) => [
            ...prev,
            {
              id: newId(),
              role: 'assistant',
              content:
                "I'm having trouble responding right now. Please submit a ticket above and an agent will follow up.",
            },
          ])
        }
        return
      }
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('Retry-After') ?? '60')
        setRateLimitReset(Math.max(1, retryAfter))
        return
      }
      setError("I'm having trouble responding right now. Please try again in a moment.")
    } catch {
      setError('Network error. Please check your connection and try again.')
    } finally {
      setSending(false)
      // Refocus the input for follow-up questions.
      requestAnimationFrame(() => inputRef.current?.focus())
    }
  }, [input, messages, sending, rateLimitReset])

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      void send()
    }
  }

  const disabled = sending || rateLimitReset !== null
  const empty = messages.length === 0

  return (
    <Card className="border-border/60 shadow-sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-lg">
          <Sparkles className="h-5 w-5 text-emerald-600" />
          Help me now
        </CardTitle>
        <CardDescription>
          Ask our assistant a quick question — it can help with common issues
          before an agent picks up.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Alert className="mb-4">
          <Bot className="h-4 w-4" />
          <AlertTitle>Heads up</AlertTitle>
          <AlertDescription>
            This assistant doesn&apos;t know your account or billing details.
            For anything sensitive, submit a ticket above and an agent will
            follow up.
          </AlertDescription>
        </Alert>

        {/* Conversation */}
        <div
          ref={listRef}
          aria-live="polite"
          aria-label="Conversation with assistant"
          className={cn(
            'mb-3 max-h-96 min-h-48 overflow-y-auto rounded-lg border border-border/60 bg-muted/20 p-3',
            '[&::-webkit-scrollbar]:w-2 [&::-webkit-scrollbar-thumb]:rounded-full [&::-webkit-scrollbar-thumb]:bg-border [&::-webkit-scrollbar-track]:bg-transparent',
          )}
        >
          {empty ? (
            <div className="grid h-48 place-items-center text-center text-sm text-muted-foreground">
              <div className="grid gap-2">
                <Bot className="mx-auto h-8 w-8 text-emerald-600" />
                <p>Ask me anything — like &ldquo;How do I reset my password?&rdquo;</p>
              </div>
            </div>
          ) : (
            <ul className="grid gap-3">
              {messages.map((m) => (
                <li
                  key={m.id}
                  className={cn(
                    'flex',
                    m.role === 'user' ? 'justify-end' : 'justify-start',
                  )}
                >
                  <div
                    className={cn(
                      'max-w-[85%] rounded-2xl px-3.5 py-2 text-sm leading-relaxed',
                      m.role === 'user'
                        ? 'bg-primary text-primary-foreground'
                        : 'border border-emerald-200 bg-emerald-50 text-foreground dark:border-emerald-900 dark:bg-emerald-950/30',
                    )}
                  >
                    {m.role === 'assistant' && (
                      <div className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-emerald-700 dark:text-emerald-400">
                        <Bot className="h-3 w-3" />
                        Assistant
                      </div>
                    )}
                    <p className="whitespace-pre-wrap break-words">{m.content}</p>
                  </div>
                </li>
              ))}
              {sending && (
                <li className="flex justify-start">
                  <div className="flex items-center gap-1.5 rounded-2xl border border-emerald-200 bg-emerald-50 px-3.5 py-2.5 dark:border-emerald-900 dark:bg-emerald-950/30">
                    <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500" />
                    <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500 [animation-delay:150ms]" />
                    <span className="h-2 w-2 animate-pulse rounded-full bg-emerald-500 [animation-delay:300ms]" />
                    <span className="sr-only">Assistant is typing</span>
                  </div>
                </li>
              )}
            </ul>
          )}
        </div>

        {/* Errors */}
        <AnimatePresence>
          {error && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0 }}
              className="mb-3"
            >
              <Alert variant="destructive">
                <AlertCircle className="h-4 w-4" />
                <AlertDescription>{error}</AlertDescription>
              </Alert>
            </motion.div>
          )}
          {rateLimitReset !== null && (
            <div className="mb-3">
              <Alert>
                <TriangleAlert className="h-4 w-4 text-amber-600" />
                <AlertDescription>
                  Please wait{' '}
                  <RetryCountdown
                    seconds={rateLimitReset}
                    onDone={() => setRateLimitReset(null)}
                  />{' '}
                  before sending another message.
                </AlertDescription>
              </Alert>
            </div>
          )}
        </AnimatePresence>

        {/* Composer */}
        <div className="flex items-end gap-2">
          <Textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={onKeyDown}
            rows={2}
            placeholder="Type your question…  (Enter to send, Shift+Enter for a new line)"
            disabled={disabled}
            className="min-h-12 max-h-48 resize-y"
            aria-label="Message to assistant"
          />
          <Button
            type="button"
            onClick={send}
            disabled={disabled || !input.trim()}
            aria-label="Send message"
            className="h-auto shrink-0 self-stretch"
          >
            {sending ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Send className="h-4 w-4" />
            )}
            <span className="sr-only sm:not-sr-only sm:ml-1">Send</span>
          </Button>
        </div>
      </CardContent>
    </Card>
  )
}

// ============================================================
// Top-level portal
// ============================================================

type Tab = 'submit' | 'lookup' | 'chat'

export function CustomerPortal() {
  const [tab, setTab] = useState<Tab>('submit')
  // When a ticket is submitted, we hand its ref+token to the lookup tab so
  // the customer can jump straight to viewing it without retyping.
  const [prefill, setPrefill] = useState<{ ref: string; token: string } | null>(null)
  // Bump on each prefill to force the lookup form to remount with the new
  // defaults (and re-trigger its auto-fetch effect).
  const [lookupNonce, setLookupNonce] = useState(0)

  const handleSubmitted = (result: SubmitResult) => {
    setPrefill({ ref: result.ref, token: result.lookupToken })
    setLookupNonce((n) => n + 1)
    setTab('lookup')
  }

  return (
    <section className="container mx-auto max-w-3xl px-4 py-8 sm:px-6 sm:py-10">
      {/* Hero */}
      <div className="mb-6 grid gap-1.5 text-center sm:mb-8">
        <div className="mx-auto inline-flex items-center gap-1.5 rounded-full border border-emerald-200 bg-emerald-50 px-3 py-0.5 text-[11px] font-medium text-emerald-700 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-400">
          <LifeBuoy className="h-3 w-3" />
          Customer support
        </div>
        <h1 className="text-2xl font-semibold tracking-tight sm:text-3xl">
          How can we help?
        </h1>
        <p className="mx-auto max-w-xl text-sm text-muted-foreground">
          Submit a ticket, check on one you&apos;ve already opened, or chat with
          our assistant. No account needed.
        </p>
      </div>

      <Tabs value={tab} onValueChange={(v) => setTab(v as Tab)} className="grid gap-6">
        <TabsList className="grid w-full grid-cols-3 h-auto">
          <TabsTrigger value="submit" className="flex-col gap-1 py-2 text-xs sm:flex-row sm:text-sm">
            <MessageSquarePlus className="h-4 w-4" />
            <span>Submit</span>
          </TabsTrigger>
          <TabsTrigger value="lookup" className="flex-col gap-1 py-2 text-xs sm:flex-row sm:text-sm">
            <Search className="h-4 w-4" />
            <span>Status</span>
          </TabsTrigger>
          <TabsTrigger value="chat" className="flex-col gap-1 py-2 text-xs sm:flex-row sm:text-sm">
            <Sparkles className="h-4 w-4" />
            <span>Help me now</span>
          </TabsTrigger>
        </TabsList>

        <TabsContent value="submit" className="outline-none">
          <SubmitTicketForm onSubmitted={handleSubmitted} />
        </TabsContent>

        <TabsContent value="lookup" className="outline-none">
          {/* `key` forces remount on each new prefill so the form picks up
              the new defaults and re-runs its auto-fetch effect. */}
          <LookupTicketForm
            key={lookupNonce}
            prefillRef={prefill?.ref}
            prefillToken={prefill?.token}
            onSwitchToSubmit={() => setTab('submit')}
          />
        </TabsContent>

        <TabsContent value="chat" className="outline-none">
          <ChatAssistant />
        </TabsContent>
      </Tabs>
    </section>
  )
}
