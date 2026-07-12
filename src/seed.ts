import type { Lead, MeetingItem, Milestone, Note, Payment, Project, Resource, Task } from './types'
import { LEGACY_REALM_ID } from './utils'

const stamp = '2026-01-01T00:00:00.000Z'
// DEV-only demo data; the realm tag is just a local grouping label (never syncs in dev seed).
const base = { realmId: LEGACY_REALM_ID, createdAt: stamp, updatedAt: stamp, createdBy: 'Demo' }

// Development-only relative dates so deadline views have content to show.
const inDays = (days: number) => {
  const date = new Date()
  date.setDate(date.getDate() + days)
  return date.toISOString().slice(0, 10)
}

// Generic development-only examples. Real client records are never bundled into production.
export const demoProjects: Project[] = [
  { ...base, id: 'demo-restaurant', name: 'Restaurant presence', clientType: 'client', serviceType: 'social_local', status: 'active', goal: 'Build a trusted local presence that turns searches into visits.', currentFocus: 'Complete the listing foundation and approve the first content plan.', phase: 'Foundation', color: '#ffb86b', order: 1 },
  { ...base, id: 'demo-website', name: 'Company website', clientType: 'client', serviceType: 'website', status: 'active', goal: 'Launch a clear, credible website that generates enquiries.', currentFocus: 'Complete the homepage and prepare it for review.', phase: 'Website build', color: '#7aa2f7', order: 2 },
  { ...base, id: 'demo-studio', name: 'Studio operations', clientType: 'internal', serviceType: 'studio', status: 'active', goal: 'Keep sales and delivery work simple, visible and consistent.', currentFocus: 'Prepare the next outreach batch and partner meeting.', phase: 'Operations', color: '#5fe0a8', order: 3 }
]

const templates: Record<Project['serviceType'], { title: string; deliverable?: boolean }[]> = {
  social_local: [
    { title: 'Discovery and access' },
    { title: 'Local listings', deliverable: true },
    { title: 'Content foundation', deliverable: true },
    { title: 'Publishing and review' },
    { title: 'Reporting', deliverable: true }
  ],
  website: [
    { title: 'Discovery and scope' },
    { title: 'Content and structure' },
    { title: 'Design', deliverable: true },
    { title: 'Build', deliverable: true },
    { title: 'QA and launch', deliverable: true }
  ],
  studio: [
    { title: 'Portfolio', deliverable: true },
    { title: 'Sales materials' },
    { title: 'Outreach rhythm' },
    { title: 'Operating review' }
  ]
}

export const demoMilestones: Milestone[] = demoProjects.flatMap((project) =>
  templates[project.serviceType].map((step, index) => ({
    ...base,
    id: `demo-milestone-${project.id}-${index}`,
    projectId: project.id,
    title: step.title,
    status: (index === 0 ? 'done' : index === 1 ? 'in_progress' : 'not_started') as Milestone['status'],
    owner: 'Moon + Kira' as const,
    position: index + 1,
    deliverable: step.deliverable,
    dueDate: index === 1 ? inDays(10) : undefined
  }))
)

export const demoTasks: Task[] = [
  { ...base, id: 'demo-task-review', projectId: 'demo-website', title: 'Review homepage on mobile', owner: 'Moon', status: 'next', priority: 'normal', position: 1, dueDate: inDays(2) },
  { ...base, id: 'demo-task-access', projectId: 'demo-restaurant', title: 'Confirm listing access', owner: 'Kira', status: 'waiting', priority: 'normal', position: 1, dueDate: inDays(-1) },
  { ...base, id: 'demo-task-posts', projectId: 'demo-studio', title: 'Portfolio posts — VK / TG', owner: 'Kira', status: 'next', priority: 'normal', position: 2 }
]

export const demoMeetingItems: MeetingItem[] = [
  { ...base, id: 'demo-agenda-pricing', projectId: 'demo-studio', title: 'Agree next outreach focus', status: 'open', owner: 'Moon + Kira' }
]

export const demoLeads: Lead[] = [
  { ...base, id: 'demo-lead-cafe', business: 'Neighbourhood cafe', owner: 'Kira', stage: 'prospect', nextAction: 'Research and decide whether to contact' },
  { ...base, id: 'demo-lead-salon', business: 'Beauty salon', owner: 'Kira', stage: 'contacted', nextAction: 'Follow up on the intro message', followUpDate: inDays(3), tariff: 'Landing', quoted: 25000 },
  { ...base, id: 'demo-lead-fitness', business: 'Fitness studio', owner: 'Moon', stage: 'won', nextAction: 'Start the project', tariff: 'Catalog', quoted: 60000, paid: 30000 }
]

// Beauty salon: a paid deposit plus a dated balance still owed. Fitness studio's
// legacy `paid` becomes a payment through the one-time convertPaidToPayments migration.
export const demoPayments: Payment[] = [
  { ...base, id: 'demo-pay-salon-deposit', leadId: 'demo-lead-salon', kind: 'one_off', label: 'Deposit', amount: 10000, status: 'paid', paidDate: inDays(-5), position: 1 },
  { ...base, id: 'demo-pay-salon-balance', leadId: 'demo-lead-salon', kind: 'one_off', label: 'Balance', amount: 15000, status: 'due', dueDate: inDays(6), position: 2 }
]

export const demoResources: Resource[] = [
  { ...base, id: 'demo-link-portfolio', projectId: 'demo-studio', type: 'Portfolio', name: 'Portfolio site', url: 'https://example.com/portfolio', owner: 'Moon' },
  { ...base, id: 'demo-link-figma', projectId: 'demo-website', type: 'Tool', name: 'Figma — homepage', url: 'https://figma.com/file/example', owner: 'Moon' }
]

export const demoNotes: Note[] = [
  { ...base, id: 'demo-idea-pitch', projectId: 'demo-studio', title: 'Two pitch tracks', body: 'Has a website: show before/after. No website: meeting + PPT pitch.', kind: 'idea', author: 'Moon' },
  { ...base, id: 'demo-decision-handle', projectId: 'demo-studio', title: 'One TG handle everywhere', body: 'Agreed to use a single Telegram handle across all channels before launch.', kind: 'decision', author: 'Moon + Kira' }
]
