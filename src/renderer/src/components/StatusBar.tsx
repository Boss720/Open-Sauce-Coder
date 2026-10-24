import { useEffect, useMemo, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../lib/store'
import { sessionCost, contextUsed, contextLimit } from '../lib/aggregate'
import { formatCost, formatTokens } from '../lib/format'
import { isAutoRoutingActive } from '../lib/routing'
import { SettingsPanel } from './SettingsPanel'
import type { AppState } from '../lib/slices/types'
import type { NanoUsage } from '../lib/types'

/** Entry points into the right-hand code surface. Always visible — the panel's own
 *  tab strip is unreachable while the panel is collapsed. */
const PANEL_BUTTONS: ReadonlyArray<{
  tab: NonNullable<AppState['panelTab']>
  label: string
  hint: string
}> = [
  { tab: 'files', label: 'Files', hint: 'File tree (Ctrl+B)' },
  { tab: 'editor', label: 'Editor', hint: 'Review and edit files' },
  { tab: 'changes', label: 'Changes', hint: 'Every changed file as one diff' },
  { tab: 'git', label: 'Git', hint: 'Stage and commit changes' },
  { tab: 'terminal', label: 'Terminal', hint: 'Integrated terminal (Ctrl+`)' },
  { tab: 'dag', label: 'DAG', hint: 'Workflow DAG Canvas' }
]

function hostLabel(url: string | null): string {
  if (!url) return 'no url'
  try {
    const u = new URL(url)
    return u.port ? `${u.hostname}:${u.port}` : u.hostname
  } catch {
    return url
  }
}

/**
 * Highest `percentUsed` across the quota buckets NanoGPT actually reported, driving the status
 * dot. A bucket that is null (no such quota on this plan) or missing a percentage contributes
 * nothing — an unknown number must not read as headroom, and it must not read as exhaustion
 * either, so it is simply not counted. All-unknown yields 0 and the dot stays green, which
 * matches the pre-existing behaviour of showing OK until a bucket says otherwise.
 */
function worstQuotaPercent(usage: NanoUsage): number {
  return [usage.dailyInputTokens, usage.weeklyInputTokens, usage.dailyImages].reduce<number>(
    (worst, bucket) => (bucket?.percentUsed === undefined ? worst : Math.max(worst, bucket.percentUsed)),
    0
  )
}

export function StatusBar(): JSX.Element {
  const [showSettings, setShowSettings] = useState(false)
  const server = useStore((s) => s.server)
  const providers = useStore((s) => s.providers)
  const providerID = useStore((s) => s.providerID)
  const modelID = useStore((s) => s.modelID)
  const pinnedProviderID = useStore((s) => s.pinnedProviderID)
  const pinnedModelID = useStore((s) => s.pinnedModelID)
  const revertToPinned = useStore((s) => s.revertToPinned)
  const sessions = useStore((s) => s.sessions)
  const activeSessionID = useStore((s) => s.activeSessionID)
  const busy = useStore((s) => s.busy)
  const pending = useStore((s) => s.permissions.length)
  // Derived from routingMode — see isAutoRoutingActive.
  const autoRotate = useStore((s) => isAutoRoutingActive(s.routingMode))
  const theme = useStore((s) => s.theme)
  const setTheme = useStore((s) => s.setTheme)
  const branch = useStore((s) => s.branch)
  const messages = useStore((s) => s.messages)
  const panelTab = useStore((s) => s.panelTab)
  const setPanelTab = useStore((s) => s.setPanelTab)
  const nanoUsage = useStore((s) => s.nanoUsage)
  const showBalanceInStatus = useStore((s) => s.showBalanceInStatus)
  const nanoBalance = useStore((s) => s.nanoBalance)

  useEffect(() => {
    const onToggleSettings = () => setShowSettings((prev) => !prev)
    window.addEventListener('opencode-desktop:toggle-settings', onToggleSettings)
    return () => window.removeEventListener('opencode-desktop:toggle-settings', onToggleSettings)
  }, [])

  const modelLabel = useMemo(() => {
    if (!providerID || !modelID) return 'no model selected'
    const p = providers.find((x) => x.id === providerID)
    if (!p) return `${providerID}/${modelID}`
    const m = p.models[modelID]
    return `${p.name} · ${m ? m.name : modelID}`
  }, [providers, providerID, modelID])

  const sessionLabel = useMemo(() => {
    if (!activeSessionID) return 'no session'
    const s = sessions.find((x) => x.id === activeSessionID)
    if (!s) return 'no session'
    return s.title || 'Untitled'
  }, [sessions, activeSessionID])

  // A running server with a dead SSE stream looks healthy but receives nothing,
  // so it gets its own colour rather than the green one.
  const dotClass = !server.running
    ? 'app__dot app__dot--bad'
    : server.streamConnected
      ? 'app__dot app__dot--ok'
      : 'app__dot app__dot--warn'
  const serverText = !server.running
    ? server.error
      ? 'server error'
      : 'offline'
    : server.streamConnected
      ? hostLabel(server.url)
      : 'reconnecting…'

  const ctxUsed = contextUsed(messages)
  const ctxLimit = contextLimit(providers, providerID, modelID)
  const ctxPct = ctxLimit > 0 ? Math.round((ctxUsed / ctxLimit) * 100) : 0
  const ctxText = ctxLimit > 0 ? `Context: ${formatTokens(ctxUsed)} / ${formatTokens(ctxLimit)} (${ctxPct}%)` : `Context: ${formatTokens(ctxUsed)}`

  const costText = `Cost: ${formatCost(sessionCost(messages))}`

  const cycleTheme = () => {
    if (theme === 'auto') setTheme('dark')
    else if (theme === 'dark') setTheme('light')
    else setTheme('auto')
  }
  const themeIcon = theme === 'light' ? '☀' : theme === 'dark' ? '☽' : '◐'

  return (
    <footer className="app__status">
      {/*
        The code-surface panel starts collapsed, and its tab strip lives inside the
        panel — so without these buttons there is no way to discover or reach it
        except undocumented keyboard shortcuts.
      */}
      <span className="app__status-panels" role="group" aria-label="Code surface">
        {PANEL_BUTTONS.map(({ tab, label, hint }) => (
          <button
            key={tab}
            type="button"
            className={
              panelTab === tab
                ? 'app__status-panelbtn app__status-panelbtn--active'
                : 'app__status-panelbtn'
            }
            aria-pressed={panelTab === tab}
            title={hint}
            onClick={() => setPanelTab(panelTab === tab ? null : tab)}
          >
            {label}
          </button>
        ))}
      </span>

      <span className="app__status-sep" aria-hidden="true" />

      <span
        className="app__status-item"
        title={server.error ? server.error : (server.url ?? 'OpenCode server not running')}
      >
        <span className={dotClass} aria-hidden="true" />
        <span className="app__status-url">{serverText}</span>
      </span>

      <span className="app__status-sep" aria-hidden="true" />

      <span className="app__status-item" title={providerID && modelID ? `${providerID}/${modelID}` : 'Pick a model with Ctrl+K'}>
        <span className="app__status-strong">{modelLabel}</span>
      </span>

      <span className="app__status-sep" aria-hidden="true" />

      <span className="app__status-item app__status-item--grow" title={sessionLabel}>
        <span className="app__status-strong">{sessionLabel}</span>
      </span>

      {autoRotate && (
        <span className="app__status-item app__autorotate" title="Free Model Auto-Routing enabled (cycles models on 429 rate limit)">
          ⚡ Auto-Route
        </span>
      )}

      {pinnedProviderID && pinnedModelID && (pinnedProviderID !== providerID || pinnedModelID !== modelID) && (
        <button
          type="button"
          className="app__status-item app__status-failover"
          title={`Failed over from ${pinnedProviderID}/${pinnedModelID}. Click to revert.`}
          onClick={() => revertToPinned()}
        >
          ⚡ {pinnedModelID} → {modelID} ↺
        </button>
      )}

      {branch && (
        <span className="app__status-item" title="Current git branch">
          ⎇ {branch}
        </span>
      )}

      <span className="app__status-sep" aria-hidden="true" />

      <span className="app__status-item" title="Context usage">
        {ctxText}
      </span>

      <span className="app__status-sep" aria-hidden="true" />

      <span className="app__status-item" title="Session cost">
        {costText}
      </span>

      <span className="app__status-sep" aria-hidden="true" />

      {providerID === 'nanogpt' && (
        <span className="app__status-item" title="NanoGPT Subscription Status">
          <span
            className={
              !nanoUsage
                ? 'app__dot app__dot--warn'
                : worstQuotaPercent(nanoUsage) >= 100
                ? 'app__dot app__dot--bad'
                : nanoUsage.state === 'grace' || worstQuotaPercent(nanoUsage) >= 80
                ? 'app__dot app__dot--warn'
                : 'app__dot app__dot--ok'
            }
            aria-hidden="true"
          />
          <span>NanoGPT</span>
        </span>
      )}

      {showBalanceInStatus && nanoBalance && (
        <span className="app__status-item" title="NanoGPT Pay-Per-Prompt Balance">
          ${nanoBalance.usd.toFixed(2)}
        </span>
      )}

      <button
        type="button"
        className="app__status-item"
        aria-label="Settings (Ctrl+,)"
        title="Settings (Ctrl+,)"
        onClick={() => setShowSettings(true)}
      >
        ⚙
      </button>

      <button
        type="button"
        className="app__status-item"
        aria-label="Toggle theme (auto/dark/light)"
        title="Toggle Theme (auto/dark/light)"
        onClick={cycleTheme}
      >
        {themeIcon}
      </button>

      {busy && (
        <span className="app__status-item app__busy" title="The assistant is working">
          <span className="app__spinner app__spinner--sm" aria-hidden="true" />
          <span>working…</span>
        </span>
      )}

      {pending > 0 && (
        <span className="app__status-item app__pending" title="Permission requests waiting on you">
          {pending} permission{pending === 1 ? '' : 's'} pending
        </span>
      )}

      <SettingsPanel open={showSettings} onClose={() => setShowSettings(false)} />
    </footer>
  )
}
