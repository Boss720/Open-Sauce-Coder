import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useStore } from '../lib/store'
import { isTextPart } from '../lib/types'
import { MessageView } from './MessageView'
import { Composer } from './Composer'
import { PermissionPrompt } from './PermissionPrompt'
import { SubagentTabs, SubagentView } from './SubagentTabs'
import { TodoPanel } from './TodoPanel'
import { ChatSearch, SCROLL_TO_MESSAGE_EVENT } from './ChatSearch'
import { exportMarkdown } from '../lib/exportMarkdown'
import {
  VIEW_MODES,
  describeViewMode,
  shouldCollapseTools,
  shouldHideTools,
  viewModeLabel
} from '../lib/viewMode'
import './messages.css'

/** Dispatched by Sidebar.tsx to open the global chat-search modal. */
const OPEN_SEARCH_EVENT = 'chat:open-search'

/** DOM id assigned to each rendered message row, used for scroll-to-message. */
function messageDomID(id: string): string {
  return `msg-${id}`
}

/** How close to the bottom still counts as "following along", in pixels. */
const STICK_THRESHOLD = 80

/**
 * Only the newest slice of a session is mounted. Long agentic sessions ran into
 * hundreds of messages, each rendering its own tool calls, and re-rendered the
 * lot on every streamed token.
 *
 * Windowing rather than a virtualiser is deliberate: the sticky-scroll effects
 * and the two scroll-to-message paths (in-session find and global chat search)
 * all resolve a message by DOM id, and a virtualiser would mean rebuilding all
 * of that. The cost is that those paths must widen the window before scrolling
 * — see `revealMessage`.
 */
const WINDOW_STEP = 60
/** Tool calls older than this many messages from the end start collapsed. */
const TOOLS_EXPANDED_TAIL = 10

const SUGGESTIONS = [
  'Give me a tour of this codebase — entry points, structure, how it runs.',
  'Find the bug: run the tests and fix whatever fails.',
  'Add a README with setup and usage instructions.',
  'Review the recent changes for correctness and edge cases.'
]

function folderName(directory: string): string {
  const parts = directory.split(/[\\/]/).filter(Boolean)
  return parts.length > 0 ? parts[parts.length - 1] : directory
}

