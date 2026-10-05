import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import type { JSX } from 'react'
import type { LeroyEvent } from '../../../preload'
import { loadPrefs } from '../lib/prefs'
import {
  describeLeroyStatus,
  formatLeroyUsage,
  isLeroyLive,
  reduceLeroyEvent,
  INITIAL_LEROY_STATE,
  type LeroyState
} from '../lib/leroySession'
import './leroy-panel.css'

/**
 * The Leroy surface inside the Live window: the `gemini-live-agent` harness run
 * as a Python sidecar, which adds local tool calling with approval gating,
 * dual-key tier failover and a usage readout on top of Gemini Live.
 *
 * The sidecar owns the microphone, speaker and screen capture, so this
 * component deliberately runs NO media pipeline of its own — it sends commands
 * and renders the event stream. The parent must not have the built-in
 * `window.api.live` session running at the same time.
 */

const YOLO_MINUTES = 10

function reducer(state: LeroyState, event: LeroyEvent): LeroyState {
  return reduceLeroyEvent(state, event, Date.now())
}

function summarizeArgs(args: Record<string, unknown>): string {
  const entries = Object.entries(args)
  if (entries.length === 0) return ''
  return entries
    .map(([key, value]) => `${key}: ${typeof value === 'string' ? value : JSON.stringify(value)}`)
    .join('  ·  ')
}

