import { useCallback, useEffect, useState } from 'react'
import type { JSX } from 'react'
import type { CrashLogReport, NanoUsage, PermissionConfig, UpdateStatus } from '../lib/types'
import { WEEKLY_INPUT_TOKEN_CAP } from '../lib/types'
import { useStore, errText } from '../lib/store'
import { FREE_ROUTING_CANDIDATES } from '../lib/rotation'
import { formatTokens, relativeTime } from '../lib/format'
import { PERMISSION_PRESETS, summarizePermission, type PermissionPreset } from '../lib/permissionPresets'
import { TIPS, loadTipsPrefs, saveTipsPrefs, setTipsEnabled, resetTips, unacknowledgedTipCount, type TipsPrefs } from '../lib/tips'
import { McpPanel } from './McpPanel'
import { RoutingPanel } from './RoutingPanel'

/** Listened for by ProviderPanel (mounted separately, in Sidebar) to open itself. */
const OPEN_PROVIDERS_EVENT = 'providers:open'

/** NanoGPT usage reset timestamps arrive as epoch — seconds or ms depending on the endpoint. */
function toEpochMs(epoch: number): number {
  return epoch < 1e12 ? epoch * 1000 : epoch
}

/** Render a bucket field honestly: a missing number is `—`, never `NaN`, `undefined`, or a blank that reads as zero. */
function formatUsageNumber(n: number | undefined): string {
  return n === undefined ? '—' : formatTokens(n)
}

function formatUsagePercent(n: number | undefined): string {
  return n === undefined ? '—' : `${Math.round(n)}%`
}

/** Subscription quota readout and token accumulator progress. */
function NanoUsageCard(): JSX.Element {
  const usage = useStore((s) => s.nanoUsage)
  const balance = useStore((s) => s.nanoBalance)
  const weeklyUsage = useStore((s) => s.nanoWeeklyUsage)
  const showBalanceInStatus = useStore((s) => s.showBalanceInStatus)
  const setShowBalanceInStatus = useStore((s) => s.setShowBalanceInStatus)
  const fetchNanoQuota = useStore((s) => s.fetchNanoQuota)

  const [loading, setLoading] = useState(false)

  const handleRefresh = async () => {
    setLoading(true)
    try {
      await fetchNanoQuota()
    } finally {
      setLoading(false)
    }
  }

  // A bucket that's `null` means "no such quota" — an honest, known fact, distinct from a
  // missing/malformed bucket (`undefined`), which is genuinely unknown and falls through to the
  // `—` handling in formatUsageNumber/formatUsagePercent.
  const bucket = (
    label: string,
    b: NanoUsage['dailyInputTokens'],
    limit: number | null | undefined
  ): JSX.Element => (
    <div className="providers__nano-bucket">
      <span className="providers__nano-bucket-label">{label}</span>
      {b === null && limit === null ? (
        <span className="providers__nano-bucket-value">No cap</span>
      ) : b == null ? (
        <span className="providers__nano-bucket-value">—</span>
      ) : (
        <>
          <span className="providers__nano-bucket-value">
            {formatUsageNumber(b.used)} used · {formatUsageNumber(b.remaining)} left · {formatUsagePercent(b.percentUsed)}
          </span>
          <span className="providers__nano-bucket-reset">
            resets {b.resetAt === undefined ? '—' : relativeTime(toEpochMs(b.resetAt))}
          </span>
        </>
      )}
    </div>
  )

  // Contract T3: the documented cap is 60M INPUT tokens/week, not total — the gauge must compare
  // inputTokens, never totalTokens.
  const weeklyPct = weeklyUsage
    ? Math.min(100, Math.round((weeklyUsage.inputTokens / WEEKLY_INPUT_TOKEN_CAP) * 100))
    : 0
  const gaugeFillClass =
    weeklyPct >= 95
      ? 'providers__nano-gauge-fill providers__nano-gauge-fill--danger'
      : weeklyPct >= 80
        ? 'providers__nano-gauge-fill providers__nano-gauge-fill--warn'
        : 'providers__nano-gauge-fill'

  return (
    <div className="providers__nano">
      <div className="providers__nano-head">
        <span className="providers__name providers__name--sm">Subscription quota & Weekly Usage</span>
        <button
          type="button"
          className="providers__key-btn"
          disabled={loading}
          onClick={handleRefresh}
        >
          {loading ? 'Loading…' : 'Refresh'}
        </button>
      </div>

      {usage !== null ? (
        <>
          <div className="providers__nano-buckets">
            {bucket('Daily input tokens', usage.dailyInputTokens, usage.limits.dailyInputTokens)}
            {bucket('Weekly input tokens', usage.weeklyInputTokens, usage.limits.weeklyInputTokens)}
            {bucket('Daily images', usage.dailyImages, usage.limits.dailyImages)}
          </div>
          {usage.period?.currentPeriodEnd !== undefined ? (
            <p className="providers__nano-period">
              Period ends {relativeTime(Date.parse(usage.period.currentPeriodEnd))}
            </p>
          ) : null}
        </>
      ) : (
        <p className="providers__nano-empty">No NanoGPT subscription data loaded yet.</p>
      )}

      {weeklyUsage && (
        <div className="providers__nano-gauge">
          <div className="providers__nano-gauge-row">
            <span>Weekly Input-Token Budget ({weeklyUsage.weekKey})</span>
            <span>
              {formatTokens(weeklyUsage.inputTokens)} / {formatTokens(WEEKLY_INPUT_TOKEN_CAP)} ({weeklyPct}%)
            </span>
          </div>
          <div className="providers__nano-gauge-track">
            <div className={gaugeFillClass} style={{ width: `${weeklyPct}%` }} />
          </div>
          <div className="providers__nano-gauge-row">
            <span>Output tokens this week (not counted against the cap)</span>
            <span>{formatTokens(weeklyUsage.outputTokens)}</span>
          </div>
        </div>
      )}

      {balance && (
        <div className="providers__nano-balance">
          <span>Pay-per-prompt balance: <strong>${balance.usd.toFixed(2)}</strong></span>
          <label className="providers__nano-balance-toggle">
            <input
              type="checkbox"
              checked={showBalanceInStatus}
              onChange={(e) => setShowBalanceInStatus(e.target.checked)}
            />
            <span>Show in status bar</span>
          </label>
        </div>
      )}
    </div>
  )
}

