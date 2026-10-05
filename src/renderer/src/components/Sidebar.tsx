import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { Session } from '@opencode-ai/sdk'
import { useStore } from '../lib/store'
import { relativeTime, shortPath } from '../lib/format'
import { isCompareSessionTitle } from '../lib/compare'
import { childSessionsOf, isSideChatTitle, splitSideChatTitle, splitSubagentTitle } from '../lib/subagents'
import {
  loadSessionMeta,
  saveSessionMeta,
  setSessionMeta,
  isPinned,
  isArchived,
  pruneSessionMeta,
  compareSessions,
  type SessionMetaMap
} from '../lib/sessionMeta'
import { ModelPicker } from './ModelPicker'
import { ProviderPanel } from './ProviderPanel'

/** Dispatched by App.tsx when Escape is pressed. */
const CLOSE_PROVIDERS_EVENT = 'opencode-desktop:close-providers'

/** Dispatched to ask Chat.tsx to open the global chat-search modal. */
const OPEN_SEARCH_EVENT = 'chat:open-search'

type SidebarIconName = 'tasks' | 'agents' | 'providers' | 'images' | 'screen'

function SidebarIcon({ name }: { name: SidebarIconName }): JSX.Element {
  const paths: Record<SidebarIconName, JSX.Element> = {
    tasks: <><rect x="3" y="4" width="18" height="15" rx="3" /><path d="M8 9h8M8 13h5" /></>,
    agents: <><circle cx="9" cy="8" r="3" /><path d="M3.5 20a5.5 5.5 0 0 1 11 0M16 5.5a3 3 0 0 1 0 5.8M17 15a5 5 0 0 1 3.5 4.8" /></>,
    providers: <><rect x="9" y="2.5" width="6" height="5" rx="1.5" /><rect x="2.5" y="16.5" width="6" height="5" rx="1.5" /><rect x="15.5" y="16.5" width="6" height="5" rx="1.5" /><path d="M12 7.5v5M5.5 16.5v-4h13v4" /></>,
    images: <><rect x="3" y="3" width="18" height="18" rx="3" /><circle cx="8.5" cy="8.5" r="1.5" /><path d="m21 15-5-5L5 21" /></>,
    screen: <><rect x="3" y="4" width="18" height="14" rx="2" /><path d="M8 22h8m-4-4v4" /></>
  }
  return <svg className="sidebar__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>
}

function SidebarNavItem({
  icon,
  label,
  active = false,
  onClick
}: {
  icon: SidebarIconName
  label: string
  active?: boolean
  onClick: () => void
}): JSX.Element {
  return (
    <button
      type="button"
      className={active ? 'sidebar__nav-item sidebar__nav-item--active' : 'sidebar__nav-item'}
      aria-current={active ? 'page' : undefined}
      onClick={onClick}
    >
      <SidebarIcon name={icon} />
      <span>{label}</span>
    </button>
  )
}

function stamp(s: Session): number {
  return s.time.updated || s.time.created || 0
}

function fullStamp(ms: number): string {
  if (!ms) return ''
  return new Date(ms).toLocaleString()
}

