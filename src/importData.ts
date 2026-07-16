import { cloudEnabled, convertDeliverablesToPlan, db } from './db'
import type { Deliverable, Lead, Meeting, MeetingItem, Milestone, Note, Payment, PerformanceMonth, PerformanceProfile, Project, Resource, Task } from './types'

interface ImportPackage {
  version: number
  seedProjects?: Project[]
  seedMilestones?: Milestone[]
  seedDeliverables?: Deliverable[]
  seedTasks?: Task[]
  seedLeads?: Lead[]
  seedPayments?: Payment[]
  seedPerformanceProfiles?: PerformanceProfile[]
  seedPerformanceMonths?: PerformanceMonth[]
  seedResources?: Resource[]
  seedMeetingItems?: MeetingItem[]
  notes?: Note[]
  meetings?: Meeting[]
}

/**
 * Dexie Cloud's "@id" primary keys must start with a table-derived prefix (e.g. "prj" for
 * projects) or bulkPut throws a ConstraintError. Import files carry plain, readable ids
 * ("project-chaihona") that don't satisfy this, so prefix them deterministically — same
 * source id always maps to the same prefixed id, keeping "same id updates, not duplicates"
 * true on re-import. Locally (no cloud) ids pass through unchanged.
 */
function prefixedId(tableName: keyof typeof db, id: string | undefined) {
  if (!id || !cloudEnabled) return id
  const prefix = (db.cloud.schema as Record<string, { idPrefix?: string }> | undefined)?.[tableName]?.idPrefix
  if (!prefix || id.startsWith(prefix) || id.startsWith(`#${prefix}`)) return id
  return `${prefix}${id}`
}

export async function importWorkspaceFile(file: File, realmId?: string) {
  const data = JSON.parse(await file.text()) as ImportPackage
  if (data.version !== 1 || !Array.isArray(data.seedProjects)) throw new Error('This is not a valid Impulse import file.')
  // Import files carry the old orphan realm id. In cloud mode every record must be re-stamped
  // with the real shared realm the user belongs to, or the whole import would fail to sync.
  if (cloudEnabled && !realmId) throw new Error('Workspace is still connecting. Try again in a moment, then import.')

  const rows = {
    projects: data.seedProjects.map((p) => ({ ...p, id: prefixedId('projects', p.id)!, clientId: prefixedId('leads', p.clientId) })),
    milestones: (data.seedMilestones ?? []).map((m) => ({ ...m, id: prefixedId('milestones', m.id)!, projectId: prefixedId('projects', m.projectId)! })),
    deliverables: (data.seedDeliverables ?? []).map((d) => ({ ...d, id: prefixedId('deliverables', d.id)!, projectId: prefixedId('projects', d.projectId)! })),
    tasks: (data.seedTasks ?? []).map((t) => ({ ...t, id: prefixedId('tasks', t.id)!, projectId: prefixedId('projects', t.projectId)! })),
    leads: (data.seedLeads ?? []).map((l) => ({ ...l, id: prefixedId('leads', l.id)! })),
    payments: (data.seedPayments ?? []).map((p) => ({ ...p, id: prefixedId('payments', p.id)!, leadId: prefixedId('leads', p.leadId)! })),
    performanceProfiles: (data.seedPerformanceProfiles ?? []).map((p) => ({ ...p, id: prefixedId('performanceProfiles', p.id)!, projectId: prefixedId('projects', p.projectId)! })),
    performanceMonths: (data.seedPerformanceMonths ?? []).map((p) => ({ ...p, id: prefixedId('performanceMonths', p.id)!, projectId: prefixedId('projects', p.projectId)! })),
    resources: (data.seedResources ?? []).map((r) => ({ ...r, id: prefixedId('resources', r.id)!, projectId: prefixedId('projects', r.projectId) })),
    meetingItems: (data.seedMeetingItems ?? []).map((mi) => ({ ...mi, id: prefixedId('meetingItems', mi.id)!, projectId: prefixedId('projects', mi.projectId)!, meetingId: prefixedId('meetings', mi.meetingId) })),
    notes: (data.notes ?? []).map((n) => ({ ...n, id: prefixedId('notes', n.id)!, projectId: prefixedId('projects', n.projectId)! })),
    meetings: (data.meetings ?? []).map((m) => ({ ...m, id: prefixedId('meetings', m.id)! }))
  }

  // Re-stamp every imported record into the real shared realm so it belongs to a realm the
  // user actually owns/joined and therefore syncs. (Offline mode keeps the file's own tag.)
  if (cloudEnabled && realmId) {
    for (const group of Object.values(rows)) for (const row of group) (row as { realmId: string }).realmId = realmId
  }

  await db.transaction('rw', [db.projects, db.milestones, db.deliverables, db.tasks, db.leads, db.payments, db.performanceProfiles, db.performanceMonths, db.resources, db.meetingItems, db.notes, db.meetings], async () => {
    await db.projects.bulkPut(rows.projects)
    await db.milestones.bulkPut(rows.milestones)
    await db.deliverables.bulkPut(rows.deliverables)
    await db.tasks.bulkPut(rows.tasks)
    await db.leads.bulkPut(rows.leads)
    await db.payments.bulkPut(rows.payments)
    await db.performanceProfiles.bulkPut(rows.performanceProfiles)
    await db.performanceMonths.bulkPut(rows.performanceMonths)
    await db.resources.bulkPut(rows.resources)
    await db.meetingItems.bulkPut(rows.meetingItems)
    await db.notes.bulkPut(rows.notes)
    await db.meetings.bulkPut(rows.meetings)
  })

  // The app tracks one plan per project; imported deliverables become plan steps.
  await convertDeliverablesToPlan()

  return Object.values(rows).reduce((total, group) => total + group.length, 0)
}
