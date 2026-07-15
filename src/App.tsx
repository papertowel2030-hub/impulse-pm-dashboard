import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useLiveQuery } from 'dexie-react-hooks'
import {
  Archive, CalendarDays, Check, ChevronDown, ChevronRight, CloudOff, Download, ExternalLink,
  FileCheck2, FolderKanban, Home, Lightbulb, Link2, LogIn, LogOut, Menu, MessageSquareText, NotebookPen,
  Pencil, Plus, Repeat, Search, Settings, Star, Target, Trash2, Upload, UserPlus, Users, Wallet, X
} from 'lucide-react'
import { db, cloudEnabled, newId, recordRealmId, getActiveRealmId, setActiveRealmId, createWorkspaceRealm, restampLegacyRealm, seedIfEmpty, convertDeliverablesToPlan, convertPaidToPayments, deleteProjectPermanently, resetLocalData } from './db'
import { importWorkspaceFile } from './importData'
import type {
  Lead, LeadStage, MeetingItem, MeetingItemStatus, Milestone, MilestoneStatus, ModalKind, Note,
  Owner, Payment, PaymentKind, PaymentTiming, Priority, Project, ProjectTab, Resource, Task, TaskStatus, ViewName
} from './types'
import {
  activeMeetingStatus, addMonthsIso, daysSince, daysUntil, formatDate, formatMoney, fullDate, generateRecurring,
  canonicalLeadStage, isOverdue, isSafeUrl, leadStageGroups, leadStageLabels, makeId, meetingStatusLabels, milestoneStatusLabels, nearestByDate, nextPayment,
  nowIso, paymentTimingLabels, resolveWorkspaceRealmId, sumDue, sumReceived, taskStatusLabels
} from './utils'

const paymentTimings = Object.keys(paymentTimingLabels) as PaymentTiming[]

const owners: Owner[] = ['Moon', 'Kira', 'Moon + Kira']
const taskStatuses: TaskStatus[] = ['next', 'in_progress', 'waiting', 'backlog', 'done']
const milestoneStatuses = Object.keys(milestoneStatusLabels) as MilestoneStatus[]
const projectColors = ['#2ee6ff', '#ffb86b', '#7aa2f7', '#5fe0a8', '#ff8585', '#c3a6ff', '#ffd166', '#93a7c4']
const activeLeadStages: LeadStage[] = ['prospect', 'contacted', 'replied', 'discovery', 'proposal']
const clientListBatchSize = 15

const ownerShort: Record<Owner, string> = { Moon: 'M', Kira: 'K', 'Moon + Kira': 'M+K' }

interface ToastState { message: string; action?: { label: string; run: () => unknown } }
interface ModalState { kind: ModalKind; projectId?: string; recordId?: string }
interface ProjectModalState { projectId?: string; clientId?: string }

function useDialogBehavior(ref: React.RefObject<HTMLElement>, onClose: () => void) {
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); onClose(); return }
      if (event.key !== 'Tab' || !ref.current) return
      const focusable = Array.from(ref.current.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]'))
        .filter((element) => element.offsetParent !== null)
      if (!focusable.length) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus() }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus() }
    }
    window.addEventListener('keydown', onKey)
    return () => { window.removeEventListener('keydown', onKey); previous?.focus?.() }
  }, [onClose, ref])
}

function usePersistedState<T>(key: string, fallback: T) {
  const [value, setValue] = useState<T>(() => {
    try { return JSON.parse(localStorage.getItem(key) ?? '') as T } catch { return fallback }
  })
  useEffect(() => { localStorage.setItem(key, JSON.stringify(value)) }, [key, value])
  return [value, setValue] as const
}