/** Project permission presets — edits the `permission` key of the project's opencode.json. */
function PermissionsCard(): JSX.Element {
  const directory = useStore((s) => s.directory)
  const [current, setCurrent] = useState<PermissionConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [applying, setApplying] = useState<string | null>(null)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = useCallback((): void => {
    if (!directory) return
    setLoading(true)
    window.api.config
      .getPermission(directory)
      .then((permission) => {
        setCurrent(permission)
        setError(null)
      })
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setLoading(false))
  }, [directory])

  useEffect(() => {
    load()
  }, [load])

  const apply = (preset: PermissionPreset): void => {
    if (!directory || applying !== null) return
    setApplying(preset.id)
    setNote(null)
    setError(null)
    window.api.config
      .setPermission({ directory, permission: preset.permission })
      .then((restarted) => {
        setNote(
          restarted
            ? 'Saved to opencode.json — the server is restarting to pick it up.'
            : `"${preset.label}" applied.`
        )
        load()
      })
      .catch((e: unknown) => setError(errText(e)))
      .finally(() => setApplying(null))
  }

  if (!directory) {
    return (
      <p style={{ fontSize: '12px', color: 'var(--fg-dim)', margin: 0 }}>
        Open a project folder to edit its permission config.
      </p>
    )
  }

  return (
    <div>
      <p style={{ fontSize: '11.5px', color: 'var(--fg-dim)', marginTop: 0, marginBottom: '8px' }}>
        Writes the <code>permission</code> key of this project&apos;s <code>opencode.json</code>.
      </p>
      <div style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
        {PERMISSION_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            className="providers__key-btn"
            disabled={applying !== null}
            title={preset.description}
            onClick={() => apply(preset)}
            style={{ flex: 1 }}
          >
            {applying === preset.id ? 'Applying…' : preset.label}
          </button>
        ))}
      </div>
      <div style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '3px' }}>
        <span style={{ fontWeight: 600, fontSize: '11.5px' }}>
          Current effective values{loading ? ' (refreshing…)' : ''}
        </span>
        {current === null && !loading && error === null ? (
          <span style={{ color: 'var(--fg-dim)' }}>Not loaded yet.</span>
        ) : (
          summarizePermission(current).map(({ key, value }) => (
            <span key={key} style={{ fontFamily: 'var(--mono)', fontSize: '11px', color: 'var(--fg-dim)' }}>
              {key}: <span style={{ color: 'var(--fg)' }}>{value}</span>
            </span>
          ))
        )}
      </div>
      {note !== null && (
        <p role="status" style={{ fontSize: '11.5px', color: 'var(--ok)', marginBottom: 0 }}>{note}</p>
      )}
      {error !== null && (
        <p role="alert" style={{ fontSize: '11.5px', color: 'var(--danger)', marginBottom: 0 }}>{error}</p>
      )}
    </div>
  )
}

