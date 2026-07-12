import Dexie, { type EntityTable } from 'dexie'
import dexieCloud from 'dexie-cloud-addon'
import type {
  BackupExport,
  Deliverable,
  Lead,
  Meeting,
  MeetingItem,
  Milestone,
  Note,
  Payment,
  Project,
  Resource,
  Task
} from './types'
import {
  demoLeads,
  demoMeetingItems,
  demoMilestones,
  demoNotes,
  demoPayments,
  demoProjects,
  demoResources,
  demoTasks
} from './seed'
import { nowIso, similarTitles, WORKSPACE_REALM_ID } from './utils'

export const cloudUrl = (import.meta.env.VITE_DEXIE_CLOUD_URL as string | undefined)?.trim()
export const cloudEnabled = Boolean(cloudUrl)

class ImpulseDB extends Dexie {
  projects!: EntityTable<Project, 'id'>
  milestones!: EntityTable<Milestone, 'id'>
  deliverables!: EntityTable<Deliverable, 'id'>
  tasks!: EntityTable<Task, 'id'>
  notes!: EntityTable<Note, 'id'>
  meetings!: EntityTable<Meeting, 'id'>
  meetingItems!: EntityTable<MeetingItem, 'id'>
  leads!: EntityTable<Lead, 'id'>
  payments!: EntityTable<Payment, 'id'>
  resources!: EntityTable<Resource, 'id'>
  backupExports!: EntityTable<BackupExport, 'id'>

  constructor() {
    super('ImpulseCommandCenter', { addons: cloudEnabled ? [dexieCloud] : [] })
    const primaryKey = cloudEnabled ? '@id' : 'id'
    this.version(1).stores({
      projects: `${primaryKey}, realmId, status, clientType, serviceType, order, targetDate, updatedAt, archivedAt`,
      milestones: `${primaryKey}, realmId, projectId, status, dueDate, position, updatedAt, archivedAt`,
      deliverables: `${primaryKey}, realmId, projectId, status, owner, dueDate, updatedAt, archivedAt`,
      tasks: `${primaryKey}, realmId, projectId, status, owner, dueDate, priority, position, updatedAt, archivedAt`,
      notes: `${primaryKey}, realmId, projectId, kind, author, createdAt, updatedAt, archivedAt`,
      meetings: `${primaryKey}, realmId, date, status, updatedAt, archivedAt`,
      meetingItems: `${primaryKey}, realmId, projectId, meetingId, status, owner, dueDate, updatedAt, archivedAt`,
      leads: `${primaryKey}, realmId, stage, owner, followUpDate, updatedAt, archivedAt`,
      payments: `${primaryKey}, realmId, leadId, kind, status, dueDate, groupId, updatedAt, archivedAt`,
      resources: `${primaryKey}, realmId, projectId, type, owner, updatedAt, archivedAt`,
      backupExports: `${primaryKey}, realmId, exportedAt, exportedBy`
    })

    if (cloudEnabled && cloudUrl) {
      this.cloud.configure({ databaseUrl: cloudUrl, requireAuth: true })
    }
  }
}

export const db = new ImpulseDB()

/**
 * Dexie Cloud's "@id" primary keys must start with a table-derived prefix (e.g. "prj" for
 * projects) or every insert throws a ConstraintError — verified against the addon's
 * generateOrVerifyAtKeys check. Locally (no cloud) any string id is fine, so fall back to the
 * old readable prefix there.
 */
export function newId(tableName: keyof typeof db, fallbackPrefix: string) {
  if (cloudEnabled) {
    const prefix = (db.cloud.schema as Record<string, { idPrefix?: string }> | undefined)?.[tableName]?.idPrefix ?? ''
    return `${prefix}${crypto.randomUUID()}`
  }
  return `${fallbackPrefix}-${crypto.randomUUID()}`
}

export async function seedIfEmpty() {
  const count = await db.projects.count()
  if (count > 0 || !import.meta.env.DEV) return

  await db.transaction(
    'rw',
    [db.projects, db.milestones, db.tasks, db.meetingItems, db.leads, db.payments, db.resources, db.notes],
    async () => {
      await db.projects.bulkPut(demoProjects)
      await db.milestones.bulkPut(demoMilestones)
      await db.tasks.bulkPut(demoTasks)
      await db.meetingItems.bulkPut(demoMeetingItems)
      await db.leads.bulkPut(demoLeads)
      await db.payments.bulkPut(demoPayments)
      await db.resources.bulkPut(demoResources)
      await db.notes.bulkPut(demoNotes)
    }
  )
}

