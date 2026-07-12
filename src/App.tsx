import { useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Archive, CalendarDays, Check, ChevronDown, ChevronRight, CloudOff, Download, ExternalLink,
  FileCheck2, FolderKanban, Home, Lightbulb, Link2, LogIn, LogOut, Menu, MessageSquareText, NotebookPen,
  Pencil, Plus, Repeat, Settings, Star, Target, Trash2, Upload, UserPlus, Users, Wallet, X
} from 'lucide-react'
import { db, cloudEnabled, newId, recordRealmId, getActiveRealmId, setActiveRealmId, createWorkspaceRealm, restampLegacyRealm, seedIfEmpty, convertDeliverablesToPlan, convertPaidToPayments, deleteProjectPermanently, resetLocalData } from './db'
import { importWorkspaceFile } from './importData'
import type {
  Lead, LeadStage, MeetingItem, MeetingItemStatus, Milestone, MilestoneStatus, ModalKind, Note,
  Owner, Payment, PaymentKind, PaymentTiming, Priority, Project, ProjectTab, Resource, Task, TaskStatus, ViewName
} from './types'
import {
  activeMeetingStatus, addMonthsIso, daysSince, daysUntil, formatDate, formatMoney, fullDate, generateRecurring,
  isOverdue, isSafeUrl, leadStageGroups, makeId, meetingStatusLabels, milestoneStatusLabels, nearestByDate, nextPayment,
  nowIso, paymentTimingLabels, resolveWorkspaceRealmId, sumDue, sumReceived, taskStatusLabels
} from './utils'

const paymentTimings = Object.keys(paymentTimingLabels) as PaymentTiming[]

const owners: Owner[] = ['Moon', 'Kira', 'Moon + Kira']
const taskStatuses = Object.keys(taskStatusLabels) as TaskStatus[]
const milestoneStatuses = Object.keys(milestoneStatusLabels) as MilestoneStatus[]
const projectColors = ['#2ee6ff', '#ffb86b', '#7aa2f7', '#5fe0a8', '#ff8585', '#c3a6ff', '#ffd166', '#93a7c4']

const ownerShort: Record<Owner, string> = { Moon: 'M', Kira: 'K', 'Moon + Kira': 'M+K' }

interface ToastState { message: string; action?: { label: string; run: () => void } }
interface ModalState { kind: ModalKind; projectId?: string; recordId?: string }
interface ProjectModalState { projectId?: string }

function usePersistedState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? '') as T } catch { return fallback }
  })
  useEffect(() => { localStorage.setItem(key, JSON.stringify(value)) }, [key, value])
  return [value, setValue] as const
}

function useCloudUser() {
  const [user, setUser] = useState<any>(null)
  useEffect(() => {
    if (!cloudEnabled) return
    const cloud = (db as any).cloud
    const subscription = cloud.currentUser.subscribe((next: any) => setUser(next))
    return () => subscription?.unsubscribe?.()
  }, [])
  return user
}

/**
 * Plain-language sync status, so "did my edits actually reach the server" never needs
 * devtools to answer. Pending count mirrors what Dexie Cloud's own logout-confirmation
 * dialog counts: rows still sitting in each table's "_mutations" outbox.
 */
function useSyncStatus() {
  const [syncState, setSyncState] = useState<{ status: string; phase: string; error?: string } | null>(null)
  useEffect(() => {
    if (!cloudEnabled) return
    const subscription = (db as any).cloud.syncState.subscribe((next: any) =>
      setSyncState({ status: next.status, phase: next.phase, error: next.error?.message ?? (next.error ? String(next.error) : undefined) })
    )
    return () => subscription?.unsubscribe?.()
  }, [])
  const breakdown = useLiveQuery(async () => {
    if (!cloudEnabled) return { total: 0, byTable: '' }
    const mutationTables = db.tables.filter((t) => t.name.endsWith('_mutations'))
    const counts = await Promise.all(mutationTables.map(async (t) => [t.name.replace(/^\$/, '').replace(/_mutations$/, ''), await t.count()] as const))
    const nonZero = counts.filter(([, c]) => c > 0)
    return { total: nonZero.reduce((s, [, c]) => s + c, 0), byTable: nonZero.map(([n, c]) => `${n}:${c}`).join(' ') }
  }, [], { total: 0, byTable: '' })
  return { phase: syncState?.phase, status: syncState?.status, error: syncState?.error, pending: breakdown?.total ?? 0, byTable: breakdown?.byTable ?? '' }
}

// Owner identity is stored as a hash, not plaintext, so the real email never ships in the public bundle.
const ownerEmailHashes = ((import.meta.env.VITE_OWNER_EMAIL_HASHES as string | undefined) ?? '')
  .split(',').map((hash) => hash.trim().toLowerCase()).filter(Boolean)

async function sha256Hex(text: string) {
  const buffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return Array.from(new Uint8Array(buffer)).map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function useIsOwner(email?: string) {
  const [isOwner, setIsOwner] = useState(false)
  useEffect(() => {
    let cancelled = false
    if (!email || !ownerEmailHashes.length) { setIsOwner(false); return }
    sha256Hex(email.trim().toLowerCase()).then((hash) => { if (!cancelled) setIsOwner(ownerEmailHashes.includes(hash)) })
    return () => { cancelled = true }
  }, [email])
  return isOwner
}

// Maps a signed-in member's hashed email to their real name, e.g. "hash1:Moon,hash2:Kira" —
// so who a record is attributed to comes from who is actually logged in, not a self-picked label.
const memberNameByHash: Record<string, Owner> = ((import.meta.env.VITE_MEMBER_EMAIL_HASHES as string | undefined) ?? '')
  .split(',').map((pair) => pair.trim()).filter(Boolean)
  .reduce((map, pair) => {
    const [hash, name] = pair.split(':').map((part) => part.trim())
    if (hash && (name === 'Moon' || name === 'Kira')) map[hash.toLowerCase()] = name
    return map
  }, {} as Record<string, Owner>)

function useLoggedInIdentity(email?: string): Owner | undefined {
  const [identity, setIdentity] = useState<Owner | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    if (!email || !Object.keys(memberNameByHash).length) { setIdentity(undefined); return }
    sha256Hex(email.trim().toLowerCase()).then((hash) => { if (!cancelled) setIdentity(memberNameByHash[hash]) })
    return () => { cancelled = true }
  }, [email])
  return identity
}

const activityTables = ['tasks', 'notes', 'milestones', 'meetingItems', 'leads', 'payments', 'resources'] as const

/**
 * Shows each invited partner's real status: whether they've accepted the invite (Dexie
 * Cloud tracks this on the realm member record), and when they last saved something —
 * the closest honest signal available, since Dexie Cloud doesn't expose live presence
 * for other devices, only for the current one.
 */
function PartnerStatus({ ownEmail, realmId }: { ownEmail?: string; realmId?: string }) {
  const members = useLiveQuery(
    () => cloudEnabled && realmId ? (db as any).members.where('realmId').equals(realmId).toArray() : Promise.resolve([]),
    [realmId], []
  ) as any[] | undefined
  const partners = (members ?? []).filter((m) => m.email && m.email.toLowerCase() !== ownEmail?.trim().toLowerCase())
  if (!partners.length) return null
  return <div className="partner-status-list">{partners.map((member) => <PartnerStatusRow key={member.id ?? member.email} member={member} />)}</div>
}

function PartnerStatusRow({ member }: { member: any }) {
  const [name, setName] = useState<Owner | undefined>(undefined)
  useEffect(() => {
    let cancelled = false
    if (!member.email) return
    sha256Hex(member.email.trim().toLowerCase()).then((hash) => { if (!cancelled) setName(memberNameByHash[hash]) })
    return () => { cancelled = true }
  }, [member.email])

  const lastActive = useLiveQuery(async () => {
    if (!name) return undefined
    const rows = (await Promise.all(activityTables.map((table) => (db as any)[table].filter((r: any) => r.createdBy === name).toArray()))).flat()
    if (!rows.length) return undefined
    return rows.reduce((latest: string, r: any) => (r.updatedAt > latest ? r.updatedAt : latest), rows[0].updatedAt)
  }, [name], undefined)

  const acceptedAt = member.accepted ? new Date(member.accepted) : undefined
  const status = acceptedAt ? `Accepted ${fullDate(acceptedAt.toISOString())}` : member.rejected ? 'Invite declined' : 'Invite pending — hasn’t signed in yet'
  return <p className="partner-status-row"><strong>{name ?? member.email}</strong> · {status}{lastActive ? ` · last saved something ${fullDate(lastActive)}` : acceptedAt ? ' · no activity yet' : ''}</p>
}

type AccessState = 'authorized' | 'signed-out' | 'checking' | 'denied'
type RealmStatus = 'loading' | 'ready' | 'none'

/**
 * Resolves the one real shared realm Moon + Kira collaborate in. The workspace realm is the
 * single realm the user belongs to that isn't their own private realm. If the owner has none
 * yet, it's created once. The resolved id is pushed to db.ts so new records get stamped with
 * it, and any records still carrying the old orphan realm id are migrated across.
 */
function useWorkspaceRealm(isCloudLoggedIn: boolean, isOwner: boolean, userId?: string): { realmId?: string; status: RealmStatus; error?: string } {
  const realms = useLiveQuery(
    () => cloudEnabled && isCloudLoggedIn ? (db as any).realms.toArray() : Promise.resolve([]),
    [isCloudLoggedIn], undefined
  ) as any[] | undefined
  // See resolveWorkspaceRealmId (utils.ts) for why PUBLIC_REALM_ID must be excluded here —
  // that exclusion has its own unit tests since it can't be exercised without a live Dexie
  // Cloud connection otherwise.
  const realmId = resolveWorkspaceRealmId(realms, userId)
  const creatingRef = useRef(false)
  const restampedRef = useRef(false)
  const [createError, setCreateError] = useState<string | undefined>(undefined)

  // Publish the resolved id to the record stamper and migrate any orphaned local records in.
  // A brand-new realm exists locally the instant db.realms.add() resolves, well before that
  // creation has reached the server — pushing first ensures the server has actually committed
  // the realm before we fire a burst of writes that reference it. Guarded to run at most once
  // so a re-resolving realmId can't re-trigger the migration.
  useEffect(() => {
    setActiveRealmId(cloudEnabled ? realmId : undefined)
    if (!realmId || !cloudEnabled || restampedRef.current) return
    restampedRef.current = true
    ;(async () => {
      try { await (db as any).cloud.sync({ purpose: 'push', wait: true }) } catch { /* offline: restamp still queues locally */ }
      await restampLegacyRealm(realmId).catch(() => {})
    })()
  }, [realmId])

  // Owner bootstrap: create the shared realm exactly once when logged in and none exists yet.
  // Local IndexedDB starts empty on a fresh device, before anything has been pulled from the
  // server — so we force a pull sync first and re-check, instead of racing ahead and creating
  // a duplicate realm every time the app boots on a device that hasn't synced yet.
  useEffect(() => {
    if (!cloudEnabled || !isCloudLoggedIn || realms === undefined) return
    if (realmId || !isOwner || creatingRef.current) return
    creatingRef.current = true
    ;(async () => {
      try { await (db as any).cloud.sync({ purpose: 'pull', wait: true }) } catch { /* offline: fall back to local state below */ }
      const freshRealms: any[] = await (db as any).realms.toArray()
      if (resolveWorkspaceRealmId(freshRealms, userId)) { creatingRef.current = false; return }
      try { await createWorkspaceRealm() }
      catch (error) {
        creatingRef.current = false
        setCreateError(error instanceof Error ? error.message : String(error))
      }
    })()
  }, [isCloudLoggedIn, realms, realmId, isOwner])

  const status: RealmStatus =
    !cloudEnabled ? 'ready'
    : !isCloudLoggedIn || realms === undefined ? 'loading'
    : realmId ? 'ready'
    : createError ? 'none'
    : isOwner || creatingRef.current ? 'loading'
    : 'none'
  return { realmId, status, error: createError }
}

