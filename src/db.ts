import Dexie, { type EntityTable, type Table } from 'dexie'
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
import { LEGACY_REALM_ID, nowIso, similarTitles, WORKSPACE_REALM_NAME } from './utils'

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

// The id of the real shared realm this device writes into, resolved once the user is logged
// in and the realm is known (see useWorkspaceRealm). New records are stamped with it so they
// belong to a realm the user actually owns/joined and therefore sync. Undefined until resolved
// (offline-only mode leaves it undefined, which routes records to the private realm).
let activeRealmId: string | undefined
export function getActiveRealmId() { return activeRealmId }
export function setActiveRealmId(realmId?: string) { activeRealmId = realmId }

// The realm id to stamp on a new record. When cloud sync is off there are no realms, so we
// return the legacy tag purely as a local grouping label (it never leaves the device anyway).
// In cloud mode the workspace realm must already be resolved — callers are gated behind that,
// so a missing id is a real invariant violation and we fail loud instead of silently writing
// an orphaned record that would never sync.
export function recordRealmId(): string {
  if (!cloudEnabled) return LEGACY_REALM_ID
  if (!activeRealmId) throw new Error('Workspace is still connecting. Try again in a moment.')
  return activeRealmId
}

/**
 * Creates the real shared workspace realm. Dexie Cloud assigns a valid "rlm…" id and makes
 * the creator its owner (owner is stamped at write time). Only the workspace owner should
 * call this, and only when no shared realm exists yet.
 */
export async function createWorkspaceRealm(): Promise<string> {
  return (await (db as any).realms.add({ name: WORKSPACE_REALM_NAME })) as string
}

/**
 * Moves any local records still tagged with the old orphan realm id into the real shared
 * realm so they finally sync. Best-effort and idempotent.
 *
 * Critically, it only issues a modify on tables that ACTUALLY hold legacy records. A blanket
 * `.modify()` scoped to the legacy realm is logged by Dexie Cloud as a sync mutation even when
 * it matches nothing — and because that mutation references a realm the server doesn't know,
 * the server rejects it and it jams the outbox forever. So we count first and skip empty
 * tables entirely: with no legacy data anywhere, this does nothing and creates no mutations.
 */
export async function restampLegacyRealm(newRealmId: string) {
  const tables = [db.projects, db.milestones, db.deliverables, db.tasks, db.notes, db.meetings, db.meetingItems, db.leads, db.payments, db.resources] as unknown as Table<any>[]
  const legacyCounts = await Promise.all(tables.map((table) => table.where('realmId').equals(LEGACY_REALM_ID).count()))
  const toMigrate = tables.filter((_, index) => legacyCounts[index] > 0)
  if (!toMigrate.length) return
  const stamp = nowIso()
  await db.transaction('rw', toMigrate, async () => {
    for (const table of toMigrate) {
      await table.where('realmId').equals(LEGACY_REALM_ID).modify({ realmId: newRealmId, updatedAt: stamp })
    }
  })
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
          id: newId('milestones', 'milestone'),
          realmId: item.realmId ?? recordRealmId(),
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
        id: newId('payments', 'payment'),
        realmId: lead.realmId ?? recordRealmId(),
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

/**
 * Deletes this browser's entire local copy of the database, including Dexie Cloud's
 * pending-sync outbox and stored login. Use to recover when records saved by an older
 * build carry invalid (unprefixed) IDs and jam the sync queue on every refresh. Records
 * that already reached the cloud sync back down on the next load; the stuck ones do not.
 */
export async function resetLocalData() {
  await db.delete()
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