export function Chat(): ReactNode {
  const messages = useStore((state) => state.messages)
  const permissions = useStore((state) => state.permissions)
  const error = useStore((state) => state.error)
  const directory = useStore((state) => state.directory)
  const activeSessionID = useStore((state) => state.activeSessionID)
  const activeSession = useStore((state) =>
    state.sessions.find((session) => session.id === state.activeSessionID) ?? null
  )
  const sessions = useStore((state) => state.sessions)
  const configuredAgents = useStore((state) => state.agents)
  const activeAgent = useStore((state) =>
    state.activeSessionID ? state.sessionAgents[state.activeSessionID] : undefined
  )
  const sessionReadOnly = useStore((state) =>
    state.activeSessionID ? state.sessionReadOnly[state.activeSessionID] === true : false
  )
  const subagentBusy = useStore((state) => state.subagentBusy)
  const branch = useStore((state) => state.branch)
  const routingMode = useStore((state) => state.routingMode)
  const setPanelTab = useStore((state) => state.setPanelTab)
  const setActiveView = useStore((state) => state.setActiveView)
  const providerID = useStore((state) => state.providerID)
  const modelID = useStore((state) => state.modelID)
  const dismissError = useStore((state) => state.dismissError)
  const replyPermission = useStore((state) => state.replyPermission)
  const pickDirectory = useStore((state) => state.pickDirectory)
  const newSession = useStore((state) => state.newSession)
  const send = useStore((state) => state.send)
  const subagentTabCount = useStore((state) => state.subagentTabs.length)
  const activeSubagentTab = useStore((state) => state.activeSubagentTab)
  /** Set while the active session is reverted to an earlier point (SDK `Session.revert`). */
  const revertInfo = useStore((state) => {
    const id = state.activeSessionID
    if (!id) return undefined
    return state.sessions.find((s) => s.id === id)?.revert
  })
  const unrevertSession = useStore((state) => state.unrevertSession)
  const viewMode = useStore((state) => state.viewMode)
  const setViewMode = useStore((state) => state.setViewMode)
  // True when a subagent tab is being viewed instead of the main transcript.
  const viewingSubagent = activeSubagentTab !== null

  // Messages at/after the revert point are the hidden ones — countable only while the
  // local transcript still contains them (an optimistic edit-and-resend slices it).
  let hiddenCount = 0
  if (revertInfo) {
    const idx = messages.findIndex((m) => m.info.id === revertInfo.messageID)
    if (idx >= 0) hiddenCount = messages.length - idx
  }

  const scrollRef = useRef<HTMLDivElement | null>(null)
  const innerRef = useRef<HTMLDivElement | null>(null)
  const [detached, setDetached] = useState(false)
  const detachedRef = useRef(false)

  const [windowSize, setWindowSize] = useState(WINDOW_STEP)
  const [searchOpen, setSearchOpen] = useState(false)
  const [findOpen, setFindOpen] = useState(false)
  const [findQuery, setFindQuery] = useState('')
  const [findIndex, setFindIndex] = useState(0)

  const setDetachedBoth = useCallback((value: boolean) => {
    detachedRef.current = value
    setDetached(value)
  }, [])

  const scrollToBottom = useCallback((behavior: ScrollBehavior = 'auto') => {
    const element = scrollRef.current
    if (!element) return
    element.scrollTo({ top: element.scrollHeight, behavior })
  }, [])

  const onScroll = useCallback(() => {
    const element = scrollRef.current
    if (!element) return
    const distance = element.scrollHeight - element.scrollTop - element.clientHeight
    const next = distance > STICK_THRESHOLD
    if (next !== detachedRef.current) setDetachedBoth(next)
  }, [setDetachedBoth])

  /* ---- windowing --------------------------------------------------------- */

  const olderCount = Math.max(0, messages.length - windowSize)
  const visibleMessages = olderCount > 0 ? messages.slice(olderCount) : messages

  // Prepending older messages grows the scroll box upwards, which would yank the
  // reader's position. Pin the distance from the BOTTOM, which is invariant here.
  const loadOlder = useCallback(() => {
    const element = scrollRef.current
    const anchor = element ? element.scrollHeight - element.scrollTop : null
    setWindowSize((size) => size + WINDOW_STEP)
    if (element === null || anchor === null) return
    window.requestAnimationFrame(() => {
      const current = scrollRef.current
      if (current) current.scrollTop = current.scrollHeight - anchor
    })
  }, [])

  /**
   * Scroll to a message, widening the window first when it sits outside it.
   * Both scroll-to-message paths MUST go through here: the element does not
   * exist in the DOM until the widened window has rendered, so the scroll is
   * deferred a frame.
   */
  const revealMessage = useCallback(
    (messageID: string, behavior: ScrollBehavior = 'smooth') => {
      const index = messages.findIndex((m) => m.info.id === messageID)
      if (index < 0) return
      const needed = messages.length - index
      if (needed > windowSize) setWindowSize(needed + WINDOW_STEP)
      window.requestAnimationFrame(() => {
        document.getElementById(messageDomID(messageID))?.scrollIntoView({ behavior, block: 'center' })
      })
    },
    [messages, windowSize]
  )

  // New content: follow it only when the user has not scrolled away. Returning from a
  // subagent tab remounts the scroll container, so re-follow on that transition too.
  useLayoutEffect(() => {
    if (!detachedRef.current) scrollToBottom()
  }, [messages, scrollToBottom, viewingSubagent])

  // Streaming grows the transcript without changing its identity — watch the box.
  useEffect(() => {
    const inner = innerRef.current
    if (!inner || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => {
      if (!detachedRef.current) scrollToBottom()
    })
    observer.observe(inner)
    return () => observer.disconnect()
  }, [scrollToBottom])

  // Switching sessions always lands at the newest message, with a fresh window —
  // an expanded window must not carry over into an unrelated session.
  useLayoutEffect(() => {
    setDetachedBoth(false)
    setWindowSize(WINDOW_STEP)
    scrollToBottom()
  }, [activeSessionID, scrollToBottom, setDetachedBoth])

  // Global "search all chats" modal, opened from the sidebar.
  useEffect(() => {
    const openSearch = (): void => setSearchOpen(true)
    window.addEventListener(OPEN_SEARCH_EVENT, openSearch)
    return () => window.removeEventListener(OPEN_SEARCH_EVENT, openSearch)
  }, [])

  // A global-search hit lands here once its session is active — scroll to the
  // message, widening the window when the hit is older than what is mounted.
  useEffect(() => {
    const onScrollTo = (e: Event): void => {
      const messageID = (e as CustomEvent<{ messageID: string }>).detail?.messageID
      if (!messageID) return
      // The delay stays: the session's messages may still be loading when the hit arrives.
      window.setTimeout(() => revealMessage(messageID), 60)
    }
    window.addEventListener(SCROLL_TO_MESSAGE_EVENT, onScrollTo)
    return () => window.removeEventListener(SCROLL_TO_MESSAGE_EVENT, onScrollTo)
  }, [revealMessage])

  // Ctrl+F opens an in-session find bar over the currently loaded messages.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'f') {
        // Sidebar.tsx has advertised Ctrl+Shift+F in its tooltip all along while
        // nothing bound it. Same event the sidebar button dispatches.
        e.preventDefault()
        setSearchOpen(true)
      } else if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'f') {
        e.preventDefault()
        setFindOpen(true)
      } else if (e.key === 'Escape' && findOpen) {
        setFindOpen(false)
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [findOpen])

  // Message ids (in display order) whose text matches the in-session find query.
  const findMatches = useMemo(() => {
    const q = findQuery.trim().toLowerCase()
    if (!q) return []
    return messages
      .filter((m) =>
        m.parts.some((p) => isTextPart(p) && p.text.toLowerCase().includes(q))
      )
      .map((m) => m.info.id)
  }, [messages, findQuery])

  useEffect(() => {
    setFindIndex(0)
  }, [findQuery])

  // findMatches is computed over ALL messages, not the mounted window, so find
  // still reaches matches that are scrolled out of the window — revealMessage
  // mounts them on demand.
  const gotoFindMatch = useCallback(
    (index: number) => {
      if (findMatches.length === 0) return
      const wrapped = ((index % findMatches.length) + findMatches.length) % findMatches.length
      setFindIndex(wrapped)
      revealMessage(findMatches[wrapped])
    },
    [findMatches, revealMessage]
  )

  const canPrompt = directory !== null && providerID !== null && modelID !== null

  const runSuggestion = useCallback(
    (text: string) => {
      void send(text)
    },
    [send]
  )

  const showEmptySession = activeSessionID !== null && messages.length === 0
  const hideTools = shouldHideTools(viewMode)
  const taskTitle = activeSession?.title?.trim() || (activeSessionID ? 'New task' : 'Start a task')
  const childSessions = activeSessionID
    ? sessions.filter((session) => session.parentID === activeSessionID)
    : []
  const activeAgentProfile = configuredAgents.find((agent) => agent.name === activeAgent)
  const coordinatorRoute = activeAgentProfile?.model
    ? `${activeAgentProfile.model.providerID}/${activeAgentProfile.model.modelID}`
    : providerID && modelID
      ? `${providerID}/${modelID}`
      : 'No model selected'

  return (
    <section className="chat">
      <header className="chat__task-head">
        <div className="chat__task-title-wrap">
          <div className="chat__eyebrow">Task / {folderName(directory ?? 'Workspace')}</div>
          <h1 className="chat__task-title">{taskTitle}</h1>
        </div>
        <button
          type="button"
          className="chat__review-button"
          onClick={() => setPanelTab('changes')}
          title="Review changed files in this workspace"
          disabled={directory === null}
        >
          Review changes
        </button>
      </header>
      {messages.length > 0 && (
        <div className="chat__header-actions">
          <div
            className="chat__viewmode"
            role="radiogroup"
            aria-label="Transcript detail"
            title={describeViewMode(viewMode)}
          >
            {VIEW_MODES.map((mode) => (
              <button
                key={mode}
                type="button"
                role="radio"
                aria-checked={viewMode === mode}
                className={
                  viewMode === mode
                    ? 'chat__viewmode-btn chat__viewmode-btn--active'
                    : 'chat__viewmode-btn'
                }
                title={describeViewMode(mode)}
                onClick={() => setViewMode(mode)}
              >
                {viewModeLabel(mode)}
              </button>
            ))}
          </div>
          <button
            type="button"
            className="chat__export-btn"
            title="Export Chat History to Markdown"
            onClick={async () => {
              const sessions = useStore.getState().sessions
              const session = sessions.find((s) => s.id === activeSessionID)
              const defaultName = `${session?.title || 'opencode-chat'}.md`.replace(/[^a-zA-Z0-9._-]/g, '_')
              const content = exportMarkdown(messages, {
                sessionTitle: session?.title,
                directory: directory ?? undefined,
                providerID: providerID ?? undefined,
                modelID: modelID ?? undefined,
                exportedAt: new Date()
              })
              try {
                await window.api.exportChat(defaultName, content)
              } catch (err) {
                useStore
                  .getState()
                  .addSystemNotice(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
              }
            }}
          >
            📄 Export Markdown
          </button>
        </div>
      )}
      {subagentTabCount > 0 ? <SubagentTabs /> : null}
      {viewingSubagent ? (
        <SubagentView sessionID={activeSubagentTab} />
      ) : (
        <div className="chat__scroll" ref={scrollRef} onScroll={onScroll}>
          <div className="chat__inner" ref={innerRef}>
            {activeSessionID === null ? (
              <div className="chat__empty">
                <div className="chat__emptyglyph" aria-hidden="true">
                  ◇
                </div>
                <h2 className="chat__emptytitle">
                  {directory === null ? 'Open a folder to get started' : 'No session selected'}
                </h2>
                <p className="chat__emptybody">
                  {directory === null
                    ? 'opencode-desktop works against a project directory. Pick one and start a session — any provider, any model.'
                    : `Working in ${folderName(directory)}. Start a new session or pick one from the sidebar.`}
                </p>
                <div className="chat__emptyactions">
                  {directory === null ? (
                    <button
                      type="button"
                      className="chat__cta"
                      onClick={() => {
                        void pickDirectory()
                      }}
                    >
                      Open folder…
                    </button>
                  ) : (
                    <button
                      type="button"
                      className="chat__cta"
                      onClick={() => {
                        void newSession()
                      }}
                    >
                      New session
                    </button>
                  )}
                </div>
                {directory !== null ? <code className="chat__emptypath">{directory}</code> : null}
              </div>
            ) : showEmptySession ? (
              <div className="chat__empty">
                <div className="chat__emptyglyph" aria-hidden="true">
                  ✦
                </div>
                <h2 className="chat__emptytitle">What should we build?</h2>
                <p className="chat__emptybody">
                  {directory === null
                    ? 'Describe a change and the agent will work through it.'
                    : `This session is scoped to ${folderName(directory)}. Describe a change and the agent will work through it.`}
                </p>
                <ul className="chat__suggestions">
                  {SUGGESTIONS.map((suggestion) => (
                    <li key={suggestion}>
                      <button
                        type="button"
                        className="chat__suggestion"
                        disabled={!canPrompt}
                        onClick={() => runSuggestion(suggestion)}
                      >
                        {suggestion}
                      </button>
                    </li>
                  ))}
                </ul>
                {!canPrompt ? (
                  <p className="chat__emptyhint">Choose a model before sending your first prompt.</p>
                ) : null}
              </div>
            ) : (
              <>
                {olderCount > 0 ? (
                  <button type="button" className="chat__loadolder" onClick={loadOlder}>
                    Load {Math.min(WINDOW_STEP, olderCount)} earlier message
                    {Math.min(WINDOW_STEP, olderCount) === 1 ? '' : 's'}
                    <span className="chat__loadolder-count">{olderCount} older</span>
                  </button>
                ) : null}
                {visibleMessages.map((message, index) => (
                  <div
                    key={message.info.id}
                    id={messageDomID(message.info.id)}
                    className={
                      findOpen && findMatches[findIndex] === message.info.id
                        ? 'chat__msgwrap chat__msgwrap--findactive'
                        : 'chat__msgwrap'
                    }
                  >
                    <MessageView
                      message={message}
                      collapseTools={shouldCollapseTools(
                        viewMode,
                        visibleMessages.length - index,
                        TOOLS_EXPANDED_TAIL
                      )}
                      hideTools={hideTools}
                    />
                  </div>
                ))}
              </>
            )}
          </div>
        </div>
      )}

      {findOpen ? (
        <div className="chat__findbar" role="search" aria-label="Find in session">
          <input
            type="text"
            className="chat__findinput"
            placeholder="Find in this session…"
            value={findQuery}
            autoFocus
            onChange={(e) => setFindQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault()
                gotoFindMatch(findIndex + (e.shiftKey ? -1 : 1))
              } else if (e.key === 'Escape') {
                setFindOpen(false)
              }
            }}
          />
          <span className="chat__findcount">
            {findMatches.length > 0 ? `${findIndex + 1}/${findMatches.length}` : '0/0'}
          </span>
          <button
            type="button"
            className="chat__findnav"
            disabled={findMatches.length === 0}
            onClick={() => gotoFindMatch(findIndex - 1)}
            title="Previous match (Shift+Enter)"
          >
            ↑
          </button>
          <button
            type="button"
            className="chat__findnav"
            disabled={findMatches.length === 0}
            onClick={() => gotoFindMatch(findIndex + 1)}
            title="Next match (Enter)"
          >
            ↓
          </button>
          <button
            type="button"
            className="chat__findclose"
            onClick={() => setFindOpen(false)}
            aria-label="Close find"
          >
            ✕
          </button>
        </div>
      ) : null}

      {detached ? (
        <button
          type="button"
          className="chat__jump"
          onClick={() => {
            setDetachedBoth(false)
            scrollToBottom('smooth')
          }}
        >
          Jump to latest <span aria-hidden="true">↓</span>
        </button>
      ) : null}

      <div className="chat__dock">
        {error !== null ? (
          <div className="chat__banner" role="alert">
            <span className="chat__bannericon" aria-hidden="true">
              ⚠
            </span>
            <span className="chat__bannertext">{error}</span>
            <button
              type="button"
              className="chat__bannerclose"
              onClick={dismissError}
              aria-label="Dismiss error"
            >
              ✕
            </button>
          </div>
        ) : null}

        {permissions.length > 0 ? (
          <div className="chat__permissions">
            {permissions.map((permission) => (
              <PermissionPrompt
                key={permission.id}
                permission={permission}
                onRespond={(response) => {
                  void replyPermission(permission.id, response)
                }}
              />
            ))}
          </div>
        ) : null}

        {revertInfo && !viewingSubagent ? (
          <div className="chat__revert" role="status">
            <span className="chat__reverttext">
              This chat is reverted to an earlier point
              {hiddenCount > 0
                ? ` — ${hiddenCount} message${hiddenCount === 1 ? '' : 's'} hidden`
                : ' — later messages are hidden'}
              .
            </span>
            <button
              type="button"
              className="chat__revertbtn"
              onClick={() => {
                void unrevertSession()
              }}
            >
              Restore
            </button>
          </div>
        ) : null}

        <TodoPanel />
        {/* The composer stays bound to the main session; the subagent view is read-only
            and shows its own notice bar with a stop control instead. */}
        {viewingSubagent ? null : <Composer />}
      </div>

      {activeSessionID && (
        <details className="chat__task-context">
          <summary className="chat__task-context-summary">
            <span className="chat__task-context-label">This task</span>
            <strong className="chat__task-context-title">{taskTitle}</strong>
            <span className="chat__task-context-team">
              Team · {childSessions.length > 0
                ? `${childSessions.length} run${childSessions.length === 1 ? '' : 's'}`
                : activeAgent ?? 'Coordinator'}
            </span>
            <span className="chat__task-context-chevron" aria-hidden="true">›</span>
          </summary>
          <div className="chat__task-context-body">
            <section className="chat__task-outcome" aria-label="Task context">
              <span className="chat__eyebrow">Workspace</span>
              <strong>{taskTitle}</strong>
              <p title={directory ?? undefined}>{directory ?? 'No workspace selected'}</p>
              <div className="chat__context-tags">
                <span>{branch ? `Branch · ${branch}` : 'Branch · not detected'}</span>
                <span>{sessionReadOnly ? 'Read only' : 'Read/write session'}</span>
                <span>{routingMode === 'locked' ? 'Pinned route' : 'Automatic routing'}</span>
              </div>
            </section>
            <section className="chat__team" aria-label="Task team and agents">
              <div className="chat__team-head">
                <div>
                  <span className="chat__eyebrow">Team</span>
                  <strong>{configuredAgents.length > 0 ? 'Available agents' : 'Coordinator'}</strong>
                </div>
                <button type="button" onClick={() => setActiveView('harness')}>Manage agents</button>
              </div>
              <div className="chat__team-grid">
                <div className="chat__team-member">
                  <span className="chat__team-avatar">{(activeAgent ?? 'C').slice(0, 1).toUpperCase()}</span>
                  <span><strong>{activeAgent ?? 'Coordinator'}</strong><small>{coordinatorRoute} · {sessionReadOnly ? 'read only' : 'project rules'}</small></span>
                </div>
                {configuredAgents.filter((agent) => agent.name !== activeAgent).slice(0, 4).map((agent) => {
                  const access = agent.permission.edit === 'deny'
                    ? 'no edits'
                    : agent.permission.edit === 'ask'
                      ? 'ask to edit'
                      : 'edits allowed'
                  const model = agent.model
                    ? `${agent.model.providerID}/${agent.model.modelID}`
                    : `${agent.mode} agent`
                  return (
                    <div className="chat__team-member" key={agent.name}>
                      <span className="chat__team-avatar">{agent.name.slice(0, 1).toUpperCase()}</span>
                      <span><strong>{agent.name}</strong><small>{model} · {access}</small></span>
                    </div>
                  )
                })}
                {childSessions.map((session) => (
                  <button
                    className="chat__team-member chat__team-member--child"
                    type="button"
                    key={session.id}
                    onClick={() => {
                      setActiveView('chats')
                      void useStore.getState().openSubagentTab(session.id)
                    }}
                  >
                    <span className="chat__team-avatar">{(session.title || 'A').slice(0, 1).toUpperCase()}</span>
                    <span><strong>{session.title || 'Subagent'}</strong><small>{subagentBusy[session.id] ? 'Working' : 'Open run'}</small></span>
                  </button>
                ))}
              </div>
            </section>
          </div>
        </details>
      )}

      <ChatSearch open={searchOpen} onClose={() => setSearchOpen(false)} />
    </section>
  )
}