function useWorkspaceAccess(isCloudLoggedIn: boolean, realmStatus: RealmStatus): AccessState {
  // Access now follows real realm membership: you're in once you belong to (or, as owner,
  // have created) the shared workspace realm — no record-counting guesswork.
  const [pastGracePeriod, setPastGracePeriod] = useState(false)

  useEffect(() => {
    setPastGracePeriod(false)
    if (!cloudEnabled || !isCloudLoggedIn || realmStatus !== 'none') return
    const timer = window.setTimeout(() => setPastGracePeriod(true), 8000)
    return () => window.clearTimeout(timer)
  }, [isCloudLoggedIn, realmStatus])

  if (!cloudEnabled) return 'authorized'
  if (!isCloudLoggedIn) return 'signed-out'
  if (realmStatus === 'ready') return 'authorized'
  if (realmStatus === 'loading') return 'checking'
  return pastGracePeriod ? 'denied' : 'checking'
}

export default function App() {
  const [view, setView] = usePersistedState<ViewName>('impulse:view', 'home')
  const [selectedProjectId, setSelectedProjectId] = usePersistedState<string>('impulse:project', '')
  // Offline/dev fallback only — once cloud sync is on, identity comes from who is actually
  // logged in (below), not a self-picked label, so attribution can't be spoofed.
  const [localUser, setLocalUser] = usePersistedState<Owner>('impulse:user', 'Moon')
  const [projectTab, setProjectTab] = useState<ProjectTab>('overview')
  const [modal, setModal] = useState<ModalState>({ kind: null })
  const [projectModal, setProjectModal] = useState<ProjectModalState | null>(null)
  const [toast, setToast] = useState<ToastState | null>(null)
  const [menuOpen, setMenuOpen] = useState(false)
  const [mobileNavOpen, setMobileNavOpen] = useState(false)
  const cloudUser = useCloudUser()
  const isCloudLoggedIn = !cloudEnabled || Boolean(cloudUser?.isLoggedIn)
  const isOwner = useIsOwner(cloudEnabled ? cloudUser?.email : undefined)
  const loggedInIdentity = useLoggedInIdentity(cloudEnabled ? cloudUser?.email : undefined)
  const currentUser: Owner = cloudEnabled ? (loggedInIdentity ?? 'Moon + Kira') : localUser
  const { realmId: workspaceRealmId, status: realmStatus, error: realmError } = useWorkspaceRealm(isCloudLoggedIn, isOwner, cloudUser?.userId)
  const access = useWorkspaceAccess(isCloudLoggedIn, realmStatus)
  const signOut = async () => {
    // No force: Dexie Cloud's own logout warns and asks for confirmation first if this
    // device has edits that haven't synced yet, instead of silently discarding them.
    try { await (db as any).cloud.logout() }
    catch (error) { if (!(error instanceof Error && error.message.includes('cancelled'))) throw error }
  }

  useEffect(() => {
    if (access !== 'authorized') return
    seedIfEmpty()
      .then(() => convertDeliverablesToPlan())
      .then(() => convertPaidToPayments())
      .catch((error) => setToast({ message: `Could not prepare workspace: ${error.message}` }))
  }, [access])

  useEffect(() => {
    if (!toast) return
    const timer = window.setTimeout(() => setToast(null), 5000)
    return () => window.clearTimeout(timer)
  }, [toast])

  const projects = useLiveQuery(() => db.projects.filter((project) => !project.archivedAt).toArray(), [], [])

  if (access === 'signed-out') return <LoginScreen />
  if (access === 'checking') return <CheckingAccessScreen />
  if (access === 'denied' && isOwner && realmError) return <WorkspaceSetupErrorScreen error={realmError} />
  if (access === 'denied') return <NotAuthorizedScreen email={cloudUser?.email} />

  const navigate = (next: ViewName) => {
    setView(next)
    setMobileNavOpen(false)
    setMenuOpen(false)
  }

  const openProject = (id: string) => {
    setSelectedProjectId(id)
    setProjectTab('overview')
    setView('projects')
  }

  const openQuickAdd = (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => {
    const inheritedProject = projects.find((project) => project.id === selectedProjectId)?.id ?? projects[0]?.id
    setModal({ kind, projectId: projectId ?? inheritedProject, recordId })
  }

  return (
    <div className="app-shell">
      <a href="#main" className="skip-link">Skip to content</a>
      <aside className={`sidebar ${mobileNavOpen ? 'is-open' : ''}`} aria-label="Primary navigation">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">⌁</span>
          <span><strong>Impulse</strong><small>Command Center</small></span>
        </div>
        <nav>
          <NavButton active={view === 'home'} icon={<Home />} label="Home" onClick={() => navigate('home')} />
          <NavButton active={view === 'projects'} icon={<FolderKanban />} label="Projects" onClick={() => navigate('projects')} />
          <NavButton active={view === 'sales'} icon={<Target />} label="Clients & Money" onClick={() => navigate('sales')} />
          <NavButton active={view === 'meeting'} icon={<MessageSquareText />} label="Next Meeting" onClick={() => navigate('meeting')} />
        </nav>
        <div className="sidebar-projects" aria-label="Active projects">
          <p>Active projects</p>
          {projects.filter((p) => p.status === 'active').sort((a, b) => a.order - b.order).map((project) => (
            <button key={project.id} onClick={() => openProject(project.id)} className={selectedProjectId === project.id && view === 'projects' ? 'selected' : ''}>
              <span className="project-dot" style={{ background: project.color }} />{project.name}
            </button>
          ))}
          <button className="sidebar-new" onClick={() => { setProjectModal({}); setMobileNavOpen(false) }}><Plus /> New project</button>
        </div>
        <button className="sidebar-settings" onClick={() => navigate('settings')}><Settings /> Settings</button>
      </aside>

      <div className="app-main">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Toggle navigation" onClick={() => setMobileNavOpen(!mobileNavOpen)}><Menu /></button>
          <div className="topbar-context">
            <span>{view === 'meeting' ? 'Partner workspace' : 'Impulse Workspace'}</span>
            {!navigator.onLine && <span className="sync-state"><CloudOff /> Offline</span>}
          </div>
          <div className="topbar-actions">
            <QuickAdd onSelect={(kind) => openQuickAdd(kind)} />
            <div className="user-menu-wrap">
              <button className="user-button" onClick={() => setMenuOpen(!menuOpen)} aria-expanded={menuOpen}>
                <span className="avatar">{ownerShort[currentUser]}</span>
                <span className="user-name">{currentUser}</span><ChevronDown />
              </button>
              {menuOpen && (
                <div className="user-menu">
                  {cloudEnabled ? (
                    <>
                      <p>Signed in as</p>
                      <p className="user-menu-email">{cloudUser?.email ?? currentUser}</p>
                    </>
                  ) : (
                    <>
                      <p>Working as</p>
                      {owners.slice(0, 2).map((owner) => <button key={owner} onClick={() => { setLocalUser(owner); setMenuOpen(false) }}>{owner}{currentUser === owner && <Check />}</button>)}
                    </>
                  )}
                  <hr />
                  <button onClick={() => navigate('settings')}><Settings /> Settings</button>
                  {cloudEnabled && isCloudLoggedIn && <button onClick={() => { setMenuOpen(false); signOut() }}><LogOut /> Log out</button>}
                </div>
              )}
            </div>
          </div>
        </header>

        <main id="main">
          {view === 'home' && <HomeView openProject={openProject} navigate={navigate} />}
          {view === 'projects' && (
            <ProjectsView
              selectedProjectId={selectedProjectId}
              setSelectedProjectId={setSelectedProjectId}
              tab={projectTab}
              setTab={setProjectTab}
              openAdd={openQuickAdd}
              openProjectEdit={(id) => setProjectModal({ projectId: id })}
              setToast={setToast}
            />
          )}
          {view === 'sales' && <ClientsView openModal={(recordId) => setModal({ kind: 'lead', recordId })} addLead={() => setModal({ kind: 'lead' })} />}
          {view === 'meeting' && <MeetingView currentUser={currentUser} setToast={setToast} openProject={openProject} openEdit={openQuickAdd} />}
          {view === 'settings' && <SettingsView currentUser={currentUser} isOwner={isOwner} email={cloudUser?.email} realmId={workspaceRealmId} onSignOut={signOut} setToast={setToast} />}
        </main>
      </div>

      {modal.kind && <EntryModal state={modal} currentUser={currentUser} onClose={() => setModal({ kind: null })} setToast={setToast} />}
      {projectModal && <ProjectModal state={projectModal} onClose={() => setProjectModal(null)} setToast={setToast} openProject={openProject} />}
      {toast && <Toast toast={toast} close={() => setToast(null)} />}
    </div>
  )
}

function LoginScreen() {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const login = async () => {
    setBusy(true); setError('')
    try { await (db as any).cloud.login({ grant_type: 'otp' }) }
    catch (err) { setError(err instanceof Error ? err.message : 'Could not start sign in.') }
    finally { setBusy(false) }
  }
  return (
    <main className="login-screen">
      <div className="login-card">
        <span className="brand-mark large">⌁</span>
        <p className="eyebrow">Impulse workspace</p>
        <h1>Your projects, without the noise.</h1>
        <p>Sign in with the code sent to your email. There is no password to remember.</p>
        <button className="primary-button wide" onClick={login} disabled={busy}><LogIn /> {busy ? 'Opening sign in…' : 'Continue with email'}</button>
        {error && <p className="form-error">{error}</p>}
      </div>
    </main>
  )
}

function CheckingAccessScreen() {
  return (
    <main className="login-screen">
      <div className="login-card">
        <span className="brand-mark large">⌁</span>
        <p className="eyebrow">Impulse workspace</p>
        <h1>Checking your access…</h1>
        <p>Syncing your account with the workspace. This only takes a moment.</p>
      </div>
    </main>
  )
}

function WorkspaceSetupErrorScreen({ error }: { error: string }) {
  return (
    <main className="login-screen">
      <div className="login-card">
        <span className="brand-mark large">⌁</span>
        <p className="eyebrow">Impulse workspace</p>
        <h1>Couldn't set up your workspace.</h1>
        <p>Creating the shared workspace on Dexie Cloud failed. Reloading might resolve a one-off hiccup — if it keeps happening, send this exact message to Moon's assistant:</p>
        <p className="workspace-error-detail">{error}</p>
        <button className="primary-button wide" onClick={() => window.location.reload()}><Repeat /> Reload</button>
      </div>
    </main>
  )
}

function NotAuthorizedScreen({ email }: { email?: string }) {
  const [busy, setBusy] = useState(false)
  const signOut = async () => {
    setBusy(true)
    try { await (db as any).cloud.logout() }
    catch (error) { if (!(error instanceof Error && error.message.includes('cancelled'))) throw error }
    finally { setBusy(false) }
  }
  return (
    <main className="login-screen">
      <div className="login-card">
        <span className="brand-mark large">⌁</span>
        <p className="eyebrow">Impulse workspace</p>
        <h1>Not on this workspace yet.</h1>
        <p>{email ? <>{email} isn't</> : 'This account isn\'t'} part of the Impulse workspace. Ask Moon to invite you from Settings → Partner access.</p>
        <button className="primary-button wide" onClick={signOut} disabled={busy}><LogIn /> {busy ? 'Signing out…' : 'Try a different email'}</button>
      </div>
    </main>
  )
}

function NavButton({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return <button className={active ? 'active' : ''} onClick={onClick}>{icon}<span>{label}</span></button>
}

function QuickAdd({ onSelect }: { onSelect: (kind: 'task' | 'note' | 'discussion' | 'idea') => void }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="quick-add-wrap">
      <button className="primary-button" onClick={() => setOpen(!open)} aria-expanded={open}><Plus /> Add</button>
      {open && <div className="quick-add-menu">
        <button onClick={() => { onSelect('task'); setOpen(false) }}><Check /><span><strong>Task</strong><small>A clear next action</small></span></button>
        <button onClick={() => { onSelect('note'); setOpen(false) }}><NotebookPen /><span><strong>Note</strong><small>Project context or decision</small></span></button>
        <button onClick={() => { onSelect('discussion'); setOpen(false) }}><MessageSquareText /><span><strong>For next meeting</strong><small>A topic to discuss together</small></span></button>
        <button onClick={() => { onSelect('idea'); setOpen(false) }}><Lightbulb /><span><strong>Idea</strong><small>Park it before it gets lost</small></span></button>
      </div>}
    </div>
  )
}

function PageHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: React.ReactNode; action?: React.ReactNode }) {
  return <div className="page-header"><div>{eyebrow && <p className="eyebrow">{eyebrow}</p>}<h1>{title}</h1>{description && <p>{description}</p>}</div>{action}</div>
}