function useOnlineStatus() {
  const [online, setOnline] = useState(() => navigator.onLine)
  useEffect(() => {
    const update = () => setOnline(navigator.onLine)
    window.addEventListener('online', update)
    window.addEventListener('offline', update)
    return () => {
      window.removeEventListener('online', update)
      window.removeEventListener('offline', update)
    }
  }, [])
  return online
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
  const status = acceptedAt ? `Accepted ${fullDate(acceptedAt)}` : member.rejected ? 'Invite declined' : 'Invite pending — hasn’t signed in yet'
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
  const userMenuRef = useRef<HTMLDivElement>(null)
  const online = useOnlineStatus()
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

  useEffect(() => {
    if (!menuOpen && !mobileNavOpen) return
    const closeOnOutside = (event: PointerEvent) => {
      if (menuOpen && userMenuRef.current && !userMenuRef.current.contains(event.target as Node)) setMenuOpen(false)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { setMenuOpen(false); setMobileNavOpen(false) }
    }
    document.addEventListener('pointerdown', closeOnOutside)
    window.addEventListener('keydown', closeOnEscape)
    return () => { document.removeEventListener('pointerdown', closeOnOutside); window.removeEventListener('keydown', closeOnEscape) }
  }, [menuOpen, mobileNavOpen])

  const projects = useLiveQuery(() => db.projects.filter((project) => !project.archivedAt).toArray(), [], [])

  if (access === 'signed-out') return <LoginScreen />
  if (access === 'checking') return <CheckingAccessScreen />
  if (access === 'denied' && isOwner && realmError) return <WorkspaceSetupErrorScreen error={realmError} />
  if (access === 'denied') return <NotAuthorizedScreen email={cloudUser?.email} />

  const navigate = (next: ViewName) => {
    setView(next)
    setMobileNavOpen(false)
    setMenuOpen(false)
    window.scrollTo({ top: 0 })
  }

  const openProject = (id: string) => {
    setSelectedProjectId(id)
    setProjectTab('overview')
    setView('projects')
    setMobileNavOpen(false)
    window.scrollTo({ top: 0 })
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
          <NavButton active={view === 'home'} icon={<Home />} label="Today" onClick={() => navigate('home')} />
          <NavButton active={view === 'projects'} icon={<FolderKanban />} label="Projects" onClick={() => navigate('projects')} />
          <NavButton active={view === 'sales'} icon={<Target />} label="Clients" onClick={() => navigate('sales')} />
          <NavButton active={view === 'meeting'} icon={<MessageSquareText />} label="Meeting" onClick={() => navigate('meeting')} />
        </nav>
        <details className="sidebar-projects" aria-label="Active projects">
          <summary><span>Active projects</span><strong>{projects.filter((p) => p.status === 'active').length}</strong><ChevronDown /></summary>
          <div>
            {projects.filter((p) => p.status === 'active').sort((a, b) => a.order - b.order).map((project) => (
              <button key={project.id} onClick={() => openProject(project.id)} className={selectedProjectId === project.id && view === 'projects' ? 'selected' : ''}>
                <span className="project-dot" style={{ background: project.color }} />{project.name}
              </button>
            ))}
            <button className="sidebar-new" onClick={() => { setProjectModal({}); setMobileNavOpen(false) }}><Plus /> New project</button>
          </div>
        </details>
        <button className="sidebar-settings" onClick={() => navigate('settings')}><Settings /> Settings</button>
      </aside>
      {mobileNavOpen && <button className="mobile-nav-backdrop" aria-label="Close navigation" onClick={() => setMobileNavOpen(false)} />}

      <div className="app-main">
        <header className="topbar">
          <button className="mobile-menu" aria-label="Toggle navigation" onClick={() => setMobileNavOpen(!mobileNavOpen)}><Menu /></button>
          <div className="topbar-context">
            <span>Impulse Workspace</span>
            {!online && <span className="sync-state"><CloudOff /> Offline</span>}
          </div>
          <div className="topbar-actions">
            <QuickAdd onSelect={(kind) => openQuickAdd(kind)} />
            <div className="user-menu-wrap" ref={userMenuRef}>
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
          {view === 'home' && <HomeView openProject={openProject} navigate={navigate} openEdit={openQuickAdd} openClient={(id) => setModal({ kind: 'lead', recordId: id })} />}
          {view === 'projects' && (
            <ProjectsView
              selectedProjectId={selectedProjectId}
              setSelectedProjectId={setSelectedProjectId}
              tab={projectTab}
              setTab={setProjectTab}
              openAdd={openQuickAdd}
              openProjectEdit={(id) => setProjectModal({ projectId: id })}
              openClient={(id) => setModal({ kind: 'lead', recordId: id })}
              setToast={setToast}
            />
          )}
          {view === 'sales' && <ClientsView openModal={(recordId) => setModal({ kind: 'lead', recordId })} addLead={() => setModal({ kind: 'lead' })} />}
          {view === 'meeting' && <MeetingView currentUser={currentUser} setToast={setToast} openProject={openProject} openEdit={openQuickAdd} />}
          {view === 'settings' && <SettingsView currentUser={currentUser} isOwner={isOwner} email={cloudUser?.email} realmId={workspaceRealmId} onSignOut={signOut} setToast={setToast} />}
        </main>
      </div>

      {modal.kind && <EntryModal state={modal} currentUser={currentUser} onClose={() => setModal({ kind: null })} setToast={setToast}
        createProjectForClient={(clientId) => { setModal({ kind: null }); setProjectModal({ clientId }) }}
        openProject={(projectId) => { setModal({ kind: null }); openProject(projectId) }} />}
      {projectModal && <ProjectModal state={projectModal} currentUser={currentUser} onClose={() => setProjectModal(null)} setToast={setToast} openProject={openProject} />}
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
  const wrapRef = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (event: PointerEvent) => { if (wrapRef.current && !wrapRef.current.contains(event.target as Node)) setOpen(false) }
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', close)
    window.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', close); window.removeEventListener('keydown', escape) }
  }, [open])
  return (
    <div className="quick-add-wrap" ref={wrapRef}>
      <button className="primary-button" onClick={() => setOpen(!open)} aria-expanded={open}><Plus /> Quick capture</button>
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

type HomeSection = 'focus' | 'projects' | 'schedule' | 'tasks' | 'followups' | 'meeting'

function HomeSectionButton({ id, active, icon, title, count, onClick }: {
  id: HomeSection; active: boolean; icon: React.ReactNode; title: string; count: number; onClick: () => void
}) {
  return <button className={`home-section-button ${active ? 'active' : ''}`} onClick={onClick} aria-expanded={active} aria-controls="home-section-content">
    <span className="home-section-icon">{icon}</span>
    <strong>{title}</strong>
    <span className="home-section-count">{count}</span>
    <ChevronRight className="home-section-chevron" />
  </button>
}

function HomeView({ openProject, navigate, openEdit, openClient }: {
  openProject: (id: string) => void
  navigate: (view: ViewName) => void
  openEdit: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void
  openClient: (id: string) => void
}) {
  const projects = useLiveQuery(() => db.projects.filter((p) => !p.archivedAt && p.status === 'active').toArray(), [], [])
  const milestones = useLiveQuery(() => db.milestones.filter((m) => !m.archivedAt).toArray(), [], [])
  const tasks = useLiveQuery(() => db.tasks.filter((t) => !t.archivedAt && t.status !== 'done').toArray(), [], [])
  const leads = useLiveQuery(() => db.leads.filter((l) => !l.archivedAt && l.stage !== 'won' && l.stage !== 'lost').toArray(), [], [])
  const allLeads = useLiveQuery(() => db.leads.filter((l) => !l.archivedAt).toArray(), [], [])
  const payments = useLiveQuery(() => db.payments.filter((p) => !p.archivedAt && p.status === 'due').toArray(), [], [])
  const meetingItems = useLiveQuery(() => db.meetingItems.filter((item) => !item.archivedAt && activeMeetingStatus(item.status)).toArray(), [], [])

  const dueFollowUps = leads.filter((lead) => lead.followUpDate && daysUntil(lead.followUpDate) <= 7).sort((a, b) => (a.followUpDate ?? '').localeCompare(b.followUpDate ?? ''))
  const nextTasks = tasks.filter((task) => task.status === 'next' || task.status === 'in_progress').sort((a, b) => (a.dueDate ?? '9999').localeCompare(b.dueDate ?? '9999')).slice(0, 6)
  const urgentTasks = nextTasks.filter((task) => task.dueDate && daysUntil(task.dueDate) <= 7)
  const blockers = tasks.filter((task) => task.status === 'waiting')
  const [section, setSection] = useState<HomeSection>('focus')
  const [importPromptDismissed, setImportPromptDismissed] = usePersistedState('impulse:import-prompt-dismissed', false)
  const focusItems = [
    ...blockers.map((task) => ({ id: `blocker-${task.id}`, title: task.title, meta: `Waiting · ${projects.find((p) => p.id === task.projectId)?.name ?? 'Project'}`, date: task.dueDate, open: () => openEdit('task', task.projectId, task.id), urgent: true })),
    ...urgentTasks.map((task) => ({ id: `task-${task.id}`, title: task.title, meta: `Task · ${projects.find((p) => p.id === task.projectId)?.name ?? 'Project'}`, date: task.dueDate, open: () => openEdit('task', task.projectId, task.id), urgent: Boolean(task.dueDate && isOverdue(task.dueDate)) })),
    ...dueFollowUps.map((lead) => ({ id: `lead-${lead.id}`, title: lead.business, meta: `Follow-up · ${lead.nextAction || 'Choose the next action'}`, date: lead.followUpDate, open: () => openClient(lead.id), urgent: Boolean(lead.followUpDate && isOverdue(lead.followUpDate)) }))
  ].slice(0, 7)
  const sectionButtons: { id: HomeSection; icon: React.ReactNode; title: string; count: number }[] = [
    { id: 'focus', icon: <Target />, title: 'Focus', count: blockers.length + urgentTasks.length + dueFollowUps.length },
    { id: 'projects', icon: <FolderKanban />, title: 'Projects', count: projects.length },
    { id: 'schedule', icon: <CalendarDays />, title: '14 days', count: milestones.filter((m) => m.dueDate && m.status !== 'done' && daysUntil(m.dueDate) <= 14).length + tasks.filter((t) => t.dueDate && t.status !== 'done' && daysUntil(t.dueDate) <= 14).length + leads.filter((l) => l.followUpDate && daysUntil(l.followUpDate) <= 14).length + payments.filter((p) => p.dueDate && daysUntil(p.dueDate) <= 14).length },
    { id: 'tasks', icon: <Check />, title: 'Tasks', count: nextTasks.length },
    { id: 'followups', icon: <UserPlus />, title: 'Follow-ups', count: dueFollowUps.length },
    { id: 'meeting', icon: <MessageSquareText />, title: 'Meeting', count: meetingItems.length }
  ]

  return <div className="page">
    <PageHeader title="Today" />
    <div className="calm-dashboard">
      <nav className="home-section-picker" aria-label="Dashboard sections">
        {sectionButtons.map((item) => <HomeSectionButton key={item.id} {...item} active={section === item.id} onClick={() => setSection(item.id)} />)}
      </nav>

      <section className="home-section-content" id="home-section-content" aria-live="polite">
        {section === 'focus' && <div className="simple-list focus-list">{focusItems.map((item) => <div className="list-row is-actionable" key={item.id}><span><button className="row-main" onClick={item.open}><strong>{item.title}</strong><small>{item.meta}</small></button></span>{item.date && <time className={item.urgent ? 'overdue' : ''}>{formatDate(item.date)}</time>}<ChevronRight /></div>)}{!focusItems.length && <EmptyState text="Nothing urgent." />}</div>}

        {section === 'projects' && <section className="attention-list" aria-label="Active projects">
          {projects.sort((a, b) => {
            const hasWaiting = (project: Project) => tasks.some((task) => task.projectId === project.id && task.status === 'waiting')
            const hasOverdue = (project: Project) => tasks.some((task) => task.projectId === project.id && task.status !== 'done' && isOverdue(task.dueDate))
            return Number(hasWaiting(b)) - Number(hasWaiting(a)) || Number(hasOverdue(b)) - Number(hasOverdue(a)) || a.order - b.order
          }).map((project) => {
            const projectMilestones = milestones.filter((m) => m.projectId === project.id).sort((a, b) => a.position - b.position)
            const doneCount = projectMilestones.filter((m) => m.status === 'done').length
            const openMilestones = projectMilestones.filter((m) => m.status !== 'done')
            const nextMilestone = openMilestones.find((m) => m.status === 'in_progress') ?? openMilestones[0]
            const blocker = tasks.find((task) => task.projectId === project.id && task.status === 'waiting')
            return <button key={project.id} className="attention-row calm-project-row" onClick={() => openProject(project.id)}>
              <span className="project-accent" style={{ background: project.color }} />
              <span className="attention-project"><strong>{project.name}</strong><small>{project.phase}{projectMilestones.length ? ` · ${doneCount}/${projectMilestones.length}` : ''}</small>{projectMilestones.length > 0 && <span className="progress-track" aria-hidden="true"><span className="progress-fill" style={{ width: `${Math.round((doneCount / projectMilestones.length) * 100)}%` }} /></span>}</span>
              <span className="attention-focus"><small>Current focus</small>{project.currentFocus}</span>
              <span><small>Next step</small>{nextMilestone?.title ?? (projectMilestones.length ? 'Plan complete' : 'Set the next step')}</span>
              <span className={blocker ? 'has-blocker' : 'clear'}><small>{blocker ? 'Waiting' : 'Status'}</small>{blocker?.title ?? 'Clear'}</span>
              <span className={`attention-mobile ${blocker ? 'has-blocker' : ''}`}>{blocker ? `Waiting: ${blocker.title}` : nextMilestone ? `Next: ${nextMilestone.title}` : 'Plan complete'}</span>
              <ChevronRight />
            </button>
          })}
          {!projects.length && !importPromptDismissed && <div className="first-run-card"><button className="notice-dismiss" aria-label="Dismiss import reminder" onClick={() => setImportPromptDismissed(true)}><X /></button><p className="eyebrow">First setup</p><h2>Bring in your Command Center</h2><p>Your private client data is kept outside the public app build. Import the prepared local file once, then continue here.</p><ol><li>Open Settings</li><li>Choose the Command Center import file</li><li>Review the three project overviews</li></ol><button className="primary-button" onClick={() => navigate('settings')}>Open settings</button></div>}
        </section>}

        {section === 'schedule' && <UpcomingDeadlines projects={projects} milestones={milestones} tasks={tasks} leads={leads} payments={payments} allLeads={allLeads} openEdit={openEdit} openClient={openClient} />}
        {section === 'tasks' && <section><SectionTitle title="Next tasks" action={<button onClick={() => navigate('projects')}>View projects</button>} /><div className="simple-list">{nextTasks.length ? nextTasks.map((task) => <TaskLine key={task.id} task={task} project={projects.find((p) => p.id === task.projectId)} onOpen={() => openEdit('task', task.projectId, task.id)} />) : <EmptyState text="No next tasks yet." />}</div></section>}
        {section === 'followups' && <section><SectionTitle title="Client follow-ups" action={<button onClick={() => navigate('sales')}>View all clients</button>} /><div className="simple-list">{dueFollowUps.length ? dueFollowUps.slice(0, 8).map((lead) => <div className="list-row is-actionable" key={lead.id}><span><button className="row-main" onClick={() => openClient(lead.id)}><strong>{lead.business}</strong><small>{lead.nextAction || 'Choose the next action'}</small></button></span><time className={isOverdue(lead.followUpDate) ? 'overdue' : ''}>{formatDate(lead.followUpDate)}</time><ChevronRight /></div>) : <EmptyState text="No follow-ups due in the next seven days." />}</div></section>}
        {section === 'meeting' && <section><SectionTitle title="Meeting agenda" action={<button onClick={() => navigate('meeting')}>Open meeting</button>} /><div className="simple-list">{meetingItems.slice(0, 8).map((item) => <div className="list-row is-actionable" key={item.id}><span><button className="row-main" onClick={() => openEdit('discussion', item.projectId, item.id)}><strong>{item.title}</strong><small>{projects.find((p) => p.id === item.projectId)?.name}</small></button></span><ChevronRight /></div>)}{!meetingItems.length && <EmptyState text="No unresolved topics." />}</div></section>}
      </section>
    </div>
  </div>
}

function UpcomingDeadlines({ projects, milestones, tasks, leads, payments, allLeads, openEdit, openClient }: {
  projects: Project[]; milestones: Milestone[]; tasks: Task[]; leads: Lead[]; payments: Payment[]; allLeads: Lead[]
  openEdit: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void
  openClient: (id: string) => void
}) {
  const businessOf = (leadId: string) => allLeads.find((l) => l.id === leadId)?.business ?? 'Client'
  const items = [
    ...milestones.filter((m) => m.dueDate && m.status !== 'done').map((m) => ({ id: m.id, date: m.dueDate!, kind: m.deliverable ? 'Deliverable' : 'Step', title: m.title, projectId: m.projectId as string | undefined, money: false, open: () => openEdit(m.deliverable ? 'deliverable' : 'milestone', m.projectId, m.id) })),
    ...tasks.filter((t) => t.dueDate && t.status !== 'done').map((t) => ({ id: t.id, date: t.dueDate!, kind: 'Task', title: t.title, projectId: t.projectId as string | undefined, money: false, open: () => openEdit('task', t.projectId, t.id) })),
    ...leads.filter((l) => l.followUpDate).map((l) => ({ id: l.id, date: l.followUpDate!, kind: 'Follow-up', title: l.business, projectId: undefined as string | undefined, money: false, open: () => openClient(l.id) })),
    ...payments.filter((p) => p.dueDate).map((p) => ({ id: p.id, date: p.dueDate!, kind: p.kind === 'retainer' ? 'Retainer' : 'Payment', title: `${businessOf(p.leadId)} · ${p.amount ? formatMoney(p.amount) : p.label}`, projectId: undefined as string | undefined, money: true, open: () => openClient(p.leadId) }))
  ].filter((item) => daysUntil(item.date) <= 14).sort((a, b) => a.date.localeCompare(b.date))

  return <section className="deadline-strip" aria-label="Deadlines in the next two weeks">
    <SectionTitle title="Next 14 days" />
    <div className="deadline-list">
      {items.map((item) => {
        const project = projects.find((p) => p.id === item.projectId)
        const late = isOverdue(item.date)
        return <button className="deadline-row" key={`${item.kind}-${item.id}`} onClick={item.open} aria-label={`Open ${item.kind.toLowerCase()} ${item.title}`}>
          <span className={`deadline-date ${late ? 'overdue' : ''}`}>{formatDate(item.date)}{late ? ' · late' : ''}</span>
          <span className={`deadline-kind ${item.money ? 'is-money' : ''}`}>{item.kind}</span>
          <span className="deadline-title">{item.title}</span>
          <span className="deadline-project">{project ? <><span className="project-dot" style={{ background: project.color }} />{project.name}</> : item.money ? 'Money' : 'Clients'}</span>
          <ChevronRight />
        </button>
      })}
      {!items.length && <EmptyState text="No dated work in the next two weeks. Give plan steps a deadline to see them here." />}
    </div>
  </section>
}

function TaskLine({ task, project, onOpen }: { task: Task; project?: Project; onOpen?: () => void }) {
  return <div className={`list-row ${onOpen ? 'is-actionable' : ''}`}><span className={`status-dot status-${task.status}`} /><OwnerChip owner={task.owner} /><span>{onOpen ? <button className="row-main" onClick={onOpen}><strong>{task.title}</strong><small>{project ? `${project.name} · ` : ''}{taskStatusLabels[task.status]}</small></button> : <><strong>{task.title}</strong><small>{project ? `${project.name} · ` : ''}{taskStatusLabels[task.status]}</small></>}</span>{task.dueDate && <time className={isOverdue(task.dueDate) ? 'overdue' : ''}>{formatDate(task.dueDate)}</time>}{onOpen && <ChevronRight />}</div>
}

function SectionTitle({ title, action }: { title: string; action?: React.ReactNode }) {
  return <div className="section-title"><h2>{title}</h2>{action}</div>
}

function EmptyState({ text, action }: { text: string; action?: React.ReactNode }) {
  return <div className="empty-state"><p>{text}</p>{action}</div>
}

function ProjectsView({ selectedProjectId, setSelectedProjectId, tab, setTab, openAdd, openProjectEdit, openClient, setToast }: {
  selectedProjectId: string; setSelectedProjectId: (id: string) => void; tab: ProjectTab; setTab: (tab: ProjectTab) => void;
  openAdd: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void; openProjectEdit: (id: string) => void; openClient: (id: string) => void; setToast: (toast: ToastState) => void
}) {
  const projects = useLiveQuery(() => db.projects.filter((p) => !p.archivedAt && p.status !== 'archived').toArray(), [], [])
  const project = projects.find((item) => item.id === selectedProjectId) ?? projects[0]
  if (!project) return <div className="page"><EmptyState text="No projects yet. Add one from the sidebar." /></div>
  const tabLabels: Record<ProjectTab, string> = { overview: 'Overview', plan: 'Plan', board: 'Tasks', notes: 'Notes', links: 'Files & links' }
  return <div className="page">
    <div className="project-switcher">
      {projects.sort((a, b) => a.order - b.order).map((item) => <button key={item.id} className={item.id === project.id ? 'active' : ''} onClick={() => { setSelectedProjectId(item.id); setTab('overview'); window.scrollTo({ top: 0 }) }}><span style={{ background: item.color }} />{item.name}</button>)}
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
    {tab === 'overview' && <ProjectOverview project={project} openAdd={openAdd} openClient={openClient} openProjectEdit={() => openProjectEdit(project.id)} />}
    {tab === 'plan' && <PlanView project={project} openAdd={openAdd} setToast={setToast} />}
    {tab === 'board' && <BoardView project={project} openAdd={openAdd} setToast={setToast} />}
    {tab === 'notes' && <NotesView project={project} openAdd={openAdd} setToast={setToast} />}
    {tab === 'links' && <LinksView project={project} openAdd={openAdd} />}
  </div>
}

function ProjectOverview({ project, openAdd, openClient, openProjectEdit }: { project: Project; openAdd: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void; openClient: (id: string) => void; openProjectEdit: () => void }) {
  const milestones = useLiveQuery(() => db.milestones.where('projectId').equals(project.id).filter((m) => !m.archivedAt).sortBy('position'), [project.id], [])
  const tasks = useLiveQuery(() => db.tasks.where('projectId').equals(project.id).filter((t) => !t.archivedAt && t.status !== 'done').toArray(), [project.id], [])
  const meetingItems = useLiveQuery(() => db.meetingItems.where('projectId').equals(project.id).filter((m) => !m.archivedAt && activeMeetingStatus(m.status)).toArray(), [project.id], [])
  const deliverables = milestones.filter((m) => m.deliverable && m.status !== 'done')
  const doneCount = milestones.filter((m) => m.status === 'done').length
  const client = useLiveQuery(() => project.clientId ? db.leads.get(project.clientId) : undefined, [project.clientId])
  const clientPayments = useLiveQuery(() => project.clientId ? db.payments.where('leadId').equals(project.clientId).filter((payment) => !payment.archivedAt).toArray() : [], [project.clientId], [])
  return <div className="project-overview">
    <section className="goal-panel"><p className="eyebrow">Project goal</p><h2>{project.goal}</h2>{client ? <button className="project-client-link" onClick={() => openClient(client.id)}><Users /> {client.business}{clientPayments.length ? ` · ${formatMoney(sumReceived(clientPayments)) || '₽0'} received${sumDue(clientPayments) ? ` · ${formatMoney(sumDue(clientPayments))} due` : ''}` : ''}<ChevronRight /></button> : project.clientType === 'client' && <button className="project-client-link is-unlinked" onClick={openProjectEdit}><Link2 /> Link this project to a client<ChevronRight /></button>}{project.targetDate && <span><CalendarDays /> Target {fullDate(project.targetDate)}</span>}{milestones.length > 0 && <span><Check /> {doneCount} of {milestones.length} steps done</span>}</section>
    <section className="overview-section">
      <SectionTitle title="Plan" action={<button onClick={() => openAdd('milestone', project.id)}><Plus /> Add step</button>} />
      <div className="milestone-path">{milestones.slice(0, 8).map((milestone, index) => <div key={milestone.id} className={`milestone-step ${milestone.status}`}><span>{milestone.status === 'done' ? <Check /> : index + 1}</span><p>{milestone.deliverable && <Star className="step-star" aria-label="Client deliverable" />}{milestone.title}</p></div>)}</div>
      {!milestones.length && <EmptyState text="No plan yet. Add the first step." />}
    </section>
    <div className="overview-grid">
      <section><SectionTitle title="Next deliverables" action={<button onClick={() => openAdd('deliverable', project.id)}><Plus /> Add</button>} /><div className="simple-list">{deliverables.slice(0, 3).map((item) => <div className="list-row is-actionable" key={item.id}><FileCheck2 /><span><button className="row-main" onClick={() => openAdd('deliverable', project.id, item.id)}><strong>{item.title}</strong><small>{milestoneStatusLabels[item.status]} · {item.owner}</small></button></span>{item.dueDate && <time>{formatDate(item.dueDate)}</time>}<ChevronRight /></div>)}{!deliverables.length && <EmptyState text="Mark plan steps the client receives as deliverables." />}</div></section>
      <section><SectionTitle title="Current tasks" action={<button onClick={() => openAdd('task', project.id)}><Plus /> Add</button>} /><div className="simple-list">{tasks.slice(0, 4).map((task) => <TaskLine key={task.id} task={task} onOpen={() => openAdd('task', project.id, task.id)} />)}{!tasks.length && <EmptyState text="No active tasks." />}</div></section>
      <section><SectionTitle title="Meeting agenda" action={<button onClick={() => openAdd('discussion', project.id)}><Plus /> Add</button>} /><div className="simple-list">{meetingItems.slice(0, 3).map((item) => <div className="list-row is-actionable" key={item.id}><MessageSquareText /><span><button className="row-main" onClick={() => openAdd('discussion', project.id, item.id)}><strong>{item.title}</strong><small>{meetingStatusLabels[item.status]}</small></button></span><ChevronRight /></div>)}{!meetingItems.length && <EmptyState text="Nothing waiting for the meeting." />}</div></section>
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
  const activeStatuses: TaskStatus[] = ['next', 'in_progress', 'waiting', 'backlog']
  const done = tasks.filter((task) => task.status === 'done').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  const taskCard = (task: Task, status: TaskStatus) => <article className="task-card" key={task.id}><div><span className={`priority priority-${task.priority}`}>{task.priority}</span>{task.dueDate && <time className={isOverdue(task.dueDate) && status !== 'done' ? 'overdue' : ''}>{formatDate(task.dueDate)}</time>}</div><button className="card-title" onClick={() => openAdd('task', project.id, task.id)}><h4>{task.title}</h4></button><p>{task.owner}</p><div className="card-actions"><StatusSelect value={task.status} options={taskStatuses} labels={taskStatusLabels} onChange={(value) => move(task, value as TaskStatus)} compact /><button aria-label={`Archive ${task.title}`} onClick={() => archiveTask(task)}><Archive /></button></div></article>
  return <section><SectionTitle title="Tasks" action={<button className="primary-button" onClick={() => openAdd('task', project.id)}><Plus /> Add task</button>} />
    <div className="task-board">{activeStatuses.map((status) => <div className="task-column" key={status}><div className="column-heading"><h3>{taskStatusLabels[status]}</h3><span>{tasks.filter((t) => t.status === status).length}</span></div>{tasks.filter((t) => t.status === status).sort((a, b) => a.position - b.position).map((task) => taskCard(task, status))}</div>)}</div>
    {done.length > 0 && <details className="completed-tasks"><summary>{done.length} completed {done.length === 1 ? 'task' : 'tasks'}</summary><div className="completed-task-grid">{done.slice(0, 20).map((task) => taskCard(task, 'done'))}</div></details>}
  </section>
}

function NotesView({ project, openAdd, setToast }: { project: Project; openAdd: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void; setToast: (toast: ToastState) => void }) {
  const notes = useLiveQuery(() => db.notes.where('projectId').equals(project.id).filter((n) => !n.archivedAt).reverse().sortBy('createdAt'), [project.id], [])
  const items = useLiveQuery(() => db.meetingItems.where('projectId').equals(project.id).filter((m) => !m.archivedAt && activeMeetingStatus(m.status)).toArray(), [project.id], [])
  const useIdea = async (idea: Note, target: 'meeting' | 'task') => {
    const stamp = nowIso()
    if (target === 'meeting') await db.meetingItems.add({ id: newId('meetingItems', 'agenda'), realmId: recordRealmId(), projectId: project.id, title: idea.title, notes: idea.body !== idea.title ? idea.body : undefined, status: 'open', owner: idea.author, createdAt: stamp, updatedAt: stamp, createdBy: idea.author })
    else await db.tasks.add({ id: newId('tasks', 'task'), realmId: recordRealmId(), projectId: project.id, title: idea.title, notes: idea.body !== idea.title ? idea.body : undefined, status: 'next', priority: 'normal', owner: idea.author, position: Date.now(), createdAt: stamp, updatedAt: stamp, createdBy: idea.author })
    setToast({ message: target === 'meeting' ? 'Added to the meeting agenda. The idea is still here.' : 'Task created. The idea is still here.' })
  }
  return <div className="notes-layout"><section><SectionTitle title="Notes, decisions & ideas" action={<button className="primary-button" onClick={() => openAdd('note', project.id)}><Plus /> Add note</button>} />{notes.map((note) => <article className="note-entry" key={note.id}><div><span className={`note-kind ${note.kind}`}>{note.kind}</span><time>{new Date(note.createdAt).toLocaleDateString('en-GB')}</time></div><button className="row-main" onClick={() => openAdd('note', project.id, note.id)}><h3>{note.title}</h3></button><p>{note.body}</p><footer><small>{note.author}</small>{note.kind === 'idea' && <span className="idea-actions"><button onClick={() => useIdea(note, 'meeting')}>Add to meeting</button><button onClick={() => useIdea(note, 'task')}>Create task</button></span>}</footer></article>)}{!notes.length && <EmptyState text="Add context, a decision, or something worth remembering." />}</section><section><SectionTitle title="Meeting agenda" action={<button onClick={() => openAdd('discussion', project.id)}><Plus /> Add</button>} /><div className="simple-list">{items.map((item) => <div className="list-row is-actionable" key={item.id}><MessageSquareText /><span><button className="row-main" onClick={() => openAdd('discussion', project.id, item.id)}><strong>{item.title}</strong><small>{meetingStatusLabels[item.status]}</small></button></span><ChevronRight /></div>)}{!items.length && <EmptyState text="Nothing waiting for the meeting." />}</div></section></div>
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
  const projects = useLiveQuery(() => db.projects.filter((project) => !project.archivedAt && project.status === 'active').toArray(), [], [])
  const payments = useLiveQuery(() => db.payments.filter((p) => !p.archivedAt).toArray(), [], [])
  const [stageFilter, setStageFilter] = useState('current')
  const [serviceFilter, setServiceFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [visibleCount, setVisibleCount] = useState(clientListBatchSize)
  const paymentsByLead = useMemo(() => {
    const grouped = new Map<string, Payment[]>()
    payments.forEach((payment) => grouped.set(payment.leadId, [...(grouped.get(payment.leadId) ?? []), payment]))
    return grouped
  }, [payments])
  const serviceFor = (lead: Lead) => lead.serviceInterest?.trim() || lead.tariff?.trim() || ''
  const serviceOptions = useMemo(() => Array.from(new Set(leads.map(serviceFor).filter(Boolean))).sort((a, b) => a.localeCompare(b)), [leads])
  const currentClientIds = useMemo(() => new Set(projects.map((project) => project.clientId).filter(Boolean)), [projects])
  const currentClients = leads.filter((lead) => currentClientIds.has(lead.id))
  const pipelineLeads = leads.filter((lead) => activeLeadStages.includes(lead.stage))
  const dueFollowUps = leads.filter((lead) => lead.stage !== 'lost' && lead.followUpDate && daysUntil(lead.followUpDate) <= 7).length
  const potentialTotal = pipelineLeads.reduce((total, lead) => total + (lead.quoted ?? 0), 0)
  const receivedTotal = sumReceived(payments)
  const dueTotal = sumDue(payments)
  const stageCounts = Object.fromEntries(leadStageGroups.map((group) => [group.key, leads.filter((lead) => group.stages.includes(lead.stage)).length]))
  const normalizedQuery = query.trim().toLocaleLowerCase()
  const filteredLeads = leads.filter((lead) => {
    const matchesStage = stageFilter === 'all'
      || (stageFilter === 'current' ? currentClientIds.has(lead.id)
        : stageFilter === 'active' ? activeLeadStages.includes(lead.stage)
        : stageFilter === 'followups' ? Boolean(lead.followUpDate && daysUntil(lead.followUpDate) <= 7)
        : leadStageGroups.find((group) => group.key === stageFilter)?.stages.includes(lead.stage))
    const matchesService = serviceFilter === 'all' || serviceFor(lead) === serviceFilter
    const matchesQuery = !normalizedQuery || [lead.business, lead.contact, lead.serviceInterest, lead.tariff, lead.nextAction]
      .some((value) => value?.toLocaleLowerCase().includes(normalizedQuery))
    return Boolean(matchesStage && matchesService && matchesQuery)
  }).sort((a, b) => {
    const currentOrder = Number(currentClientIds.has(b.id)) - Number(currentClientIds.has(a.id))
    const dateOrder = (a.followUpDate ?? '9999-12-31').localeCompare(b.followUpDate ?? '9999-12-31')
    const stageOrder = leadStageGroups.findIndex((group) => group.stages.includes(a.stage)) - leadStageGroups.findIndex((group) => group.stages.includes(b.stage))
    return currentOrder || dateOrder || stageOrder || a.business.localeCompare(b.business)
  })
  const visibleLeads = filteredLeads.slice(0, visibleCount)

  useEffect(() => setVisibleCount(clientListBatchSize), [stageFilter, serviceFilter, query])

  return <div className="page"><PageHeader eyebrow="Sales & relationships" title="Clients"
    description="See who needs a next step. Open the financial detail only when you need it."
    action={<button className="primary-button" onClick={addLead}><Plus /> Add client</button>} />
    <section className="client-calm-summary" aria-label="Client pipeline summary">
      <button className={stageFilter === 'followups' ? 'active needs-attention' : 'needs-attention'} onClick={() => setStageFilter('followups')}><span><small>Needs attention</small><strong>{dueFollowUps} follow-up{dueFollowUps === 1 ? '' : 's'}</strong></span><ChevronRight /></button>
      <button className={stageFilter === 'current' ? 'active' : ''} onClick={() => setStageFilter('current')}><span><small>Working together</small><strong>{currentClients.length} current client{currentClients.length === 1 ? '' : 's'}</strong></span><ChevronRight /></button>
      <details className="client-finance-summary"><summary><span><small>Money overview</small><strong>{formatMoney(receivedTotal) || '₽0'} received</strong></span><ChevronDown /></summary><div><span><small>Potential</small><strong>{formatMoney(potentialTotal) || '₽0'}</strong></span><span><small>Still due</small><strong>{formatMoney(dueTotal) || '₽0'}</strong></span></div></details>
    </section>

    <div className="stage-filters primary-client-filters" aria-label="Filter clients">
      {[{ key: 'current', label: 'Current', count: currentClients.length }, { key: 'active', label: 'Pipeline', count: pipelineLeads.length }, { key: 'won', label: 'Won deals', count: stageCounts.won ?? 0 }, { key: 'lost', label: 'Lost', count: stageCounts.lost ?? 0 }, { key: 'all', label: 'All', count: leads.length }].map((filter) =>
        <button key={filter.key} className={stageFilter === filter.key ? 'active' : ''} aria-pressed={stageFilter === filter.key} onClick={() => setStageFilter(filter.key)}><span>{filter.label}</span><strong>{filter.count}</strong></button>
      )}
    </div>
    <details className="pipeline-filter-details"><summary>Filter by pipeline stage <ChevronDown /></summary><div className="stage-filters" aria-label="Pipeline stages">{leadStageGroups.filter((group) => !['won', 'lost'].includes(group.key)).map((filter) => <button key={filter.key} className={stageFilter === filter.key ? 'active' : ''} aria-pressed={stageFilter === filter.key} onClick={() => setStageFilter(filter.key)}><span>{filter.label}</span><strong>{stageCounts[filter.key] ?? 0}</strong></button>)}</div></details>

    <div className="client-toolbar">
      <label className="client-search"><Search /><span className="sr-only">Search clients</span><input type="search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search client, contact or next action" /></label>
      <label className="client-service-filter"><span>Service</span><select value={serviceFilter} onChange={(event) => setServiceFilter(event.target.value)}><option value="all">All services</option>{serviceOptions.map((service) => <option key={service} value={service}>{service}</option>)}</select></label>
      <span className="client-results-count">{filteredLeads.length} {filteredLeads.length === 1 ? 'client' : 'clients'}</span>
    </div>

    <div className="client-register">
      <div className="client-register-head"><span>Client</span><span>Stage</span><span>Next action</span><span>Follow-up</span><span>Money</span><span /></div>
      {visibleLeads.map((lead) => {
        const leadPayments = paymentsByLead.get(lead.id) ?? []
        const received = sumReceived(leadPayments)
        const due = sumDue(leadPayments)
        const service = serviceFor(lead)
        const moneyValue = received || lead.quoted || due
        const moneyLabel = received ? 'received' : lead.quoted ? 'quoted' : due ? 'due' : 'No value yet'
        return <button className="client-row" key={lead.id} onClick={() => openModal(lead.id)} aria-label={`Edit ${lead.business}`}>
          <span className="client-identity"><strong>{lead.business}</strong><small>{lead.owner}{service ? ` · ${service}` : ''}</small></span>
          <span className="client-stage-cell"><span className={`client-stage ${currentClientIds.has(lead.id) ? 'stage-current' : `stage-${lead.stage}`}`}>{currentClientIds.has(lead.id) ? 'Current client' : leadStageLabels[lead.stage]}</span></span>
          <span className="client-next">{lead.nextAction || 'Set a next action'}</span>
          <span className="client-followup">{lead.followUpDate ? <><time className={isOverdue(lead.followUpDate) ? 'overdue' : ''}>{formatDate(lead.followUpDate)}</time>{isOverdue(lead.followUpDate) && <small>Overdue</small>}</> : <small>No date</small>}</span>
          <span className="client-money"><strong>{moneyValue ? formatMoney(moneyValue) : '—'}</strong><small>{moneyLabel}{due > 0 && moneyLabel !== 'due' ? ` · ${formatMoney(due)} due` : ''}</small></span>
          <ChevronRight />
        </button>
      })}
      {!visibleLeads.length && <div className="client-empty"><strong>No clients found</strong><span>Try another stage, service or search.</span></div>}
    </div>
    {filteredLeads.length > 0 && <div className="client-list-footer"><span>Showing {visibleLeads.length} of {filteredLeads.length}</span>{visibleLeads.length < filteredLeads.length && <button className="secondary-button" onClick={() => setVisibleCount((count) => count + clientListBatchSize)}>Show {Math.min(clientListBatchSize, filteredLeads.length - visibleLeads.length)} more</button>}</div>}
  </div>
}

function AgendaNotes({ value, onChange, onCommit }: { value: string; onChange: (value: string) => void; onCommit: () => void }) {
  return <textarea className="agenda-notes" rows={2} placeholder="Notes while you talk…" value={value} onChange={(event) => onChange(event.target.value)} onBlur={onCommit} />
}

function MeetingView({ currentUser, setToast, openProject, openEdit }: { currentUser: Owner; setToast: (toast: ToastState) => void; openProject: (id: string) => void; openEdit: (kind: Exclude<ModalKind, null>, projectId?: string, recordId?: string) => void }) {
  const projects = useLiveQuery(() => db.projects.filter((p) => !p.archivedAt).toArray(), [], [])
  const items = useLiveQuery(() => db.meetingItems.filter((m) => !m.archivedAt && activeMeetingStatus(m.status)).toArray(), [], [])
  const decisions = useLiveQuery(() => db.notes.filter((n) => !n.archivedAt && n.kind === 'decision').reverse().sortBy('createdAt'), [], [])
  const meetingTasks = useLiveQuery(() => db.tasks.filter((task) => !task.archivedAt && Boolean(task.sourceMeetingItemId)).toArray(), [], [])
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
    const stamp = nowIso()
    try {
      const tables = status === 'action' ? [db.meetingItems, db.tasks] : status === 'decision' ? [db.meetingItems, db.notes] : [db.meetingItems]
      let createdId: string | undefined
      await db.transaction('rw', tables, async () => {
        await db.meetingItems.update(item.id, { status, notes: liveNotes || undefined, archivedAt: status === 'closed' ? stamp : undefined, updatedAt: stamp, updatedBy: currentUser })
        if (status === 'action') {
          createdId = newId('tasks', 'task')
          await db.tasks.add({ id: createdId, realmId: recordRealmId(), projectId: item.projectId, title: item.title, owner: item.owner || currentUser, status: 'next', priority: 'normal', dueDate: item.dueDate, position: Date.now(), createdAt: stamp, updatedAt: stamp, createdBy: currentUser, notes: liveNotes ? `From the meeting: ${liveNotes}` : 'From the meeting.', sourceMeetingItemId: item.id })
        } else if (status === 'decision') {
          createdId = newId('notes', 'note')
          await db.notes.add({ id: createdId, realmId: recordRealmId(), projectId: item.projectId, title: item.title, body: liveNotes || 'Agreed in the meeting.', kind: 'decision', author: currentUser, createdAt: stamp, updatedAt: stamp, createdBy: currentUser, sourceMeetingItemId: item.id })
        }
      })
      const undo = async () => {
        const undoTables = status === 'action' ? [db.meetingItems, db.tasks] : status === 'decision' ? [db.meetingItems, db.notes] : [db.meetingItems]
        await db.transaction('rw', undoTables, async () => {
          await db.meetingItems.update(item.id, { status: 'open', archivedAt: undefined, updatedAt: nowIso() })
          if (createdId && status === 'action') await db.tasks.delete(createdId)
          if (createdId && status === 'decision') await db.notes.delete(createdId)
        })
      }
      setToast({ message: status === 'action' ? 'Task created in To do.' : status === 'decision' ? 'Decision saved to project notes.' : 'Topic closed.', action: { label: 'Undo', run: undo } })
      setDrafts((prev) => { const next = { ...prev }; delete next[item.id]; return next })
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not resolve this topic.' })
    }
  }

  const grouped = projects.map((project) => ({ project, items: items.filter((item) => item.projectId === project.id) })).filter((group) => group.items.length)
  const outcomes = [
    ...decisions.map((note) => ({ id: note.id, projectId: note.projectId, title: note.title, updatedAt: note.updatedAt, kind: 'Decision' as const, open: () => openEdit('note', note.projectId, note.id) })),
    ...meetingTasks.map((task) => ({ id: task.id, projectId: task.projectId, title: task.title, updatedAt: task.updatedAt, kind: 'Task' as const, open: () => openEdit('task', task.projectId, task.id) }))
  ].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, 8)
  return <div className="page meeting-page"><PageHeader eyebrow="Work together" title="Meeting agenda" description="Discuss each topic, capture the outcome, and leave anything unresolved here for next time." action={<button className="primary-button" onClick={() => openEdit('discussion')}><Plus /> Add topic</button>} />
    <SectionTitle title="To discuss" />
    {grouped.map(({ project, items: projectItems }) => <section className="meeting-group" key={project.id}><div className="meeting-project"><span className="project-dot" style={{ background: project.color }} /><button onClick={() => openProject(project.id)}>{project.name}<ChevronRight /></button><span>{projectItems.length} {projectItems.length === 1 ? 'topic' : 'topics'}</span></div>{projectItems.map((item) => <article className="agenda-card" key={item.id}><div><button className="row-main" onClick={() => openEdit('discussion', item.projectId, item.id)}><h3>{item.title}</h3></button><AgendaNotes value={noteFor(item)} onChange={(value) => setDrafts((prev) => ({ ...prev, [item.id]: value }))} onCommit={() => commitNote(item)} /><small>Owner: {item.owner}</small></div><div className="agenda-actions"><button onClick={() => resolve(item, 'decision')}>Save decision</button><button className="primary-button" onClick={() => resolve(item, 'action')}>Create task</button><button className="close-topic" onClick={() => resolve(item, 'closed')}>Close topic</button></div></article>)}</section>)}
    {!grouped.length && <EmptyState text="Nothing to discuss. Add a topic whenever something needs a conversation." action={<button className="primary-button" onClick={() => openEdit('discussion')}>Add a topic</button>} />}

    <section className="meeting-outcomes"><SectionTitle title="Recent outcomes" /><div className="simple-list">{outcomes.map((outcome) => <div className="list-row is-actionable" key={`${outcome.kind}-${outcome.id}`}><span className={`outcome-kind outcome-${outcome.kind.toLowerCase()}`}>{outcome.kind}</span><span><button className="row-main" onClick={outcome.open}><strong>{outcome.title}</strong><small>{projects.find((project) => project.id === outcome.projectId)?.name}</small></button></span><ChevronRight /></div>)}{!outcomes.length && <EmptyState text="Tasks and decisions created in meetings will stay visible here." />}</div></section>
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

function SyncStatusLine({ phase, status, pending, error }: { phase?: string; status?: string; pending: number; error?: string }) {
  if (status === 'offline' || phase === 'offline') return <p className="sync-status sync-warn">Offline — changes save on this device and will sync when you're back online.</p>
  if (status === 'error' || phase === 'error') return <p className="sync-status sync-error">Sync needs attention.{error ? ` ${error}` : ' Reload the page and try again.'}</p>
  if (pending > 0) return <p className="sync-status sync-pending">{pending} change{pending === 1 ? '' : 's'} waiting to sync…</p>
  if (phase === 'in-sync') return <p className="sync-status sync-ok">All changes synced.</p>
  return <p className="sync-status">Checking sync status…</p>
}

type ArchivedKind = 'projects' | 'milestones' | 'tasks' | 'notes' | 'meetingItems' | 'leads' | 'resources'
interface ArchivedRow { id: string; kind: ArchivedKind; label: string; title: string; archivedAt: string; color?: string }

function ArchivedItems({ setToast }: { setToast: (toast: ToastState) => void }) {
  const rows = useLiveQuery(async () => {
    const [projects, milestones, tasks, notes, meetingItems, leads, resources] = await Promise.all([
      db.projects.filter((row) => Boolean(row.archivedAt) || row.status === 'archived').toArray(),
      db.milestones.filter((row) => Boolean(row.archivedAt)).toArray(), db.tasks.filter((row) => Boolean(row.archivedAt)).toArray(),
      db.notes.filter((row) => Boolean(row.archivedAt)).toArray(), db.meetingItems.filter((row) => Boolean(row.archivedAt)).toArray(),
      db.leads.filter((row) => Boolean(row.archivedAt)).toArray(), db.resources.filter((row) => Boolean(row.archivedAt)).toArray()
    ])
    return [
      ...projects.map((row) => ({ id: row.id, kind: 'projects' as const, label: 'Project', title: row.name, archivedAt: row.archivedAt ?? row.updatedAt, color: row.color })),
      ...milestones.map((row) => ({ id: row.id, kind: 'milestones' as const, label: row.deliverable ? 'Deliverable' : 'Plan step', title: row.title, archivedAt: row.archivedAt! })),
      ...tasks.map((row) => ({ id: row.id, kind: 'tasks' as const, label: 'Task', title: row.title, archivedAt: row.archivedAt! })),
      ...notes.map((row) => ({ id: row.id, kind: 'notes' as const, label: row.kind === 'idea' ? 'Idea' : row.kind === 'decision' ? 'Decision' : 'Note', title: row.title, archivedAt: row.archivedAt! })),
      ...meetingItems.map((row) => ({ id: row.id, kind: 'meetingItems' as const, label: 'Meeting topic', title: row.title, archivedAt: row.archivedAt! })),
      ...leads.map((row) => ({ id: row.id, kind: 'leads' as const, label: 'Client', title: row.business, archivedAt: row.archivedAt! })),
      ...resources.map((row) => ({ id: row.id, kind: 'resources' as const, label: 'Link', title: row.name, archivedAt: row.archivedAt! }))
    ].sort((a, b) => b.archivedAt.localeCompare(a.archivedAt)) as ArchivedRow[]
  }, [], [])
  const [workingId, setWorkingId] = useState<string | null>(null)

  const restore = async (row: ArchivedRow) => {
    setWorkingId(row.id)
    try {
      if (row.kind === 'projects') await db.projects.update(row.id, { archivedAt: undefined, status: 'active', updatedAt: nowIso() })
      else await (db[row.kind] as any).update(row.id, { archivedAt: undefined, updatedAt: nowIso() })
      setToast({ message: `${row.title} restored.` })
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not restore this item.' })
    } finally {
      setWorkingId(null)
    }
  }

  const removeProject = async (row: ArchivedRow) => {
    if (!window.confirm(`Permanently delete "${row.title}" and all of its project records? This cannot be undone.`)) return
    setWorkingId(row.id)
    try {
      await deleteProjectPermanently(row.id)
      setToast({ message: `${row.title} permanently deleted.` })
    } catch (error) {
      setToast({ message: error instanceof Error ? error.message : 'Could not delete the project.' })
    } finally {
      setWorkingId(null)
    }
  }

  return <section className="settings-section">
    <div><Archive /><span><h2>Recently archived</h2><p>Restore anything that was removed from daily views.</p></span></div>
    {rows.length ? <div className="archived-projects">{rows.map((row) => {
      const working = workingId === row.id
      return <div className="archived-project-row" key={`${row.kind}-${row.id}`}>
        <span className="project-dot" style={{ background: row.color ?? 'var(--subtle)' }} />
        <span><strong>{row.title}</strong><small>{row.label} · archived {new Date(row.archivedAt).toLocaleDateString('en-GB')}</small></span>
        <div className="archived-project-actions">
          <button className="secondary-button" onClick={() => restore(row)} disabled={working}><Repeat /> Restore</button>
          {row.kind === 'projects' && <button className="danger-link" onClick={() => removeProject(row)} disabled={working}><Trash2 /> Delete permanently</button>}
        </div>
      </div>
    })}</div> : <p className="last-backup">Nothing is archived.</p>}
  </section>
}

function SettingsView({ currentUser, isOwner, email, realmId, onSignOut, setToast }: { currentUser: Owner; isOwner: boolean; email?: string; realmId?: string; onSignOut: () => Promise<void>; setToast: (toast: ToastState) => void }) {
  const backups = useLiveQuery(() => db.backupExports.orderBy('exportedAt').reverse().toArray(), [], [])
  const projectCount = useLiveQuery(() => db.projects.filter((project) => !project.archivedAt).count(), [], 0)
  const syncStatus = useSyncStatus()
  const [inviteEmail, setInviteEmail] = useState('')
  const [busy, setBusy] = useState(false)
  const importInput = useRef<HTMLInputElement>(null)
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
  const importSection = <section className="settings-section"><div><Upload /><span><h2>Import existing workspace</h2><p>Use the prepared private file to bring existing projects and clients into this workspace.</p></span></div><input ref={importInput} className="sr-only" type="file" accept="application/json,.json" onChange={(event) => importFile(event.target.files?.[0])} /><button className="secondary-button" onClick={() => importInput.current?.click()} disabled={busy}><Upload /> Choose import file</button></section>
  return <div className="page settings-page"><PageHeader eyebrow="Workspace" title="Settings" description="Manage your account, access, backups and archived work." />
    {cloudEnabled && <section className="settings-section"><div><LogOut /><span><h2>Account</h2><p>Signed in as {email ?? currentUser}{isOwner ? ' · workspace owner' : ''}.</p><SyncStatusLine {...syncStatus} /></span></div><button className="secondary-button" onClick={signOut} disabled={signingOut}><LogOut /> {signingOut ? 'Signing out…' : 'Log out'}</button></section>}
    {projectCount === 0 && importSection}
    <section className="settings-section"><div><Users /><span><h2>Partner access</h2><p>Invite one trusted partner. Only the workspace owner can manage access.</p></span></div>{!cloudEnabled ? <p className="last-backup">This workspace currently saves on this browser only.</p> : isOwner ? <><div className="inline-form"><label><span>Partner email</span><input type="email" value={inviteEmail} onChange={(e) => setInviteEmail(e.target.value)} placeholder="partner@example.com" /></label><button className="primary-button" onClick={invite}><UserPlus /> Invite</button></div><PartnerStatus ownEmail={email} realmId={realmId} /></> : <p className="last-backup">Ask the workspace owner to manage access.</p>}</section>
    <section className="settings-section"><div><Download /><span><h2>Backup</h2><p>Export a readable workbook and store it somewhere safe.</p></span></div><button className="primary-button" onClick={exportBackup} disabled={busy}><Download /> {busy ? 'Creating…' : 'Export Excel backup'}</button>{backups[0] ? <BackupStatus exportedAt={backups[0].exportedAt} exportedBy={backups[0].exportedBy} /> : projectCount > 0 ? <p className="last-backup backup-stale">No backup exported yet.</p> : <p className="last-backup">Add or import work before creating a backup.</p>}</section>
    <ArchivedItems setToast={setToast} />
    <section className="settings-section"><div><ExternalLink /><span><h2>Impulse website</h2><p>The public website remains separate from this private workspace.</p></span></div><a className="secondary-button" href="https://papertowel2030-hub.github.io/Impulse/" target="_blank" rel="noreferrer">Open website <ExternalLink /></a></section>
    <details className="advanced-settings"><summary>Advanced & troubleshooting</summary><div className="advanced-settings-body">{projectCount > 0 && importSection}{!cloudEnabled && <section className="settings-section"><div><CloudOff /><span><h2>Cloud setup</h2><p>This development copy is using browser-only storage. Add the cloud database URL in the deployment configuration to enable shared sync.</p></span></div></section>}<section className="settings-section"><div><Download /><span><h2>Restoreable cloud backup</h2><p>For administrators: run <code>npx dexie-cloud export</code> from the project folder and keep the resulting ZIP and key private.</p></span></div></section>{cloudEnabled && <section className="settings-section"><div><Trash2 /><span><h2>Reset this device</h2><p>Use only when support asks you to clear a local sync problem. Synced records return after reload.</p></span></div><button className="danger-link" onClick={resetDevice} disabled={busy}><Trash2 /> Reset local copy</button></section>}</div></details>
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

function EntryModal({ state, currentUser, onClose, setToast, createProjectForClient, openProject }: { state: ModalState; currentUser: Owner; onClose: () => void; setToast: (toast: ToastState) => void; createProjectForClient: (clientId: string) => void; openProject: (projectId: string) => void }) {
  const projects = useLiveQuery(() => db.projects.filter((p) => !p.archivedAt && p.status === 'active').toArray(), [], [])
  const kind = state.kind
  const isEdit = Boolean(state.recordId)
  const existing = useLiveQuery<any>(() => {
    if (!state.recordId) return undefined
    return recordTable(kind)?.get(state.recordId)
  }, [state.recordId, kind])
  const linkedProjects = useLiveQuery(() => kind === 'lead' && state.recordId
    ? db.projects.filter((project) => project.clientId === state.recordId && !project.archivedAt).toArray()
    : [], [kind, state.recordId], [])
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
  const [status, setStatus] = useState(kind === 'lead' && initial.status ? canonicalLeadStage(initial.status as LeadStage) : initial.status ?? '')
  const [notes, setNotes] = useState(initial.notes ?? '')
  const [url, setUrl] = useState(initial.url ?? '')
  const [priority, setPriority] = useState<Priority>(initial.priority ?? 'normal')
  const [linkType, setLinkType] = useState(initial.linkType ?? '')
  const [tariff, setTariff] = useState(initial.tariff ?? '')
  const [quoted, setQuoted] = useState(initial.quoted ?? '')
  const [contact, setContact] = useState(initial.contact ?? '')
  const [serviceInterest, setServiceInterest] = useState(initial.serviceInterest ?? '')
  const [source, setSource] = useState(initial.source ?? '')
  const [lastContactDate, setLastContactDate] = useState(initial.lastContactDate ?? '')
  const [nextAction, setNextAction] = useState(initial.nextAction ?? '')
  const [projectToLink, setProjectToLink] = useState('')
  const [isDeliverable, setIsDeliverable] = useState(kind === 'deliverable')
  const [more, setMore] = useState(Boolean(initial.notes || initial.url))
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const titleInput = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)
  const discardAndClose = useCallback(() => { if (!isEdit) localStorage.removeItem(draftKey); onClose() }, [draftKey, isEdit, onClose])

  useEffect(() => { titleInput.current?.focus() }, [])
  useDialogBehavior(dialogRef, discardAndClose)

  useEffect(() => {
    if (!existing) return
    if (kind === 'lead') {
      setTitle(existing.business); setOwner(existing.owner); setStatus(canonicalLeadStage(existing.stage))
      setDueDate(existing.followUpDate ?? ''); setNotes(existing.notes ?? ''); setUrl(existing.website ?? '')
      setTariff(existing.tariff ?? ''); setQuoted(existing.quoted?.toString() ?? '')
      setContact(existing.contact ?? ''); setServiceInterest(existing.serviceInterest ?? ''); setSource(existing.source ?? '')
      setLastContactDate(existing.lastContactDate ?? ''); setNextAction(existing.nextAction ?? '')
      setMore(Boolean(existing.notes || existing.website || existing.source || existing.lastContactDate))
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
    localStorage.setItem(draftKey, JSON.stringify({ title, projectId, owner, dueDate, status, notes, url, priority, linkType, tariff, quoted, contact, serviceInterest, source, lastContactDate, nextAction }))
  }, [draftKey, isEdit, title, projectId, owner, dueDate, status, notes, url, priority, linkType, tariff, quoted, contact, serviceInterest, source, lastContactDate, nextAction])

  const unlinkedProjects = projects.filter((project) => !project.clientId)
  useEffect(() => {
    if (!projectToLink && unlinkedProjects.length === 1) setProjectToLink(unlinkedProjects[0].id)
  }, [projectToLink, unlinkedProjects])

  const config = modalConfig(kind)
  const save = async (event: React.FormEvent) => {
    event.preventDefault(); if (!title.trim()) return setError('Add a short title.')
    if (kind !== 'lead' && kind !== 'link' && !projectId) return setError('Choose the project this belongs to.')
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
        const data = { business: title.trim(), contact: contact.trim() || undefined, serviceInterest: serviceInterest.trim() || undefined, source: source.trim() || undefined, lastContactDate: lastContactDate || undefined, nextAction: nextAction.trim() || undefined, owner, followUpDate: dueDate || undefined, stage: (status || 'prospect') as LeadStage, notes: notes || undefined, website: url || undefined, tariff: tariff || undefined, quoted: quoted ? Number(quoted) : undefined, updatedAt: stamp }
        if (isEdit) await db.leads.update(state.recordId!, data)
        else await db.leads.add({ id: newId('leads', 'lead'), ...add, ...data })
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
    setToast({ message: `${config.singular} archived.`, action: { label: 'Undo', run: () => (table as any).update(state.recordId, { archivedAt: undefined, updatedAt: nowIso() }) } })
    onClose()
  }

  const linkExistingProject = async () => {
    if (!state.recordId || !projectToLink) return
    await db.projects.update(projectToLink, { clientId: state.recordId, clientType: 'client', updatedAt: nowIso() })
    setProjectToLink('')
    setToast({ message: 'Project linked to this client.' })
  }

  const showProject = kind !== 'lead'
  const showDate = kind !== 'note' && kind !== 'idea' && kind !== 'link'
  const showStatus = config.statuses.length > 0
  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && discardAndClose()}><section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="modal-title"><header><div><p className="eyebrow">{isEdit ? 'Edit' : 'Quick capture'}</p><h2 id="modal-title">{isEdit ? 'Edit' : 'Add'} {config.label}</h2></div><button onClick={discardAndClose} aria-label="Close"><X /></button></header><form onSubmit={save}>
    {!isEdit && initial.title && <p className="draft-restored">Unsaved draft restored.</p>}
    <label><span>{config.titleLabel}</span><input ref={titleInput} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={config.placeholder} required /></label>
    {kind === 'link' && <label><span>URL</span><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" required /></label>}
    {kind === 'link' && <label><span>Type <small>optional</small></span><input value={linkType} onChange={(e) => setLinkType(e.target.value)} placeholder="Portfolio, Demo, Tool, Social…" /></label>}
    {showProject && <label><span>Project{kind === 'link' && <small> optional</small>}</span><select value={projectId} onChange={(e) => setProjectId(e.target.value)} required={kind !== 'link'}>{kind === 'link' && <option value="">Workspace-wide</option>}{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>}
    {kind === 'lead' && <><div className="form-row"><label><span>Contact <small>optional</small></span><input value={contact} onChange={(e) => setContact(e.target.value)} placeholder="Name, email or phone" /></label><label><span>Service <small>optional</small></span><input value={serviceInterest} onChange={(e) => setServiceInterest(e.target.value)} placeholder="Website, social, studio…" /></label></div><label><span>Next action</span><input value={nextAction} onChange={(e) => setNextAction(e.target.value)} placeholder="What happens next?" /></label></>}
    <div className="form-row"><label><span>Owner</span><select value={owner} onChange={(e) => setOwner(e.target.value as Owner)}>{owners.map((item) => <option key={item}>{item}</option>)}</select></label>{showDate && <label><span>{kind === 'lead' ? 'Follow-up' : 'Deadline'} <small>optional</small></span><input type="date" value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></label>}</div>
    {showStatus && <label><span>{kind === 'lead' ? 'Stage' : 'Status'}</span><select value={status || config.defaultStatus} onChange={(e) => setStatus(e.target.value)}>{config.statuses.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</select></label>}
    {(kind === 'milestone' || kind === 'deliverable') && <label className="check-label"><input type="checkbox" checked={isDeliverable} onChange={(e) => setIsDeliverable(e.target.checked)} /><span>The client receives this <small>shows up under deliverables and deadlines</small></span></label>}
    {kind === 'lead' && <div className="form-row">
      <label><span>Tariff <small>optional</small></span><input value={tariff} onChange={(e) => setTariff(e.target.value)} placeholder="Landing, Catalog…" /></label>
      <label><span>Project price ₽ <small>optional</small></span><input type="number" min="0" value={quoted} onChange={(e) => setQuoted(e.target.value)} placeholder="0" /></label>
    </div>}
    {kind === 'lead' && (isEdit
      ? <PaymentsEditor leadId={state.recordId!} quoted={quoted ? Number(quoted) : undefined} currentUser={currentUser} setToast={setToast} />
      : <p className="payments-hint">Save the client first, then you can add deposits, installments, a retainer, or a revenue share.</p>)}
    {kind === 'lead' && isEdit && <div className="client-projects-callout">
      <div className="client-projects-heading"><span><strong>Delivery project</strong><small>{linkedProjects.length ? 'The project holds the work. Financials stay here.' : 'Link the work you are already doing for this client.'}</small></span>{linkedProjects.length > 0 && <span className="client-project-count">{linkedProjects.length}</span>}</div>
      {linkedProjects.map((project) => <button type="button" className="linked-project-row" key={project.id} onClick={() => openProject(project.id)}><span><strong>{project.name}</strong><small>{project.phase} · {project.status}</small></span><ChevronRight /></button>)}
      {!linkedProjects.length && <div className="link-project-actions">
        {unlinkedProjects.length > 0 && <><select aria-label="Existing project" value={projectToLink} onChange={(event) => setProjectToLink(event.target.value)}><option value="">Choose existing project</option>{unlinkedProjects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select><button type="button" className="secondary-button" disabled={!projectToLink} onClick={linkExistingProject}>Link project</button></>}
        <button type="button" className={unlinkedProjects.length ? 'text-button' : 'secondary-button'} onClick={() => createProjectForClient(state.recordId!)}><Plus /> New project</button>
      </div>}
    </div>}
    <button type="button" className="more-toggle" onClick={() => setMore(!more)}>{more ? 'Hide details' : 'More details'}<ChevronDown /></button>
    {more && <div className="more-fields">{kind === 'lead' && <div className="form-row"><label><span>Last contacted <small>optional</small></span><input type="date" value={lastContactDate} onChange={(e) => setLastContactDate(e.target.value)} /></label><label><span>Source <small>optional</small></span><input value={source} onChange={(e) => setSource(e.target.value)} placeholder="Referral, website…" /></label></div>}<label><span>{kind === 'note' || kind === 'idea' ? 'Text' : 'Notes'} <small>optional</small></span><textarea value={notes} onChange={(e) => setNotes(e.target.value)} rows={4} placeholder="Add only the context someone will need later." /></label>{(kind === 'task' || kind === 'milestone' || kind === 'deliverable' || kind === 'lead') && <label><span>{kind === 'lead' ? 'Website' : 'Drive link'} <small>optional</small></span><input type="url" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://" /></label>}{kind === 'task' && <label><span>Priority</span><select value={priority} onChange={(e) => setPriority(e.target.value as Priority)}><option value="low">Low</option><option value="normal">Normal</option><option value="high">High</option></select></label>}</div>}
    {error && <p className="form-error">{error}</p>}
    <footer>{isEdit && <button type="button" className="danger-link" onClick={remove}>Archive</button>}<span className="footer-spacer" /><button type="button" onClick={discardAndClose}>Cancel</button><button className="primary-button" type="submit" disabled={saving}>{saving ? 'Saving…' : `Save ${config.singular.toLowerCase()}`}</button></footer>
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
  if (kind === 'lead') return { ...common, singular: 'Client', label: 'client', titleLabel: 'Business', placeholder: 'Business name', defaultStatus: 'prospect', statuses: leadStageGroups.map((group) => [group.canonical, group.label] as [string, string]) }
  return common
}

function PaymentsEditor({ leadId, quoted, currentUser, setToast }: { leadId: string; quoted?: number; currentUser: Owner; setToast: (toast: ToastState) => void }) {
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
      ? <PaymentForm kind={adding} leadId={leadId} startPosition={nextPosition()} currentUser={currentUser} onDone={() => setAdding(null)} setToast={setToast} />
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

function PaymentForm({ kind, leadId, startPosition, currentUser, onDone, setToast }: { kind: PaymentKind; leadId: string; startPosition: number; currentUser: Owner; onDone: () => void; setToast: (toast: ToastState) => void }) {
  const [label, setLabel] = useState(kind === 'retainer' ? 'Monthly retainer' : kind === 'share' ? 'Revenue share' : '')
  const [amount, setAmount] = useState('')
  const [percent, setPercent] = useState('')
  const [timing, setTiming] = useState<PaymentTiming>('date')
  const [date, setDate] = useState('')
  const [startDate, setStartDate] = useState('')
  const [count, setCount] = useState('12')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const title = kind === 'retainer' ? 'Recurring retainer' : kind === 'share' ? 'Revenue / profit share' : 'One-off payment'

  const save = async () => {
    if (saving) return
    setSaving(true); setError('')
    const stamp = nowIso()
    try {
      if (kind === 'one_off') {
        await db.payments.add({
          id: newId('payments', 'payment'), realmId: recordRealmId(), leadId, kind: 'one_off',
          label: label.trim() || 'Payment', amount: amount ? Number(amount) : undefined,
          timing, dueDate: timing === 'date' ? (date || undefined) : undefined,
          status: 'due', position: startPosition, createdAt: stamp, updatedAt: stamp, createdBy: currentUser
        })
      } else {
        const rows = generateRecurring({
          leadId, realmId: recordRealmId(), kind,
          label: label.trim() || (kind === 'retainer' ? 'Retainer' : 'Share'),
          amount: kind === 'retainer' && amount ? Number(amount) : undefined,
          percent: kind === 'share' && percent ? Number(percent) : undefined,
          startDate: startDate || stamp.slice(0, 10),
          count: Math.max(1, Number(count) || 1), createdBy: currentUser,
          makeRowId: () => newId('payments', 'payment')
        })
        rows.forEach((r, i) => { r.position = startPosition + i })
        await db.payments.bulkAdd(rows)
      }
      setToast({ message: 'Payment added.' })
      onDone()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not add payment.')
    } finally {
      setSaving(false)
    }
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
    {error && <p className="form-error">{error}</p>}
    <div className="payment-form-actions"><button type="button" onClick={onDone} disabled={saving}>Cancel</button><button type="button" className="primary-button" onClick={save} disabled={saving}>{saving ? 'Adding…' : 'Add'}</button></div>
  </div>
}

function ProjectModal({ state, currentUser, onClose, setToast, openProject }: { state: ProjectModalState; currentUser: Owner; onClose: () => void; setToast: (toast: ToastState) => void; openProject: (id: string) => void }) {
  const existing = useLiveQuery(() => state.projectId ? db.projects.get(state.projectId) : undefined, [state.projectId])
  const clients = useLiveQuery(() => db.leads.filter((lead) => !lead.archivedAt).toArray(), [], [])
  const sourceClient = clients.find((client) => client.id === state.clientId)
  const isEdit = Boolean(state.projectId)
  const [name, setName] = useState('')
  const [clientType, setClientType] = useState<Project['clientType']>('client')
  const [phase, setPhase] = useState('')
  const [goal, setGoal] = useState('')
  const [currentFocus, setCurrentFocus] = useState('')
  const [targetDate, setTargetDate] = useState('')
  const [driveFolderUrl, setDriveFolderUrl] = useState('')
  const [color, setColor] = useState(projectColors[1])
  const [clientId, setClientId] = useState(state.clientId ?? '')
  const [error, setError] = useState('')
  const nameInput = useRef<HTMLInputElement>(null)
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => { nameInput.current?.focus() }, [])
  useDialogBehavior(dialogRef, onClose)
  useEffect(() => {
    if (!existing) return
    setName(existing.name); setClientType(existing.clientType); setPhase(existing.phase)
    setGoal(existing.goal); setCurrentFocus(existing.currentFocus); setTargetDate(existing.targetDate ?? '')
    setDriveFolderUrl(existing.driveFolderUrl ?? ''); setColor(existing.color); setClientId(existing.clientId ?? '')
  }, [existing])
  useEffect(() => {
    if (isEdit || !sourceClient) return
    setName(sourceClient.business); setClientType('client'); setClientId(sourceClient.id)
    setGoal(`Deliver ${sourceClient.serviceInterest || sourceClient.tariff || 'the agreed work'} successfully for ${sourceClient.business}.`)
    setCurrentFocus('Confirm scope and agree the first next step.')
  }, [isEdit, sourceClient])

  const save = async (event: React.FormEvent) => {
    event.preventDefault()
    if (!name.trim()) return setError('Give the project a name.')
    if (driveFolderUrl.trim() && !isSafeUrl(driveFolderUrl.trim())) return setError('Only http:// or https:// links are allowed.')
    if (cloudEnabled && !state.projectId && !getActiveRealmId()) return setError('Still connecting to the workspace. Try again in a moment.')
    const stamp = nowIso()
    const data = { name: name.trim(), clientId: clientType === 'client' ? clientId || undefined : undefined, clientType, phase: phase.trim() || (clientType === 'internal' ? 'Operations' : 'Getting started'), goal: goal.trim(), currentFocus: currentFocus.trim(), targetDate: targetDate || undefined, driveFolderUrl: driveFolderUrl || undefined, color, updatedAt: stamp }
    try {
      if (isEdit) {
        await db.projects.update(state.projectId!, data)
        setToast({ message: 'Project updated.' })
      } else {
        const count = await db.projects.count()
        const id = newId('projects', 'project')
        await db.projects.add({ id, realmId: recordRealmId(), ...data, serviceType: clientType === 'internal' ? 'studio' : 'website', status: 'active', order: count + 1, createdAt: stamp, createdBy: currentUser })
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

  return <div className="modal-backdrop" role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()}><section ref={dialogRef} className="modal" role="dialog" aria-modal="true" aria-labelledby="project-modal-title"><header><div><p className="eyebrow">{isEdit ? 'Edit' : 'New'}</p><h2 id="project-modal-title">{isEdit ? 'Edit project' : 'New project'}</h2></div><button onClick={onClose} aria-label="Close"><X /></button></header><form onSubmit={save}>
    <label><span>Name</span><input ref={nameInput} value={name} onChange={(e) => setName(e.target.value)} placeholder="Client or project name" required /></label>
    <div className="form-row">
      <label><span>Type</span><select value={clientType} onChange={(e) => setClientType(e.target.value as Project['clientType'])}><option value="client">Client project</option><option value="internal">Internal</option></select></label>
      <label><span>Phase <small>optional</small></span><input value={phase} onChange={(e) => setPhase(e.target.value)} placeholder="Foundation, Build…" /></label>
    </div>
    {clientType === 'client' && <label><span>Linked client <small>financials live on the client</small></span><select value={clientId} onChange={(e) => setClientId(e.target.value)}><option value="">No linked client</option>{clients.sort((a, b) => Number(b.stage === 'won') - Number(a.stage === 'won') || a.business.localeCompare(b.business)).map((client) => <option key={client.id} value={client.id}>{client.business} — {leadStageLabels[client.stage]}</option>)}</select></label>}
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
