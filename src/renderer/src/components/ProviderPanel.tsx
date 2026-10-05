import { useCallback, useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import type { Provider } from '@opencode-ai/sdk'
import { useStore } from '../lib/store'

/** Shape returned by `window.api.keys.list()` (owned by the keys/preload stream). */
type KeyRow = { providerID: string; envVar: string; maskedTail: string | null }

/** All BYOK-supported first-party and third-party experiences. */
const BYOK_PROVIDER_IDS = new Set([
  'nanogpt',
  'google',
  'groq',
  'mistral',
  'openrouter',
  'moonshot',
  'xai',
  'cerebras'
])

/** Provider id whose models come from a flat-rate subscription catalogue fetched at runtime. */
const NANOGPT = 'nanogpt'

const DOCS: Record<string, string> = {
  nanogpt: 'https://docs.nano-gpt.com/',
  google: 'https://ai.google.dev/gemini-api/docs',
  groq: 'https://console.groq.com/docs/quickstart',
  mistral: 'https://docs.mistral.ai/',
  openrouter: 'https://openrouter.ai/docs',
  moonshot: 'https://platform.moonshot.cn/docs',
  xai: 'https://docs.x.ai/',
  cerebras: 'https://inference-docs.cerebras.ai/'
}

const FALLBACK_DOCS = 'https://opencode.ai/docs/providers/'

/** Built-in floor of key-manageable providers so a key can be added before OpenCode knows the provider. */
const BUILTIN_PROVIDERS: { id: string; name: string }[] = [
  // NanoGPT MUST be listed here: its OpenCode provider block is generated from the cached
  // subscription catalogue, which cannot be fetched until a key exists — so on a fresh install the
  // provider is absent from `providers` and this floor entry is the only way to enter the key.
  { id: NANOGPT, name: 'NanoGPT (subscription)' },
  { id: 'google', name: 'Gemini (including Gemini Live)' },
  { id: 'groq', name: 'Groq' },
  { id: 'mistral', name: 'Mistral AI' },
  { id: 'openrouter', name: 'OpenRouter' },
  { id: 'moonshot', name: 'Moonshot (Kimi)' },
  { id: 'xai', name: 'xAI (Grok)' },
  { id: 'cerebras', name: 'Cerebras' }
]

/** Dispatched by SettingsPanel's "Manage provider keys…" entry point. */
const OPEN_PROVIDERS_EVENT = 'providers:open'

function rankID(id: string): number {
  if (id === NANOGPT) return -2
  if (id === 'google') return -1
  return 0
}

/** "3 minutes ago" style relative label for the catalogue's last-fetch timestamp. */
function relativeTime(epochMs: number): string {
  if (!Number.isFinite(epochMs) || epochMs <= 0) return 'never'
  const seconds = Math.max(0, Math.round((Date.now() - epochMs) / 1000))
  if (seconds < 60) return 'just now'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.round(hours / 24)}d ago`
}

/**
 * NanoGPT-only footer: shows how many subscription models are cached and lets the user re-fetch.
 *
 * A refresh that changes the chat-model SET needs an OpenCode restart, because the generated
 * provider block is only read at spawn time — so the restart is offered right here rather than
 * leaving the user to guess why a new model has not appeared.
 */
function NanogptCatalogRow({ onRestart }: { onRestart: () => Promise<void> }): JSX.Element {
  const [chatCount, setChatCount] = useState<number | null>(null)
  const [imageCount, setImageCount] = useState<number | null>(null)
  const [fetchedAt, setFetchedAt] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback(async () => {
    try {
      const result = await window.api.nanogpt.models()
      setChatCount(result.chat.length)
      setImageCount(result.image.length)
      setFetchedAt(result.fetchedAt)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not read the cached catalogue.')
    }
  }, [])

  useEffect(() => {
    void load()
  }, [load])

  const refresh = useCallback(async () => {
    setBusy(true)
    setError(null)
    try {
      const result = await window.api.nanogpt.refresh()
      setChatCount(result.chatCount)
      setImageCount(result.imageCount)
      setFetchedAt(result.fetchedAt)
      if (result.restartRequired) await onRestart()
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Refresh failed.')
    } finally {
      setBusy(false)
    }
  }, [onRestart])

  const empty = chatCount === 0 || chatCount === null

  const isStale = fetchedAt > 0 && Date.now() - fetchedAt > 6 * 60 * 60 * 1000

  return (
    <div className="providers__key-set">
      <span className="providers__key-masked" style={isStale ? { color: 'var(--warn, #f59e0b)' } : undefined}>
        {empty
          ? 'No subscription models loaded yet'
          : `${chatCount} chat · ${imageCount ?? 0} image models · fetched ${relativeTime(fetchedAt)}${isStale ? ' ⚠️ (>6h old)' : ''}`}
      </span>
      <div className="providers__key-actions">
        <button
          type="button"
          className={
            empty
              ? 'providers__key-btn providers__key-btn--primary'
              : 'providers__key-btn'
          }
          onClick={() => void refresh()}
          disabled={busy}
          title="Fetch the models included in your NanoGPT subscription"
        >
          {busy ? 'Loading…' : empty ? 'Load subscription models' : 'Refresh models'}
        </button>
      </div>
      {error !== null && (
        <p className="providers__key-result providers__key-result--fail">✗ {error}</p>
      )}
    </div>
  )
}

/**
 * A provider counts as live-connected when OpenCode reports a stored key, or when it
 * resolved the provider from the environment / config file (which is exactly how
 * OpenCode reports satisfied `env` vars — the renderer has no process access).
 */
function isConnected(providerID: string, linkedProviderIDs: string[]): boolean {
  return linkedProviderIDs.includes(providerID)
}

type TestOutcome = { ok: boolean; status?: number; detail?: string }

function ProviderKeyCard({
  id,
  name,
  env,
  storeProvider,
  linkedProviderIDs,
  row,
  keyValue,
  saving,
  testing,
  result,
  onKeyChange,
  onSave,
  onRemove,
  onTest,
  footer
}: {
  id: string
  name: string
  env: string[]
  storeProvider?: Provider
  linkedProviderIDs: string[]
  row?: KeyRow
  keyValue: string
  saving: boolean
  testing: boolean
  /** Provider-specific extras rendered under the key controls (NanoGPT catalogue row). */
  footer?: JSX.Element | null
  result?: TestOutcome
  onKeyChange: (value: string) => void
  onSave: () => void
  onRemove: () => void
  onTest: () => void
}): JSX.Element {
  const subscription = id === NANOGPT
  const url = DOCS[id] ?? FALLBACK_DOCS
  const live = isConnected(id, linkedProviderIDs)
  const modelCount = storeProvider ? Object.keys(storeProvider.models).length : 0
  const envVar = row?.envVar ?? env[0]

  return (
    <div className={live ? 'providers__card providers__card--on' : 'providers__card'}>
      <div className="providers__row">
        <button
          type="button"
          className="providers__name"
          title={`Open ${name} docs — ${url}`}
          onClick={() => void window.api.openExternal(url)}
        >
          {name} <span className="providers__ext">↗</span>
        </button>
        <span className="providers__tags">
          {subscription && <span className="providers__tag providers__tag--free">subscription</span>}
          {live && <span className="providers__tag providers__tag--ok">connected</span>}
          {!live && row && (
            <span className="providers__tag providers__key-tag--pending">key saved · restart to apply</span>
          )}
        </span>
      </div>

      <div className="providers__meta">
        {storeProvider && (
          <span>
            {modelCount} model{modelCount === 1 ? '' : 's'}
          </span>
        )}
        {envVar && <span className="providers__envvar">{envVar}</span>}
      </div>

      <div className="providers__key-manage">
        {row ? (
          <>
            <div className="providers__key-set">
              <span className="providers__key-masked">
                Key set {row.maskedTail ? `••••${row.maskedTail}` : '••••'}
              </span>
              <div className="providers__key-actions">
                <button type="button" className="providers__key-btn" onClick={onTest} disabled={testing}>
                  {testing ? 'Testing…' : 'Test'}
                </button>
                <button
                  type="button"
                  className="providers__key-btn providers__key-btn--danger"
                  onClick={onRemove}
                >
                  Remove
                </button>
              </div>
            </div>
            {result && (
              <p
                className={
                  result.ok
                    ? 'providers__key-result providers__key-result--ok'
                    : 'providers__key-result providers__key-result--fail'
                }
              >
                {result.ok
                  ? '✓ Connection OK'
                  : `✗ ${result.status ? `HTTP ${result.status} — ` : ''}${result.detail ?? 'Test failed'}`}
              </p>
            )}
          </>
        ) : (
          <div className="providers__key-form">
            <input
              type="password"
              className="providers__key-input"
              placeholder={`Paste ${name} API key`}
              value={keyValue}
              autoComplete="off"
              spellCheck={false}
              onChange={(e) => onKeyChange(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && keyValue.trim().length > 0 && !saving) onSave()
              }}
            />
            <button
              type="button"
              className="providers__key-btn providers__key-btn--primary"
              onClick={onSave}
              disabled={saving || keyValue.trim().length === 0}
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
          </div>
        )}
        {footer ?? null}
      </div>
    </div>
  )
}

export function ProviderPanel({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const providers = useStore((s) => s.providers)
  const linkedProviderIDs = useStore((s) => s.linkedProviderIDs)

  // Lets SettingsPanel open this panel even when it isn't the component that owns the
  // controlling `open` prop (ProviderPanel is currently mounted/controlled by Sidebar).
  const [eventOpen, setEventOpen] = useState(false)
  const visible = open || eventOpen

  useEffect(() => {
    function handler(): void {
      setEventOpen(true)
    }
    window.addEventListener(OPEN_PROVIDERS_EVENT, handler)
    return () => window.removeEventListener(OPEN_PROVIDERS_EVENT, handler)
  }, [])

  const handleClose = useCallback(() => {
    setEventOpen(false)
    onClose()
  }, [onClose])

  const [rows, setRows] = useState<KeyRow[]>([])
  const [loadingRows, setLoadingRows] = useState(false)
  const [needsRestart, setNeedsRestart] = useState(false)
  const [restarting, setRestarting] = useState(false)
  const [keyInputs, setKeyInputs] = useState<Record<string, string>>({})
  const [savingID, setSavingID] = useState<string | null>(null)
  const [testingID, setTestingID] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestOutcome>>({})

  const refreshRows = useCallback(async () => {
    setLoadingRows(true)
    try {
      const list = await window.api.keys.list()
      setRows(list)
    } finally {
      setLoadingRows(false)
    }
  }, [])

  useEffect(() => {
    if (visible) void refreshRows()
  }, [visible, refreshRows])

  const manageable = useMemo(() => {
    const map = new Map<string, { id: string; name: string; env: string[]; storeProvider?: Provider }>()
    for (const b of BUILTIN_PROVIDERS) {
      map.set(b.id, { id: b.id, name: b.name, env: [] })
    }
    for (const p of providers) {
      if (!BYOK_PROVIDER_IDS.has(p.id)) continue
      map.set(p.id, { id: p.id, name: p.name, env: p.env, storeProvider: p })
    }
    return [...map.values()].sort((a, b) => {
      const d = rankID(a.id) - rankID(b.id)
      return d !== 0 ? d : a.name.localeCompare(b.name)
    })
  }, [providers])

  const rowsByID = useMemo(() => {
    const m = new Map<string, KeyRow>()
    for (const r of rows) m.set(r.providerID, r)
    return m
  }, [rows])

  const handleSave = useCallback(
    async (providerID: string) => {
      const key = (keyInputs[providerID] ?? '').trim()
      if (!key) return
      setSavingID(providerID)
      try {
        await window.api.keys.set({ providerID, key })
        setKeyInputs((s) => {
          const next = { ...s }
          delete next[providerID]
          return next
        })
        setTestResults((s) => {
          const next = { ...s }
          delete next[providerID]
          return next
        })
        await refreshRows()
        // NanoGPT's provider block is generated from the cached subscription catalogue at spawn, so
        // the catalogue has to be fetched BEFORE the restart below — otherwise the first restart
        // injects an empty model map and the provider appears connected but has no models.
        //
        // A failure here is non-fatal (the key is stored and the card's "Load subscription models"
        // button stays available), but it must not be silent: without a reported reason the user
        // just sees a connected provider with zero models. Report it through the same result slot
        // the Test button uses.
        if (providerID === NANOGPT) {
          try {
            await window.api.nanogpt.refresh()
          } catch (e) {
            setTestResults((s) => ({
              ...s,
              [providerID]: {
                ok: false,
                detail: `Key saved, but loading subscription models failed: ${
                  e instanceof Error ? e.message : 'unknown error'
                }`
              }
            }))
          }
        }
        // The OpenCode child receives BYOK credentials only at spawn.  Restart
        // it here so a valid key is usable immediately rather than leaving the
        // provider appearing saved-but-disconnected until the user notices a
        // separate banner and restarts manually.
        setRestarting(true)
        try {
          await window.api.restart()
          setNeedsRestart(false)
        } finally {
          setRestarting(false)
        }
      } catch (e) {
        setTestResults((s) => ({
          ...s,
          [providerID]: { ok: false, detail: e instanceof Error ? e.message : 'Failed to save key' }
        }))
      } finally {
        setSavingID(null)
      }
    },
    [keyInputs, refreshRows]
  )

  const handleRemove = useCallback(
    async (providerID: string) => {
      setTestResults((s) => {
        const next = { ...s }
        delete next[providerID]
        return next
      })
      try {
        await window.api.keys.remove(providerID)
        setRestarting(true)
        try {
          await window.api.restart()
          setNeedsRestart(false)
        } finally {
          setRestarting(false)
        }
      } finally {
        await refreshRows()
      }
    },
    [refreshRows]
  )

  const handleTest = useCallback(async (providerID: string) => {
    setTestingID(providerID)
    try {
      const result = await window.api.keys.test(providerID)
      setTestResults((s) => ({ ...s, [providerID]: result }))
    } catch (e) {
      setTestResults((s) => ({
        ...s,
        [providerID]: { ok: false, detail: e instanceof Error ? e.message : 'Test failed' }
      }))
    } finally {
      setTestingID(null)
      window.setTimeout(() => {
        setTestResults((s) => {
          const next = { ...s }
          delete next[providerID]
          return next
        })
      }, 5000)
    }
  }, [])

  const handleRestart = useCallback(async () => {
    setRestarting(true)
    try {
      await window.api.restart()
      setNeedsRestart(false)
    } finally {
      setRestarting(false)
    }
  }, [])

  if (!visible) return null

  return (
    <div
      className="providers"
      role="dialog"
      aria-modal="true"
      aria-label="Provider keys"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) handleClose()
      }}
    >
      <div className="providers__panel">
        <div className="providers__head">
          <span className="providers__title">Provider Keys</span>
          <button type="button" className="providers__close" onClick={handleClose} aria-label="Close provider keys (Esc)" title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="providers__body">
          {needsRestart && (
            <div className="providers__key-restart-banner">
              <span>Changes require a restart to apply.</span>
              <button
                type="button"
                className="providers__key-restart-btn"
                onClick={() => void handleRestart()}
                disabled={restarting}
              >
                {restarting ? 'Restarting…' : 'Restart now'}
              </button>
            </div>
          )}

          <p className="providers__note providers__key-intro">
            Add API keys for NanoGPT, Gemini, Groq, Mistral, OpenRouter, Moonshot, xAI, or Cerebras.
            Keys are encrypted by the app and this panel only ever displays masked tails.
          </p>

          <section>
            <h2 className="providers__group-title">
              Providers <span className="providers__count">{manageable.length}</span>
            </h2>
            <div className="providers__cards">
              {loadingRows && rows.length === 0 ? (
                <p className="providers__empty">Loading keys…</p>
              ) : (
                manageable.map((entry) => (
                  <ProviderKeyCard
                    key={entry.id}
                    id={entry.id}
                    name={entry.name}
                    env={entry.env}
                    storeProvider={entry.storeProvider}
                    linkedProviderIDs={linkedProviderIDs}
                    row={rowsByID.get(entry.id)}
                    keyValue={keyInputs[entry.id] ?? ''}
                    saving={savingID === entry.id}
                    testing={testingID === entry.id}
                    result={testResults[entry.id]}
                    onKeyChange={(value) =>
                      setKeyInputs((s) => ({ ...s, [entry.id]: value }))
                    }
                    onSave={() => void handleSave(entry.id)}
                    onRemove={() => void handleRemove(entry.id)}
                    onTest={() => void handleTest(entry.id)}
                    footer={
                      entry.id === NANOGPT && rowsByID.has(NANOGPT) ? (
                        <NanogptCatalogRow onRestart={handleRestart} />
                      ) : null
                    }
                  />
                ))
              )}
            </div>
          </section>

        </div>
      </div>
    </div>
  )
}