function OwnerChip({ owner }: { owner: Owner }) {
  return <span className="owner-chip" title={owner}>{ownerShort[owner]}</span>
}

function HomeView({ openProject, navigate }: { openProject: (id: string) => void; navigate: (view: ViewName) => void }) {
  const projects = useLiveQuery(() => db.projects.filter((p) => !p.archivedAt && p.status === 'active').toArray(), [], [])
  const milestones = useLiveQuery(() => db.milestones.filter((m) => !m.archivedAt).toArray(), [], [])
  const tasks = useLiveQuery(() => db.tasks.filter((t) => !t.archivedAt && t.status !== 'done').toArray(), [], [])
  const leads = useLiveQuery(() => db.leads.filter((l) => !l.archivedAt && l.stage !== 'won' && l.stage !== 'lost').toArray(), [], [])
  const allLeads = useLiveQuery(() => db.leads.filter((l) => !l.archivedAt).toArray(), [], [])
  const payments = useLiveQuery(() => db.payments.filter((p) => !p.archivedAt && p.status === 'due').toArray(), [], [])
  const meetingItems = useLiveQuery(() => db.meetingItems.filter((item) => !item.archivedAt && activeMeetingStatus(item.status)).toArray(), [], [])
  const backups = useLiveQuery(() => db.backupExports.orderBy('exportedAt').reverse().toArray(), [], [])

  const dueFollowUps = leads.filter((lead) => lead.followUpDate && daysUntil(lead.followUpDate) <= 7).sort((a, b) => (a.followUpDate ?? '').localeCompare(b.followUpDate ?? '')).slice(0, 3)
  const thisWeek = tasks.filter((task) => task.status === 'next' || task.status === 'in_progress').sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')).slice(0, 6)
  const backupAge = backups[0] ? daysSince(backups[0].exportedAt) : Infinity

  return <div className="page">
    <PageHeader eyebrow="Today" title="What needs attention" description="Only active work and upcoming decisions." />
    {backupAge >= 30 && <div className="gentle-banner"><Archive /><span><strong>Monthly backup is due.</strong> Export it from Settings when you have a quiet moment.</span><button onClick={() => navigate('settings')}>Open settings</button></div>}
    <section className="attention-list" aria-label="Active projects">
      {projects.sort((a, b) => a.order - b.order).map((project) => {
        const projectMilestones = milestones.filter((m) => m.projectId === project.id).sort((a, b) => a.position - b.position)
        const doneCount = projectMilestones.filter((m) => m.status === 'done').length
        const openMilestones = projectMilestones.filter((m) => m.status !== 'done')
        const nextMilestone = openMilestones.find((m) => m.status === 'in_progress') ?? openMilestones[0]
        const openDeliverables = openMilestones.filter((m) => m.deliverable)
        const nextDeliverable = nearestByDate(openDeliverables) ?? openDeliverables[0]
        const blocker = tasks.find((task) => task.projectId === project.id && task.status === 'waiting')
        return <button key={project.id} className="attention-row" onClick={() => openProject(project.id)}>
          <span className="project-accent" style={{ background: project.color }} />
          <span className="attention-project"><strong>{project.name}</strong><small>{project.phase}{projectMilestones.length ? ` · ${doneCount}/${projectMilestones.length}` : ''}</small>{projectMilestones.length > 0 && <span className="progress-track" aria-hidden="true"><span className="progress-fill" style={{ width: `${Math.round((doneCount / projectMilestones.length) * 100)}%` }} /></span>}</span>
          <span className="attention-focus"><small>Current focus</small>{project.currentFocus}</span>
          <span><small>Next step</small>{nextMilestone?.title ?? (projectMilestones.length ? 'Plan complete' : 'Set the next step')}</span>
          <span><small>Next deliverable</small>{nextDeliverable?.title ?? 'Mark a step as deliverable'}{nextDeliverable?.dueDate && <em className={isOverdue(nextDeliverable.dueDate) ? 'overdue' : ''}>{formatDate(nextDeliverable.dueDate)}</em>}</span>
          <span className={blocker ? 'has-blocker' : 'clear'}><small>{blocker ? 'Waiting' : 'Status'}</small>{blocker?.title ?? 'No blocker recorded'}</span>
          <ChevronRight />
        </button>
      })}
      {!projects.length && <div className="first-run-card"><p className="eyebrow">First setup</p><h2>Bring in your Command Center</h2><p>Your private client data is kept outside the public app build. Import the prepared local file once, then continue here.</p><ol><li>Open Settings</li><li>Choose the Command Center import file</li><li>Review the three project overviews</li></ol><button className="primary-button" onClick={() => navigate('settings')}>Open settings</button></div>}
    </section>

    <UpcomingDeadlines projects={projects} milestones={milestones} tasks={tasks} leads={leads} payments={payments} allLeads={allLeads} />

    <div className="home-lower">
      <section>
        <SectionTitle title="This week" action={<button onClick={() => navigate('projects')}>View projects</button>} />
        <div className="simple-list">
          {thisWeek.length ? thisWeek.map((task) => <TaskLine key={task.id} task={task} project={projects.find((p) => p.id === task.projectId)} />) : <EmptyState text="Nothing planned for this week yet." />}
        </div>
      </section>
      <section>
        <SectionTitle title="Client follow-ups" action={<button onClick={() => navigate('sales')}>View all</button>} />
        <div className="simple-list">
          {dueFollowUps.length ? dueFollowUps.map((lead) => <div className="list-row" key={lead.id}><span><strong>{lead.business}</strong><small>{lead.nextAction || 'Set a next action'}</small></span><time className={isOverdue(lead.followUpDate) ? 'overdue' : ''}>{formatDate(lead.followUpDate)}</time></div>) : <EmptyState text="No follow-ups due in the next seven days." />}
        </div>
      </section>
      <section>
        <SectionTitle title="Next meeting" action={<button onClick={() => navigate('meeting')}>View all</button>} />
        <div className="simple-list">
          {meetingItems.slice(0, 3).map((item) => <div className="list-row" key={item.id}><span><strong>{item.title}</strong><small>{projects.find((p) => p.id === item.projectId)?.name}</small></span></div>)}
          {!meetingItems.length && <EmptyState text="No unresolved topics." />}
        </div>
      </section>
    </div>
  </div>
}

function UpcomingDeadlines({ projects, milestones, tasks, leads, payments, allLeads }: {
  projects: Project[]; milestones: Milestone[]; tasks: Task[]; leads: Lead[]; payments: Payment[]; allLeads: Lead[]
}) {
  const businessOf = (leadId: string) => allLeads.find((l) => l.id === leadId)?.business ?? 'Client'
  const items = [
    ...milestones.filter((m) => m.dueDate && m.status !== 'done').map((m) => ({ id: m.id, date: m.dueDate!, kind: m.deliverable ? 'Deliverable' : 'Step', title: m.title, projectId: m.projectId as string | undefined, money: false })),
    ...tasks.filter((t) => t.dueDate).map((t) => ({ id: t.id, date: t.dueDate!, kind: 'Task', title: t.title, projectId: t.projectId as string | undefined, money: false })),
    ...leads.filter((l) => l.followUpDate).map((l) => ({ id: l.id, date: l.followUpDate!, kind: 'Follow-up', title: l.business, projectId: undefined as string | undefined, money: false })),
    ...payments.filter((p) => p.dueDate).map((p) => ({ id: p.id, date: p.dueDate!, kind: p.kind === 'retainer' ? 'Retainer' : 'Payment', title: `${businessOf(p.leadId)} · ${p.amount ? formatMoney(p.amount) : p.label}`, projectId: undefined as string | undefined, money: true }))
  ].filter((item) => daysUntil(item.date) <= 14).sort((a, b) => a.date.localeCompare(b.date))

  return <section className="deadline-strip" aria-label="Deadlines in the next two weeks">
    <SectionTitle title="Next 14 days" />
    <div className="deadline-list">
      {items.map((item) => {
        const project = projects.find((p) => p.id === item.projectId)
        const late = isOverdue(item.date)
        return <div className="deadline-row" key={`${item.kind}-${item.id}`}>
          <span className={`deadline-date ${late ? 'overdue' : ''}`}>{formatDate(item.date)}{late ? ' · late' : ''}</span>
          <span className={`deadline-kind ${item.money ? 'is-money' : ''}`}>{item.kind}</span>
          <span className="deadline-title">{item.title}</span>
          <span className="deadline-project">{project ? <><span className="project-dot" style={{ background: project.color }} />{project.name}</> : item.money ? 'Money' : 'Clients'}</span>
        </div>
      })}
      {!items.length && <EmptyState text="No dated work in the next two weeks. Give plan steps a deadline to see them here." />}
    </div>
  </section>
}

function TaskLine({ task, project }: { task: Task; project?: Project }) {
  return <div className="list-row"><span className={`status-dot status-${task.status}`} /><OwnerChip owner={task.owner} /><span><strong>{task.title}</strong><small>{project?.name} · {taskStatusLabels[task.status]}</small></span>{task.dueDate && <time className={isOverdue(task.dueDate) ? 'overdue' : ''}>{formatDate(task.dueDate)}</time>}</div>
}

function SectionTitle({ title, action }: { title: string; action?: React.ReactNode }) {
  return <div className="section-title"><h2>{title}</h2>{action}</div>
}

function EmptyState({ text, action }: { text: string; action?: React.ReactNode }) {
  return <div className="empty-state"><p>{text}</p>{action}</div>
}

