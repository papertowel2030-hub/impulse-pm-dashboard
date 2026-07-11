import { convertDeliverablesToPlan, db } from './db'
import type { Deliverable, Lead, Meeting, MeetingItem, Milestone, Note, Payment, Project, Resource, Task } from './types'

interface ImportPackage {
  version: number
  seedProjects?: Project[]
  seedMilestones?: Milestone[]
  seedDeliverables?: Deliverable[]
  seedTasks?: Task[]
  seedLeads?: Lead[]
  seedPayments?: Payment[]
  seedResources?: Resource[]
  seedMeetingItems?: MeetingItem[]
  notes?: Note[]
  meetings?: Meeting[]
}

export async function importWorkspaceFile(file: File) {
  const data = JSON.parse(await file.text()) as ImportPackage
  if (data.version !== 1 || !Array.isArray(data.seedProjects)) throw new Error('This is not a valid Impulse import file.')

  const rows = {
    projects: data.seedProjects,
    milestones: data.seedMilestones ?? [],
    deliverables: data.seedDeliverables ?? [],
    tasks: data.seedTasks ?? [],
    leads: data.seedLeads ?? [],
    payments: data.seedPayments ?? [],
    resources: data.seedResources ?? [],
    meetingItems: data.seedMeetingItems ?? [],
    notes: data.notes ?? [],
    meetings: data.meetings ?? []
  }

  await db.transaction('rw', [db.projects, db.milestones, db.deliverables, db.tasks, db.leads, db.payments, db.resources, db.meetingItems, db.notes, db.meetings], async () => {
    await db.projects.bulkPut(rows.projects)
    await db.milestones.bulkPut(rows.milestones)
    await db.deliverables.bulkPut(rows.deliverables)
    await db.tasks.bulkPut(rows.tasks)
    await db.leads.bulkPut(rows.leads)
    await db.payments.bulkPut(rows.payments)
    await db.resources.bulkPut(rows.resources)
    await db.meetingItems.bulkPut(rows.meetingItems)
    await db.notes.bulkPut(rows.notes)
    await db.meetings.bulkPut(rows.meetings)
  })

  // The app tracks one plan per project; imported deliverables become plan steps.
  await convertDeliverablesToPlan()

  return Object.values(rows).reduce((total, group) => total + group.length, 0)
}