/** Human-readable byte size for the crash-log readout. */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
}

/** Crash-log readout. Fetches once on mount and on manual refresh — never polled. */
function CrashLogCard(): JSX.Element {
  const [report, setReport] = useState<CrashLogReport | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState(false)

  const load = useCallback((): void => {
    setLoading(true)
    setError(null)
    window.api.crashLog
      .read()
      .then((result) => setReport(result))
      .catch((e: unknown) => {
        setReport(null)
        setError(errText(e))
      })
      .finally(() => setLoading(false))
  }, [])

  useEffect(() => {
    load()
  }, [load])

  const hasEntries = report !== null && report.tail.trim().length > 0

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span className="providers__name" style={{ fontSize: '12px' }}>Crash log</span>
        <div style={{ display: 'flex', gap: '6px' }}>
          <button type="button" className="providers__key-btn" disabled={loading} onClick={load}>
            {loading ? 'Loading…' : 'Refresh'}
          </button>
          <button
            type="button"
            className="providers__key-btn"
            disabled={report === null || !report.exists}
            onClick={() => {
              void window.api.crashLog.reveal()
            }}
          >
            Reveal in folder
          </button>
        </div>
      </div>
      {loading && report === null ? (
        <p style={{ fontSize: '12px', color: 'var(--fg-dim)', margin: 0 }}>Loading crash log…</p>
      ) : error !== null ? (
        <p role="alert" style={{ fontSize: '12px', color: 'var(--danger)', margin: 0 }}>{error}</p>
      ) : report !== null && !hasEntries ? (
        <p style={{ fontSize: '12px', color: 'var(--fg-dim)', margin: 0 }}>No crashes recorded.</p>
      ) : report !== null ? (
        <div style={{ fontSize: '12px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
          <span style={{ color: 'var(--fg-dim)' }}>
            {report.entryCount} {report.entryCount === 1 ? 'entry' : 'entries'}
            {report.truncated ? ' (most recent)' : ''} · {formatBytes(report.sizeBytes)}
            {report.hasOld ? ' · an older rotated log also exists' : ''}
          </span>
          <span
            style={{
              fontFamily: 'var(--mono)',
              fontSize: '11px',
              color: 'var(--fg-dim)',
              wordBreak: 'break-all'
            }}
          >
            {report.path}
          </span>
          <button
            type="button"
            className="providers__key-btn"
            style={{ alignSelf: 'flex-start' }}
            aria-expanded={expanded}
            onClick={() => setExpanded((current) => !current)}
          >
            {expanded ? 'Hide recent entries' : 'Show recent entries'}
          </button>
          {expanded && (
            <pre
              style={{
                margin: 0,
                padding: '8px',
                maxHeight: '260px',
                overflow: 'auto',
                background: 'var(--bg-sunken)',
                border: '1px solid var(--border)',
                borderRadius: 'var(--radius)',
                fontFamily: 'var(--mono)',
                fontSize: '11px',
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word'
              }}
            >
              {report.tail.trim()}
            </pre>
          )}
        </div>
      ) : null}
    </div>
  )
}

function updateStatusText(status: UpdateStatus): string {
  switch (status.state) {
    case 'idle':
      return 'Updates are checked automatically.'
    case 'checking':
      return 'Checking for updates...'
    case 'not-available':
      return 'OpenCode Desktop is up to date.'
    case 'available':
      return `Version ${status.version} is available.`
    case 'progress':
      return `Downloading update... ${Math.round(status.percent)}%`
    case 'downloaded':
      return 'Update downloaded. You will be asked before the app restarts.'
    case 'error':
      return `Update check failed: ${status.message}`
  }
}

export function SettingsPanel({ open, onClose }: { open: boolean; onClose: () => void }): JSX.Element | null {
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const routingMode = useStore((s) => s.routingMode)
  const setRoutingMode = useStore((s) => s.setRoutingMode)
  const showPaidModels = useStore((s) => s.showPaidModels)
  const setShowPaidModels = useStore((s) => s.setShowPaidModels)
  const modelPool = useStore((s) => s.modelPool)
  const setModelPool = useStore((s) => s.setModelPool)
  const providers = useStore((s) => s.providers)
  const server = useStore((s) => s.server)
  const appSettings = useStore((s) => s.appSettings)
  const shortcutRegistered = useStore((s) => s.shortcutRegistered)
  const shortcutError = useStore((s) => s.shortcutError)
  const updateStatus = useStore((s) => s.updateStatus)
  const updateAppSettings = useStore((s) => s.updateAppSettings)
  const [shortcutDraft, setShortcutDraft] = useState(appSettings.globalShortcut)
  const [applyingShortcut, setApplyingShortcut] = useState(false)
  // Tips prefs are renderer-local localStorage state, not main-process appSettings
  const [tipsPrefs, setTipsPrefs] = useState<TipsPrefs>(() => loadTipsPrefs())

  useEffect(() => {
    setShortcutDraft(appSettings.globalShortcut)
  }, [appSettings.globalShortcut])

  const applyShortcut = (): void => {
    const globalShortcut = shortcutDraft.trim()
    if (applyingShortcut || globalShortcut.length === 0) return
    setApplyingShortcut(true)
    void updateAppSettings({ globalShortcut }).finally(() => {
      setApplyingShortcut(false)
    })
  }

  const applyTipsPrefs = (next: TipsPrefs): void => {
    saveTipsPrefs(next)
    setTipsPrefs(next)
  }

  if (!open) return null

  const candidateKeys = FREE_ROUTING_CANDIDATES.map((c) => `${c.providerID}/${c.modelID}`)
  const activePoolKeys = new Set(modelPool ?? candidateKeys)

  const togglePoolCandidate = (key: string): void => {
    let next: string[]
    if (activePoolKeys.has(key)) {
      next = candidateKeys.filter((k) => k !== key && activePoolKeys.has(k))
    } else {
      next = [...Array.from(activePoolKeys), key]
    }
    // If all candidates are selected, revert to default null pool
    if (next.length === candidateKeys.length && candidateKeys.every((k) => next.includes(k))) {
      setModelPool(null)
    } else {
      setModelPool(next)
    }
  }

  return (
    <div
      className="providers"
      role="dialog"
      aria-modal="true"
      aria-label="Settings"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="providers__panel">
        <div className="providers__head">
          <span className="providers__title">Settings</span>
          <button type="button" className="providers__close" onClick={onClose} aria-label="Close settings (Esc)" title="Close (Esc)">
            ×
          </button>
        </div>

        <div className="providers__body">
          <section>
            <h2 className="providers__group-title">Appearance</h2>
            <div className="providers__card">
              <div className="providers__row">
                <span className="providers__name">Theme</span>
              </div>
              <div style={{ display: 'flex', gap: '12px', marginTop: '8px' }}>
                {(['auto', 'dark', 'light'] as const).map((t) => (
                  <label key={t} style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="theme"
                      checked={theme === t}
                      onChange={() => setTheme(t)}
                    />
                    {t.charAt(0).toUpperCase() + t.slice(1)}
                  </label>
                ))}
              </div>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">NanoGPT Images</h2>
            <div className="providers__card">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={appSettings.nanogptSubscriptionOnly}
                  onChange={(event) => {
                    void updateAppSettings({ nanogptSubscriptionOnly: event.target.checked })
                  }}
                />
                Subscription images only
              </label>
              <p style={{ fontSize: '11.5px', color: 'var(--fg-dim)', margin: '6px 0 0' }}>
                NanoGPT does not publish which image models its subscription covers, so a model&apos;s
                billing is only known once it has generated: the response reports a
                {' '}<code>paymentSource</code>. With this on, any model found to bill your
                pay-as-you-go balance is refused from then on. The first generation on an
                untested model is what reveals it.
              </p>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">NanoGPT Usage</h2>
            <div className="providers__card">
              <NanoUsageCard />
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Tips</h2>
            <div className="providers__card">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={tipsPrefs.enabled}
                  onChange={(event) => applyTipsPrefs(setTipsEnabled(tipsPrefs, event.target.checked))}
                />
                Show new-user tips
              </label>
              <p style={{ fontSize: '11.5px', color: 'var(--fg-dim)', margin: '4px 0 8px' }}>
                Tips appear one at a time above the chat and disappear once acknowledged.
              </p>
              <button
                type="button"
                className="providers__key-btn"
                onClick={() => applyTipsPrefs(resetTips(tipsPrefs))}
              >
                Show all tips again
              </button>
              <p style={{ fontSize: '11.5px', color: 'var(--fg-dim)', margin: '6px 0 0' }}>
                {unacknowledgedTipCount(tipsPrefs)} of {TIPS.length} tips not yet seen
              </p>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Desktop Integration</h2>
            <div className="providers__card">
              <label style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px', cursor: 'pointer' }}>
                <input
                  type="checkbox"
                  checked={appSettings.closeToTray}
                  onChange={(event) => {
                    void updateAppSettings({ closeToTray: event.target.checked })
                  }}
                />
                Keep OpenCode Desktop running in the tray when its window closes
              </label>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px', marginTop: '4px' }}>
                <label htmlFor="global-shortcut" className="providers__name">
                  Quick Entry shortcut
                </label>
                <p style={{ fontSize: '11.5px', color: 'var(--fg-dim)', margin: '4px 0 8px' }}>
                  Use an Electron accelerator such as Ctrl+Alt+Space.
                </p>
                <div className="providers__row">
                  <input
                    id="global-shortcut"
                    className="providers__key-input"
                    value={shortcutDraft}
                    onChange={(event) => setShortcutDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter') {
                        event.preventDefault()
                        applyShortcut()
                      }
                    }}
                    aria-invalid={shortcutError !== null}
                    aria-describedby="global-shortcut-status"
                    spellCheck={false}
                    autoComplete="off"
                  />
                  <button
                    type="button"
                    className="providers__key-btn providers__key-btn--primary"
                    disabled={applyingShortcut || shortcutDraft.trim().length === 0}
                    onClick={applyShortcut}
                  >
                    {applyingShortcut ? 'Applying...' : 'Apply'}
                  </button>
                </div>
                {shortcutError ? (
                  <p id="global-shortcut-status" role="alert" style={{ marginTop: '7px', fontSize: '11.5px', color: 'var(--danger)' }}>
                    Shortcut conflict: {shortcutError}
                  </p>
                ) : (
                  <p id="global-shortcut-status" style={{ marginTop: '7px', fontSize: '11.5px', color: shortcutRegistered ? 'var(--ok)' : 'var(--fg-dim)' }}>
                    {shortcutRegistered ? 'Shortcut registered.' : 'Shortcut is not currently registered.'}
                  </p>
                )}
              </div>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Updates</h2>
            <div
              className="providers__card"
              role="status"
              aria-live="polite"
              style={updateStatus.state === 'error' ? { borderColor: 'var(--danger)' } : undefined}
            >
              <span style={{ color: updateStatus.state === 'error' ? 'var(--danger)' : 'var(--fg)' }}>
                {updateStatusText(updateStatus)}
              </span>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Model Preferences & Smart Routing</h2>
            <div className="providers__card">
              <div className="providers__row">
                <span className="providers__name">Routing Mode</span>
              </div>
              <p style={{ fontSize: '11.5px', color: 'var(--fg-dim)', marginTop: '4px', marginBottom: '8px' }}>
                How OpenCode Desktop chooses which model runs each turn.
              </p>
              <div role="radiogroup" aria-label="Routing mode" style={{ display: 'flex', gap: '6px', marginBottom: '10px' }}>
                {(['locked', 'failover', 'auto'] as const).map((mode) => (
                  <button
                    key={mode}
                    type="button"
                    role="radio"
                    aria-checked={routingMode === mode}
                    onClick={() => setRoutingMode(mode)}
                    style={{
                      flex: 1,
                      padding: '6px 10px',
                      fontSize: '12px',
                      cursor: 'pointer',
                      background: routingMode === mode ? 'var(--accent)' : 'transparent',
                      color: routingMode === mode ? 'var(--bg)' : 'var(--fg)',
                      border: '1px solid var(--border)',
                      borderRadius: '4px',
                      fontWeight: routingMode === mode ? 600 : 400,
                    }}
                    title={
                      mode === 'locked' ? 'Never change model. Surface errors only.'
                      : mode === 'failover' ? 'Use your model. Swap only on 429/timeout. (Recommended)'
                      : 'Proactively pick best healthy model each send. (Legacy)'
                    }
                  >
                    {mode === 'locked' ? '🔒 Locked' : mode === 'failover' ? '⚡ Failover' : '🎯 Auto'}
                  </button>
                ))}
              </div>
              <p style={{ fontSize: '11px', color: 'var(--fg-dim)', marginBottom: '12px' }}>
                {routingMode === 'locked' && 'Your chosen model runs every turn. Errors surface immediately.'}
                {routingMode === 'failover' && 'Your chosen model stays pinned. On 429 or stall, auto-fails over to a healthy free model — your chosen pin is never overwritten.'}
                {routingMode === 'auto' && 'Legacy: pre-selects the healthiest model on every send. May override your pick for this session.'}
              </p>

              <label style={{ display: 'flex', alignItems: 'center', gap: '6px', fontSize: '13px', cursor: 'pointer', marginBottom: '10px' }}>
                <input
                  type="checkbox"
                  checked={showPaidModels}
                  onChange={(e) => setShowPaidModels(e.target.checked)}
                />
                Show paid models in picker
              </label>
              <p style={{ fontSize: '11px', color: 'var(--fg-dim)', marginTop: '-6px', marginBottom: '12px' }}>
                Paid models still require manual selection — auto-failover never routes to a paid model.
              </p>

              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '10px', marginBottom: '10px' }}>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                  <span>TTFT (ms) — time to first token</span>
                  <input
                    type="number"
                    min={5000}
                    step={1000}
                    value={appSettings.ttftMs}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (Number.isFinite(v) && v >= 5000) void updateAppSettings({ ttftMs: v })
                    }}
                    style={{ padding: '4px 6px', fontSize: '12px' }}
                  />
                </label>
                <label style={{ display: 'flex', flexDirection: 'column', gap: '4px', fontSize: '12px' }}>
                  <span>Stall (ms) — max gap between parts</span>
                  <input
                    type="number"
                    min={10000}
                    step={5000}
                    value={appSettings.stallMs}
                    onChange={(e) => {
                      const v = parseInt(e.target.value, 10)
                      if (Number.isFinite(v) && v >= 10000) void updateAppSettings({ stallMs: v })
                    }}
                    style={{ padding: '4px 6px', fontSize: '12px' }}
                  />
                </label>
              </div>

              <div style={{ borderTop: '1px solid var(--border)', paddingTop: '10px', marginTop: '10px' }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '6px' }}>
                  <span className="providers__name" style={{ fontSize: '12px' }}>Candidate Model Pool</span>
                  {modelPool !== null && (
                    <button
                      type="button"
                      style={{ background: 'none', border: 'none', color: 'var(--accent)', fontSize: '11px', cursor: 'pointer', padding: 0 }}
                      onClick={() => setModelPool(null)}
                    >
                      Reset to Default
                    </button>
                  )}
                </div>
                <p style={{ fontSize: '11px', color: 'var(--fg-dim)', marginBottom: '8px' }}>
                  Select candidate models allowed in the rotation pool:
                </p>
                <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', maxHeight: '180px', overflowY: 'auto' }}>
                  {FREE_ROUTING_CANDIDATES.map(({ providerID, modelID }) => {
                    const key = `${providerID}/${modelID}`
                    const isChecked = activePoolKeys.has(key)
                    const provider = providers.find((p) => p.id === providerID)
                    const modelObj = provider?.models?.[modelID]
                    const label = provider ? `${provider.name} · ${modelObj?.name ?? modelID}` : key

                    return (
                      <label key={key} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '12px', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => togglePoolCandidate(key)}
                        />
                        <span>{label}</span>
                        {!provider && <span style={{ fontSize: '10px', color: 'var(--fg-dim)', fontStyle: 'italic' }}>(provider offline)</span>}
                      </label>
                    )
                  })}
                </div>
              </div>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Live Model Health</h2>
            <div className="providers__card">
              <RoutingPanel />
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Provider Keys</h2>
            <div className="providers__card">
              <div className="providers__row">
                <span className="providers__name">API Keys (BYOK)</span>
              </div>
              <p style={{ fontSize: '11.5px', color: 'var(--fg-dim)', marginTop: '4px', marginBottom: '8px' }}>
                Add, test, or remove your NanoGPT subscription or Gemini key.
              </p>
              <button
                type="button"
                className="providers__key-btn providers__key-btn--primary"
                onClick={() => window.dispatchEvent(new CustomEvent(OPEN_PROVIDERS_EVENT))}
              >
                Manage provider keys…
              </button>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">MCP Connectors</h2>
            <div className="providers__card">
              <McpPanel />
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Permissions</h2>
            <div className="providers__card">
              <PermissionsCard />
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Server Info</h2>
            <div className="providers__card">
              <div style={{ fontSize: '13px', display: 'flex', flexDirection: 'column', gap: '6px' }}>
                <div><strong>Status:</strong> {server.running ? 'Running' : 'Offline'}</div>
                <div><strong>URL:</strong> {server.url || 'N/A'}</div>
                {server.error && <div><strong>Error:</strong> {server.error}</div>}
              </div>
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Crash Log</h2>
            <div className="providers__card">
              <CrashLogCard />
            </div>
          </section>

          <section>
            <h2 className="providers__group-title">Shortcuts</h2>
            <div className="providers__card">
              <table style={{ width: '100%', fontSize: '13px', borderCollapse: 'collapse' }}>
                <tbody>
                  <tr>
                    <td style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>New Session</td>
                    <td style={{ textAlign: 'right', padding: '6px 0', borderBottom: '1px solid var(--border)' }}><kbd className="providers__envvar">Ctrl+N</kbd></td>
                  </tr>
                  <tr>
                    <td style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>Open Folder</td>
                    <td style={{ textAlign: 'right', padding: '6px 0', borderBottom: '1px solid var(--border)' }}><kbd className="providers__envvar">Ctrl+O</kbd></td>
                  </tr>
                  <tr>
                    <td style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>Clear</td>
                    <td style={{ textAlign: 'right', padding: '6px 0', borderBottom: '1px solid var(--border)' }}><kbd className="providers__envvar">Ctrl+K</kbd></td>
                  </tr>
                  <tr>
                    <td style={{ padding: '6px 0' }}>Settings</td>
                    <td style={{ textAlign: 'right', padding: '6px 0' }}><kbd className="providers__envvar">Ctrl+,</kbd></td>
                  </tr>
                </tbody>
              </table>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