function ProjectsView({ selectedProjectId, setSelectedProjectId, tab, setTab, openAdd, openProjectEdit, setToast }: {
  selectedProjectId: string; setSelectedProjectId: (id: string) => void; tab: ProjectTab; setTab: (tab: ProjectTab) => void;
  openAdd: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void; openProjectEdit: (id: string) => void; setToast: (toast: ToastState) => void
}) {
  const projects = useLiveQuery(() => db.projects.filter((p) => !p.archivedAt && p.status !== 'archived').toArray(), [], [])
  const project = projects.find((item) => item.id === selectedProjectId) ?? projects[0]
  if (!project) return <div className="page"><EmptyState text="No projects yet. Add one from the sidebar." /></div>
  const tabLabels: Record<ProjectTab, string> = { overview: 'Overview', plan: 'Plan', board: 'Board', notes: 'Notes', links: 'Links' }
  return <div className="page">
    <div className="project-switcher">
      {projects.sort((a, b) => a.order - b.order).map((item) => <button key={item.id} className={item.id === project.id ? 'active' : ''} onClick={() => { setSelectedProjectId(item.id); setTab('overview') }}><span style={{ background: item.color }} />{item.name}</button>)}
    </div>
    <div className="project-heading">
      <div><p className="eyebrow">{project.clientType === 'internal' ? 'Internal project' : 'Client project'} · {project.phase}</p><h1>{project.name}</h1><p>{project.currentFocus}</p></div>
      <div className="project-heading-actions">
        {isSafeUrl(project.driveFolderUrl) && <a className="secondary-button" href={project.driveFolderUrl} target="_blank" rel="noreferrer"><Link2 /> Drive folder</a>}
        <button className="secondary-button" onClick={() => openProjectEdit(project.id)}><Pencil /> Edit project</button>
      </div>
    </div>
    <nav className="subnav" aria-label="Project sections">
      {(Object.keys(tabLabels) as ProjectTab[]).map((item) => <button key={item} onClick={() => setTab(item)} className={tab === item ? 'active' : ''}>{tabLabels[item]}</button>)}
    </nav>
    {tab === 'overview' && <ProjectOverview project={project} openAdd={openAdd} />}
    {tab === 'plan' && <PlanView project={project} openAdd={openAdd} setToast={setToast} />}
    {tab === 'board' && <BoardView project={project} openAdd={openAdd} setToast={setToast} />}
    {tab === 'notes' && <NotesView project={project} openAdd={openAdd} />}
    {tab === 'links' && <LinksView project={project} openAdd={openAdd} />}
  </div>
}

function ProjectOverview({ project, openAdd }: { project: Project; openAdd: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void }) {
  const milestones = useLiveQuery(() => db.milestones.where('projectId').equals(project.id).filter((m) => !m.archivedAt).sortBy('position'), [project.id], [])
  const tasks = useLiveQuery(() => db.tasks.where('projectId').equals(project.id).filter((t) => !t.archivedAt && t.status !== 'done').toArray(), [project.id], [])
  const meetingItems = useLiveQuery(() => db.meetingItems.where('projectId').equals(project.id).filter((m) => !m.archivedAt && activeMeetingStatus(m.status)).toArray(), [project.id], [])
  const deliverables = milestones.filter((m) => m.deliverable && m.status !== 'done')
  const doneCount = milestones.filter((m) => m.status === 'done').length
  return <div className="project-overview">
    <section className="goal-panel"><p className="eyebrow">Project goal</p><h2>{project.goal}</h2>{project.targetDate && <span><CalendarDays /> Target {fullDate(project.targetDate)}</span>}{milestones.length > 0 && <span><Check /> {doneCount} of {milestones.length} steps done</span>}</section>
    <section className="overview-section">
      <SectionTitle title="Plan" action={<button onClick={() => openAdd('milestone', project.id)}><Plus /> Add step</button>} />
      <div className="milestone-path">{milestones.slice(0, 8).map((milestone, index) => <div key={milestone.id} className={`milestone-step ${milestone.status}`}><span>{milestone.status === 'done' ? <Check /> : index + 1}</span><p>{milestone.deliverable && <Star className="step-star" aria-label="Client deliverable" />}{milestone.title}</p></div>)}</div>
      {!milestones.length && <EmptyState text="No plan yet. Add the first step." />}
    </section>
    <div className="overview-grid">
      <section><SectionTitle title="Next deliverables" action={<button onClick={() => openAdd('deliverable', project.id)}><Plus /> Add</button>} /><div className="simple-list">{deliverables.slice(0, 3).map((item) => <div className="list-row" key={item.id}><FileCheck2 /><span><strong>{item.title}</strong><small>{milestoneStatusLabels[item.status]} · {item.owner}</small></span>{item.dueDate && <time>{formatDate(item.dueDate)}</time>}</div>)}{!deliverables.length && <EmptyState text="Mark plan steps the client receives as deliverables." />}</div></section>
      <section><SectionTitle title="Current tasks" action={<button onClick={() => openAdd('task', project.id)}><Plus /> Add</button>} /><div className="simple-list">{tasks.slice(0, 4).map((task) => <TaskLine key={task.id} task={task} />)}{!tasks.length && <EmptyState text="No active tasks." />}</div></section>
      <section><SectionTitle title="For next meeting" action={<button onClick={() => openAdd('discussion', project.id)}><Plus /> Add</button>} /><div className="simple-list">{meetingItems.slice(0, 3).map((item) => <div className="list-row" key={item.id}><MessageSquareText /><span><strong>{item.title}</strong><small>{meetingStatusLabels[item.status]}</small></span></div>)}{!meetingItems.length && <EmptyState text="Nothing waiting for the next meeting." />}</div></section>
    </div>
  </div>
}

function PlanView({ project, openAdd, setToast }: { project: Project; openAdd: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void; setToast: (toast: ToastState) => void }) {
  const milestones = useLiveQuery(() => db.milestones.where('projectId').equals(project.id).filter((m) => !m.archivedAt).sortBy('position'), [project.id], [])
  const update = async (milestone: Milestone, status: MilestoneStatus) => { await db.milestones.update(milestone.id, { status, updatedAt: nowIso() }); setToast({ message: 'Step updated.' }) }
  const toggleDeliverable = async (milestone: Milestone) => {
    await db.milestones.update(milestone.id, { deliverable: !milestone.deliverable, updatedAt: nowIso() })
    setToast({ message: milestone.deliverable ? 'No longer marked as a deliverable.' : 'Marked as a client deliverable.' })
  }
  return <section><SectionTitle title="Plan" action={<button className="primary-button" onClick={() => openAdd('milestone', project.id)}><Plus /> Add step</button>} />
    <div className="structured-list">{milestones.map((milestone, index) => <div className="structured-row" key={milestone.id}>
      <span className="sequence">{index + 1}</span>
      <button className="row-main" onClick={() => openAdd('milestone', project.id, milestone.id)}>
        <strong>{milestone.title}</strong>
        <small>{milestone.owner}{milestone.dueDate ? ` · ${formatDate(milestone.dueDate)}` : ' · No deadline'}{milestone.deliverable ? ' · client receives this' : ''}</small>
      </button>
      <button className={`star-toggle ${milestone.deliverable ? 'on' : ''}`} aria-label={milestone.deliverable ? `Unmark ${milestone.title} as deliverable` : `Mark ${milestone.title} as deliverable`} title="Client deliverable" onClick={() => toggleDeliverable(milestone)}><Star /></button>
      {isSafeUrl(milestone.driveUrl) && <a href={milestone.driveUrl} target="_blank" rel="noreferrer" aria-label={`Open ${milestone.title}`}><ExternalLink /></a>}
      <StatusSelect value={milestone.status} options={milestoneStatuses} labels={milestoneStatusLabels} onChange={(value) => update(milestone, value as MilestoneStatus)} />
    </div>)}</div>
    {!milestones.length && <EmptyState text="No plan yet." action={<button className="primary-button" onClick={() => openAdd('milestone', project.id)}>Add the first step</button>} />}
  </section>
}

function BoardView({ project, openAdd, setToast }: { project: Project; openAdd: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void; setToast: (toast: ToastState) => void }) {
  const tasks = useLiveQuery(() => db.tasks.where('projectId').equals(project.id).filter((t) => !t.archivedAt).toArray(), [project.id], [])
  const move = async (task: Task, status: TaskStatus) => { await db.tasks.update(task.id, { status, updatedAt: nowIso() }); setToast({ message: `Moved to ${taskStatusLabels[status]}.` }) }
  const archiveTask = async (task: Task) => {
    const archivedAt = nowIso(); await db.tasks.update(task.id, { archivedAt, updatedAt: archivedAt })
    setToast({ message: 'Task archived.', action: { label: 'Undo', run: () => db.tasks.update(task.id, { archivedAt: undefined, updatedAt: nowIso() }) } })
  }
  return <section><SectionTitle title="Board" action={<button className="primary-button" onClick={() => openAdd('task', project.id)}><Plus /> Add task</button>} />
    <div className="task-board">{taskStatuses.map((status) => <div className="task-column" key={status}><div className="column-heading"><h3>{taskStatusLabels[status]}</h3><span>{tasks.filter((t) => t.status === status).length}</span></div>{tasks.filter((t) => t.status === status).sort((a, b) => a.position - b.position).map((task) => <article className="task-card" key={task.id}><div><span className={`priority priority-${task.priority}`}>{task.priority}</span>{task.dueDate && <time className={isOverdue(task.dueDate) && status !== 'done' ? 'overdue' : ''}>{formatDate(task.dueDate)}</time>}</div><button className="card-title" onClick={() => openAdd('task', project.id, task.id)}><h4>{task.title}</h4></button><p>{task.owner}</p><div className="card-actions"><StatusSelect value={task.status} options={taskStatuses} labels={taskStatusLabels} onChange={(value) => move(task, value as TaskStatus)} compact /><button aria-label={`Archive ${task.title}`} onClick={() => archiveTask(task)}><Archive /></button></div></article>)}</div>)}</div>
  </section>
}

function NotesView({ project, openAdd }: { project: Project; openAdd: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void }) {
  const notes = useLiveQuery(() => db.notes.where('projectId').equals(project.id).filter((n) => !n.archivedAt).reverse().sortBy('createdAt'), [project.id], [])
  const items = useLiveQuery(() => db.meetingItems.where('projectId').equals(project.id).filter((m) => !m.archivedAt && activeMeetingStatus(m.status)).toArray(), [project.id], [])
  return <div className="notes-layout"><section><SectionTitle title="Notes, decisions & ideas" action={<button className="primary-button" onClick={() => openAdd('note', project.id)}><Plus /> Add note</button>} />{notes.map((note) => <article className="note-entry" key={note.id}><div><span className={`note-kind ${note.kind}`}>{note.kind}</span><time>{new Date(note.createdAt).toLocaleDateString('en-GB')}</time></div><button className="row-main" onClick={() => openAdd('note', project.id, note.id)}><h3>{note.title}</h3></button><p>{note.body}</p><small>{note.author}</small></article>)}{!notes.length && <EmptyState text="Add context, a decision, or something worth remembering." />}</section><section><SectionTitle title="For next meeting" action={<button onClick={() => openAdd('discussion', project.id)}><Plus /> Add</button>} /><div className="simple-list">{items.map((item) => <div className="list-row" key={item.id}><MessageSquareText /><span><strong>{item.title}</strong><small>{meetingStatusLabels[item.status]}</small></span></div>)}{!items.length && <EmptyState text="Nothing waiting for the next meeting." />}</div></section></div>
}

function LinksView({ project, openAdd }: { project: Project; openAdd: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void }) {
  const links = useLiveQuery(() => db.resources.where('projectId').equals(project.id).filter((r) => !r.archivedAt).toArray(), [project.id], [])
  return <section><SectionTitle title="Links" action={<button className="primary-button" onClick={() => openAdd('link', project.id)}><Plus /> Add link</button>} />
    <div className="structured-list">{links.map((link) => <div className="structured-row" key={link.id}>
      <span className="link-type">{link.type}</span>
      <span className="grow">{isSafeUrl(link.url) ? <a className="link-name" href={link.url} target="_blank" rel="noreferrer"><strong>{link.name}</strong> <ExternalLink /></a> : <span className="link-name"><strong>{link.name}</strong></span>}<small>{link.owner}{link.notes ? ` · ${link.notes}` : ''}</small></span>
      <button aria-label={`Edit ${link.name}`} onClick={() => openAdd('link', project.id, link.id)}><Pencil /></button>
    </div>)}</div>
    {!links.length && <EmptyState text="Demos, documents, profiles — keep every link you both need here." action={<button className="primary-button" onClick={() => openAdd('link', project.id)}>Add the first link</button>} />}
  </section>
}

