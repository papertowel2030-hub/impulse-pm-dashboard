export type ProjectStatus = 'active' | 'paused' | 'completed' | 'archived'
export type MilestoneStatus = 'not_started' | 'in_progress' | 'blocked' | 'done'
export type DeliverableStatus = 'planned' | 'in_production' | 'ready_for_review' | 'approved' | 'delivered'
export type TaskStatus = 'backlog' | 'next' | 'in_progress' | 'waiting' | 'done'
export type Priority = 'low' | 'normal' | 'high'
export type MeetingItemStatus = 'open' | 'decision' | 'action' | 'deferred' | 'closed'
export type LeadStage = 'prospect' | 'contacted' | 'replied' | 'discovery' | 'proposal' | 'won' | 'lost'
export type Owner = 'Moon' | 'Kira' | 'Moon + Kira'
export type PaymentKind = 'one_off' | 'retainer' | 'share'
export type PaymentTiming = 'date' | 'on_start' | 'before_delivery' | 'on_delivery' | 'after_delivery'
export type PaymentStatus = 'due' | 'paid'

export interface BaseRecord {
  id: string
  realmId: string
  createdAt: string
  updatedAt: string
  createdBy?: string
  updatedBy?: string
  archivedAt?: string
}

export interface Project extends BaseRecord {
  /** Optional client/opportunity this delivery project belongs to. */
  clientId?: string
  name: string
  clientType: 'client' | 'internal'
  serviceType: 'social_local' | 'website' | 'studio'
  status: ProjectStatus
  goal: string
  currentFocus: string
  phase: string
  targetDate?: string
  driveFolderUrl?: string
  color: string
  order: number
}

export interface Milestone extends BaseRecord {
  projectId: string
  title: string
  status: MilestoneStatus
  owner: Owner
  dueDate?: string
  position: number
  notes?: string
  /** Marks a plan step whose result the client receives. */
  deliverable?: boolean
  driveUrl?: string
}

export interface Deliverable extends BaseRecord {
  projectId: string
  title: string
  status: DeliverableStatus
  owner: Owner
  dueDate?: string
  driveUrl?: string
  notes?: string
}

export interface Task extends BaseRecord {
  projectId: string
  title: string
  status: TaskStatus
  owner: Owner
  dueDate?: string
  priority: Priority
  notes?: string
  driveUrl?: string
  position: number
  /** Meeting topic that produced this task, when applicable. */
  sourceMeetingItemId?: string
}

export interface Note extends BaseRecord {
  projectId: string
  title: string
  body: string
  kind: 'note' | 'decision' | 'idea'
  author: Owner
  /** Meeting topic that produced this decision, when applicable. */
  sourceMeetingItemId?: string
}

export interface Meeting extends BaseRecord {
  title: string
  date: string
  summary?: string
  status: 'draft' | 'completed'
}

export interface MeetingItem extends BaseRecord {
  projectId: string
  meetingId?: string
  title: string
  notes?: string
  status: MeetingItemStatus
  owner: Owner
  dueDate?: string
}

export interface Lead extends BaseRecord {
  business: string
  website?: string
  contact?: string
  owner: Owner
  stage: LeadStage
  tariff?: string
  serviceInterest?: string
  source?: string
  lastContactDate?: string
  nextAction?: string
  followUpDate?: string
  quoted?: number
  paid?: number
  notes?: string
}

export interface Payment extends BaseRecord {
  leadId: string
  kind: PaymentKind
  label: string
  amount?: number
  percent?: number
  timing?: PaymentTiming
  dueDate?: string
  status: PaymentStatus
  paidDate?: string
  groupId?: string
  note?: string
  position: number
}

export interface Resource extends BaseRecord {
  projectId?: string
  type: string
  name: string
  url: string
  owner: Owner
  notes?: string
}

export interface PerformanceChannel {
  id: string
  label: string
  position: number
  archivedAt?: string
}

/** One optional performance configuration per project. An unarchived profile enables the feature. */
export interface PerformanceProfile extends BaseRecord {
  projectId: string
  currency: string
  targetAmount?: number
  targetLabel?: string
  channels: PerformanceChannel[]
}

/** Verified totals for one completed calendar month. */
export interface PerformanceMonth extends BaseRecord {
  projectId: string
  month: string
  channelAmounts: Record<string, number>
  expenses: number
}

export interface BackupExport extends BaseRecord {
  exportedAt: string
  exportedBy: Owner
  filename: string
  recordCount: number
}

export type ModalKind = 'task' | 'note' | 'idea' | 'discussion' | 'milestone' | 'deliverable' | 'lead' | 'link' | null
export type ViewName = 'home' | 'projects' | 'sales' | 'meeting' | 'settings'
export type ProjectTab = 'overview' | 'plan' | 'board' | 'notes' | 'links' | 'performance'