export function LeroyPanel({ onSendToChat }: { onSendToChat?: (text: string) => void }): JSX.Element {
  const [state, dispatch] = useReducer(reducer, INITIAL_LEROY_STATE)
  const [running, setRunning] = useState(false)
  const [prompt, setPrompt] = useState('')
  const [micOpen, setMicOpen] = useState(true)
  const [gating, setGating] = useState<'guarded' | 'yolo'>('guarded')
  const [startError, setStartError] = useState<string | null>(null)
  const unsubscribe = useRef<(() => void) | null>(null)

  // Unmount must not leave an orphaned Python process holding the microphone.
  // Main also kills it on window destroy; this covers a plain unmount.
  useEffect(() => () => {
    unsubscribe.current?.()
    void window.api.leroy.stop()
  }, [])

  const start = useCallback(async (): Promise<void> => {
    setStartError(null)
    const { directory } = loadPrefs()
    unsubscribe.current?.()
    unsubscribe.current = window.api.leroy.onEvent((event) => dispatch(event))
    try {
      await window.api.leroy.start({
        // The open project is the agent's working directory, so relative paths
        // in its file tools land where the user is actually working.
        settings: directory ? { working_dir: directory, workspace_root: directory } : {}
      })
      setRunning(true)
      setGating('guarded')
    } catch (cause) {
      unsubscribe.current?.()
      unsubscribe.current = null
      setStartError(cause instanceof Error ? cause.message : 'Leroy could not be started.')
    }
  }, [])

  const stop = useCallback((): void => {
    void window.api.leroy.stop()
    unsubscribe.current?.()
    unsubscribe.current = null
    setRunning(false)
  }, [])

  const live = isLeroyLive(state)

  const send = (): void => {
    const text = prompt.trim()
    if (!text || !live) return
    window.api.leroy.send({ type: 'send_text', text })
    setPrompt('')
  }

  const toggleMic = (): void => {
    const open = !micOpen
    setMicOpen(open)
    window.api.leroy.send({ type: 'set_mic_gate', open })
  }

  const toggleGating = (): void => {
    const next = gating === 'guarded' ? 'yolo' : 'guarded'
    setGating(next)
    window.api.leroy.send(
      next === 'yolo'
        ? { type: 'set_gating_mode', mode: 'yolo', duration_minutes: YOLO_MINUTES }
        : { type: 'set_gating_mode', mode: 'guarded' }
    )
  }

  const answer = (callId: string, allow: boolean): void => {
    window.api.leroy.send(allow ? { type: 'approve_tool', call_id: callId } : { type: 'deny_tool', call_id: callId })
  }

  const usage = formatLeroyUsage(state.usage)
  const status = running || state.dead ? describeLeroyStatus(state) : 'Off'

  return <section className="leroy" aria-label="Leroy agent">
    <header className="leroy__head">
      <div className="leroy__title">
        <span className={`leroy__dot leroy__dot--${state.dead ? 'failed' : running ? state.connection : 'idle'}`} />
        <strong>Leroy</strong>
        <span className="leroy__status">{status}{state.detail ? ` — ${state.detail}` : ''}</span>
      </div>
      <div className="leroy__head-actions">
        {usage && <span className="leroy__usage" title="Cumulative session usage">{usage}</span>}
        <button type="button" onClick={running ? stop : () => void start()}>{running ? 'Stop' : 'Start Leroy'}</button>
      </div>
    </header>

    {startError && <p className="leroy__error">{startError}</p>}
    {state.error && <p className="leroy__error">{state.error}</p>}
    {state.rateLimit && <p className="leroy__notice">
      Rate limited on {state.rateLimit.model} ({state.rateLimit.tier}) — {state.rateLimit.tpmUsed.toLocaleString()} of{' '}
      {state.rateLimit.tpmLimit.toLocaleString()} TPM. Falling back{state.rateLimit.cooldownSeconds ? ` after ${Math.round(state.rateLimit.cooldownSeconds)}s` : ''}.
    </p>}

    {state.approvals.length > 0 && <div className="leroy__approvals">
      {state.approvals.map((approval) => <div className="leroy__approval" key={approval.callId} role="alertdialog" aria-label={`Approve ${approval.name}`}>
        <div className="leroy__approval-head"><strong>{approval.name}</strong>{approval.allowText && <span>{approval.allowText}</span>}</div>
        <code className="leroy__approval-args">{summarizeArgs(approval.args)}</code>
        <div className="leroy__approval-actions">
          <button type="button" className="leroy__deny" onClick={() => answer(approval.callId, false)}>Deny</button>
          <button type="button" className="leroy__allow" onClick={() => answer(approval.callId, true)}>Allow</button>
        </div>
      </div>)}
    </div>}

    <div className="leroy__messages" aria-live="polite">
      {state.transcript.length
        ? state.transcript.map((entry) => <p className={`leroy__message leroy__message--${entry.role}`} key={entry.id}>
          <strong>{entry.role === 'gemini' ? 'Leroy' : entry.role === 'you' ? 'You' : 'Status'}</strong>
          {entry.text}
          {entry.role === 'gemini' && onSendToChat && <button type="button" className="leroy__handoff" onClick={() => onSendToChat(entry.text)} title="Send this answer to the OpenCode chat as a prompt">→ Chat</button>}
        </p>)
        : <p className="leroy__muted">{running ? 'Listening — speak or type.' : 'Start Leroy to give the assistant your microphone, screen and local tools.'}</p>}
    </div>

    {state.toolRuns.length > 0 && <details className="leroy__tools">
      <summary>Tool activity ({state.toolRuns.length})</summary>
      {state.toolRuns.map((run) => <p className={`leroy__tool leroy__tool--${run.ok ? 'ok' : 'fail'}`} key={`${run.callId}-${run.name}`}>
        <strong>{run.name}</strong>{run.result}
      </p>)}
    </details>}

    <div className="leroy__controls">
      <button type="button" onClick={toggleMic} aria-pressed={!micOpen} disabled={!live} title={micOpen ? 'Mute the microphone' : 'Unmute the microphone'}>{micOpen ? 'Mute' : 'Unmute'}</button>
      <input
        value={prompt}
        onChange={(event) => setPrompt(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter') send() }}
        placeholder="Ask Leroy, or tell it what to do…"
        disabled={!live}
      />
      <button type="button" onClick={send} disabled={!live}>Send</button>
    </div>

    <div className="leroy__gating">
      <button
        type="button"
        className={`leroy__gate${gating === 'yolo' ? ' leroy__gate--yolo' : ''}`}
        onClick={toggleGating}
        aria-pressed={gating === 'yolo'}
        disabled={!live}
      >
        {gating === 'yolo' ? `Auto-approving (${YOLO_MINUTES} min)` : 'Approve each action'}
      </button>
      <span className="leroy__gating-note">
        {gating === 'yolo'
          ? 'Leroy runs file writes and shell commands without asking until the timer expires.'
          : 'Destructive actions wait for your Allow.'}
      </span>
    </div>
  </section>
}