function ClientsView({ addLead, openModal }: { addLead: () => void; openModal: (id: string) => void }) {
  const leads = useLiveQuery(() => db.leads.filter((l) => !l.archivedAt).toArray(), [], [])
  const payments = useLiveQuery(() => db.payments.filter((p) => !p.archivedAt).toArray(), [], [])
  const paymentsFor = (leadId: string) => payments.filter((p) => p.leadId === leadId)
  const receivedTotal = sumReceived(payments)
  const dueTotal = sumDue(payments)
  return <div className="page"><PageHeader eyebrow="Outreach" title="Clients & Money"
    description={<>Every client has one next action.{(receivedTotal > 0 || dueTotal > 0) && <span className="money-totals"> Received {formatMoney(receivedTotal)} · Due {formatMoney(dueTotal)}</span>}</>}
    action={<button className="primary-button" onClick={addLead}><Plus /> Add client</button>} />
    <div className="pipeline">{leadStageGroups.map((group) => {
      const groupLeads = leads.filter((l) => group.stages.includes(l.stage))
      return <section className={`pipeline-stage stage-${group.key}`} key={group.key}><div className="column-heading"><h2>{group.label}</h2><span>{groupLeads.length}</span></div>{groupLeads.map((lead) => {
        const leadPayments = paymentsFor(lead.id)
        const received = sumReceived(leadPayments)
        const next = nextPayment(leadPayments)
        return <button className="lead-card" key={lead.id} onClick={() => openModal(lead.id)}>
          <strong>{lead.business}</strong>
          <span>{lead.owner}{lead.tariff ? ` · ${lead.tariff}` : ''}</span>
          <p>{lead.nextAction || 'Set a next action'}</p>
          {(received > 0 || lead.quoted || next) ? <em className="money-line">{received > 0 ? `${formatMoney(received)} received` : 'Nothing received'}{lead.quoted && received < lead.quoted ? ` of ${formatMoney(lead.quoted)}` : ''}{next ? ` · next ${next.amount ? formatMoney(next.amount) : next.label} ${formatDate(next.dueDate)}` : ''}</em> : null}
          {lead.followUpDate && <time className={isOverdue(lead.followUpDate) ? 'overdue' : ''}>{formatDate(lead.followUpDate)}</time>}
        </button>
      })}</section>
    })}</div>
  </div>
}

function AgendaNotes({ value, onChange, onCommit }: { value: string; onChange: (value: string) => void; onCommit: () => void }) {
  return <textarea className="agenda-notes" rows={2} placeholder="Notes while you talk…" value={value} onChange={(event) => onChange(event.target.value)} onBlur={onCommit} />
}

function MeetingView({ currentUser, setToast, openProject, openEdit }: { currentUser: Owner; setToast: (toast: ToastState) => void; openProject: (id: string) => void; openEdit: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void }) {
  const projects = useLiveQuery(() => db.projects.filter((p) => !p.archivedAt).toArray(), [], [])
  const items = useLiveQuery(() => db.meetingItems.filter((m) => !m.archivedAt && activeMeetingStatus(m.status)).toArray(), [], [])
  const ideas = useLiveQuery(() => db.notes.filter((n) => !n.archivedAt && n.kind === 'idea').reverse().sortBy('createdAt'), [], [])
  const decisions = useLiveQuery(() => db.notes.filter((n) => !n.archivedAt && n.kind === 'decision').reverse().sortBy('createdAt'), [], [])
  // Notes typed live while talking. Kept in state (not just written on blur) so
  // resolving a topic can never race the autosave and drop what was just typed.
  const [drafts, setDrafts] = useState<Record<string, string>>({})
  const noteFor = (item: MeetingItem) => drafts[item.id] ?? item.notes ?? ''
  const commitNote = async (item: MeetingItem) => {
    const value = noteFor(item)
    if (value === (item.notes ?? '')) return
    await db.meetingItems.update(item.id, { notes: value || undefined, updatedAt: nowIso() })
  }

  const resolve = async (item: MeetingItem, status: MeetingItemStatus) => {
    const liveNotes = noteFor(item)
    await db.meetingItems.update(item.id, { status, notes: liveNotes || undefined, updatedAt: nowIso() })
    if (status === 'action') {
      await db.tasks.add({ id: newId('tasks', 'task'), realmId: recordRealmId(), projectId: item.projectId, title: item.title, owner: item.owner || currentUser, status: 'next', priority: 'normal', dueDate: item.dueDate, position: Date.now(), createdAt: nowIso(), updatedAt: nowIso(), notes: liveNotes ? `From the partner meeting: ${liveNotes}` : 'From the partner meeting.' })
      setToast({ message: 'Added to the project board for this week.' })
    } else if (status === 'decision') {
      await db.notes.add({ id: newId('notes', 'note'), realmId: recordRealmId(), projectId: item.projectId, title: item.title, body: liveNotes || 'Agreed in the partner meeting.', kind: 'decision', author: currentUser, createdAt: nowIso(), updatedAt: nowIso(), createdBy: currentUser })
      setToast({ message: 'Decision saved to the project notes.' })
    } else {
      setToast({ message: status === 'deferred' ? 'Topic will roll into the next meeting.' : 'Topic closed.' })
    }
    setDrafts((prev) => { const next = { ...prev }; delete next[item.id]; return next })
  }

  const promoteIdea = async (idea: Note, to: 'agenda' | 'task') => {
    const stamp = nowIso()
    if (to === 'agenda') {
      await db.meetingItems.add({ id: newId('meetingItems', 'agenda'), realmId: recordRealmId(), projectId: idea.projectId, title: idea.title, notes: idea.body !== idea.title ? idea.body : undefined, status: 'open', owner: idea.author, createdAt: stamp, updatedAt: stamp, createdBy: currentUser })
      setToast({ message: 'Idea moved to the meeting agenda.' })
    } else {
      await db.tasks.add({ id: newId('tasks', 'task'), realmId: recordRealmId(), projectId: idea.projectId, title: idea.title, notes: idea.body !== idea.title ? idea.body : undefined, status: 'next', priority: 'normal', owner: idea.author, position: Date.now(), createdAt: stamp, updatedAt: stamp, createdBy: currentUser })
      setToast({ message: 'Idea turned into a task for this week.' })
    }
    await db.notes.update(idea.id, { archivedAt: stamp, updatedAt: stamp })
  }

  const grouped = projects.map((project) => ({ project, items: items.filter((item) => item.projectId === project.id) })).filter((group) => group.items.length)
  return <div className="page meeting-page"><PageHeader eyebrow="Partner meeting" title="Only unresolved topics" description="Jot notes while you talk. Decisions go to project notes, actions go to the board." />
    {grouped.map(({ project, items: projectItems }) => <section className="meeting-group" key={project.id}><div className="meeting-project"><span className="project-dot" style={{ background: project.color }} /><button onClick={() => openProject(project.id)}>{project.name}<ChevronRight /></button><span>{projectItems.length} {projectItems.length === 1 ? 'topic' : 'topics'}</span></div>{projectItems.map((item) => <article className="agenda-card" key={item.id}><div><button className="row-main" onClick={() => openEdit('discussion', item.projectId, item.id)}><h3>{item.title}</h3></button><AgendaNotes value={noteFor(item)} onChange={(value) => setDrafts((prev) => ({ ...prev, [item.id]: value }))} onCommit={() => commitNote(item)} /><small>Added by {item.owner}</small></div><div className="agenda-actions"><button onClick={() => resolve(item, 'decision')}>Decision</button><button className="primary-button" onClick={() => resolve(item, 'action')}>Make it a task</button><button onClick={() => resolve(item, 'deferred')}>Next time</button><button aria-label="Close topic" onClick={() => resolve(item, 'closed')}><X /></button></div></article>)}</section>)}
    {!grouped.length && <EmptyState text="Nothing unresolved. Your next meeting can stay short." />}

    <div className="meeting-lower">
      <section>
        <SectionTitle title="Parked ideas" action={<button onClick={() => openEdit('idea')}><Plus /> Add idea</button>} />
        <div className="simple-list">
          {ideas.map((idea) => <div className="list-row idea-row" key={idea.id}>
            <Lightbulb />
            <span><button className="row-main" onClick={() => openEdit('note', idea.projectId, idea.id)}><strong>{idea.title}</strong></button><small>{projects.find((p) => p.id === idea.projectId)?.name}{idea.body && idea.body !== idea.title ? ` · ${idea.body}` : ''}</small></span>
            <span className="idea-actions"><button onClick={() => promoteIdea(idea, 'agenda')}>To agenda</button><button onClick={() => promoteIdea(idea, 'task')}>To task</button></span>
          </div>)}
          {!ideas.length && <EmptyState text="Park ideas here so they survive until the next meeting." />}
        </div>
      </section>
      <section>
        <SectionTitle title="Recent decisions" />
        <div className="simple-list">
          {decisions.slice(0, 5).map((note) => <div className="list-row" key={note.id}>
            <Check />
            <span><strong>{note.title}</strong><small>{projects.find((p) => p.id === note.projectId)?.name} · {new Date(note.createdAt).toLocaleDateString('en-GB')}</small></span>
          </div>)}
          {!decisions.length && <EmptyState text="Decisions you make in meetings will be listed here." />}
        </div>
      </section>
    </div>
  </div>
}

function BackupStatus({ exportedAt, exportedBy }: { exportedAt: string; exportedBy: Owner }) {
  const days = daysSince(exportedAt)
  const stale = days >= 30
  const age = days <= 0 ? 'today' : days === 1 ? '1 day ago' : `${days} days ago`
  return <p className={`last-backup ${stale ? 'backup-stale' : ''}`}>
    Last export: {new Date(exportedAt).toLocaleString('en-GB')} by {exportedBy} ({age}){stale && ' — due for a fresh backup'}
  </p>
}

function SyncStatusLine({ phase, status, pending, error, byTable, realmId }: { phase?: string; status?: string; pending: number; error?: string; byTable?: string; realmId?: string }) {
  // Temporary diagnostic detail appended while we chase a stuck-sync bug. `realm` shows the
  // resolved workspace realm id: a real server-minted realm looks like "rlm" + random chars
  // (no dash). "rlm-…" or a blank means realm creation didn't land — the root of the 403.
  const diag = <span className="sync-diag"> · [{phase ?? '?'}/{status ?? '?'}{byTable ? ` · ${byTable}` : ''}{` · realm:${realmId ?? 'none'}`}{error ? ` · ${error}` : ''}]</span>
  if (status === 'offline' || phase === 'offline') return <p className="sync-status sync-warn">Offline — changes save on this device and will sync once you're back online.{diag}</p>
  if (status === 'error' || phase === 'error') return <p className="sync-status sync-error">Sync error — your latest changes may not have reached the server.{error ? ` Details: ${error}` : ' Try reloading the page.'}{diag}</p>
  if (pending > 0) return <p className="sync-status sync-pending">{pending} change{pending === 1 ? '' : 's'} waiting to sync…{diag}</p>
  if (phase === 'in-sync') return <p className="sync-status sync-ok">All changes synced.</p>
  return <p className="sync-status">Checking sync status…{diag}</p>
}

