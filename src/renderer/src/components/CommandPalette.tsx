import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { JSX, KeyboardEvent as ReactKeyboardEvent } from 'react'
import { useStore } from '../lib/store'
import { relativeTime, shortPath } from '../lib/format'
import { findMatches, splitHighlight } from '../lib/search'
import { exportMarkdown } from '../lib/exportMarkdown'
import { SLASH_COMMANDS } from '../lib/commands'
import { loadTipsPrefs, saveTipsPrefs, setTipsEnabled, resetTips, TIPS } from '../lib/tips'
import type { Theme, RoutingMode } from '../lib/prefs'
import type { AppState } from '../lib/slices/types'
import './palette.css'

/** Dispatched by App.tsx (Ctrl+,) and listened for by StatusBar.tsx to toggle Settings. */
const TOGGLE_SETTINGS_EVENT = 'opencode-desktop:toggle-settings'
/** Dispatched by Sidebar.tsx and listened for by Chat.tsx to open the global chat-search modal. */
const OPEN_SEARCH_EVENT = 'chat:open-search'

/** How long to wait after the last keystroke before firing a file search. */
const FILE_SEARCH_DEBOUNCE_MS = 150
/** Cap on live file-search results shown in the palette. */
const MAX_FILE_RESULTS = 20

type Category = 'Sessions' | 'Models' | 'Files' | 'Panels' | 'Git' | 'Terminal' | 'View'

const CATEGORY_ORDER: Category[] = [
  'Sessions',
  'Models',
  'Files',
  'Panels',
  'Git',
  'Terminal',
  'View'
]

type PaletteCommand = {
  id: string
  category: Category
  label: string
  /** Extra text (e.g. a path or provider id) that also participates in the filter. */
  keywords?: string
  /** Shown right-aligned — current value, active marker, counts, etc. */
  hint?: string
  disabled?: boolean
  run: () => void
}

const THEME_LABEL: Record<Theme, string> = { auto: 'Auto', dark: 'Dark', light: 'Light' }
const ROUTING_LABEL: Record<RoutingMode, string> = {
  locked: 'Locked',
  failover: 'Failover',
  auto: 'Auto'
}
const VIEW_LABEL: Record<AppState['activeView'], string> = {
  chats: 'Chats',
  projects: 'Projects',
  images: 'Images',
  harness: 'Harness',
  dag: 'Workflows'
}
type PanelTab = NonNullable<AppState['panelTab']>
const PANEL_LABEL: Record<PanelTab, string> = {
  files: 'Files',
  editor: 'Editor',
  changes: 'Changes',
  git: 'Git',
  terminal: 'Terminal',
  artifacts: 'Artifacts',
  harness: 'Harness',
  dag: 'DAG'
}

function commandMatches(cmd: PaletteCommand, query: string): boolean {
  if (query.length === 0) return true
  const haystack = `${cmd.label} ${cmd.category} ${cmd.keywords ?? ''}`
  return findMatches(haystack, query).length > 0
}

