import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { ChangeEvent, KeyboardEvent, ReactNode } from 'react'
import { useStore } from '../lib/store'
import { getMatchingCommands, type SlashCommand } from '../lib/commands'
import { guessMime, joinPath, toFileUrl } from '../lib/fileurl'
import { resolveMentionMenuKey } from '../lib/keyboard'
import type { PromptPart } from '../lib/types'
import { MentionMenu } from './MentionMenu'
import { ModelPicker } from './ModelPicker'
import { FILE_TREE_DRAG_MIME } from './FileTree'
import { selectModelDetailed, getCostTier, type ModelSelectionExplanation } from '../lib/routing'
import { FREE_PROVIDER_CAPS, isFreeModel } from '../lib/freeTier'
import { getLedger } from '../lib/slices/attemptMachine'
import { isAgentModel } from '../lib/models'
import './composer.css'

const MAX_HEIGHT_RATIO = 0.4
const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024 // 5 MB — larger drag-and-drop files are silently skipped

export function Composer(): ReactNode {
  const directory = useStore((state) => state.directory)
  const providerID = useStore((state) => state.providerID)
  const modelID = useStore((state) => state.modelID)
  const activeSessionID = useStore((state) => state.activeSessionID)
  const busy = useStore((state) => state.busy)
  const send = useStore((state) => state.send)
  const abort = useStore((state) => state.abort)
  const serverCommands = useStore((state) => state.serverCommands)
  const queuedPrompts = useStore((state) => state.queuedPrompts)
  const queuePrompt = useStore((state) => state.queuePrompt)
  const removeQueued = useStore((state) => state.removeQueued)
  const agents = useStore((state) => state.agents)
  const activeAgent = useStore((state) =>
    state.activeSessionID ? state.sessionAgents[state.activeSessionID] : undefined
  )
  const readOnly = useStore((state) =>
    state.activeSessionID ? state.sessionReadOnly[state.activeSessionID] === true : false
  )
  const setSessionAgent = useStore((state) => state.setSessionAgent)
  const setSessionReadOnly = useStore((state) => state.setSessionReadOnly)

  // Subagents (mode 'subagent') are not selectable as the session's driver.
  const primaryAgents = useMemo(
    () => agents.filter((a) => a.mode === 'primary' || a.mode === 'all'),
    [agents]
  )

  const providers = useStore((state) => state.providers)
  const linkedProviderIDs = useStore((state) => state.linkedProviderIDs)
  const modelPool = useStore((state) => state.modelPool)
  const routingMode = useStore((state) => state.routingMode)
  const showPaidModels = useStore((state) => state.showPaidModels)

  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [slashIndex, setSlashIndex] = useState(0)
  const [attachments, setAttachments] = useState<Array<{ filename: string; absPath: string }>>([])
  const [mentionQuery, setMentionQuery] = useState<string | null>(null)
  const [mentionStart, setMentionStart] = useState<number | null>(null)
  const [mentionFiles, setMentionFiles] = useState<string[]>([])
  const [mentionSelectedIndex, setMentionSelectedIndex] = useState(0)
  const [isDragging, setIsDragging] = useState(false)
  const [showWhyModel, setShowWhyModel] = useState(false)
  const areaRef = useRef<HTMLTextAreaElement | null>(null)
  const whyModelRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!showWhyModel) return
    const handleClickOutside = (e: MouseEvent): void => {
      if (whyModelRef.current && !whyModelRef.current.contains(e.target as Node)) {
        setShowWhyModel(false)
      }
    }
    const handleKeyDown = (e: globalThis.KeyboardEvent): void => {
      if (e.key === 'Escape') {
        setShowWhyModel(false)
      }
    }
    document.addEventListener('mousedown', handleClickOutside)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('mousedown', handleClickOutside)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [showWhyModel])

  const explanation = useMemo<ModelSelectionExplanation | null>(() => {
    if (!providers || providers.length === 0) return null
    const available = new Set<string>()
    for (const p of providers) {
      if (!linkedProviderIDs.includes(p.id)) continue
      for (const m of Object.values(p.models ?? {})) {
        if (isAgentModel(m) && (showPaidModels || isFreeModel(p.id, m.id))) {
          available.add(`${p.id}/${m.id}`)
        }
      }
    }
    const currentKey = providerID && modelID ? `${providerID}/${modelID}` : null
    return selectModelDetailed(modelPool, getLedger(), FREE_PROVIDER_CAPS, Date.now(), {
      sticky: routingMode !== 'auto',
      current: currentKey,
      available,
      authenticatedProviders: new Set(linkedProviderIDs)
    })
  }, [providers, linkedProviderIDs, modelPool, routingMode, showPaidModels, providerID, modelID])

  // Fetches the file list backing the @mention menu. This used to live inside
  // MentionMenu itself, but the menu's open/closed and selection state now has
  // to be visible here so onKeyDown can consult it (see lib/keyboard.ts) —
  // MentionMenu is presentational only.
  useEffect(() => {
    if (mentionQuery === null || !directory) {
      setMentionFiles([])
      return
    }
    let cancelled = false
    const timer = setTimeout(() => {
      const q = mentionQuery.trim()
      if (window.api && window.api.find) {
        window.api.find
          .files(directory, q)
          .then((result) => {
            if (cancelled) return
            setMentionFiles(Array.isArray(result) ? result.slice(0, 10) : [])
            setMentionSelectedIndex(0)
          })
          .catch(() => {
            if (cancelled) return
            setMentionFiles([])
          })
      }
    }, 150)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [mentionQuery, directory])

  const slashMatches = useMemo(() => {
    if (text.startsWith('/')) {
      return getMatchingCommands(text, serverCommands)
    }
    return []
  }, [text, serverCommands])

  const showSlashMenu = slashMatches.length > 0

  useEffect(() => {
    setSlashIndex(0)
  }, [slashMatches.length])

  const blocked: string | null = !directory
    ? 'Open a folder to start coding'
    : !providerID || !modelID
      ? 'Choose a model to start'
      : null

  const disabled = blocked !== null

  const resize = useCallback(() => {
    const area = areaRef.current
    if (!area) return
    area.style.height = 'auto'
    const max = Math.max(120, Math.round(window.innerHeight * MAX_HEIGHT_RATIO))
    const next = Math.min(area.scrollHeight, max)
    area.style.height = `${next}px`
    area.style.overflowY = area.scrollHeight > max ? 'auto' : 'hidden'
  }, [])

  useLayoutEffect(() => {
    resize()
  }, [text, resize])

  useEffect(() => {
    const onResize = (): void => resize()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [resize])

  useEffect(() => {
    if (!disabled && activeSessionID) areaRef.current?.focus()
  }, [activeSessionID, disabled])

  const submit = useCallback(
    (customText?: string) => {
      const payload = (customText ?? text).trim()
      if (payload === '' || disabled || sending) return

      let fileParts: PromptPart[] | undefined = undefined
      if (attachments.length > 0) {
        fileParts = attachments.map((att) => ({
          type: 'file' as const,
          mime: guessMime(att.filename),
          filename: att.filename,
          url: toFileUrl(att.absPath)
        }))
      }

      if (busy) {
        queuePrompt(payload, fileParts)
        setText('')
        setAttachments([])
        setMentionQuery(null)
        setMentionStart(null)
        return
      }

      setSending(true)
      void (async () => {
        try {
          await send(payload, fileParts)
          if (useStore.getState().error === null) {
            setText('')
            setAttachments([])
            setMentionQuery(null)
            setMentionStart(null)
          }
        } catch {
          /* keep the draft */
        } finally {
          setSending(false)
          areaRef.current?.focus()
        }
      })()
    },
    [text, disabled, sending, busy, send, attachments, queuePrompt]
  )

  const selectSlashCommand = useCallback((cmd: SlashCommand) => {
    setText(`${cmd.name} `)
    areaRef.current?.focus()
  }, [])

  /** Shared append logic for every attachment source (mentions, drag-and-drop, the
   *  attach button, and clipboard paste): derive the filename from the absolute path
   *  and skip anything already attached. */
  const addAttachments = useCallback((absPaths: string[]) => {
    setAttachments((prev) => {
      const next = [...prev]
      for (const absPath of absPaths) {
        if (next.some((a) => a.absPath === absPath)) continue
        const segments = absPath.split(/[/\\]/)
        const filename = segments[segments.length - 1]
        next.push({ filename, absPath })
      }
      return next
    })
  }, [])

  const onSelectMention = useCallback((filepath: string) => {
    if (mentionStart === null) return
    const before = text.slice(0, mentionStart)
    const after = text.slice(areaRef.current?.selectionEnd || mentionStart + (mentionQuery?.length || 0) + 1)

    const newText = before + filepath + ' ' + after
    setText(newText)

    const absPath = joinPath(directory || '', filepath)
    addAttachments([absPath])

    setMentionQuery(null)
    setMentionStart(null)
    areaRef.current?.focus()
  }, [text, mentionStart, mentionQuery, directory, addAttachments])

  const onKeyDown = useCallback(
    (event: KeyboardEvent<HTMLTextAreaElement>) => {
      // Mention menu owns these keys first when it's open. This is the single point
      // of contact for the collision that used to exist between this handler and
      // MentionMenu's own (now-removed) capture-phase document listener: exactly one
      // listener now looks at mention-menu keys, and resolveMentionMenuKey is the
      // pure decision of what they mean.
      const mentionAction = resolveMentionMenuKey(event.nativeEvent, {
        open: mentionQuery !== null,
        fileCount: mentionFiles.length,
        selectedIndex: mentionSelectedIndex
      })
      if (mentionAction) {
        event.preventDefault()
        if (mentionAction.type === 'move') {
          setMentionSelectedIndex(mentionAction.nextIndex)
        } else if (mentionAction.type === 'select') {
          const file = mentionFiles[mentionSelectedIndex]
          if (file) onSelectMention(file)
        } else {
          setMentionQuery(null)
          setMentionStart(null)
        }
        return
      }

      if (showSlashMenu) {
        if (event.key === 'ArrowDown') {
          event.preventDefault()
          setSlashIndex((i) => (i + 1) % slashMatches.length)
          return
        }
        if (event.key === 'ArrowUp') {
          event.preventDefault()
          setSlashIndex((i) => (i - 1 + slashMatches.length) % slashMatches.length)
          return
        }
        if (event.key === 'Tab') {
          event.preventDefault()
          const cmd = slashMatches[slashIndex]
          if (cmd) selectSlashCommand(cmd)
          return
        }
        if (event.key === 'Escape') {
          event.preventDefault()
          setText('')
          return
        }
      }

      if (event.key !== 'Enter') return
      if (event.shiftKey || event.altKey || event.ctrlKey || event.metaKey) return
      if (event.nativeEvent.isComposing) return
      // mentionQuery !== null but we got here means resolveMentionMenuKey returned
      // null for this Enter — the "no files found" panel is showing (see its
      // fileCount === 0 branch) — so still don't let it fall through to submit.
      if (mentionQuery !== null) return
      event.preventDefault()

      if (showSlashMenu && text.trim().startsWith('/')) {
        const cmd = slashMatches[slashIndex]
        if (cmd && text.trim() === cmd.name) {
          submit()
        } else if (cmd) {
          submit(cmd.name)
        } else {
          submit()
        }
        return
      }

      submit()
    },
    [
      mentionQuery,
      mentionFiles,
      mentionSelectedIndex,
      onSelectMention,
      showSlashMenu,
      slashMatches,
      slashIndex,
      selectSlashCommand,
      submit,
      text
    ]
  )

  const onChange = useCallback((event: ChangeEvent<HTMLTextAreaElement>) => {
    const val = event.target.value
    setText(val)

    if (val.startsWith('/')) {
      setMentionQuery(null)
      setMentionStart(null)
      return
    }

    const cursor = event.target.selectionStart
    const textBeforeCursor = val.slice(0, cursor)
    const match = textBeforeCursor.match(/(?:^|\s)@([^\s]*)$/)

    if (match && match.index !== undefined) {
      const startIdx = match.index + (textBeforeCursor[match.index] === '@' ? 0 : 1)
      setMentionStart(startIdx)
      setMentionQuery(match[1])
    } else {
      setMentionQuery(null)
      setMentionStart(null)
    }
  }, [])

  /** Only react to file drags — dragging plain text/HTML must not trigger the overlay or a drop.
   *  Covers both an OS file drag (`Files`) and an internal drag started from the file tree
   *  (`FILE_TREE_DRAG_MIME`), since a same-window HTML5 drag never populates `dataTransfer.files`. */
  const isFileDrag = (e: React.DragEvent): boolean => {
    const types = Array.from(e.dataTransfer.types)
    return types.includes('Files') || types.includes(FILE_TREE_DRAG_MIME)
  }

  const onDragOver = useCallback(
    (e: React.DragEvent) => {
      if (disabled || !isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(true)
    },
    [disabled]
  )

  const onDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setIsDragging(false)
  }, [])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!isFileDrag(e)) return
      e.preventDefault()
      e.stopPropagation()
      setIsDragging(false)
      if (disabled) return

      // Internal drag from the file tree: no dataTransfer.files, path comes from the
      // custom MIME type and is workspace-relative, so resolve it the same way @mentions do.
      const internalPath = e.dataTransfer.getData(FILE_TREE_DRAG_MIME)
      if (internalPath && directory) {
        const absPath = joinPath(directory, internalPath)
        addAttachments([absPath])
        return
      }

      const dropped = Array.from(e.dataTransfer.files)
      if (dropped.length === 0) return

      for (const file of dropped) {
        if (file.size > MAX_ATTACHMENT_BYTES) continue // silent skip, per spec

        const absPath = window.api.pathForFile(file)
        if (!absPath) continue // Electron 43 dropped File.path; empty result means "can't resolve"

        addAttachments([absPath])
      }
    },
    [disabled, directory, addAttachments]
  )

  const onAttachClick = useCallback(() => {
    void (async () => {
      const paths = await window.api.pickFiles()
      if (paths.length > 0) addAttachments(paths)
    })()
  }, [addAttachments])

  /** Handle files pasted into the textarea (e.g. Ctrl+V from Explorer or a clipboard
   *  screenshot). A normal text paste must keep working untouched, so we only
   *  preventDefault once we know we've actually consumed at least one file. */
  const onPaste = useCallback(
    (event: React.ClipboardEvent<HTMLTextAreaElement>) => {
      if (disabled) return
      const files = Array.from(event.clipboardData.files)
      if (files.length === 0) return // nothing but text — let the default paste happen

      let consumed = false

      for (const file of files) {
        // A file copied from Explorer carries a real path — attach it directly,
        // no byte copy needed.
        const absPath = window.api.pathForFile(file)
        if (absPath) {
          addAttachments([absPath])
          consumed = true
          continue
        }

        // No resolvable path means this is the real clipboard-bitmap case (e.g. a
        // screenshot). Only images are handleable this way.
        if (!file.type.startsWith('image/')) continue
        if (file.size > MAX_ATTACHMENT_BYTES) continue // silent skip, per spec
        consumed = true

        void (async () => {
          try {
            const dataUrl = await new Promise<string>((resolve, reject) => {
              const reader = new FileReader()
              reader.onload = () => resolve(reader.result as string)
              reader.onerror = () => reject(reader.error)
              reader.readAsDataURL(file)
            })
            const data = dataUrl.slice(dataUrl.indexOf(',') + 1)
            const subtype = file.type.slice('image/'.length)
            const ext = subtype === 'jpeg' ? 'jpg' : subtype
            const savedPath = await window.api.saveClipboardImage({ data, ext })
            addAttachments([savedPath])
          } catch {
            /* skip silently, consistent with oversize-drop handling */
          }
        })()
      }

      if (consumed) event.preventDefault()
    },
    [disabled, addAttachments]
  )

  const canSend = !disabled && !sending && text.trim() !== ''

  return (
    <div
      className={`composer${disabled ? ' composer--disabled' : ''}${isDragging ? ' composer--drag-active' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {showSlashMenu && (
        <div className="composer__slash-menu" role="listbox">
          <div className="composer__slash-head">Claude Code Slash Commands</div>
          {slashMatches.map((cmd, idx) => (
            <button
              type="button"
              key={cmd.name}
              className={`composer__slash-item${idx === slashIndex ? ' composer__slash-item--active' : ''}`}
              onClick={() => submit(cmd.name)}
              onMouseEnter={() => setSlashIndex(idx)}
            >
              <span className="composer__slash-name">{cmd.name}</span>
              {cmd.isServerCommand && <span className="composer__slash-badge">Project</span>}
              <span className="composer__slash-desc">{cmd.description}</span>
            </button>
          ))}
        </div>
      )}

      {mentionQuery !== null && directory && (
        <MentionMenu
          query={mentionQuery}
          files={mentionFiles}
          selectedIndex={mentionSelectedIndex}
          onSelect={onSelectMention}
          onHoverIndex={setMentionSelectedIndex}
        />
      )}

      {queuedPrompts.length > 0 && (
        <div className="composer__queue">
          {queuedPrompts.map((q, idx) => (
            <div key={idx} className="composer__queue-chip">
              <span className="composer__queue-text">{q.text}</span>
              <button type="button" onClick={() => removeQueued(idx)}>×</button>
            </div>
          ))}
        </div>
      )}

      {attachments.length > 0 && (
        <div className="composer__attachments">
          {attachments.map((att, idx) => (
            <div key={idx} className="composer__chip">
              <span>{att.filename}</span>
              <button type="button" onClick={() => setAttachments(prev => prev.filter((_, i) => i !== idx))}>×</button>
            </div>
          ))}
        </div>
      )}

      <div className="composer__box">
        <textarea
          ref={areaRef}
          className="composer__input"
          value={text}
          onChange={onChange}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          disabled={disabled}
          rows={1}
          spellCheck={false}
          placeholder={
            disabled
              ? (blocked ?? '')
              : 'Ask anything, or type / for commands…'
          }
          aria-label="Message"
        />
        <div className="composer__actions">
          <div className="composer__actions-left">
            <button
              type="button"
              className="composer__attach"
              disabled={disabled}
              onClick={onAttachClick}
              aria-label="Attach files"
              title="Attach files"
            >
              📎
            </button>
            <ModelPicker compact />
            <button
              type="button"
              className={`composer__why-model${showWhyModel ? ' composer__why-model--active' : ''}`}
              onClick={() => setShowWhyModel((prev) => !prev)}
              title="Why this model? (Explainable routing details)"
              aria-expanded={showWhyModel}
              aria-label="Explain model selection"
            >
              <span className="composer__why-model-icon" aria-hidden="true">💡</span>
              <span className="composer__why-model-label">Why this model?</span>
            </button>
            {activeSessionID && primaryAgents.length > 0 && (
              <select
                className={`composer__agent${activeAgent ? ' composer__agent--active' : ''}`}
                value={activeAgent ?? ''}
                onChange={(event) =>
                  setSessionAgent(activeSessionID, event.target.value === '' ? null : event.target.value)
                }
                title="Agent to run this session's prompts with"
                aria-label="Agent"
              >
                <option value="">Default</option>
                {primaryAgents.map((a) => (
                  <option key={a.name} value={a.name}>
                    {a.name}
                  </option>
                ))}
              </select>
            )}
            {activeSessionID && (
              <button
                type="button"
                className={`composer__pill${readOnly ? ' composer__pill--active' : ''}`}
                aria-pressed={readOnly}
                onClick={() => setSessionReadOnly(activeSessionID, !readOnly)}
                title={
                  readOnly
                    ? 'Read-only is ON — the agent cannot write, edit, patch, or run shell commands'
                    : 'Make this session read-only'
                }
              >
                🔒 Read-only
              </button>
            )}
          </div>
          <div className="composer__actions-right">
          {canSend && (
            <button
              type="button"
              className="composer__send"
              onClick={() => submit()}
              title={busy ? 'Queue Message (Enter)' : 'Send (Enter)'}
            >
              {busy ? 'Queue' : sending ? 'Sending…' : 'Send'}
            </button>
          )}
          {busy && (
            <button
              type="button"
              className="composer__send composer__send--stop"
              onClick={() => {
                void abort()
              }}
              title="Stop the assistant"
            >
              <span className="composer__stopglyph" aria-hidden="true">
                ■
              </span>
              Stop
            </button>
          )}
          {!busy && !canSend && (
            <button
              type="button"
              className="composer__send"
              disabled
              title="Send (Enter)"
            >
              Send
            </button>
          )}
          </div>
        </div>

        {showWhyModel && explanation && (
          <div className="composer__routing-inspector" ref={whyModelRef} role="dialog" aria-label="Model routing explanation">
            <div className="composer__routing-header">
              <div className="composer__routing-title-group">
                <span className="composer__routing-title">Model Routing Rationale</span>
                <span className="composer__routing-subtitle">Balanced quality, cost & health breakdown</span>
              </div>
              <button
                type="button"
                className="composer__routing-close"
                onClick={() => setShowWhyModel(false)}
                aria-label="Close routing rationale"
              >
                ×
              </button>
            </div>

            <div className="composer__routing-summary">
              <div className="composer__routing-pick">
                <span className="composer__routing-pick-label">Current Choice:</span>
                <span className="composer__routing-pick-name">{explanation.selected ?? 'None'}</span>
                {explanation.selected && (
                  <span className={`composer__cost-badge composer__cost-badge--${getCostTier(explanation.selected)}`}>
                    {getCostTier(explanation.selected)}
                  </span>
                )}
              </div>
              <p className="composer__routing-reason">{explanation.reason}</p>
            </div>

            <div className="composer__routing-candidates">
              <div className="composer__routing-table-header">
                <span>Candidate</span>
                <span>Quality</span>
                <span>Latency</span>
                <span>Tier</span>
                <span>Status</span>
              </div>
              <div className="composer__routing-table-body">
                {explanation.candidates.map((cand) => (
                  <div
                    key={cand.key}
                    className={`composer__routing-row${cand.key === explanation.selected ? ' composer__routing-row--selected' : ''}${cand.rejectedReason ? ' composer__routing-row--rejected' : ''}`}
                  >
                    <span className="composer__routing-cell composer__routing-cell-key" title={cand.key}>
                      {cand.key === explanation.selected && <span className="composer__routing-checkmark">✓ </span>}
                      {cand.key}
                    </span>
                    <span className="composer__routing-cell">{cand.quality}/6</span>
                    <span className="composer__routing-cell">{cand.latency !== null ? `${Math.round(cand.latency)}ms` : '—'}</span>
                    <span className="composer__routing-cell">
                      <span className={`composer__cost-badge composer__cost-badge--${cand.costTier}`}>
                        {cand.costTier}
                      </span>
                    </span>
                    <span
                      className={`composer__routing-cell composer__routing-cell-status${cand.rejectedReason ? ' composer__routing-cell-status--rejected' : ''}`}
                      title={cand.rejectedReason ?? 'Healthy'}
                    >
                      {cand.rejectedReason ? cand.rejectedReason : `${(cand.score * 100).toFixed(0)}%`}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          </div>
        )}
      </div>

      <div className="composer__footer">
        {blocked ? (
          <span className="composer__hint composer__hint--warn">{blocked}</span>
        ) : (
          <span className="composer__hint">Enter to send · Type / for slash commands</span>
        )}
        {(activeAgent || readOnly) && (
          <span className="composer__flags">
            {activeAgent && <span className="composer__flag">agent: {activeAgent}</span>}
            {readOnly && <span className="composer__flag composer__flag--lock">read-only</span>}
          </span>
        )}
      </div>
    </div>
  )
}