function SettingsView({ currentUser, isOwner, email, realmId, onSignOut, setToast }: { currentUser: Owner; isOwner: boolean; email?: string; realmId?: string; onSignOut: () => Promise<void>; setToast: (toast: ToastState) => void }) {
  const backups = useLiveQuery(() => db.backupExports.orderBy('exportedAt').reverse().toArray(), [], [])
  const syncStatus = useSyncStatus()
  const [inviteEmail, setInviteEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)
  const login = async () => { try { await (db as any).cloud.login({ grant_type: 'otp' }) } catch (error) { setToast({ message: error instanceof Error ? error.message : 'Could not sign in.' }) } }
  const invite = async () => {
    if (!cloudEnabled) return setToast({ message: 'Connect Dexie Cloud before sending an invitation.' })
    if (!isOwner) return setToast({ message: 'Only the workspace owner can invite partners.' })
    if (!realmId) return setToast({ message: 'Still connecting to the workspace. Try again in a moment.' })
    if (!inviteEmail.trim()) return
    try {
      const members = (db as any).members
      await members.add({ realmId, email: inviteEmail.trim().toLowerCase(), invite: true, permissions: { manage: '*' } })
      setInviteEmail(''); setToast({ message: 'Invitation sent.' })
    } catch (error) { setToast({ message: error instanceof Error ? error.message : 'Could not send invitation.' }) }
  }
  const exportBackup = async () => {
    setBusy(true)
    try { const { exportExcelBackup } = await import('./backup'); const result = await exportExcelBackup(currentUser); setToast({ message: `${result.filename} created with ${result.recordCount} records.` }) }
    catch (error) { setToast({ message: error instanceof Error ? error.message : 'Backup failed.' }) }
    finally { setBusy(false) }
  }
  const importFile = async (file?: File) => {
    if (!file) return
    setBusy(true)
    try {
      const count = await importWorkspaceFile(file, realmId)
      setToast({ message: `Command Center imported: ${count} records.` })
    } catch (error) { setToast({ message: error instanceof Error ? error.message : 'Import failed.' }) }
    finally { setBusy(false); if (importInput.current) importInput.current.value = '' }
  }
  const [signingOut, setSigningOut] = useState(false)
  const signOut = async () => {
    setSigningOut(true)
    try { await onSignOut() }
    catch (error) { setToast({ message: error instanceof Error ? error.message : 'Could not sign out.' }) }
    finally { setSigningOut(false) }
  }
  const resetDevice = async () => {
    if (!window.confirm('Reset this device? This clears the local copy of your data on this browser, including anything stuck waiting to sync. Records already synced to the cloud come back on reload. Do this, then import the private file again.')) return
    setBusy(true)
    try { await resetLocalData(); window.location.reload() }
    catch (error) { setBusy(false); setToast({ message: error instanceof Error ? error.message : 'Reset failed.' }) }
  }
  return <div className="page settings-page"><PageHeader eyebrow="Workspace" title="Settings" description="The technical details stay here, away from daily work." />
    {cloudEnabled && <section className="settings-section"><div><LogOut /><span><h2>Account</h2><p>Signed in as {email ?? currentUser}{isOwner ? ' · workspace owner' : ''}. Log out on any shared or borrowed device.</p><SyncStatusLine {...syncStatus} realmId={realmId} /></span></div><button className="secondary-button" onClick={signOut} disabled={signingOut}><LogOut /> {signingOut ? 'Signing out…' : 'Log out'}</button></section>}
    <section className="settings-section"><div><Upload /><span><h2>Command Center import</h2><p>Use the prepared private JSON file once. Existing records with the same IDs are updated, not duplicated.</p></span></div><input ref={importInput} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => importFile(event.target.files?.[0])} /><button className="secondary-button" onClick={() => importInput.current?.click()} disabled={busy}><Upload /> Import private file</button>{cloudEnabled && <details className="reset-details"><summary>Import keeps failing?</summary><p>If a sync error keeps returning on every refresh, reset this device to clear local data stuck from an older version, then import again.</p><button className="danger-link" onClick={resetDevice} disabled={busy}><Trash2 /> Reset this device</button></details>}</section>
    <section className="settings-section"><div><Users /><span><h2>Partner access</h2><p>Invite one trusted partner with their email address. Only the workspace owner can manage access.</p></span></div>{!cloudEnabled ? <div className="setup-callout"><strong>Cloud sync is not connected yet.</strong><p>Add your Dexie Cloud database URL to <code>VITE_DEXIE_CLOUD_URL</code>. The app is currently using this browser only.</p><button onClick={login} disabled={!cloudEnabled}>Connect after setup</button></div> : isOwner ? <><div className="inline-form"><label><span>Partner email</span><input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="partner@example.com" /></label><button className="primary-button" onClick={invite}><UserPlus /> Invite</button></div><PartnerStatus ownEmail={email} realmId={realmId} /></> : <p className="last-backup">Ask the workspace owner to manage access.</p>}</section>
    <section className="settings-section"><div><Download /><span><h2>Backup</h2><p>Export a human-readable workbook and place it in Google Drive.</p></span></div><button className="primary-button" onClick={exportBackup} disabled={busy}><Download /> {busy ? 'Creating…' : 'Export Excel backup'}</button>{backups[0] ? <BackupStatus exportedAt={backups[0].exportedAt} exportedBy={backups[0].exportedBy} /> : <p className="last-backup backup-stale">No backup exported yet.</p>}<details><summary>Monthly restoreable backup</summary><p>From this project folder, run <code>npx dexie-cloud export</code>. Store the resulting ZIP in Google Drive. Keep <code>dexie-cloud.key</code> private.</p></details></section>
    <section className="settings-section"><div><ExternalLink /><span><h2>Impulse website</h2><p>The public website remains separate from this private workspace.</p></span></div><a className="secondary-button" href="https://papertowel2030-hub.github.io/Impulse/" target="_blank" rel="noreferrer">Open website <ExternalLink /></a></section>
  </div>
}

function StatusSelect({ value, options, labels, onChange, compact = false }: { value: string; options: string[]; labels: Record<string, string>; onChange: (value: string) => void; compact?: boolean }) {
  return <label className={`status-select ${compact ? 'compact' : ''}`}><span className="sr-only">Status</span><select value={value} onChange={(event) => onChange(event.target.value)}>{options.map((option) => <option key={option} value={option}>{labels[option]}</option>)}</select></label>
}

function recordTable(kind: ModalKind) {
  if (kind === 'task') return db.tasks
  if (kind === 'milestone' || kind === 'deliverable') return db.milestones
  if (kind === 'note' || kind === 'idea') return db.notes
  if (kind === 'discussion') return db.meetingItems
  if (kind === 'lead') return db.leads
  if (kind === 'link') return db.resources
  return null
}