const deliverableStatusToMilestone: Record<Deliverable['status'], Milestone['status']> = {
  planned: 'not_started',
  in_production: 'in_progress',
  ready_for_review: 'in_progress',
  approved: 'done',
  delivered: 'done'
}

/**
 * One plan per project: folds any remaining deliverable records into the
 * project's plan as steps flagged `deliverable`, then archives the originals.
 * Idempotent — converted deliverables are archived, so re-runs are no-ops.
 */
export async function convertDeliverablesToPlan() {
  const pending = await db.deliverables.filter((d) => !d.archivedAt).toArray()
  if (!pending.length) return 0

  await db.transaction('rw', [db.deliverables, db.milestones], async () => {
    for (const item of pending) {
      const stamp = nowIso()
      const planSteps = await db.milestones.where('projectId').equals(item.projectId).filter((m) => !m.archivedAt).toArray()
      const match = planSteps.find((step) => similarTitles(step.title, item.title))
      if (match) {
        await db.milestones.update(match.id, {
          deliverable: true,
          dueDate: match.dueDate ?? item.dueDate,
          driveUrl: match.driveUrl ?? item.driveUrl,
          notes: match.notes ?? item.notes,
          updatedAt: stamp
        })
      } else {
        const position = planSteps.reduce((max, step) => Math.max(max, step.position), 0) + 1
        await db.milestones.put({
          id: `milestone-from-${item.id}`,
          realmId: item.realmId ?? WORKSPACE_REALM_ID,
          projectId: item.projectId,
          title: item.title,
          status: deliverableStatusToMilestone[item.status] ?? 'not_started',
          owner: item.owner,
          dueDate: item.dueDate,
          driveUrl: item.driveUrl,
          notes: item.notes,
          deliverable: true,
          position,
          createdAt: item.createdAt,
          updatedAt: stamp,
          createdBy: item.createdBy
        })
      }
      await db.deliverables.update(item.id, { archivedAt: stamp, updatedAt: stamp })
    }
  })
  return pending.length
}

/**
 * Moves each client's legacy single `paid` amount into the new payments list as
 * one received payment, so money history survives the flat-field → list change.
 * Idempotent — guarded by a localStorage flag and skips leads that already have
 * payments, so re-runs are no-ops.
 */
export async function convertPaidToPayments() {
  if (localStorage.getItem('impulse:migrated:payments') === 'done') return 0
  const leads = await db.leads.filter((lead) => Boolean(lead.paid && lead.paid > 0)).toArray()
  let created = 0
  await db.transaction('rw', [db.leads, db.payments], async () => {
    for (const lead of leads) {
      const existing = await db.payments.where('leadId').equals(lead.id).count()
      if (existing > 0) continue
      const stamp = nowIso()
      await db.payments.put({
        id: `payment-from-${lead.id}`,
        realmId: lead.realmId ?? WORKSPACE_REALM_ID,
        leadId: lead.id,
        kind: 'one_off',
        label: 'Paid',
        amount: lead.paid,
        status: 'paid',
        paidDate: lead.updatedAt,
        position: 1,
        createdAt: lead.createdAt,
        updatedAt: stamp,
        createdBy: lead.createdBy
      })
      created += 1
    }
  })
  localStorage.setItem('impulse:migrated:payments', 'done')
  return created
}

export async function deleteProjectPermanently(projectId: string) {
  await db.transaction(
    'rw',
    [db.projects, db.milestones, db.deliverables, db.tasks, db.notes, db.meetingItems, db.resources],
    async () => {
      await Promise.all([
        db.milestones.where('projectId').equals(projectId).delete(),
        db.deliverables.where('projectId').equals(projectId).delete(),
        db.tasks.where('projectId').equals(projectId).delete(),
        db.notes.where('projectId').equals(projectId).delete(),
        db.meetingItems.where('projectId').equals(projectId).delete(),
        db.resources.where('projectId').equals(projectId).delete()
      ])
      await db.projects.delete(projectId)
    }
  )
}

export async function clearLocalData() {
  await db.transaction(
    'rw',
    [db.projects, db.milestones, db.deliverables, db.tasks, db.notes, db.meetings, db.meetingItems, db.leads, db.payments, db.resources, db.backupExports],
    async () => {
      await Promise.all([
        db.projects.clear(), db.milestones.clear(), db.deliverables.clear(), db.tasks.clear(), db.notes.clear(),
        db.meetings.clear(), db.meetingItems.clear(), db.leads.clear(), db.payments.clear(), db.resources.clear(), db.backupExports.clear()
      ])
    }
  )
}