export function Sidebar({ onOpenLiveScreen }: { onOpenLiveScreen?: () => void }): JSX.Element {
  const directory = useStore((s) => s.directory)
  const sessions = useStore((s) => s.sessions)
  const activeSessionID = useStore((s) => s.activeSessionID)
  const pickDirectory = useStore((s) => s.pickDirectory)
  const newSession = useStore((s) => s.newSession)
  const selectSession = useStore((s) => s.selectSession)
  const deleteSession = useStore((s) => s.deleteSession)
  const projects = useStore((s) => s.projects)
  const setDirectory = useStore((s) => s.setDirectory)
  const renameSession = useStore((s) => s.renameSession)
  const activeView = useStore((s) => s.activeView)
  const setActiveView = useStore((s) => s.setActiveView)
  const subagentBusy = useStore((s) => s.subagentBusy)
  const openSubagentTab = useStore((s) => s.openSubagentTab)

  const [providersOpen, setProvidersOpen] = useState(false)
  const [confirmID, setConfirmID] = useState<string | null>(null)
  const [tick, setTick] = useState(0)
  const [searchQuery, setSearchQuery] = useState('')
  const [editingSessionID, setEditingSessionID] = useState<string | null>(null)
  const [editingTitle, setEditingTitle] = useState('')
  const [showCompareRuns, setShowCompareRuns] = useState(false)
  const [showArchived, setShowArchived] = useState(false)
  const [sessionMeta, setSessionMetaState] = useState<SessionMetaMap>(() => loadSessionMeta())
  const [selectedIDs, setSelectedIDs] = useState<Set<string>>(() => new Set())
  const [bulkConfirm, setBulkConfirm] = useState(false)

  /* keep relative timestamps honest without a per-second re-render */
  useEffect(() => {
    const id = window.setInterval(() => setTick((n) => n + 1), 30_000)
    return () => window.clearInterval(id)
  }, [])

  useEffect(() => {
    const close = (): void => setProvidersOpen(false)
    window.addEventListener(CLOSE_PROVIDERS_EVENT, close)
    return () => window.removeEventListener(CLOSE_PROVIDERS_EVENT, close)
  }, [])

  /* the pending delete confirmation must not survive a list change */
  useEffect(() => {
    if (confirmID !== null && !sessions.some((s) => s.id === confirmID)) setConfirmID(null)
  }, [sessions, confirmID])

  /* selection entries for sessions that vanish from the list must not survive either */
  useEffect(() => {
    setSelectedIDs((prev) => {
      if (prev.size === 0) return prev
      const liveIDs = new Set(sessions.map((s) => s.id))
      const next = new Set([...prev].filter((id) => liveIDs.has(id)))
      return next.size === prev.size ? prev : next
    })
  }, [sessions])

  /* the meta map must not grow forever — prune entries for sessions the server no longer knows about */
  useEffect(() => {
    setSessionMetaState((prev) => {
      const pruned = pruneSessionMeta(prev, sessions.map((s) => s.id))
      if (pruned !== prev) saveSessionMeta(pruned)
      return pruned
    })
  }, [sessions])

  const updateMeta = useCallback((id: string, patch: { pinned?: boolean; archived?: boolean }) => {
    setSessionMetaState((prev) => {
      const next = setSessionMeta(prev, id, patch)
      saveSessionMeta(next)
      return next
    })
  }, [])

  /* the pending bulk-delete confirmation must not survive the selection emptying out */
  useEffect(() => {
    if (selectedIDs.size === 0 && bulkConfirm) setBulkConfirm(false)
  }, [selectedIDs, bulkConfirm])

  const compareCount = useMemo(
    () => sessions.filter((s) => !s.parentID && isCompareSessionTitle(s.title)).length,
    [sessions]
  )

  // The active session's child sessions (Task-tool subagents and `/btw` side chats). These
  // are hidden from the Recents list by the `!s.parentID` filter, so without this section
  // there is no way back into a subagent tab once it has been closed or cleared by a
  // session switch — short of scrolling the transcript for the Task tool call.
  const subagentChildren = useMemo(
    () => childSessionsOf(sessions, activeSessionID),
    [sessions, activeSessionID]
  )

  // Bulk operations must never sweep up compare-run sessions or subagent/side-chat sessions —
  // this is the same predicate `ordered` below applies, exported here so the bulk-delete handler
  // can re-filter the (possibly stale) selection against it rather than trusting stored state.
  const isBulkEligible = useCallback(
    (s: Session) => !s.parentID && !isCompareSessionTitle(s.title),
    []
  )

  const archivedCount = useMemo(
    () => sessions.filter((s) => isBulkEligible(s) && isArchived(sessionMeta, s.id)).length,
    [sessions, sessionMeta, isBulkEligible]
  )

  const ordered = useMemo(() => {
    void tick
    let res = sessions.filter((s) => !s.parentID)
    // Compare runs create one real session per column, which would otherwise bury the user's own
    // chats. Hidden by default behind the toggle below rather than deleted, so a run stays
    // recoverable.
    if (!showCompareRuns) res = res.filter((s) => !isCompareSessionTitle(s.title))
    if (!showArchived) res = res.filter((s) => !isArchived(sessionMeta, s.id))
    if (searchQuery.trim()) {
      const lower = searchQuery.trim().toLowerCase()
      res = res.filter((s) => (s.title || 'Untitled').toLowerCase().includes(lower))
    }
    return res.sort((a, b) => compareSessions(sessionMeta, { id: a.id, stamp: stamp(a) }, { id: b.id, stamp: stamp(b) }))
  }, [sessions, tick, searchQuery, showCompareRuns, showArchived, sessionMeta])

  const commitRename = useCallback(
    (id: string) => {
      const session = sessions.find((s) => s.id === id)
      const trimmed = editingTitle.trim()
      setEditingSessionID(null)
      if (!session || !trimmed) return
      const current = (session.title || '').trim()
      if (trimmed === current) return // no-op rename — skip the round trip
      void renameSession(id, trimmed)
    },
    [sessions, editingTitle, renameSession]
  )

  const handleEditKeyDown = (e: React.KeyboardEvent<HTMLInputElement>, id: string) => {
    if (e.key === 'Enter') {
      commitRename(id)
    } else if (e.key === 'Escape') {
      setEditingSessionID(null)
    }
  }

  const handleEditBlur = (id: string) => {
    commitRename(id)
  }

  const toggleSelected = useCallback((id: string) => {
    setSelectedIDs((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }, [])

  const runBulkDelete = useCallback(async () => {
    setBulkConfirm(false)
    // Re-filter against the live eligibility predicate rather than trusting stored selection —
    // it can survive a toggle change (e.g. show-compare-runs) and must never sweep up compare or
    // subagent/side-chat sessions.
    const idsToDelete = sessions.filter((s) => selectedIDs.has(s.id) && isBulkEligible(s)).map((s) => s.id)
    setSelectedIDs(new Set())
    for (const id of idsToDelete) {
      await deleteSession(id)
    }
  }, [sessions, selectedIDs, isBulkEligible, deleteSession])

  return (
    <div className="sidebar">
      {directory === null ? (
        <>
          <div className="sidebar__new">
            <button
              type="button"
              className="sidebar__btn sidebar__btn--primary sidebar__btn--newchat"
              onClick={() => void pickDirectory()}
              title="Choose the project folder OpenCode works in (Ctrl+O)"
            >
              + New task
              <span className="sidebar__kbd">Ctrl+O</span>
            </button>
          </div>

          <div className="sidebar__nav">
            <div className="sidebar__group-label">Workspace</div>
            <SidebarNavItem icon="tasks" label="Tasks" active={activeView === 'chats'} onClick={() => setActiveView('chats')} />
            <SidebarNavItem icon="agents" label="Agents" active={activeView === 'harness'} onClick={() => setActiveView('harness')} />
            <SidebarNavItem icon="providers" label="Providers" onClick={() => setProvidersOpen(true)} />
          </div>
          <div className="sidebar__nav-secondary">
            <div className="sidebar__group-label">Tools</div>
            <SidebarNavItem icon="images" label="Images" active={activeView === 'images'} onClick={() => setActiveView('images')} />
            <SidebarNavItem icon="screen" label="Live screen" onClick={() => onOpenLiveScreen?.()} />
          </div>

          <button
            type="button"
            className="sidebar__btn sidebar__btn--search"
            disabled
            title="Open a project first"
          >
            🔍 Search tasks
          </button>

          <div className="sidebar__empty">
            <span className="sidebar__empty-title">No project open</span>
            <p>
              Pick a folder to start. OpenCode reads and edits files inside it, and every session
              belongs to that folder.
            </p>
            <button type="button" className="sidebar__btn sidebar__btn--primary" onClick={() => void pickDirectory()}>
              Open folder…
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="sidebar__new">
            <button
              type="button"
              className="sidebar__btn sidebar__btn--primary sidebar__btn--newchat"
              onClick={() => { setActiveView('chats'); void newSession() }}
              title="Start a new session (Ctrl+N)"
            >
              + New task
              <span className="sidebar__kbd">Ctrl+N</span>
            </button>
          </div>

          <div className="sidebar__nav">
            <div className="sidebar__group-label">Workspace</div>
            <SidebarNavItem icon="tasks" label="Tasks" active={activeView === 'chats'} onClick={() => setActiveView('chats')} />
            <SidebarNavItem icon="agents" label="Agents" active={activeView === 'harness'} onClick={() => setActiveView('harness')} />
            <SidebarNavItem icon="providers" label="Providers" onClick={() => setProvidersOpen(true)} />
          </div>
          <div className="sidebar__nav-secondary">
            <div className="sidebar__group-label">Tools</div>
            <SidebarNavItem icon="images" label="Images" active={activeView === 'images'} onClick={() => setActiveView('images')} />
            <SidebarNavItem icon="screen" label="Live screen" onClick={() => onOpenLiveScreen?.()} />
          </div>

          <button
            type="button"
            className="sidebar__btn sidebar__btn--search"
            onClick={() => {
              setActiveView('chats')
              window.setTimeout(() => window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT)), 0)
            }}
            title="Search across every session's messages (Ctrl+Shift+F)"
          >
            🔍 Search tasks
          </button>

          <div className="sidebar__listhead">
            <span className="sidebar__label">Recent tasks</span>
            <span className="sidebar__count">{ordered.length}</span>
          </div>

          <div className="sidebar__search">
            <input
              type="text"
              className="sidebar__search-input"
              placeholder="Search tasks..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
            />
            {compareCount > 0 && (
              <label
                className="sidebar__compare-toggle"
                title="Compare runs create one session per model column"
              >
                <input
                  type="checkbox"
                  checked={showCompareRuns}
                  onChange={(e) => setShowCompareRuns(e.target.checked)}
                />
                Show {compareCount} compare session{compareCount === 1 ? '' : 's'}
              </label>
            )}
            {archivedCount > 0 && (
              <label
                className="sidebar__compare-toggle"
                title="Archived sessions are hidden from the list by default"
              >
                <input
                  type="checkbox"
                  checked={showArchived}
                  onChange={(e) => setShowArchived(e.target.checked)}
                />
                Show {archivedCount} archived session{archivedCount === 1 ? '' : 's'}
              </label>
            )}
          </div>

          {subagentChildren.length > 0 && (
            <div className="sidebar__subagents">
              <div className="sidebar__listhead">
                <span className="sidebar__label">Subagents</span>
                <span className="sidebar__count">{subagentChildren.length}</span>
              </div>
              {subagentChildren.map((child) => {
                const sideChat = isSideChatTitle(child.title)
                const { label, agent } = sideChat
                  ? { ...splitSideChatTitle(child.title), agent: null }
                  : splitSubagentTitle(child.title)
                return (
                  <button
                    key={child.id}
                    type="button"
                    className="sidebar__subagent"
                    title={`${child.title}\nOpen in a chat tab`}
                    onClick={() => {
                      setActiveView('chats')
                      void openSubagentTab(child.id)
                    }}
                  >
                    {subagentBusy[child.id] === true ? (
                      <span className="sidebar__subagent-spinner" role="status" aria-label="Working" />
                    ) : null}
                    <span className="sidebar__subagent-label">{label}</span>
                    {sideChat ? <span className="sidebar__subagent-badge">btw</span> : null}
                    {agent !== null ? <span className="sidebar__subagent-badge">{agent}</span> : null}
                  </button>
                )
              })}
            </div>
          )}

          {selectedIDs.size > 0 && (
            <div className="sidebar__bulkbar">
              <span className="sidebar__bulkbar-count">{selectedIDs.size} selected</span>
              {bulkConfirm ? (
                <>
                  <span className="sidebar__confirm-text">Delete {selectedIDs.size} session{selectedIDs.size === 1 ? '' : 's'}?</span>
                  <button
                    type="button"
                    className="sidebar__btn sidebar__btn--sm sidebar__btn--danger"
                    onClick={() => void runBulkDelete()}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="sidebar__btn sidebar__btn--sm"
                    onClick={() => setBulkConfirm(false)}
                  >
                    Cancel
                  </button>
                </>
              ) : (
                <>
                  <button
                    type="button"
                    className="sidebar__btn sidebar__btn--sm sidebar__btn--danger"
                    onClick={() => setBulkConfirm(true)}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="sidebar__btn sidebar__btn--sm"
                    onClick={() => setSelectedIDs(new Set())}
                  >
                    Clear
                  </button>
                </>
              )}
            </div>
          )}

          <div className="sidebar__list">
            {ordered.length === 0 && (
              <div className="sidebar__empty">
                <p>No sessions yet. Create one to start coding.</p>
              </div>
            )}

            {ordered.map((s) =>
              confirmID === s.id ? (
                <div className="sidebar__confirm" key={s.id}>
                  <span className="sidebar__confirm-text">Delete this session?</span>
                  <button
                    type="button"
                    className="sidebar__btn sidebar__btn--sm sidebar__btn--danger"
                    onClick={() => {
                      setConfirmID(null)
                      void deleteSession(s.id)
                    }}
                  >
                    Delete
                  </button>
                  <button
                    type="button"
                    className="sidebar__btn sidebar__btn--sm"
                    onClick={() => setConfirmID(null)}
                  >
                    Cancel
                  </button>
                </div>
              ) : (
                <div className="sidebar__row" key={s.id}>
                  <input
                    type="checkbox"
                    className="sidebar__checkbox"
                    aria-label={`Select session ${s.title || 'Untitled'}`}
                    checked={selectedIDs.has(s.id)}
                    onChange={() => toggleSelected(s.id)}
                  />
                  <button
                    type="button"
                    className={
                      s.id === activeSessionID
                        ? 'sidebar__session sidebar__session--active'
                        : 'sidebar__session'
                    }
                    onClick={() => {
                      setActiveView('chats')
                      if (s.id !== activeSessionID) void selectSession(s.id)
                    }}
                    title={`${s.title || 'Untitled'}\n${fullStamp(stamp(s))}`}
                  >
                    <span
                      className="sidebar__session-main"
                      onDoubleClick={() => {
                        setEditingSessionID(s.id)
                        setEditingTitle(s.title || 'Untitled')
                      }}
                    >
                      {editingSessionID === s.id ? (
                        <input
                          type="text"
                          className="sidebar__rename-input"
                          value={editingTitle}
                          onChange={(e) => setEditingTitle(e.target.value)}
                          onKeyDown={(e) => handleEditKeyDown(e, s.id)}
                          onBlur={() => handleEditBlur(s.id)}
                          autoFocus
                        />
                      ) : (
                        <span className="sidebar__session-title">{s.title || 'Untitled'}</span>
                      )}
                      <span className="sidebar__session-meta">
                        {isPinned(sessionMeta, s.id) ? '📌 ' : ''}
                        {relativeTime(stamp(s))}
                      </span>
                    </span>
                  </button>
                  <button
                    type="button"
                    className={
                      isPinned(sessionMeta, s.id) ? 'sidebar__pin sidebar__pin--active' : 'sidebar__pin'
                    }
                    aria-label={isPinned(sessionMeta, s.id) ? `Unpin session ${s.title || 'Untitled'}` : `Pin session ${s.title || 'Untitled'}`}
                    title={isPinned(sessionMeta, s.id) ? 'Unpin session' : 'Pin session'}
                    onClick={() => updateMeta(s.id, { pinned: !isPinned(sessionMeta, s.id) })}
                  >
                    {isPinned(sessionMeta, s.id) ? '📌' : '📍'}
                  </button>
                  <button
                    type="button"
                    className={
                      isArchived(sessionMeta, s.id) ? 'sidebar__archive sidebar__archive--active' : 'sidebar__archive'
                    }
                    aria-label={isArchived(sessionMeta, s.id) ? `Unarchive session ${s.title || 'Untitled'}` : `Archive session ${s.title || 'Untitled'}`}
                    title={isArchived(sessionMeta, s.id) ? 'Unarchive session' : 'Archive session'}
                    onClick={() => updateMeta(s.id, { archived: !isArchived(sessionMeta, s.id) })}
                  >
                    ⤓
                  </button>
                  <button
                    type="button"
                    className="sidebar__del"
                    aria-label={`Delete session ${s.title || 'Untitled'}`}
                    title="Delete session"
                    onClick={() => setConfirmID(s.id)}
                  >
                    ×
                  </button>
                </div>
              )
            )}
          </div>
        </>
      )}

      <div className="sidebar__foot">
        <div className="sidebar__foot-project">
          {directory ? (
            <div className="sidebar__path" title={directory}>
              <span>{shortPath(directory)}</span>
            </div>
          ) : (
            <div className="sidebar__path sidebar__path--empty">
              <span>No folder open</span>
            </div>
          )}
          {projects.length > 0 && (
            <select
              className="sidebar__btn sidebar__btn--select"
              value={directory || ''}
              onChange={(e) => void setDirectory(e.target.value)}
            >
              <option value="" disabled>Recent projects...</option>
              {projects.map((p) => (
                <option key={p.id} value={p.directory}>
                  {p.name}
                </option>
              ))}
            </select>
          )}
          <button
            type="button"
            className={activeView === 'projects' ? 'sidebar__btn sidebar__project-settings sidebar__project-settings--active' : 'sidebar__btn sidebar__project-settings'}
            onClick={() => setActiveView('projects')}
            title="Open project settings"
          >
            Project settings
          </button>
        </div>

        {/* Primary model picker now lives in the Composer action row; this is the
            fallback for reachability when no session/composer is on screen (e.g. empty state). */}
        <ModelPicker compact />

        <button type="button" className="sidebar__btn sidebar__change-folder" onClick={() => void pickDirectory()} title="Choose another project folder (Ctrl+O)">
          Change folder <span className="sidebar__kbd">Ctrl+O</span>
        </button>
      </div>

      <ProviderPanel open={providersOpen} onClose={() => setProvidersOpen(false)} />
    </div>
  )
}