function EntryModal({ state, currentUser, onClose, setToast }: { state: ModalState; currentUser: Owner; onClose: () => void; setToast: (toast: ToastState) => void }) {
  const projects = useLiveQuery(() => db.projects.filter((p) => !p.archivedAt && p.status === 'active').toArray(), [], [])
  const kind = state.kind
  const isEdit = Boolean(state.recordId)
  const existing = useLiveQuery<any>(() => {
    if (!state.recordId) return undefined
    return recordTable(kind)?.get(state.recordId)
  }, [state.recordId, kind])
  const draftKey = `impulse:draft:${kind ?? 'none'}`
  const defaultProject = state.projectId ?? projects[0]?.id ?? ''
  const initial = useMemo(() => {
    if (isEdit) return {}
    try { return JSON.parse(localStorage.getItem(draftKey) ?? '') } catch { return {} }
  }, [draftKey, isEdit])
  const [title, setTitle] = useState(initial.title ?? '')
  const [projectId, setProjectId] = useState(state.projectId ?? initial.projectId ?? defaultProject)
  const [owner, setOwner] = useState<Owner>(initial.owner ?? currentUser)
  const [dueDate, setDueDate] = useState(initial.dueDate ?? '')
  const [status, setStatus] = useState(initial.status ?? '')
  const [notes, setNotes] = useState(initial.notes ?? '')
  const [url, setUrl] = useState(initial.url ?? '')
  const [priority, setPriority] = useState<Priority>(initial.priority ?? 'normal')
  const [linkType, setLinkType] = useState(initial.linkType ?? '')
  const [tariff, setTariff] = useState(initial.tariff ?? '')
  const [quoted, setQuoted] = useState(initial.quoted ?? '')
  const [isDeliverable, setIsDeliverable] = useState(kind === 'deliverable')
  const [more, setMore] = useState(Boolean(initial.notes || initial.url))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const titleInput = useRef<HTMLInputElement>(null)

  useEffect(() => { titleInput.current?.focus() }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  useEffect(() => {
    if (!existing) return
    if (kind === 'lead') {
      setTitle(existing.business); setOwner(existing.owner); setStatus(existing.stage)
      setDueDate(existing.followUpDate ?? ''); setNotes(existing.notes ?? ''); setUrl(existing.website ?? '')
      setTariff(existing.tariff ?? ''); setQuoted(existing.quoted?.toString() ?? '')
      setMore(Boolean(existing.notes || existing.website))
    } else if (kind === 'link') {
      setTitle(existing.name); setOwner(existing.owner); setUrl(existing.url); setLinkType(existing.type ?? ''); setNotes(existing.notes ?? '')
      setProjectId(existing.projectId ?? '')
      setMore(Boolean(existing.notes))
    } else if (kind === 'note' || kind === 'idea') {
      setTitle(existing.title); setOwner(existing.author); setStatus(existing.kind)
      setNotes(existing.body === existing.title ? '' : existing.body); setProjectId(existing.projectId)
      setMore(Boolean(existing.body && existing.body !== existing.title))
    } else {
      setTitle(existing.title); setOwner(existing.owner ?? currentUser); setStatus(existing.status ?? '')
      setDueDate(existing.dueDate ?? ''); setNotes(existing.notes ?? ''); setUrl(existing.driveUrl ?? '')
      setProjectId(existing.projectId)
      if (kind === 'task') setPriority(existing.priority ?? 'normal')
      if (kind === 'milestone' || kind === 'deliverable') setIsDeliverable(Boolean(existing.deliverable))
      setMore(Boolean(existing.notes || existing.driveUrl))
    }
  }, [existing, kind, currentUser])

  useEffect(() => {
    if (isEdit) return
    localStorage.setItem(draftKey, JSON.stringify({ title, projectId, owner, dueDate, status, notes, url, priority, linkType, tariff, quoted }))
  }, [draftKey, isEdit, title, projectId, owner, dueDate, status, notes, url, priority, linkType, tariff, quoted])

  const config = modalConfig(kind)
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!title.trim()) return setError('Add a short title.')
    if (url.trim() && (kind === 'task' || kind === 'milestone' || kind === 'deliverable' || kind === 'lead') && !isSafeUrl(url.trim())) return setError('Only http:// or https:// links are allowed.')
    if (cloudEnabled && !isEdit && !getActiveRealmId()) return setError('Still connecting to the workspace. Try again in a moment.')
    setSaving(true); setError('')
    const stamp = nowIso()
    const add = { realmId: recordRealmId(), createdAt: stamp, createdBy: currentUser }
    try {
      if (kind === 'task') {
        const data = { projectId, title: title.trim(), owner, dueDate: dueDate || undefined, status: (status || 'next') as TaskStatus, priority, notes: notes || undefined, driveUrl: url || undefined, updatedAt: stamp }
        if (isEdit) await db.tasks.update(state.recordId!, data)
        else await db.tasks.add({ id: newId('tasks', 'task'), ...add, ...data, position: Date.now() })
      }
      if (kind === 'note' || kind === 'idea') {
        const noteKind = (status || (kind === 'idea' ? 'idea' : 'note')) as Note['kind']
        const data = { projectId, title: title.trim(), body: notes || title.trim(), kind: noteKind, author: owner, updatedAt: stamp }
        if (isEdit) await db.notes.update(state.recordId!, data)
        else await db.notes.add({ id: newId('notes', 'note'), ...add, ...data })
      }
      if (kind === 'discussion') {
        const data = { projectId, title: title.trim(), owner, dueDate: dueDate || undefined, notes: notes || undefined, updatedAt: stamp }
        if (isEdit) await db.meetingItems.update(state.recordId!, data)
        else await db.meetingItems.add({ id: newId('meetingItems', 'agenda'), ...add, ...data, status: 'open' })
      }
      if (kind === 'milestone' || kind === 'deliverable') {
        const data = { projectId, title: title.trim(), owner, dueDate: dueDate || undefined, status: (status || 'not_started') as MilestoneStatus, notes: notes || undefined, driveUrl: url || undefined, deliverable: isDeliverable, updatedAt: stamp }
        if (isEdit) await db.milestones.update(state.recordId!, data)
        else await db.milestones.add({ id: newId('milestones', 'milestone'), ...add, ...data, position: Date.now() })
      }
      if (kind === 'link') {
        const data = { projectId, name: title.trim(), url: url.trim(), type: linkType.trim() || 'Link', owner, notes: notes || undefined, updatedAt: stamp }
        if (!data.url) { setSaving(false); return setError('Add the link URL.') }
        if (!isSafeUrl(data.url)) { setSaving(false); return setError('Only http:// or https:// links are allowed.') }
        if (isEdit) await db.resources.update(state.recordId!, data)
        else await db.resources.add({ id: newId('resources', 'link'), ...add, ...data })
      }
      if (kind === 'lead') {
        const data = { business: title.trim(), owner, followUpDate: dueDate || undefined, stage: (status || 'prospect') as LeadStage, notes: notes || undefined, website: url || undefined, tariff: tariff || undefined, quoted: quoted ? Number(quoted) : undefined, updatedAt: stamp }
        if (isEdit) await db.leads.update(state.recordId!, data)
        else await db.leads.add({ id: newId('leads', 'lead'), ...add, ...data, nextAction: 'Set the next action' })
      }
      localStorage.removeItem(draftKey); setToast({ message: `${config.singular} saved.` }); onClose()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save. Your draft is preserved.') }
    finally { setSaving(false) }
  }

  const remove = async () => {
    if (!state.recordId) return
    const table = recordTable(kind)
    if (!table) return
    const stamp = nowIso()
    await (table as any).update(state.recordId, { archivedAt: stamp, updatedAt: stamp })
    setToast({ message: `${config.singular} deleted.`, action: { label: 'Undo', run: () => (table as any).update(state.recordId, { archivedAt: undefined, updatedAt: nowIso() }) } })
    onClose()
  }

  const showProject = kind !== 'lead' && !state.projectId && !isEdit
  const showDate = kind !== 'note' && kind !== 'idea' && kind !== 'link'
  const showStatus = config.statuses.length > 0
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><div><p className="eyebrow">{isEdit ? 'Edit' : 'Quick add'}</p><h2 id="modal-title">{isEdit ? 'Edit' : 'Add'} {config.label}</h2></div><button onClick={onClose} aria-label="Close"><X /></button></header><form onSubmit={save}>
    <label><span>{config.titleLabel}</span><input ref={titleInput} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={config.placeholder} required /></label>
    {kind === 'link' && <label><span>URL</span><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" required /></label>}
    {kind === 'link' && <label><span>Type <small>optional</small></span><input value={linkType} onChange={(e) => setLinkType(e.target.value)} placeholder="Portfolio, Demo, Tool, Social…" /></label>}
    {showProject && <label><span>Project</span><select value={projectId} onChange={(e) => setProjectId(e.target.value)} required>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
    <div className="form-row"><label><span>Owner</span><select value={owner} onChange={(e) => setOwner(e.target.value as Owner)}>{owners.map((item) => <option key={item}>{item}</option>)}</select></label>{showDate && <label><span>{kind === 'lead' ? 'Follow-up' : 'Deadline'} <small>optional</small></span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>}</div>
    {showStatus && <label><span>{kind === 'lead' ? 'Stage' : 'Status'}</span><select value={status || config.defaultStatus} onChange={(e) => setStatus(e.target.value)}>{config.statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
    {(kind === 'milestone' || kind === 'deliverable') && <label className="check-label"><input type="checkbox" checked={isDeliverable} onChange={(e) => setIsDeliverable(e.target.checked)} /><span>The client receives this <small>shows up under deliverables and deadlines</small></span></label>}
    {kind === 'lead' && <div className="form-row">
      <label><span>Tariff <small>optional</small></span><input value={tariff} onChange={(e) => setTariff(e.target.value)} placeholder="Landing, Catalog…" /></label>
      <label><span>Project price ₽ <small>optional</small></span><input type="number" min="0" value={quoted} onChange={(e) => setQuoted(e.target.value)} placeholder="0" /></label>
    </div>}
    {kind === 'lead' && (isEdit
      ? <PaymentsEditor leadId={state.recordId!} quoted={quoted ? Number(quoted) : undefined} setToast={setToast} />
      : <p className="payments-hint">Save the client first, then you can add deposits, installments, a retainer, or a revenue share.</p>)}
    <button type="button" className="more-toggle" onClick={() => setMore(!more)}>{more ? 'Hide details' : 'More details'}<ChevronDown /></button>
    {more && <div className="more-fields"><label><span>{kind === 'note' || kind === 'idea' ? 'Text' : 'Notes'} <small>optional</small></span><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} placeholder="Add only the context someone will need later." /></label>{(kind === 'task' || kind === 'milestone' || kind === 'deliverable' || kind === 'lead') && <label><span>{kind === 'lead' ? 'Website' : 'Drive link'} <small>optional</small></span><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></label>}{kind === 'task' && <label><span>Priority</span><select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label>}</div>}
    {error && <p className="form-error">{error}</p>}
    <footer>{isEdit && <button type="button" className="danger-link" onClick={remove}>Delete</button>}<span className="footer-spacer" /><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? 'Saving…' : `Save ${config.singular.toLowerCase()}`}</button></footer>
  </form></section></div>
}

function modalConfig(kind: ModalKind) {
  const common = { singular: 'Item', label: 'item', titleLabel: 'Title', placeholder: 'What needs attention?', defaultStatus: '', statuses: [] as [string, string][] }
  if (kind === 'task') return { ...common, singular: 'Task', label: 'task', placeholder: 'A clear next action', defaultStatus: 'next', statuses: taskStatuses.map((s) => [s, taskStatusLabels[s]] as [string, string]) }
  if (kind === 'note') return { ...common, singular: 'Note', label: 'note', placeholder: 'What should you remember?', defaultStatus: 'note', statuses: [['note', 'Note'], ['decision', 'Decision'], ['idea', 'Idea']] as [string, string][] }
  if (kind === 'idea') return { ...common, singular: 'Idea', label: 'idea', placeholder: 'An idea worth keeping', defaultStatus: 'idea', statuses: [['idea', 'Idea'], ['note', 'Note'], ['decision', 'Decision']] as [string, string][] }
  if (kind === 'discussion') return { ...common, singular: 'Topic', label: 'meeting topic', placeholder: 'What should you discuss together?' }
  if (kind === 'milestone') return { ...common, singular: 'Step', label: 'plan step', placeholder: 'A meaningful stage in the plan', defaultStatus: 'not_started', statuses: milestoneStatuses.map((s) => [s, milestoneStatusLabels[s]] as [string, string]) }
  if (kind === 'deliverable') return { ...common, singular: 'Deliverable', label: 'deliverable', placeholder: 'Something the client receives', defaultStatus: 'not_started', statuses: milestoneStatuses.map((s) => [s, milestoneStatusLabels[s]] as [string, string]) }
  if (kind === 'link') return { ...common, singular: 'Link', label: 'link', titleLabel: 'Name', placeholder: 'What does this link open?' }
  if (kind === 'lead') return { ...common, singular: 'Client', label: 'client', titleLabel: 'Business', placeholder: 'Business name', defaultStatus: 'prospect', statuses: leadStageGroups.map((g) => [g.canonical, g.label] as [string, string]) }
  return common
}

function PaymentsEditor({ leadId, quoted, setToast }: { leadId: string; quoted?: number; setToast: (toast: ToastState) => void }) {
  const payments = useLiveQuery(() => db.payments.where('leadId').equals(leadId).filter((p) => !p.archivedAt).sortBy('position'), [leadId], [])
  const [adding, setAdding] = useState<PaymentKind | null>(null)
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})

  const received = sumReceived(payments)
  const due = sumDue(payments)
  const outstanding = quoted ? Math.max(0, quoted - received) : undefined
  const singles = payments.filter((p) => !p.groupId)
  const groups = new Map<string, Payment[]>()
  payments.filter((p) => p.groupId).forEach((p) => { groups.set(p.groupId!, [...(groups.get(p.groupId!) ?? []), p]) })
  const nextPosition = () => payments.reduce((max, p) => Math.max(max, p.position), 0) + 1

  const togglePaid = async (p: Payment) => {
    const paidNow = p.status !== 'paid'
    await db.payments.update(p.id, { status: paidNow ? 'paid' : 'due', paidDate: paidNow ? nowIso() : undefined, updatedAt: nowIso() })
  }
  const removeOne = async (p: Payment) => {
    await db.payments.update(p.id, { archivedAt: nowIso(), updatedAt: nowIso() })
    setToast({ message: 'Payment removed.', action: { label: 'Undo', run: () => db.payments.update(p.id, { archivedAt: undefined, updatedAt: nowIso() }) } })
  }
  const removeGroup = async (rows: Payment[]) => {
    const stamp = nowIso()
    await Promise.all(rows.map((r) => db.payments.update(r.id, { archivedAt: stamp, updatedAt: stamp })))
    setToast({ message: 'Recurring payments removed.', action: { label: 'Undo', run: () => Promise.all(rows.map((r) => db.payments.update(r.id, { archivedAt: undefined, updatedAt: nowIso() }))) } })
  }

  return <div className="payments-editor">
    <div className="payments-head"><span>Payments</span><span className="payments-summary">{formatMoney(received) || '₽0'} received{outstanding ? ` · ${formatMoney(outstanding)} outstanding` : due > 0 ? ` · ${formatMoney(due)} due` : ''}</span></div>
    <div className="payment-rows">
      {singles.map((p) => <PaymentRow key={p.id} payment={p} onToggle={() => togglePaid(p)} onRemove={() => removeOne(p)} />)}
      {[...groups.values()].map((rows) => {
        const first = rows[0]
        const label = first.label.split(' — ')[0]
        const paidCount = rows.filter((r) => r.status === 'paid').length
        const open = expanded[first.groupId!]
        return <div className="payment-group" key={first.groupId}>
          <div className="payment-group-head">
            <button type="button" className="row-main" onClick={() => setExpanded((e) => ({ ...e, [first.groupId!]: !open }))}>
              {first.kind === 'retainer' ? <Repeat /> : <Wallet />}
              <span><strong>{label}</strong><small>{first.amount ? `${formatMoney(first.amount)} × ${rows.length}` : `${rows.length} periods`}{first.percent ? ` · ${first.percent}%` : ''} · {paidCount} of {rows.length} paid</small></span>
              <ChevronDown className={open ? 'chevron rotated' : 'chevron'} />
            </button>
            <button type="button" aria-label={`Remove ${label}`} className="pay-remove" onClick={() => removeGroup(rows)}><Trash2 /></button>
          </div>
          {open && <div className="payment-group-rows">{rows.map((p) => <PaymentRow key={p.id} payment={p} compact onToggle={() => togglePaid(p)} onRemove={() => removeOne(p)} />)}</div>}
        </div>
      })}
      {!payments.length && <p className="payments-empty">No payments yet. Add a deposit, an installment, a retainer, or a share.</p>}
    </div>
    {adding
      ? <PaymentForm kind={adding} leadId={leadId} startPosition={nextPosition()} onDone={() => setAdding(null)} setToast={setToast} />
      : <div className="payment-add-actions">
          <button type="button" onClick={() => setAdding('one_off')}><Plus /> Add payment</button>
          <button type="button" onClick={() => setAdding('retainer')}><Repeat /> Add recurring</button>
          <button type="button" onClick={() => setAdding('share')}><Wallet /> Add share</button>
        </div>}
  </div>
}

