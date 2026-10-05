import { useEffect, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../lib/store'
import { currentRateUsage, loadLedger, type Ledger, type ModelHealth } from '../lib/routing'
import { FREE_FALLBACK_PROVIDER_ORDER, FREE_MODEL_TIERS, FREE_PROVIDER_CAPS, isFreeModel, OPAQUE_RPM_PROVIDERS } from '../lib/freeTier'
import { isAgentModel } from '../lib/models'
import type { Model } from '../lib/types'

const MAX_VISIBLE_MODELS = 60

type RoutingRow = {
  providerID: string
  providerName: string
  model: Model
  tier: string | null
}

function formatSecondsAgo(then: number, now: number): string {
  const secs = Math.round((now - then) / 1000)
  if (secs < 60) return `${secs}s ago`
  if (secs < 3600) return `${Math.round(secs / 60)}m ago`
  return `${Math.round(secs / 3600)}h ago`
}

function cooldownRemaining(h: ModelHealth, now: number): number {
  return Math.max(0, h.cooldownUntil - now)
}

export function RoutingPanel(): JSX.Element {
  const providers = useStore((s) => s.providers)
  const linkedProviderIDs = useStore((s) => s.linkedProviderIDs)
  const [ledger, setLedger] = useState<Ledger>(() => loadLedger())
  const [now, setNow] = useState(Date.now())

  useEffect(() => {
    const tick = setInterval(() => {
      setLedger(loadLedger())
      setNow(Date.now())
    }, 2000)
    return () => clearInterval(tick)
  }, [])

  const linked = new Set(linkedProviderIDs)
  const tiers = new Map(FREE_MODEL_TIERS.map((entry, index) => [`${entry.providerID}/${entry.modelID}`, { tier: entry.tier, index }]))
  const providerOrder = new Map(FREE_FALLBACK_PROVIDER_ORDER.map((providerID, index) => [providerID, index]))
  const allRows: RoutingRow[] = providers
    .filter((provider) => linked.has(provider.id))
    .flatMap((provider) => Object.values(provider.models ?? {})
      .filter((model) => isAgentModel(model) && isFreeModel(provider.id, model.id, model.cost))
      .map((model) => ({
        providerID: provider.id,
        providerName: provider.name,
        model,
        tier: tiers.get(`${provider.id}/${model.id}`)?.tier ?? null
      })))
    .sort((a, b) => {
      const keyA = `${a.providerID}/${a.model.id}`
      const keyB = `${b.providerID}/${b.model.id}`
      const tierA = tiers.get(keyA)?.index ?? Number.MAX_SAFE_INTEGER
      const tierB = tiers.get(keyB)?.index ?? Number.MAX_SAFE_INTEGER
      return tierA - tierB ||
        (providerOrder.get(a.providerID) ?? Number.MAX_SAFE_INTEGER) - (providerOrder.get(b.providerID) ?? Number.MAX_SAFE_INTEGER) ||
        keyA.localeCompare(keyB)
    })
  const rows = allRows.slice(0, MAX_VISIBLE_MODELS)

  if (rows.length === 0) {
    return (
      <div style={{ fontSize: '11.5px', color: 'var(--fg-dim)', padding: '10px 0' }}>
        No linked provider models active. Add an API key under Provider Keys
        (Google, Groq, Mistral, Cerebras, OpenRouter, or NanoGPT) to see per-model health here.
      </div>
    )
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
      {rows.map((row) => {
        const { providerID, model } = row
        const key = `${providerID}/${model.id}`
        const health = ledger[key]
        const label = `${row.providerName} · ${model.name || model.id}`
        const total = (health?.success ?? 0) + (health?.error ?? 0)
        const successRatio = total > 0 ? Math.round((health!.success / total) * 100) : null
        const latency = health?.latencyEwma !== undefined && health?.latencyEwma !== null
          ? Math.round(health.latencyEwma)
          : null
        const cooldown = health ? cooldownRemaining(health, now) : 0
        const usage = currentRateUsage(ledger, key, FREE_PROVIDER_CAPS, now)
        const cap = usage?.caps
        const rpd = usage?.requestsPerDay ?? 0
        const rpm = usage?.requestsPerMinute ?? 0

        return (
          <div key={key} style={{
            padding: '6px 8px',
            border: '1px solid var(--border)',
            borderRadius: '4px',
            fontSize: '11.5px',
            background: cooldown > 0 ? 'rgba(180, 83, 9, 0.06)' : 'transparent',
          }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '8px' }}>
              <span style={{ fontWeight: 500 }}>
                {row.tier && <span style={{
                  display: 'inline-block',
                  padding: '1px 5px',
                  fontSize: '10px',
                  background: 'var(--border)',
                  borderRadius: '3px',
                  marginRight: '6px',
                }}>{row.tier}</span>}
                {label}
              </span>
              <span style={{ color: 'var(--fg-dim)', fontSize: '10.5px' }}>
                {cap?.rpm === undefined || OPAQUE_RPM_PROVIDERS.has(providerID)
                  ? `RPM ${rpm} local · unpublished`
                  : `RPM ${rpm}/${cap.rpm} local`}
                {' · '}
                {cap?.rpd === undefined ? `RPD ${rpd} local · no cap` : `RPD ${rpd}/${cap.rpd} local`}
              </span>
            </div>

            <div style={{ marginTop: '3px', display: 'flex', gap: '10px', color: 'var(--fg-dim)', fontSize: '10.5px' }}>
              {cap?.burst && <span>burst {usage?.burstRequests ?? 0}/{cap.burst.count} per {cap.burst.windowMs / 1000}s</span>}
              {cap?.tpm !== undefined && <span>TPM {cap.tpmTokens === 'input' ? 'input ' : ''}{usage?.tokensPerMinute ?? 0}/{cap.tpm} local</span>}
              {cap?.rpdWindow === 'day-pt' && <span>resets midnight PT</span>}
              <span title="Successful requests">✓ {health?.success ?? 0}</span>
              <span title="Failed requests">✗ {health?.error ?? 0}</span>
              {successRatio !== null && <span>{successRatio}% ok</span>}
              {latency !== null && <span>{latency}ms avg</span>}
              {health?.last429 !== null && health?.last429 !== undefined && (
                <span>last 429: {formatSecondsAgo(health.last429, now)}</span>
              )}
              {cooldown > 0 && (
                <span style={{ color: 'var(--warn, #b45309)', fontWeight: 500 }}>
                  cooling {Math.round(cooldown / 1000)}s
                </span>
              )}
            </div>
          </div>
        )
      })}
      <p style={{ fontSize: '10.5px', color: 'var(--fg-dim)', marginTop: '4px' }}>
        Local desktop ledger only; other apps using the same provider key are not counted. Provider limits vary by account and project.
        {allRows.length > rows.length ? ` Showing ${rows.length} of ${allRows.length} eligible models.` : ''}
      </p>
    </div>
  )
}
