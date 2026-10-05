import { useEffect, useRef, useState } from 'react'
import type { JSX } from 'react'
import { appendTranscriptChunk, type LiveTranscriptEntry } from '../lib/liveTranscript'
import { LeroyPanel } from './LeroyPanel'
import { collectProjectContext } from '../lib/liveContext'
import { DEFAULT_LIVE_PREFS, LIVE_VOICES, loadLivePrefs, loadPrefs, saveLivePrefs, type LivePrefs } from '../lib/prefs'
import './live-screen.css'

type LiveStatus = 'idle' | 'connecting' | 'live' | 'reconnecting' | 'error'
type ServerMessage = { setupComplete?: object; serverContent?: { interrupted?: boolean; inputTranscription?: { text?: string }; outputTranscription?: { text?: string }; modelTurn?: { parts?: Array<{ text?: string; inlineData?: { data?: string; mimeType?: string } }> } } }

function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  for (let offset = 0; offset < bytes.length; offset += 8192) binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192))
  return window.btoa(binary)
}

function base64ToInt16(value: string): Int16Array {
  const binary = window.atob(value)
  const bytes = new Uint8Array(binary.length)
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index)
  return new Int16Array(bytes.buffer)
}

export function LiveScreenAssistant({ onClose }: { onClose?: () => void }): JSX.Element {
  const [status, setStatus] = useState<LiveStatus>('idle')
  const [pinned, setPinned] = useState(true)
  const [transcript, setTranscript] = useState<LiveTranscriptEntry[]>([])
  const [prompt, setPrompt] = useState('')
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [muted, setMuted] = useState(false)
  const [settings, setSettings] = useState<LivePrefs>(() => loadLivePrefs())
  const [settingsOpen, setSettingsOpen] = useState(false)
  // 'copilot' is the built-in Gemini Live path; 'leroy' hands the window to the
  // gemini-live-agent sidecar, which owns the mic/screen itself. They can never
  // run together — switching stops the built-in session first.
  const [mode, setMode] = useState<'copilot' | 'leroy'>('copilot')
  const statusRef = useRef<LiveStatus>('idle')
  const transcriptRef = useRef<LiveTranscriptEntry[]>([])
  const nextEntryId = useRef(0)
  const mutedRef = useRef(false)
  const unsubscribeLive = useRef<(() => void) | null>(null)
  const screenStream = useRef<MediaStream | null>(null)
  const micStream = useRef<MediaStream | null>(null)
  const frameTimer = useRef<number | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const audioContext = useRef<AudioContext | null>(null)
  const micWorklet = useRef<AudioWorkletNode | null>(null)
  const audioSources = useRef(new Set<AudioBufferSourceNode>())
  const nextAudioTime = useRef(0)
  const closing = useRef(false)
  const savingTranscript = useRef(false)

  // Ref-mirrored status: the IPC callback is registered once per connect and
  // must read the CURRENT status, not a stale closure.
  const changeStatus = (next: LiveStatus): void => {
    statusRef.current = next
    setStatus(next)
  }

  const addTranscript = (role: LiveTranscriptEntry['role'], text: string): void => {
    if (!text.trim()) return
    nextEntryId.current += 1
    transcriptRef.current = appendTranscriptChunk(transcriptRef.current, { id: nextEntryId.current, role, text, at: Date.now() })
    setTranscript(transcriptRef.current)
  }

  const updateSettings = (patch: Partial<LivePrefs>): void => {
    setSettings((current) => {
      const next = { ...current, ...patch }
      saveLivePrefs(next)
      return next
    })
  }

  const toggleMuted = (): void => {
    setMuted((current) => {
      mutedRef.current = !current
      return !current
    })
  }

  const stop = (): void => {
    closing.current = true
    if (frameTimer.current !== null) window.clearInterval(frameTimer.current)
    frameTimer.current = null
    if (micWorklet.current) {
      micWorklet.current.port.onmessage = null
      micWorklet.current.disconnect()
      micWorklet.current = null
    }
    micStream.current?.getTracks().forEach((track) => track.stop())
    screenStream.current?.getTracks().forEach((track) => track.stop())
    micStream.current = null
    screenStream.current = null
    for (const source of audioSources.current) source.stop()
    audioSources.current.clear()
    void audioContext.current?.close()
    audioContext.current = null
    unsubscribeLive.current?.()
    unsubscribeLive.current = null
    void window.api.live.stop()
    nextAudioTime.current = 0
    changeStatus('idle')
  }

  // eslint-disable-next-line react-hooks/exhaustive-deps -- unmount-only cleanup; stop reads refs, not state
  useEffect(() => () => stop(), [])

  const playAudio = (data: string): void => {
    const context = audioContext.current
    if (!context) return
    const pcm = base64ToInt16(data)
    const buffer = context.createBuffer(1, pcm.length, 24_000)
    const channel = buffer.getChannelData(0)
    for (let index = 0; index < pcm.length; index += 1) channel[index] = pcm[index] / 0x8000
    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(context.destination)
    const startAt = Math.max(context.currentTime + 0.02, nextAudioTime.current)
    source.start(startAt)
    nextAudioTime.current = startAt + buffer.duration
    audioSources.current.add(source)
    source.onended = () => audioSources.current.delete(source)
  }

  const startMicrophone = async (): Promise<void> => {
    try {
      const media = await navigator.mediaDevices.getUserMedia({ audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true } })
      micStream.current = media
      const context = audioContext.current ?? new AudioContext()
      audioContext.current = context
      await context.resume()
      // Same-origin static asset from public/ — a blob: module URL would violate
      // the production CSP (script-src 'self', no worker-src override).
      await context.audioWorklet.addModule(`${import.meta.env.BASE_URL}live-mic-worklet.js`)
      const source = context.createMediaStreamSource(media)
      const worklet = new AudioWorkletNode(context, 'live-mic-capture')
      worklet.port.onmessage = (event: MessageEvent<ArrayBuffer>) => {
        // Muted/closing chunks are dropped renderer-side; screen frames and text keep flowing.
        if (mutedRef.current || closing.current) return
        const data = bytesToBase64(new Uint8Array(event.data))
        window.api.live.send({ audio: { data, mimeType: 'audio/pcm;rate=16000' } })
      }
      // Zero-gain keepalive: the graph must reach the destination to be pulled,
      // but the mic must not monitor through the speakers.
      const mutedOutput = context.createGain()
      mutedOutput.gain.value = 0
      source.connect(worklet)
      worklet.connect(mutedOutput)
      mutedOutput.connect(context.destination)
      micWorklet.current = worklet
    } catch {
      addTranscript('system', 'Microphone unavailable — screen and typed questions are still live.')
    }
  }

  const startFrames = (media: MediaStream): void => {
    const video = document.createElement('video')
    video.srcObject = media
    video.muted = true
    video.playsInline = true
    void video.play()
    const sendFrame = (): void => {
      const target = canvas.current
      if (!target || video.readyState < 2) return
      const aspect = video.videoWidth / Math.max(1, video.videoHeight)
      target.width = 768
      target.height = Math.round(768 / aspect)
      target.getContext('2d')?.drawImage(video, 0, 0, target.width, target.height)
      const data = target.toDataURL('image/jpeg', 0.62).split(',')[1]
      window.api.live.send({ video: { data, mimeType: 'image/jpeg' } })
    }
    frameTimer.current = window.setInterval(sendFrame, 1000)
  }

  const connect = async (): Promise<void> => {
    if (savingTranscript.current) return
    closing.current = false
    setError(null)
    setNotice(null)
    changeStatus('connecting')
    transcriptRef.current = []
    setTranscript([])
    try {
      const media = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 5 }, audio: false })
      screenStream.current = media
      media.getVideoTracks()[0]?.addEventListener('ended', stop, { once: true })
      const context = new AudioContext()
      audioContext.current = context
      await context.resume()
      unsubscribeLive.current = window.api.live.onMessage((event) => {
        if (event.type === 'error') {
          setError(event.message)
          // Once live, errors are transient (dropped chunks, send failures) —
          // don't tear the session UI down for them.
          if (statusRef.current !== 'live' && statusRef.current !== 'reconnecting') changeStatus('error')
          return
        }
        if (event.type === 'reconnecting') {
          changeStatus('reconnecting')
          addTranscript('system', `Connection lost — reconnecting (${event.attempt}/${event.maxAttempts})…`)
          return
        }
        if (event.type === 'closed') {
          if (!closing.current) {
            setError(event.reason || `Gemini Live closed unexpectedly (code ${event.code}).`)
            changeStatus('error')
          }
          return
        }
        if (statusRef.current === 'reconnecting') {
          changeStatus('live')
          addTranscript('system', 'Reconnected.')
        }
        if (statusRef.current === 'live') setError(null)
        const data = event.data as ServerMessage
        const content = data.serverContent
        if (!content) return
        if (content.interrupted) {
          for (const source of audioSources.current) source.stop()
          audioSources.current.clear()
          nextAudioTime.current = 0
        }
        if (content.inputTranscription?.text) addTranscript('you', content.inputTranscription.text)
        if (content.outputTranscription?.text) addTranscript('gemini', content.outputTranscription.text)
        for (const part of content.modelTurn?.parts ?? []) {
          if (part.text) addTranscript('gemini', part.text)
          if (part.inlineData?.data && part.inlineData.mimeType?.startsWith('audio/pcm')) playAudio(part.inlineData.data)
        }
      })
      await window.api.live.start({
        voice: settings.voice,
        model: settings.model,
        systemInstruction: settings.systemInstruction
      })
      changeStatus('live')
      addTranscript('system', 'Connected. Speak naturally or type a question.')
      startFrames(media)
      void startMicrophone()
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Screen sharing was cancelled.')
      changeStatus('error')
    }
  }

  const close = (): void => {
    if (savingTranscript.current) return
    // Standalone window (no onClose prop): close this window instead of unmounting
    // back to a parent that doesn't exist.
    const finish = onClose ?? (() => window.close())
    const entries = transcriptRef.current.filter((entry) => entry.role !== 'system')
    stop()
    if (entries.length === 0) {
      finish()
      return
    }
    // Auto-save the conversation, show where it landed, then unmount.
    savingTranscript.current = true
    setNotice('Saving transcript…')
    window.api.live.saveTranscript({ messages: entries }).then(
      (path) => setNotice(`Transcript saved to ${path}`),
      () => setNotice('Transcript could not be saved.')
    ).finally(() => {
      window.setTimeout(finish, 1500)
    })
  }

  /* ---- handing work between Gemini and the coding agent ------------------ */

  // Reuses the Quick Entry path: `quick.submit` already forwards text to the main
  // window (creating/restoring/focusing it and waiting on load) where it lands in
  // the composer. No new main-process code is needed to reach the agent.
  const sendToChat = (text: string, label: string): void => {
    const trimmed = text.trim()
    if (!trimmed) return
    window.api.quick.submit(trimmed).then(
      () => setNotice(`${label} sent to chat.`),
      (cause: unknown) => setNotice(cause instanceof Error ? cause.message : `${label} could not be sent to chat.`)
    )
  }

  const sendTranscriptToChat = (): void => {
    const entries = transcriptRef.current.filter((entry) => entry.role !== 'system')
    if (entries.length === 0) {
      setNotice('Nothing to send yet.')
      return
    }
    const body = entries
      .map((entry) => `${entry.role === 'gemini' ? 'Gemini' : 'Me'}: ${entry.text}`)
      .join('\n')
    sendToChat(`From my Gemini Live screen session:\n\n${body}`, 'Transcript')
  }

  // The copilot window has no store, but prefs are same-origin localStorage and the
  // fs/git bridge is on window.api — so repo context needs no extra IPC surface.
  const describeProject = (): void => {
    if (statusRef.current !== 'live') return
    const { directory } = loadPrefs()
    if (!directory) {
      setNotice('No project folder is open in the main window.')
      return
    }
    setNotice('Reading project context…')
    void collectProjectContext(window.api, directory).then((text) => {
      window.api.live.send({ text })
      addTranscript('system', 'Sent the current project context to Gemini.')
      setNotice(null)
    })
  }

  const togglePinned = (): void => {
    setPinned((current) => {
      const next = !current
      void window.api.liveWindow.setAlwaysOnTop(next)
      return next
    })
  }

  const sendPrompt = (): void => {
    const text = prompt.trim()
    if (!text || status !== 'live') return
    window.api.live.send({ text })
    addTranscript('you', text)
    setPrompt('')
  }

  const busy = status === 'live' || status === 'connecting' || status === 'reconnecting'

  const switchMode = (next: 'copilot' | 'leroy'): void => {
    if (next === mode) return
    // Leaving copilot mode must release the microphone and screen capture
    // before the sidecar asks the OS for them.
    if (next === 'leroy' && busy) stop()
    setMode(next)
  }

  return <div className="live-screen" role="dialog" aria-modal="true">
    <div className="live-screen__head"><div><span className="live-screen__eyebrow">{settings.model.toUpperCase()} LIVE</span><h1>Screen copilot</h1><p>Share a window, speak naturally, and get live visual help.</p></div><div className="live-screen__head-actions"><button className="live-screen__close" onClick={() => switchMode(mode === 'leroy' ? 'copilot' : 'leroy')} aria-pressed={mode === 'leroy'} title={mode === 'leroy' ? 'Back to the built-in screen copilot' : 'Hand this window to the Leroy agent — local tools with approval prompts'}>{mode === 'leroy' ? 'Copilot' : 'Leroy'}</button><button className="live-screen__close" onClick={togglePinned} aria-pressed={pinned} title={pinned ? 'Unpin from always-on-top' : 'Keep this window on top of others'}>{pinned ? 'Unpin' : 'Pin'}</button><button className="live-screen__close" onClick={() => void window.api.live.revealTranscripts()} title="Open the saved transcripts folder">Transcripts</button><button className="live-screen__close" onClick={() => setSettingsOpen((open) => !open)} aria-expanded={settingsOpen}>Settings</button><button className="live-screen__close" onClick={close}>Close</button></div></div>
    {settingsOpen && mode === 'copilot' && <div className="live-screen__settings">
      <label className="live-screen__field">Voice<select value={settings.voice} onChange={(event) => updateSettings({ voice: event.target.value })}>{LIVE_VOICES.map((voice) => <option key={voice} value={voice}>{voice}</option>)}</select></label>
      <label className="live-screen__field">Model<input value={settings.model} onChange={(event) => updateSettings({ model: event.target.value })} placeholder={DEFAULT_LIVE_PREFS.model} spellCheck={false} /></label>
      <label className="live-screen__field live-screen__field--wide">System prompt<textarea value={settings.systemInstruction} onChange={(event) => updateSettings({ systemInstruction: event.target.value })} rows={3} /></label>
      <p className="live-screen__settings-note">Applied on connect — changes mid-session take effect after a stop and restart.</p>
    </div>}
    {mode === 'leroy' && <div className="live-screen__body live-screen__body--leroy"><LeroyPanel onSendToChat={(text) => sendToChat(text, 'Answer')} /></div>}
    {mode === 'copilot' && <>
    <div className="live-screen__body"><div className="live-screen__preview"><canvas ref={canvas} /><div className="live-screen__preview-label"><span className={`live-screen__dot live-screen__dot--${status}`} />{status === 'live' ? (muted ? 'Screen live — mic muted' : 'Screen + microphone live') : status === 'reconnecting' ? 'Reconnecting…' : status === 'connecting' ? 'Connecting…' : 'Screen preview'}</div></div><div className="live-screen__conversation"><div className="live-screen__messages" aria-live="polite">{transcript.length ? transcript.map((entry) => <p className={`live-screen__message live-screen__message--${entry.role}`} key={entry.id}><strong>{entry.role === 'gemini' ? 'Gemini' : entry.role === 'you' ? 'You' : 'Status'}</strong>{entry.text}{entry.role === 'gemini' && <button type="button" className="live-screen__handoff" onClick={() => sendToChat(entry.text, 'Answer')} title="Send this answer to the OpenCode chat as a prompt">→ Chat</button>}</p>) : <p className="live-screen__muted">Your visual conversation will appear here.</p>}</div><div className="live-screen__controls"><button className={`live-screen__mute${muted ? ' live-screen__mute--on' : ''}`} onClick={toggleMuted} aria-pressed={muted} disabled={status !== 'live'} title={muted ? 'Unmute microphone' : 'Mute microphone'}>{muted ? 'Unmute' : 'Mute'}</button><input value={prompt} onChange={(event) => setPrompt(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter') sendPrompt() }} placeholder="Ask about the screen…" disabled={status !== 'live'} /><button onClick={sendPrompt} disabled={status !== 'live'}>Send</button></div><div className="live-screen__handoffs"><button type="button" className="live-screen__handoff" onClick={describeProject} disabled={status !== 'live'} title="Read the open project's git state and tell Gemini what you are working on">Send project context</button><button type="button" className="live-screen__handoff" onClick={sendTranscriptToChat} title="Send this whole conversation to the OpenCode chat as a prompt">Send transcript → Chat</button></div></div></div>
    <div className="live-screen__foot"><span className="live-screen__provider">Uses the encrypted Google key from Providers</span><button className="live-screen__start" onClick={busy ? stop : () => void connect()}>{status === 'live' || status === 'reconnecting' ? 'Stop sharing' : status === 'connecting' ? 'Cancel' : 'Start screen share'}</button>{error && <span className="live-screen__error">{error}</span>}{notice && <span className="live-screen__notice">{notice}</span>}</div>
    </>}
  </div>
}