function PaymentRow({ payment, onToggle, onRemove, compact }: { payment: Payment; onToggle: () => void; onRemove: () => void; compact?: boolean }) {
  const [amount, setAmount] = useState(payment.amount?.toString() ?? '')
  useEffect(() => { setAmount(payment.amount?.toString() ?? '') }, [payment.amount])
  const timing = payment.dueDate ? formatDate(payment.dueDate) : payment.timing && payment.timing !== 'date' ? paymentTimingLabels[payment.timing] : ''
  const overdue = payment.status !== 'paid' && isOverdue(payment.dueDate)
  const rowLabel = compact ? payment.label.split(' — ').slice(1).join(' — ') || payment.label : payment.label
  const commitAmount = async () => {
    const next = amount ? Number(amount) : undefined
    if (next === payment.amount) return
    await db.payments.update(payment.id, { amount: next, updatedAt: nowIso() })
  }
  return <div className={`payment-row ${compact ? 'compact' : ''}`}>
    <span className="payment-label"><strong>{rowLabel}</strong>{timing && <small className={overdue ? 'overdue' : ''}>{timing}</small>}</span>
    {payment.kind === 'share'
      ? <span className="payment-amount"><input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} onBlur={commitAmount} placeholder={payment.percent ? `${payment.percent}%` : '₽'} /></span>
      : <span className="payment-amount">{payment.amount ? formatMoney(payment.amount) : '—'}</span>}
    <button type="button" className={`pay-pill ${payment.status}`} onClick={onToggle}>{payment.status === 'paid' ? 'Paid' : 'Due'}</button>
    <button type="button" aria-label={`Remove ${payment.label}`} className="pay-remove" onClick={onRemove}><Trash2 /></button>
  </div>
}

function PaymentForm({ kind, leadId, startPosition, onDone, setToast }: { kind: PaymentKind; leadId: string; startPosition: number; onDone: () => void; setToast: (toast: ToastState) => void }) {
  const [label, setLabel] = useState(kind === 'retainer' ? 'Monthly retainer' : kind === 'share' ? 'Revenue share' : '')
  const [amount, setAmount] = useState('')
  const [percent, setPercent] = useState('')
  const [timing, setTiming] = useState<PaymentTiming>('date')
  const [date, setDate] = useState('')
  const [startDate, setStartDate] = useState('')
  const [count, setCount] = useState('12')
  const title = kind === 'retainer' ? 'Recurring retainer' : kind === 'share' ? 'Revenue / profit share' : 'One-off payment'

  const save = async () => {
    const stamp = nowIso()
    if (kind === 'one_off') {
      await db.payments.add({
        id: newId('payments', 'payment'), realmId: recordRealmId(), leadId, kind: 'one_off',
        label: label.trim() || 'Payment', amount: amount ? Number(amount) : undefined,
        timing, dueDate: timing === 'date' ? (date || undefined) : undefined,
        status: 'due', position: startPosition, createdAt: stamp, updatedAt: stamp
      })
    } else {
      const rows = generateRecurring({
        leadId, realmId: recordRealmId(), kind,
        label: label.trim() || (kind === 'retainer' ? 'Retainer' : 'Share'),
        amount: kind === 'retainer' && amount ? Number(amount) : undefined,
        percent: kind === 'share' && percent ? Number(percent) : undefined,
        startDate: startDate || stamp.slice(0, 10),
        count: Math.max(1, Number(count) || 1),
        makeRowId: () => newId('payments', 'payment')
      })
      rows.forEach((r, i) => { r.position = startPosition + i })
      await db.payments.bulkAdd(rows)
    }
    setToast({ message: 'Payment added.' })
    onDone()
  }

  return <div className="payment-form" onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); save() } }}>
    <p className="payment-form-title">{title}</p>
    <label><span>Label</span><input value={label} onChange={(e) => setLabel(e.target.value)} placeholder={kind === 'one_off' ? 'Deposit, Balance…' : undefined} autoFocus /></label>
    {kind === 'one_off' && <>
      <div className="form-row"><label><span>Amount ₽</span><input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0" /></label><label><span>When</span><select value={timing} onChange={(e) => setTiming(e.target.value as PaymentTiming)}>{paymentTimings.map((t) => <option key={t} value={t}>{paymentTimingLabels[t]}</option>)}</select></label></div>
      {timing === 'date' && <label><span>Due date</span><input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>}
    </>}
    {kind === 'retainer' && <div className="form-row form-row-3">
      <label><span>Amount ₽ / month</span><input type="number" min="0" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="20000" /></label>
      <label><span>Starts</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
      <label><span>Months</span><input type="number" min="1" max="120" value={count} onChange={(e) => setCount(e.target.value)} /></label>
    </div>}
    {kind === 'share' && <div className="form-row form-row-3">
      <label><span>Share %</span><input type="number" min="0" value={percent} onChange={(e) => setPercent(e.target.value)} placeholder="10" /></label>
      <label><span>Starts</span><input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} /></label>
      <label><span>Months</span><input type="number" min="1" max="120" value={count} onChange={(e) => setCount(e.target.value)} /></label>
    </div>}
    {kind === 'share' && <p className="payment-form-hint">Creates one row per month. Fill in each period's amount as it comes in.</p>}
    <div className="payment-form-actions"><button type="button" onClick={onDone}>Cancel</button><button type="button" className="primary-button" onClick={save}>Add</button></div>
  </div>
}

function ProjectModal({ state, onClose, setToast, openProject }: { state: ProjectModalState; onClose: () => void; setToast: (toast: ToastState) => void; openProject: (id: string) => void }) {
  const existing = useLiveQuery(() => state.projectId ? db.projects.get(state.projectId) : undefined, [state.projectId])
  const isEdit = Boolean(state.projectId)
  const [name, setName] = useState('')
  const [clientType, setClientType] = useState<Project['clientType']>('client')
  const [phase, setPhase] = useState('')
  const [goal, setGoal] = useState('')
  const [currentFocus, setCurrentFocus] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [driveFolderUrl, setDriveFolderUrl] = useState('')
  const [color, setColor] = useState(projectColors[1])
  const [error, setError] = useState('')
  const nameInput = useRef<HTMLInputElement>(null)

  useEffect(() => { nameInput.current?.focus() }, [])
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])
  useEffect(() => {
    if (!existing) return
    setName(existing.name); setClientType(existing.clientType); setPhase(existing.phase)
    setGoal(existing.goal); setCurrentFocus(existing.currentFocus); setTargetDate(existing.targetDate ?? '')
    setDriveFolderUrl(existing.driveFolderUrl ?? ''); setColor(existing.color)
  }, [existing])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return setError('Give the project a name.')
    if (driveFolderUrl.trim() && !isSafeUrl(driveFolderUrl.trim())) return setError('Only http:// or https:// links are allowed.')
    if (cloudEnabled && !state.projectId && !getActiveRealmId()) return setError('Still connecting to the workspace. Try again in a moment.')
    const stamp = nowIso()
    const data = { name: name.trim(), clientType, phase: phase.trim() || (clientType === 'internal' ? 'Operations' : 'Getting started'), goal: goal.trim(), currentFocus: currentFocus.trim(), targetDate: targetDate || undefined, driveFolderUrl: driveFolderUrl || undefined, color, updatedAt: stamp }
    try {
      if (isEdit) {
        await db.projects.update(state.projectId!, data)
        setToast({ message: 'Project updated.' })
      } else {
        const count = await db.projects.count()
        const id = newId('projects', 'project')
        await db.projects.add({ id, realmId: recordRealmId(), ...data, serviceType: clientType === 'internal' ? 'studio' : 'website', status: 'active', order: count + 1, createdAt: stamp, createdBy: undefined })
        setToast({ message: 'Project created. Add the first plan step.' })
        openProject(id)
      }
      onClose()
    } catch (err) { setError(err instanceof Error ? err.message : 'Could not save the project.') }
  }

  const archiveProject = async () => {
    if (!state.projectId) return
    const stamp = nowIso()
    await db.projects.update(state.projectId, { archivedAt: stamp, status: 'archived', updatedAt: stamp })
    setToast({ message: 'Project archived.', action: { label: 'Undo', run: () => db.projects.update(state.projectId!, { archivedAt: undefined, status: 'active', updatedAt: nowIso() }) } })
    onClose()
  }

  const deleteProject = async () => {
    if (!state.projectId || !existing) return
    if (!window.confirm(`Permanently delete "${existing.name}"? This removes its plan, tasks, notes and links for good. This cannot be undone.`)) return
    await deleteProjectPermanently(state.projectId)
    setToast({ message: `${existing.name} permanently deleted.` })
    onClose()
  }

  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section className="modal" role="dialog" aria-modal="true" aria-labelledby="project-modal-title"><header><div><p className="eyebrow">{isEdit ? 'Edit' : 'New'}</p><h2 id="project-modal-title">{isEdit ? 'Edit project' : 'New project'}</h2></div><button onClick={onClose} aria-label="Close"><X /></button></header><form onSubmit={save}>
    <label><span>Name</span><input ref={nameInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Client or project name" required /></label>
    <div className="form-row">
      <label><span>Type</span><select value={clientType} onChange={(e) => setClientType(e.target.value as Project['clientType'])}><option value="client">Client project</option><option value="internal">Internal</option></select></label>
      <label><span>Phase <small>optional</small></span><input value={phase} onChange={(e) => setPhase(e.target.value)} placeholder="Foundation, Build…" /></label>
    </div>
    <label><span>Goal</span><textarea value={goal} onChange={(e) => setGoal(e.target.value)} rows={2} placeholder="What does done look like for this project?" /></label>
    <label><span>Current focus</span><input value={currentFocus} onChange={(e) => setCurrentFocus(e.target.value)} placeholder="The one thing you are pushing right now" /></label>
    <div className="form-row">
      <label><span>Target date <small>optional</small></span><input type="date" value={targetDate} onChange={(e) => setTargetDate(e.target.value)} /></label>
      <label><span>Drive folder <small>optional</small></span><input type="url" value={driveFolderUrl} onChange={(e) => setDriveFolderUrl(e.target.value)} placeholder="https://" /></label>
    </div>
    <div className="swatch-field"><span>Colour</span><div className="swatches" role="radiogroup" aria-label="Project colour">{projectColors.map((item) => <button type="button" key={item} className={`swatch ${color === item ? 'selected' : ''}`} style={{ background: item }} aria-label={`Colour ${item}`} onClick={() => setColor(item)}>{color === item && <Check />}</button>)}</div></div>
    {error && <p className="form-error">{error}</p>}
    <footer>{isEdit && !existing?.archivedAt && <button type="button" className="danger-link" onClick={archiveProject}>Archive project</button>}{isEdit && existing?.archivedAt && <button type="button" className="danger-link" onClick={deleteProject}>Delete permanently</button>}<span className="footer-spacer" /><button type="button" onClick={onClose}>Cancel</button><button className="primary-button" type="submit">{isEdit ? 'Save project' : 'Create project'}</button></footer>
  </form></section></div>
}

function Toast({ toast, close }: { toast: ToastState; close: () => void }) {
  return <div className="toast" role="status"><span>{toast.message}</span>{toast.action && <button onClick={() => { toast.action?.run(); close() }}>{toast.action.label}</button>}<button aria-label="Dismiss" onClick={close}><X /></button></div>
}
