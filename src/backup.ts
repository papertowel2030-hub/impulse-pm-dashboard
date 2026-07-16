import * as XLSX from 'xlsx'
import { db, newId, recordRealmId } from './db'
import type { Owner } from './types'
import { nowIso } from './utils'

const sheet = <T extends object>(rows: T[]) => XLSX.utils.json_to_sheet(rows)

export async function exportExcelBackup(exportedBy: Owner) {
  const [projects, milestones, deliverables, tasks, notes, meetings, meetingItems, leads, payments, performanceProfiles, performanceMonths, resources] = await Promise.all([
    db.projects.toArray(), db.milestones.toArray(), db.deliverables.toArray(), db.tasks.toArray(), db.notes.toArray(),
    db.meetings.toArray(), db.meetingItems.toArray(), db.leads.toArray(), db.payments.toArray(), db.performanceProfiles.toArray(), db.performanceMonths.toArray(), db.resources.toArray()
  ])

  const businessOf = new Map(leads.map((lead) => [lead.id, lead.business]))
  const paymentRows = payments.map(({ leadId, label, kind, amount, percent, timing, dueDate, status, paidDate }) => ({
    business: businessOf.get(leadId) ?? leadId, label, kind, amount, percent, timing, dueDate, status, paidDate
  }))
  const projectOf = new Map(projects.map((project) => [project.id, project.name]))
  const profileOf = new Map(performanceProfiles.map((profile) => [profile.projectId, profile]))
  const performanceSettingRows = performanceProfiles.map(({ projectId, currency, targetAmount, targetLabel, channels }) => ({
    project: projectOf.get(projectId) ?? projectId, currency, targetAmount, targetLabel,
    channels: JSON.stringify(channels)
  }))
  const performanceRows = performanceMonths.map(({ projectId, month, channelAmounts, expenses, archivedAt }) => {
    const profile = profileOf.get(projectId)
    const totalSales = Object.values(channelAmounts).reduce((sum, value) => sum + value, 0)
    const breakdown = (profile?.channels ?? []).map((channel) => `${channel.label}: ${channelAmounts[channel.id] ?? 0}`).join('; ')
    return { project: projectOf.get(projectId) ?? projectId, month, currency: profile?.currency, channelBreakdown: breakdown, totalSales, expenses, net: totalSales - expenses, channelAmounts: JSON.stringify(channelAmounts), archivedAt }
  })

  const workbook = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(workbook, sheet(projects), 'Projects')
  XLSX.utils.book_append_sheet(workbook, sheet(milestones), 'Plan')
  XLSX.utils.book_append_sheet(workbook, sheet(deliverables), 'Deliverables (legacy)')
  XLSX.utils.book_append_sheet(workbook, sheet(tasks), 'Tasks')
  XLSX.utils.book_append_sheet(workbook, sheet(meetings), 'Meetings')
  XLSX.utils.book_append_sheet(workbook, sheet(meetingItems), 'Agenda Items')
  XLSX.utils.book_append_sheet(workbook, sheet(notes), 'Notes & Decisions')
  XLSX.utils.book_append_sheet(workbook, sheet(leads), 'Clients & Money')
  XLSX.utils.book_append_sheet(workbook, sheet(paymentRows), 'Payments')
  XLSX.utils.book_append_sheet(workbook, sheet(performanceSettingRows), 'Performance Settings')
  XLSX.utils.book_append_sheet(workbook, sheet(performanceRows), 'Monthly Performance')
  XLSX.utils.book_append_sheet(workbook, sheet(resources), 'Links')

  const date = new Date().toISOString().slice(0, 10)
  const filename = `IMPULS-Backup-${date}.xlsx`
  XLSX.writeFile(workbook, filename, { compression: true })

  const recordCount = [projects, milestones, deliverables, tasks, notes, meetings, meetingItems, leads, payments, performanceProfiles, performanceMonths, resources]
    .reduce((sum, rows) => sum + rows.length, 0)

  await db.backupExports.add({
    id: newId('backupExports', 'backup'),
    realmId: recordRealmId(),
    exportedAt: nowIso(),
    exportedBy,
    filename,
    recordCount,
    createdAt: nowIso(),
    updatedAt: nowIso()
  })

  return { filename, recordCount }
}
