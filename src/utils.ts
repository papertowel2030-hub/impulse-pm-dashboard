import type { DeliverableStatus, LeadStage, MeetingItemStatus, MilestoneStatus, Payment, PaymentKind, PaymentTiming, TaskStatus } from './types'

export const WORKSPACE_REALM_ID = 'rlm-impulse-workspace'

export const nowIso = () => new Date().toISOString()

export function makeId(prefix: string) {
  return `${prefix}-${crypto.randomUUID()}`
}

export function isOverdue(date?: string) {
  if (!date) return false
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  return new Date(`${date}T00:00:00`) < today
}

export function daysUntil(date?: string) {
  if (!date) return Number.POSITIVE_INFINITY
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const target = new Date(`${date}T00:00:00`)
  return Math.ceil((target.getTime() - today.getTime()) / 86400000)
}

export function daysSince(isoTimestamp: string) {
  return Math.floor((Date.now() - new Date(isoTimestamp).getTime()) / 86400000)
}

export function formatDate(date?: string) {
  if (!date) return 'No date'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' }).format(new Date(`${date}T00:00:00`))
}

export function fullDate(date?: string) {
  if (!date) return 'No date'
  return new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(`${date}T00:00:00`))
}

export function titleCase(value: string) {
  return value.split('_').map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(' ')
}

export const taskStatusLabels: Record<TaskStatus, string> = {
  backlog: 'Todo', next: 'This week', in_progress: 'In progress', waiting: 'Waiting', done: 'Done'
}

export const milestoneStatusLabels: Record<MilestoneStatus, string> = {
  not_started: 'Not started', in_progress: 'In progress', blocked: 'Blocked', done: 'Done'
}

export const deliverableStatusLabels: Record<DeliverableStatus, string> = {
  planned: 'Planned', in_production: 'In production', ready_for_review: 'Ready for review', approved: 'Approved', delivered: 'Delivered'
}

export const meetingStatusLabels: Record<MeetingItemStatus, string> = {
  open: 'Open', decision: 'Decision', action: 'Action', deferred: 'Deferred', closed: 'Closed'
}

// Wording from the original Command Center workbook: lead / writing / meeting / paid / lost.
// Old 7-value records keep their stored stage; the board groups them into five columns.
export const leadStageLabels: Record<LeadStage, string> = {
  prospect: 'Lead', contacted: 'Writing', replied: 'Writing', discovery: 'Meeting', proposal: 'Meeting', won: 'Paid', lost: 'Lost'
}

export const leadStageGroups: { key: string; label: string; stages: LeadStage[]; canonical: LeadStage }[] = [
  { key: 'lead', label: 'Lead', stages: ['prospect'], canonical: 'prospect' },
  { key: 'writing', label: 'Writing', stages: ['contacted', 'replied'], canonical: 'contacted' },
  { key: 'meeting', label: 'Meeting', stages: ['discovery', 'proposal'], canonical: 'discovery' },
  { key: 'paid', label: 'Paid', stages: ['won'], canonical: 'won' },
  { key: 'lost', label: 'Lost', stages: ['lost'], canonical: 'lost' }
]

/** Only allow http(s) links — blocks javascript:/data: URIs from stored link fields. */
export function isSafeUrl(url?: string) {
  if (!url) return false
  try {
    const parsed = new URL(url)
    return parsed.protocol === 'http:' || parsed.protocol === 'https:'
  } catch {
    return false
  }
}

export function normalizeTitle(value: string) {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '')
}

/** True when one title is the other, or contains it ("QA and client-review build" ~ "QA and client review"). */
export function similarTitles(a: string, b: string) {
  const x = normalizeTitle(a)
  const y = normalizeTitle(b)
  if (!x || !y) return false
  return x === y || x.includes(y) || y.includes(x)
}

export function formatMoney(value?: number) {
  if (value === undefined || value === null || Number.isNaN(value)) return ''
  return `₽${new Intl.NumberFormat('ru-RU').format(value)}`
}

export function nearestByDate<T extends { dueDate?: string }>(items: T[]) {
  return items.filter((item) => item.dueDate).sort((a, b) => (a.dueDate ?? '').localeCompare(b.dueDate ?? ''))[0]
}

// ---------- Payments ----------

export const paymentKindLabels: Record<PaymentKind, string> = {
  one_off: 'Payment', retainer: 'Retainer', share: 'Share'
}

// Event-based timing for payments with no fixed calendar date.
export const paymentTimingLabels: Record<PaymentTiming, string> = {
  date: 'On a date', on_start: 'On start', before_delivery: 'Before delivery', on_delivery: 'On delivery', after_delivery: 'After delivery'
}

export function sumReceived(payments: Payment[]) {
  return payments.filter((p) => p.status === 'paid').reduce((total, p) => total + (p.amount ?? 0), 0)
}

export function sumDue(payments: Payment[]) {
  return payments.filter((p) => p.status === 'due' && typeof p.amount === 'number').reduce((total, p) => total + (p.amount ?? 0), 0)
}

/** Nearest unpaid payment that carries a calendar date. */
export function nextPayment(payments: Payment[]) {
  return nearestByDate(payments.filter((p) => p.status === 'due' && p.dueDate))
}

/** Adds whole months to an ISO date (YYYY-MM-DD), keeping day-of-month where possible. */
export function addMonthsIso(date: string, months: number) {
  const base = new Date(`${date}T00:00:00`)
  const day = base.getDate()
  base.setDate(1)
  base.setMonth(base.getMonth() + months)
  const daysInMonth = new Date(base.getFullYear(), base.getMonth() + 1, 0).getDate()
  base.setDate(Math.min(day, daysInMonth))
  const offset = base.getTimezoneOffset() * 60000
  return new Date(base.getTime() - offset).toISOString().slice(0, 10)
}

function monthLabel(date: string) {
  return new Intl.DateTimeFormat('en-GB', { month: 'short', year: 'numeric' }).format(new Date(`${date}T00:00:00`))
}

/** Materialises a recurring arrangement into one dated payment row per month. */
export function generateRecurring(options: {
  leadId: string; realmId: string; kind: PaymentKind; label: string
  amount?: number; percent?: number; startDate: string; count: number; createdBy?: string
}): Payment[] {
  const groupId = makeId('paygroup')
  const stamp = nowIso()
  const count = Math.min(120, Math.max(1, options.count))
  return Array.from({ length: count }, (_, index) => {
    const dueDate = addMonthsIso(options.startDate, index)
    return {
      id: makeId('payment'),
      realmId: options.realmId,
      leadId: options.leadId,
      kind: options.kind,
      label: `${options.label} — ${monthLabel(dueDate)}`,
      amount: options.amount,
      percent: options.percent,
      dueDate,
      status: 'due' as const,
      groupId,
      position: index + 1,
      createdAt: stamp,
      updatedAt: stamp,
      createdBy: options.createdBy
    }
  })
}

export function activeMeetingStatus(status: MeetingItemStatus) {
  return status === 'open' || status === 'deferred'
}