export function CommandPalette(): JSX.Element | null {
  const paletteOpen = useStore((s) => s.paletteOpen)
  const setPaletteOpen = useStore((s) => s.setPaletteOpen)

  const directory = useStore((s) => s.directory)

  const sessions = useStore((s) => s.sessions)
  const activeSessionID = useStore((s) => s.activeSessionID)
  const selectSession = useStore((s) => s.selectSession)
  const newSession = useStore((s) => s.newSession)

  const providers = useStore((s) => s.providers)
  const providerID = useStore((s) => s.providerID)
  const modelID = useStore((s) => s.modelID)
  const setModel = useStore((s) => s.setModel)
  const routingMode = useStore((s) => s.routingMode)
  const setRoutingMode = useStore((s) => s.setRoutingMode)

  const openPath = useStore((s) => s.openPath)

  const panelTab = useStore((s) => s.panelTab)
  const setPanelTab = useStore((s) => s.setPanelTab)

  const gitStatus = useStore((s) => s.gitStatus)
  const refreshGit = useStore((s) => s.refreshGit)
  const stagePaths = useStore((s) => s.stagePaths)
  const commit = useStore((s) => s.commit)

  const startTerminal = useStore((s) => s.startTerminal)

  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const activeView = useStore((s) => s.activeView)
  const setActiveView = useStore((s) => s.setActiveView)

  const projects = useStore((s) => s.projects)
  const setDirectory = useStore((s) => s.setDirectory)
  const messages = useStore((s) => s.messages)
  const addSystemNotice = useStore((s) => s.addSystemNotice)

  const [query, setQuery] = useState('')
  // Identity, not position: see the activeIndex derivation below for why.
  const [activeId, setActiveId] = useState<string | null>(null)

  // Commit is the one command that needs free-text input. Selecting it switches the
  // single input box into "collect a commit message" mode instead of opening a second dialog.
  const [commitMode, setCommitMode] = useState(false)
  const [commitText, setCommitText] = useState('')

  const [fileResults, setFileResults] = useState<string[]>([])
  const [fileSearching, setFileSearching] = useState(false)
  const fileSeqRef = useRef(0)

  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLDivElement | null>(null)
  const previouslyFocused = useRef<HTMLElement | null>(null)

  const close = useCallback(() => {
    setPaletteOpen(false)
  }, [setPaletteOpen])

  /* ---- open / close lifecycle -------------------------------------------- */

  useEffect(() => {
    if (paletteOpen) {
      previouslyFocused.current = document.activeElement as HTMLElement | null
      setQuery('')
      setActiveId(null)
      setCommitMode(false)
      setCommitText('')
      setFileResults([])
      const t = window.setTimeout(() => inputRef.current?.focus(), 0)
      return () => window.clearTimeout(t)
    }
    previouslyFocused.current?.focus?.()
    previouslyFocused.current = null
    return undefined
  }, [paletteOpen])

  /* ---- debounced, race-safe file search ----------------------------------- */

  useEffect(() => {
    if (!paletteOpen || !directory || commitMode || query.trim().length === 0) {
      setFileResults([])
      setFileSearching(false)
      return undefined
    }
    const q = query.trim()
    const mySeq = ++fileSeqRef.current
    setFileSearching(true)
    const t = window.setTimeout(() => {
      window.api.find
        .files(directory, q)
        .then((paths) => {
          // A newer keystroke may have already started its own search. Only the most
          // recent request is allowed to land, regardless of which resolves first.
          if (fileSeqRef.current !== mySeq) return
          setFileResults(paths.slice(0, MAX_FILE_RESULTS))
        })
        .catch(() => {
          if (fileSeqRef.current !== mySeq) return
          setFileResults([])
        })
        .finally(() => {
          if (fileSeqRef.current === mySeq) setFileSearching(false)
        })
    }, FILE_SEARCH_DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query, paletteOpen, directory, commitMode])

  /* ---- static commands ----------------------------------------------------- */

  const staticCommands = useMemo<PaletteCommand[]>(() => {
    const out: PaletteCommand[] = []

    for (const s of sessions) {
      out.push({
        id: `session:${s.id}`,
        category: 'Sessions',
        label: s.title || 'Untitled session',
        hint:
          s.id === activeSessionID
            ? 'current'
            : relativeTime(s.time?.updated || s.time?.created || 0),
        run: () => {
          void selectSession(s.id)
          close()
        }
      })
    }
    out.push({
      id: 'session:new',
      category: 'Sessions',
      label: 'New session',
      run: () => {
        void newSession()
        close()
      }
    })

    for (const p of providers) {
      for (const m of Object.values(p.models)) {
        const isCurrent = p.id === providerID && m.id === modelID
        out.push({
          id: `model:${p.id}/${m.id}`,
          category: 'Models',
          label: `${p.name} · ${m.name}`,
          keywords: `${p.id} ${m.id}`,
          hint: isCurrent ? 'current' : undefined,
          run: () => {
            setModel(p.id, m.id)
            close()
          }
        })
      }
    }
    for (const mode of ['locked', 'failover', 'auto'] as RoutingMode[]) {
      out.push({
        id: `routing:${mode}`,
        category: 'Models',
        label: `Routing: ${ROUTING_LABEL[mode]}`,
        hint: mode === routingMode ? 'current' : undefined,
        run: () => {
          setRoutingMode(mode)
          close()
        }
      })
    }

    const panelTabs: PanelTab[] = ['files', 'editor', 'changes', 'git', 'terminal', 'artifacts', 'harness', 'dag']
    for (const tab of panelTabs) {
      out.push({
        id: `panel:${tab}`,
        category: 'Panels',
        label: `Show ${PANEL_LABEL[tab]}`,
        hint: tab === panelTab ? 'current' : undefined,
        run: () => {
          setPanelTab(tab)
          close()
        }
      })
    }
    out.push({
      id: 'panel:close',
      category: 'Panels',
      label: 'Close panel',
      hint: panelTab === null ? 'current' : undefined,
      run: () => {
        setPanelTab(null)
        close()
      }
    })

    const stagedCount = gitStatus?.entries.filter((e) => e.index !== null).length ?? 0
    out.push({
      id: 'git:refresh',
      category: 'Git',
      label: 'Refresh git status',
      run: () => {
        void refreshGit()
        close()
      }
    })
    out.push({
      id: 'git:stage-all',
      category: 'Git',
      label: 'Stage all changes',
      hint: gitStatus ? `${gitStatus.entries.length} file(s)` : undefined,
      disabled: !gitStatus || gitStatus.entries.length === 0,
      run: () => {
        if (!gitStatus || gitStatus.entries.length === 0) return
        void stagePaths(gitStatus.entries.map((e) => e.path))
        close()
      }
    })
    out.push({
      id: 'git:commit',
      category: 'Git',
      label: 'Commit staged changes…',
      hint: stagedCount > 0 ? `${stagedCount} staged` : 'nothing staged',
      disabled: stagedCount === 0,
      run: () => {
        if (stagedCount === 0) return
        setCommitMode(true)
        setCommitText('')
      }
    })

    out.push({
      id: 'terminal:new',
      category: 'Terminal',
      label: 'New terminal',
      run: () => {
        void startTerminal()
        close()
      }
    })

    for (const t of ['auto', 'dark', 'light'] as Theme[]) {
      out.push({
        id: `theme:${t}`,
        category: 'View',
        label: `Theme: ${THEME_LABEL[t]}`,
        hint: t === theme ? 'current' : undefined,
        run: () => {
          setTheme(t)
          close()
        }
      })
    }
    for (const v of ['chats', 'projects', 'images', 'harness', 'dag'] as Array<AppState['activeView']>) {
      out.push({
        id: `view:${v}`,
        category: 'View',
        label: `View: ${VIEW_LABEL[v]}`,
        hint: v === activeView ? 'current' : undefined,
        run: () => {
          setActiveView(v)
          close()
        }
      })
    }
    out.push({
      id: 'view:live',
      category: 'View',
      label: 'Open Gemini Live',
      run: () => {
        void window.api.liveWindow.open()
        close()
      }
    })
    out.push({
      id: 'view:settings',
      category: 'View',
      label: 'Open Settings',
      run: () => {
        window.dispatchEvent(new Event(TOGGLE_SETTINGS_EVENT))
        close()
      }
    })

    // Tips state is localStorage, not in the store; read directly here for hints/disabled.
    const tipsPrefs = loadTipsPrefs()
    out.push({
      id: 'tips:show',
      category: 'View',
      label: 'Show new-user tips',
      // The count is the catalogue size, not `remainingTipCount`: this action
      // resets dismissals, and remaining is 0 whenever tips are off — exactly
      // when the action has the most to restore.
      hint: `restores all ${TIPS.length}`,
      run: () => {
        saveTipsPrefs(resetTips(loadTipsPrefs()))
        close()
      }
    })
    out.push({
      id: 'tips:hide',
      category: 'View',
      label: 'Hide new-user tips',
      hint: tipsPrefs.enabled ? undefined : 'already hidden',
      disabled: !tipsPrefs.enabled,
      run: () => {
        saveTipsPrefs(setTipsEnabled(loadTipsPrefs(), false))
        close()
      }
    })

    for (const p of projects) {
      out.push({
        id: `project:${p.id}`,
        category: 'View',
        label: `Open recent project: ${p.name}`,
        keywords: p.directory,
        hint: p.directory === directory ? 'current' : shortPath(p.directory),
        run: () => {
          void setDirectory(p.directory)
          close()
        }
      })
    }

    out.push({
      id: 'session:search',
      category: 'Sessions',
      label: 'Search all chats',
      run: () => {
        setActiveView('chats')
        window.setTimeout(() => window.dispatchEvent(new CustomEvent(OPEN_SEARCH_EVENT)), 0)
        close()
      }
    })
    out.push({
      id: 'session:export',
      category: 'Sessions',
      label: 'Export chat to Markdown',
      hint: messages.length === 0 ? 'no messages' : undefined,
      disabled: messages.length === 0,
      run: () => {
        if (messages.length === 0) return
        const session = sessions.find((s) => s.id === activeSessionID)
        const defaultName = `${session?.title || 'opencode-chat'}.md`.replace(/[^a-zA-Z0-9._-]/g, '_')
        const content = exportMarkdown(messages, {
          sessionTitle: session?.title,
          directory: directory ?? undefined,
          providerID: providerID ?? undefined,
          modelID: modelID ?? undefined,
          exportedAt: new Date()
        })
        void window.api.exportChat(defaultName, content).catch((err: unknown) => {
          addSystemNotice(`Export failed: ${err instanceof Error ? err.message : String(err)}`)
        })
        close()
      }
    })

    // Local slash commands whose `action` runs client-side (no server round trip needed
    // for a `/command` line). Entries with no `action` are handled by the composer's own
    // parser instead — chosen deliberately over disabling them, since disabled entries with
    // no way to act on them add clutter without helping discovery.
    for (const sc of SLASH_COMMANDS) {
      if (!sc.action) continue
      out.push({
        id: `slash:${sc.name}`,
        category: 'Sessions',
        label: `${sc.name} — ${sc.description}`,
        keywords: sc.alias ?? '',
        run: () => {
          void sc.action?.('')
          close()
        }
      })
    }

    return out
  }, [
    sessions,
    activeSessionID,
    selectSession,
    newSession,
    providers,
    providerID,
    modelID,
    setModel,
    routingMode,
    setRoutingMode,
    panelTab,
    setPanelTab,
    gitStatus,
    refreshGit,
    stagePaths,
    startTerminal,
    theme,
    setTheme,
    activeView,
    setActiveView,
    directory,
    projects,
    setDirectory,
    messages,
    addSystemNotice,
    close
  ])

  const fileCommands = useMemo<PaletteCommand[]>(() => {
    if (commitMode) return []
    return fileResults.map((path) => ({
      id: `file:${path}`,
      category: 'Files' as const,
      label: path,
      run: () => {
        setPanelTab('editor')
        void openPath(path)
        close()
      }
    }))
  }, [fileResults, commitMode, setPanelTab, openPath, close])

  const trimmedQuery = query.trim()
  const filtered = useMemo<PaletteCommand[]>(() => {
    if (commitMode) return []
    const matchedStatic = staticCommands.filter((c) => commandMatches(c, trimmedQuery))
    const byCategory = new Map<Category, PaletteCommand[]>()
    for (const cat of CATEGORY_ORDER) byCategory.set(cat, [])
    for (const c of matchedStatic) byCategory.get(c.category)?.push(c)
    for (const c of fileCommands) byCategory.get('Files')?.push(c)

    const out: PaletteCommand[] = []
    for (const cat of CATEGORY_ORDER) {
      const cmds = byCategory.get(cat)
      if (cmds && cmds.length > 0) out.push(...cmds)
    }
    return out
  }, [staticCommands, fileCommands, trimmedQuery, commitMode])

  /* ---- highlight tracking -------------------------------------------------
   * The highlight is keyed on the command's id and the index is derived from it,
   * rather than the index being state. `filtered` grows asynchronously: the
   * debounced file search lands after the list has already rendered and inserts
   * a whole Files group, which sits third in CATEGORY_ORDER — ahead of Panels,
   * Git and View. With a positional index the highlight silently slid onto a
   * different command, so pressing Enter right after typing opened a fuzzy file
   * match instead of the command the user was looking at. */
  const activeIndex = useMemo(() => {
    if (activeId === null) return 0
    const found = filtered.findIndex((c) => c.id === activeId)
    // -1 for the one render between the list changing and the effect below
    // adopting a new id.
    return found >= 0 ? found : 0
  }, [filtered, activeId])

  // Adopt the first command whenever nothing is highlighted yet or the
  // highlighted one has dropped out of the list. Claiming an id up front is what
  // makes the tracking work — leaving it null would mean "whatever is first",
  // which is precisely the slot that late-arriving results take over.
  useEffect(() => {
    if (filtered.length === 0) {
      if (activeId !== null) setActiveId(null)
      return
    }
    if (activeId === null || !filtered.some((c) => c.id === activeId)) {
      setActiveId(filtered[0].id)
    }
  }, [filtered, activeId])

  const setActiveByIndex = useCallback(
    (index: number) => {
      setActiveId(filtered[index]?.id ?? null)
    },
    [filtered]
  )

  useEffect(() => {
    if (!listRef.current) return
    const el = listRef.current.querySelector<HTMLElement>(`[data-index="${activeIndex}"]`)
    el?.scrollIntoView({ block: 'nearest' })
  }, [activeIndex])

  const runCommit = useCallback(() => {
    const text = commitText.trim()
    if (!text) return
    void commit(text)
    close()
  }, [commitText, commit, close])

  const handleKeyDown = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Escape') {
      e.preventDefault()
      close()
      return
    }
    if (e.key === 'Tab') {
      // Only one real focusable element lives in this dialog while it is open — trap
      // focus on it rather than letting Tab escape to the page behind the overlay.
      e.preventDefault()
      return
    }
    if (commitMode) {
      if (e.key === 'Enter') {
        e.preventDefault()
        runCommit()
      }
      return
    }
    if (e.key === 'ArrowDown') {
      e.preventDefault()
      if (filtered.length > 0) setActiveByIndex((activeIndex + 1) % filtered.length)
    } else if (e.key === 'ArrowUp') {
      e.preventDefault()
      if (filtered.length > 0) setActiveByIndex((activeIndex - 1 + filtered.length) % filtered.length)
    } else if (e.key === 'Home') {
      e.preventDefault()
      setActiveByIndex(0)
    } else if (e.key === 'End') {
      e.preventDefault()
      if (filtered.length > 0) setActiveByIndex(filtered.length - 1)
    } else if (e.key === 'Enter') {
      e.preventDefault()
      const cmd = filtered[activeIndex]
      if (cmd && !cmd.disabled) cmd.run()
    }
  }

  if (!paletteOpen) return null

  const activeOptionId =
    filtered.length > 0 && activeIndex < filtered.length
      ? `palette-option-${activeIndex}`
      : undefined

  let lastCategory: Category | null = null

  return (
    <div
      className="palette"
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close()
      }}
    >
      <div className="palette__panel">
        <div className="palette__inputrow">
          <input
            ref={inputRef}
            type="text"
            className="palette__input"
            role="combobox"
            aria-expanded="true"
            aria-controls="palette-listbox"
            aria-autocomplete="list"
            aria-activedescendant={commitMode ? undefined : activeOptionId}
            placeholder={commitMode ? 'Commit message…' : 'Type a command, file, session, model…'}
            value={commitMode ? commitText : query}
            onChange={(e) => {
              if (commitMode) setCommitText(e.target.value)
              else {
                setQuery(e.target.value)
                // Null rather than an index: the effect above adopts the first
                // command of the *new* list once it has been computed.
                setActiveId(null)
              }
            }}
            onKeyDown={handleKeyDown}
          />
          {fileSearching ? <span className="palette__spinner" aria-hidden="true" /> : null}
        </div>

        {commitMode ? (
          <div className="palette__body">
            <p className="palette__hint">
              Press Enter to commit, Escape to close the palette.
            </p>
          </div>
        ) : (
          <div
            className="palette__body"
            id="palette-listbox"
            role="listbox"
            aria-label="Commands"
            ref={listRef}
          >
            {filtered.length === 0 ? (
              <p className="palette__empty">No matching commands.</p>
            ) : (
              filtered.map((cmd, i) => {
                const showHeader = cmd.category !== lastCategory
                lastCategory = cmd.category
                const parts = splitHighlight(cmd.label, trimmedQuery)
                return (
                  <div key={cmd.id}>
                    {showHeader ? (
                      <div className="palette__group-header">{cmd.category}</div>
                    ) : null}
                    <div
                      id={`palette-option-${i}`}
                      data-index={i}
                      role="option"
                      aria-selected={i === activeIndex}
                      className={
                        'palette__option' +
                        (i === activeIndex ? ' palette__option--active' : '') +
                        (cmd.disabled ? ' palette__option--disabled' : '')
                      }
                      onMouseEnter={() => setActiveByIndex(i)}
                      onMouseDown={(e) => {
                        e.preventDefault()
                        if (!cmd.disabled) cmd.run()
                      }}
                    >
                      <span className="palette__option-label">
                        {parts.map((p, pi) =>
                          p.match ? (
                            <mark key={pi} className="palette__mark">
                              {p.text}
                            </mark>
                          ) : (
                            <span key={pi}>{p.text}</span>
                          )
                        )}
                      </span>
                      {cmd.hint ? <span className="palette__option-hint">{cmd.hint}</span> : null}
                    </div>
                  </div>
                )
              })
            )}
          </div>
        )}
      </div>
    </div>
  )
}
