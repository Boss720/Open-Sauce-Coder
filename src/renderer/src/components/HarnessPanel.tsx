import { useEffect, useMemo, useRef, useState } from 'react'
import type { JSX } from 'react'
import { useStore } from '../lib/store'
import type { AgentProfile, KeyRow, RunnerResult } from '../lib/types'
import './HarnessPanel.css'

/** Harness providers supported by the main-process registry (providers/registry.ts). */
const PROVIDER_OPTIONS = [
  { value: 'opencode', label: 'OpenCode (Local)' },
  { value: 'anthropic', label: 'Anthropic (Claude)' },
  { value: 'openai', label: 'OpenAI (GPT-4o / o-series)' },
  { value: 'google', label: 'Google Gemini' },
  { value: 'deepseek', label: 'DeepSeek' },
  { value: 'groq', label: 'Groq (Llama / Mixtral)' },
  { value: 'nanogpt', label: 'NanoGPT' },
  { value: 'openrouter', label: 'OpenRouter' },
  { value: 'mistral', label: 'Mistral AI' },
  { value: 'xai', label: 'xAI (Grok)' },
  { value: 'cerebras', label: 'Cerebras' },
  { value: 'moonshot', label: 'Moonshot (Kimi)' },
  { value: 'custom', label: 'Custom (OpenAI-compatible)' }
] as const

/** Recommended model presets per provider for quick selection in profile editor. */
const MODEL_PRESETS: Record<string, string[]> = {
  opencode: ['default', 'claude-sonnet-5-5', 'gemini-2.5-pro'],
  anthropic: ['claude-sonnet-5-5', 'claude-opus-5-5', 'claude-haiku-5-5', 'claude-fable-5-1'],
  openai: ['gpt-5.5', 'gpt-5.4-mini', 'gpt-4o', 'o3-mini'],
  google: ['gemini-3.1-pro-preview', 'gemini-3.5-flash', 'gemini-2.5-pro', 'gemini-2.5-flash'],
  deepseek: ['deepseek-v4-pro', 'deepseek-flash'],
  groq: ['llama-3.3-70b-versatile', 'openai/gpt-oss-120b'],
  nanogpt: ['openai/gpt-4o', 'anthropic/claude-sonnet-5.5'],
  openrouter: ['anthropic/claude-sonnet-5.5', 'openai/gpt-5.5', 'google/gemini-3.5-flash', 'deepseek/deepseek-v4-pro'],
  mistral: ['mistral-medium-latest', 'codestral-latest', 'mistral-small-latest'],
  xai: ['grok-4.7', 'grok-build-0.1'],
  cerebras: ['gpt-oss-120b', 'qwen-3.8-27b'],
  moonshot: ['kimi-k3.1-pro', 'kimi-k3.1-pro-highspeed'],
  custom: []
}

/**
 * Default endpoint of each built-in provider whose adapter honours a Base URL override
 * (Google, NanoGPT and OpenCode ignore it). Mirrors the defaults in main/harness/providers.
 */
const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  deepseek: 'https://api.deepseek.com',
  groq: 'https://api.groq.com/openai/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  mistral: 'https://api.mistral.ai/v1',
  xai: 'https://api.x.ai/v1',
  cerebras: 'https://api.cerebras.ai/v1',
  moonshot: 'https://api.moonshot.cn/v1'
}

function getToolIconAndCategory(name: string): { icon: string; className: string } {
  if (name.startsWith('fs_read') || name === 'grep' || name === 'find_by_name') {
    return { icon: '📖', className: 'harness__event--tool-read' }
  }
  if (name.startsWith('fs_write') || name === 'fs_patch') {
    return { icon: '✏️', className: 'harness__event--tool-write' }
  }
  if (name === 'shell' || name === 'bash' || name === 'terminal') {
    return { icon: '💻', className: 'harness__event--tool-shell' }
  }
  if (name.includes('web') || name.includes('fetch') || name.includes('search')) {
    return { icon: '🌐', className: 'harness__event--tool-web' }
  }
  return { icon: '⚙', className: 'harness__event--tool-generic' }
}

/** Editor draft: numeric fields stay strings until save, so empty means "unset". */
type Draft = {
  id: string
  name: string
  description: string
  provider: string
  baseUrl: string
  model: string
  temperature: string
  maxTokens: string
  maxTurns: string
  tokenBudget: string
  systemPrompt: string
  readOnly: boolean
  allTools: boolean
  tools: string[]
  source?: Partial<AgentProfile>
}

const EMPTY_DRAFT: Draft = {
  id: '',
  name: '',
  description: '',
  provider: 'nanogpt',
  baseUrl: '',
  model: '',
  temperature: '',
  maxTokens: '',
  maxTurns: '',
  tokenBudget: '',
  systemPrompt: '',
  readOnly: false,
  allTools: true,
  tools: []
}

type TestState = 'testing' | 'ok' | 'fail'

function parseNum(text: string): number | undefined {
  const trimmed = text.trim()
  if (trimmed === '') return undefined
  const value = Number(trimmed)
  return Number.isFinite(value) ? value : undefined
}

function draftFrom(profile: AgentProfile): Draft {
  const isWildcard = profile.tools?.includes('*') ?? (profile.tools === undefined)
  const explicitTools = profile.tools ? profile.tools.filter((t) => t !== '*') : []
  return {
    id: profile.id,
    name: profile.name,
    description: profile.description ?? '',
    provider: profile.provider,
    baseUrl: profile.baseUrl ?? '',
    model: profile.model,
    temperature: profile.temperature === undefined ? '' : String(profile.temperature),
    maxTokens: profile.maxTokens === undefined ? '' : String(profile.maxTokens),
    maxTurns: profile.maxTurns === undefined ? '' : String(profile.maxTurns),
    tokenBudget: profile.tokenBudget === undefined ? '' : String(profile.tokenBudget),
    systemPrompt: profile.systemPrompt ?? '',
    readOnly: profile.readOnly ?? false,
    allTools: isWildcard,
    tools: explicitTools,
    source: { ...profile }
  }
}

/** `-copy`, then `-copy-2`, … — a clone must never silently overwrite an existing profile. */
function cloneId(base: string, taken: Set<string>): string {
  let candidate = `${base}-copy`
  let n = 2
  while (taken.has(candidate)) {
    candidate = `${base}-copy-${n}`
    n += 1
  }
  return candidate
}

function draftToProfile(draft: Draft): AgentProfile {
  const base = draft.source ? { ...draft.source } : {}
  delete (base as Record<string, unknown>).builtin
  delete (base as Record<string, unknown>).createdAt
  delete (base as Record<string, unknown>).updatedAt

  const profile: AgentProfile = {
    ...base,
    id: draft.id.trim(),
    name: draft.name.trim(),
    provider: draft.provider,
    model: draft.model.trim()
  }
  const description = draft.description.trim()
  if (description) profile.description = description
  else delete profile.description

  const baseUrl = draft.baseUrl.trim()
  if (baseUrl) profile.baseUrl = baseUrl
  else delete profile.baseUrl

  const temperature = parseNum(draft.temperature)
  if (temperature !== undefined) profile.temperature = temperature
  else delete profile.temperature

  const maxTokens = parseNum(draft.maxTokens)
  if (maxTokens !== undefined) profile.maxTokens = maxTokens
  else delete profile.maxTokens

  const maxTurns = parseNum(draft.maxTurns)
  if (maxTurns !== undefined) profile.maxTurns = maxTurns
  else delete profile.maxTurns

  const tokenBudget = parseNum(draft.tokenBudget)
  if (tokenBudget !== undefined) profile.tokenBudget = tokenBudget
  else delete profile.tokenBudget

  const systemPrompt = draft.systemPrompt.trim()
  if (systemPrompt) profile.systemPrompt = systemPrompt
  else delete profile.systemPrompt

  if (draft.readOnly) profile.readOnly = true
  else delete profile.readOnly

  profile.tools = draft.allTools ? ['*'] : [...draft.tools]
  return profile
}

/* ------------------------------------------------------------------ *
 * Run monitor: fold the raw event log into renderable entries,
 * merging consecutive text deltas into one streaming block.
 * ------------------------------------------------------------------ */

type MonitorEntry =
  | { kind: 'text'; text: string }
  | { kind: 'thinking'; text: string }
  | { kind: 'tool_call'; name: string; args: Record<string, unknown> }
  | { kind: 'tool_result'; name: string; output: string; error?: string }
  | { kind: 'error'; message: string }
  | { kind: 'warning'; field: string; used: number; limit: number }
  | { kind: 'done'; result: RunnerResult }

function StatusBadge({ status }: { status: string }): JSX.Element {
  return <span className={`harness__badge harness__badge--${status}`}>{status}</span>
}

export function HarnessPanel({ compact = false }: { compact?: boolean }): JSX.Element {
  const directory = useStore((s) => s.directory)
  const profiles = useStore((s) => s.harnessProfiles)
  const tools = useStore((s) => s.harnessTools)
  const runs = useStore((s) => s.harnessRuns)
  const activeRunId = useStore((s) => s.harnessActiveRunId)
  const runEvents = useStore((s) => s.harnessRunEvents)
  const loading = useStore((s) => s.harnessLoading)
  const harnessError = useStore((s) => s.harnessError)
  const loadHarnessProfiles = useStore((s) => s.loadHarnessProfiles)
  const saveHarnessProfile = useStore((s) => s.saveHarnessProfile)
  const deleteHarnessProfile = useStore((s) => s.deleteHarnessProfile)
  const testHarnessProfile = useStore((s) => s.testHarnessProfile)
  const loadHarnessTools = useStore((s) => s.loadHarnessTools)
  const startHarnessRun = useStore((s) => s.startHarnessRun)
  const stopHarnessRun = useStore((s) => s.stopHarnessRun)

  const [draft, setDraft] = useState<Draft | null>(null)
  /** True while the draft is a built-in profile shown read-only. */
  const [draftLocked, setDraftLocked] = useState(false)
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null)
  const [testResults, setTestResults] = useState<Record<string, TestState>>({})
  const [storedKeys, setStoredKeys] = useState<KeyRow[]>([])
  const [runProfileId, setRunProfileId] = useState('')
  const [task, setTask] = useState('')
  const [starting, setStarting] = useState(false)
  const [monitorFollowing, setMonitorFollowing] = useState(true)

  const monitorRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    void loadHarnessProfiles()
    void loadHarnessTools()
    const fetchKeys = async (): Promise<void> => {
      try {
        if (typeof window !== 'undefined' && window.api?.keys?.list) {
          const list = await window.api.keys.list()
          setStoredKeys(list)
        }
      } catch {
        // bridge not available or failed
      }
    }
    void fetchKeys()
  }, [loadHarnessProfiles, loadHarnessTools])

  const hasKey = (providerId: string): boolean => {
    if (providerId === 'custom' || providerId === 'opencode') return true
    const row = storedKeys.find((k) => k.providerID === providerId)
    return Boolean(row)
  }

  const activeRun = useMemo(
    () => runs.find((run) => run.id === activeRunId) ?? null,
    [runs, activeRunId]
  )

  const entries = useMemo<MonitorEntry[]>(() => {
    const out: MonitorEntry[] = []
    for (const { runId, event } of runEvents) {
      if (runId !== activeRunId) continue
      if (event.type === 'text') {
        const last = out.at(-1)
        if (last?.kind === 'text') last.text += event.delta
        else out.push({ kind: 'text', text: event.delta })
        continue
      }
      if (event.type === 'thinking') {
        const last = out.at(-1)
        if (last?.kind === 'thinking') last.text += event.content
        else out.push({ kind: 'thinking', text: event.content })
        continue
      }
      if (event.type === 'tool_call') out.push({ kind: 'tool_call', name: event.name, args: event.args })
      else if (event.type === 'tool_result') {
        out.push({ kind: 'tool_result', name: event.name, output: event.output, error: event.error })
      } else if (event.type === 'error') out.push({ kind: 'error', message: event.message })
      else if (event.type === 'budget_warning') {
        out.push({ kind: 'warning', field: event.field, used: event.used, limit: event.limit })
      } else if (event.type === 'done') out.push({ kind: 'done', result: event.result })
    }
    return out
  }, [runEvents, activeRunId])

  /* Follow new output only while the user remains near the bottom. */
  useEffect(() => {
    const el = monitorRef.current
    if (el && monitorFollowing) el.scrollTop = el.scrollHeight
  }, [entries, monitorFollowing])

  useEffect(() => {
    setMonitorFollowing(true)
  }, [activeRunId])

  const onMonitorScroll = (): void => {
    const el = monitorRef.current
    if (!el) return
    setMonitorFollowing(el.scrollHeight - el.scrollTop - el.clientHeight < 48)
  }

  const patchDraft = (patch: Partial<Draft>): void => {
    setDraft((prev) => (prev === null ? prev : { ...prev, ...patch }))
  }

  const openProfile = (profile: AgentProfile): void => {
    setDraft(draftFrom(profile))
    setDraftLocked(profile.builtin === true)
  }

  const cloneDraft = (): void => {
    if (draft === null) return
    const taken = new Set(profiles.map((p) => p.id))
    const newId = cloneId(draft.id, taken)
    const newName = `${draft.name} (copy)`
    setDraft({
      ...draft,
      id: newId,
      name: newName,
      source: draft.source ? { ...draft.source, id: newId, name: newName } : undefined
    })
    setDraftLocked(false)
  }

  const cloneProfile = (profile: AgentProfile): void => {
    const taken = new Set(profiles.map((p) => p.id))
    const base = draftFrom(profile)
    const newId = cloneId(profile.id, taken)
    const newName = `${profile.name} (copy)`
    setDraft({
      ...base,
      id: newId,
      name: newName,
      source: { ...profile, id: newId, name: newName }
    })
    setDraftLocked(false)
  }

  const saveDraft = async (): Promise<void> => {
    if (draft === null) return
    const ok = await saveHarnessProfile(draftToProfile(draft))
    if (ok) {
      setDraft(null)
      setDraftLocked(false)
    }
  }

  const runTest = async (id: string): Promise<void> => {
    setTestResults((prev) => ({ ...prev, [id]: 'testing' }))
    const ok = await testHarnessProfile(id)
    setTestResults((prev) => ({ ...prev, [id]: ok ? 'ok' : 'fail' }))
  }

  const startRun = async (): Promise<void> => {
    const trimmed = task.trim()
    if (!runProfileId || !trimmed) return
    setStarting(true)
    try {
      await startHarnessRun(runProfileId, trimmed)
    } finally {
      setStarting(false)
    }
  }

  const toggleDraftTool = (name: string): void => {
    if (draft === null) return
    const next = draft.tools.includes(name)
      ? draft.tools.filter((t) => t !== name)
      : [...draft.tools, name]
    patchDraft({ tools: next })
  }

  const running = activeRun?.status === 'running'

  return (
    <div className={compact ? 'harness harness--compact' : 'harness'}>
      <div className="harness__header">
        <h1>Harness</h1>
        <p>Custom agent profiles and single-agent runs with tool calling.</p>
      </div>

      {harnessError !== null && (
        <div className="harness__message harness__message--error" role="alert">
          {harnessError}
        </div>
      )}

      <div className="harness__layout">
        {/* ---- profile list + editor ---- */}
        <section className="harness__section">
          <div className="harness__section-head">
            <h2>Profiles</h2>
            <button
              type="button"
              className="harness__btn"
              onClick={() => {
                setDraft(EMPTY_DRAFT)
                setDraftLocked(false)
              }}
            >
              + New profile
            </button>
          </div>

          {loading && profiles.length === 0 ? (
            <p className="harness__muted">Loading profiles…</p>
          ) : profiles.length === 0 ? (
            <p className="harness__muted">No profiles yet.</p>
          ) : (
            <ul className="harness__profiles">
              {profiles.map((profile) => (
                <li key={profile.id} className="harness__profile">
                  <button
                    type="button"
                    className="harness__profile-main"
                    onClick={() => openProfile(profile)}
                    title={profile.description ?? profile.id}
                  >
                    <span className="harness__profile-name">
                      {profile.name}
                      {profile.builtin === true && (
                        <span className="harness__tag">built-in</span>
                      )}
                    </span>
                    <span className="harness__profile-meta">
                      {profile.provider} · {profile.model}
                    </span>
                  </button>
                  <span className="harness__profile-actions">
                    <button
                      type="button"
                      className="harness__btn harness__btn--sm"
                      disabled={testResults[profile.id] === 'testing'}
                      onClick={() => void runTest(profile.id)}
                      title="Probe provider connectivity"
                    >
                      {testResults[profile.id] === 'testing'
                        ? 'Testing…'
                        : testResults[profile.id] === 'ok'
                          ? '✓ Reachable'
                          : testResults[profile.id] === 'fail'
                            ? '✗ Unreachable'
                            : 'Test'}
                    </button>
                    {profile.builtin === true ? (
                      <button
                        type="button"
                        className="harness__btn harness__btn--sm"
                        onClick={() => cloneProfile(profile)}
                      >
                        Clone
                      </button>
                    ) : confirmDeleteId === profile.id ? (
                      <>
                        <button
                          type="button"
                          className="harness__btn harness__btn--sm harness__btn--danger"
                          onClick={() => {
                            setConfirmDeleteId(null)
                            if (draft?.id === profile.id) setDraft(null)
                            void deleteHarnessProfile(profile.id)
                          }}
                        >
                          Delete
                        </button>
                        <button
                          type="button"
                          className="harness__btn harness__btn--sm"
                          onClick={() => setConfirmDeleteId(null)}
                        >
                          Cancel
                        </button>
                      </>
                    ) : (
                      <button
                        type="button"
                        className="harness__btn harness__btn--sm harness__btn--danger"
                        onClick={() => setConfirmDeleteId(profile.id)}
                      >
                        Delete
                      </button>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}

          {draft !== null && (
            <form
              className="harness__editor"
              onSubmit={(e) => {
                e.preventDefault()
                if (!draftLocked) void saveDraft()
              }}
            >
              <div className="harness__editor-head">
                <h3>{draftLocked ? 'Built-in profile (read-only)' : 'Profile editor'}</h3>
                {draftLocked && (
                  <button type="button" className="harness__btn harness__btn--sm" onClick={cloneDraft}>
                    Clone to customize
                  </button>
                )}
              </div>

              <label className="harness__field">
                <span>ID</span>
                <input
                  type="text"
                  value={draft.id}
                  disabled={draftLocked}
                  placeholder="my-agent"
                  onChange={(e) =>
                    patchDraft({
                      // Slugify as typed — validateProfile requires /^[a-z0-9_-]{1,64}$/.
                      id: e.target.value
                        .toLowerCase()
                        .replace(/\s+/g, '-')
                        .replace(/[^a-z0-9_-]/g, '')
                        .slice(0, 64)
                    })
                  }
                />
                <span className="harness__muted">Lowercase letters, digits, hyphens, underscores.</span>
              </label>
              <label className="harness__field">
                <span>Name</span>
                <input
                  type="text"
                  value={draft.name}
                  disabled={draftLocked}
                  placeholder="My Agent"
                  onChange={(e) => patchDraft({ name: e.target.value })}
                />
              </label>
              <label className="harness__field">
                <span>Description</span>
                <input
                  type="text"
                  value={draft.description}
                  disabled={draftLocked}
                  onChange={(e) => patchDraft({ description: e.target.value })}
                />
              </label>
              <div className="harness__field-row">
                <label className="harness__field">
                  <span className="harness__field-header">
                    <span>Provider</span>
                    {!hasKey(draft.provider) && (
                      <span
                        className="harness__badge harness__badge--warning"
                        title="No API key found in OpenCode storage or environment. Configure it in Settings > Providers."
                      >
                        ⚠️ Key missing in Settings &gt; Providers
                      </span>
                    )}
                  </span>
                  <select
                    value={draft.provider}
                    disabled={draftLocked}
                    onChange={(e) => patchDraft({ provider: e.target.value })}
                  >
                    {PROVIDER_OPTIONS.map((opt) => (
                      <option key={opt.value} value={opt.value}>
                        {opt.label}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="harness__field harness__field--grow">
                  <span>Model</span>
                  <input
                    type="text"
                    value={draft.model}
                    disabled={draftLocked}
                    placeholder="e.g. gpt-4o, claude-sonnet-5-5, gemini-2.5-pro"
                    onChange={(e) => patchDraft({ model: e.target.value })}
                  />
                  {MODEL_PRESETS[draft.provider] && MODEL_PRESETS[draft.provider].length > 0 && (
                    <div className="harness__presets">
                      <span className="harness__muted">Presets:</span>
                      {MODEL_PRESETS[draft.provider].map((preset) => (
                        <button
                          key={preset}
                          type="button"
                          className="harness__btn harness__btn--xs"
                          disabled={draftLocked}
                          onClick={() => patchDraft({ model: preset })}
                        >
                          {preset}
                        </button>
                      ))}
                    </div>
                  )}
                </label>
              </div>
              {(draft.provider === 'custom' || DEFAULT_BASE_URLS[draft.provider]) && (
                <label className="harness__field">
                  <span>Base URL</span>
                  <input
                    type="url"
                    value={draft.baseUrl}
                    disabled={draftLocked}
                    placeholder={
                      DEFAULT_BASE_URLS[draft.provider] ??
                      'http://localhost:11434/v1 (Ollama) or http://localhost:1234/v1 (LM Studio)'
                    }
                    onChange={(e) => patchDraft({ baseUrl: e.target.value })}
                  />
                  <span className="harness__muted">
                    {draft.provider === 'custom'
                      ? 'OpenAI-compatible server endpoint (e.g. Ollama, LM Studio, vLLM).'
                      : 'Leave empty for the default API. Your stored key is only sent to that API; any other host (a proxy or local server) gets no key.'}
                  </span>
                </label>
              )}
              <div className="harness__field-row">
                <label className="harness__field">
                  <span>Temperature</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0"
                    max="2"
                    value={draft.temperature}
                    disabled={draftLocked}
                    onChange={(e) => patchDraft({ temperature: e.target.value })}
                  />
                </label>
                <label className="harness__field">
                  <span>Max tokens</span>
                  <input
                    type="number"
                    min="1"
                    value={draft.maxTokens}
                    disabled={draftLocked}
                    onChange={(e) => patchDraft({ maxTokens: e.target.value })}
                  />
                </label>
                <label className="harness__field">
                  <span>Max turns</span>
                  <input
                    type="number"
                    min="1"
                    value={draft.maxTurns}
                    disabled={draftLocked}
                    onChange={(e) => patchDraft({ maxTurns: e.target.value })}
                  />
                </label>
                <label className="harness__field">
                  <span>Token budget</span>
                  <input
                    type="number"
                    min="1"
                    value={draft.tokenBudget}
                    disabled={draftLocked}
                    onChange={(e) => patchDraft({ tokenBudget: e.target.value })}
                  />
                </label>
              </div>
              <label className="harness__field">
                <span>System prompt</span>
                <textarea
                  rows={4}
                  value={draft.systemPrompt}
                  disabled={draftLocked}
                  onChange={(e) => patchDraft({ systemPrompt: e.target.value })}
                />
              </label>
              <label className="harness__check">
                <input
                  type="checkbox"
                  checked={draft.readOnly}
                  disabled={draftLocked}
                  onChange={(e) => patchDraft({ readOnly: e.target.checked })}
                />
                Read-only tools only
              </label>

              <fieldset className="harness__tools" disabled={draftLocked}>
                <legend>Tools</legend>
                <label className="harness__check">
                  <input
                    type="checkbox"
                    checked={draft.allTools}
                    onChange={(e) => patchDraft({ allTools: e.target.checked })}
                  />
                  All tools (*)
                </label>
                {!draft.allTools && (
                  <div className="harness__tools-grid">
                    {tools.map((tool) => (
                      <label key={tool.name} className="harness__check" title={tool.description}>
                        <input
                          type="checkbox"
                          checked={draft.tools.includes(tool.name)}
                          onChange={() => toggleDraftTool(tool.name)}
                        />
                        {tool.name}
                        <span className="harness__tag">{tool.category}</span>
                      </label>
                    ))}
                    {tools.length === 0 && (
                      <span className="harness__muted">No tools registered.</span>
                    )}
                  </div>
                )}
              </fieldset>

              <div className="harness__editor-actions">
                {!draftLocked && (
                  <button
                    type="submit"
                    className="harness__btn harness__btn--primary"
                    disabled={!draft.id.trim() || !draft.name.trim() || !draft.model.trim()}
                  >
                    Save profile
                  </button>
                )}
                <button
                  type="button"
                  className="harness__btn"
                  onClick={() => {
                    setDraft(null)
                    setDraftLocked(false)
                  }}
                >
                  Close
                </button>
              </div>
            </form>
          )}
        </section>

        {/* ---- run controls + monitor ---- */}
        <section className="harness__section">
          <div className="harness__section-head">
            <h2>Run</h2>
          </div>

          {directory === null && (
            <p className="harness__muted">Open a project folder to start a run.</p>
          )}

          <div className="harness__run">
            <select
              className="harness__select"
              value={runProfileId}
              onChange={(e) => setRunProfileId(e.target.value)}
            >
              <option value="" disabled>
                Pick a profile…
              </option>
              {profiles.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name} ({p.provider}/{p.model})
                </option>
              ))}
            </select>
            <textarea
              className="harness__task"
              rows={3}
              placeholder="Describe the task for the agent…"
              value={task}
              onChange={(e) => setTask(e.target.value)}
            />
            <div className="harness__run-actions">
              <button
                type="button"
                className="harness__btn harness__btn--primary"
                disabled={
                  starting || running || directory === null || !runProfileId || !task.trim()
                }
                onClick={() => void startRun()}
              >
                {starting ? 'Starting…' : 'Start run'}
              </button>
              <button
                type="button"
                className="harness__btn harness__btn--danger"
                disabled={!running}
                onClick={() => void stopHarnessRun()}
              >
                Stop
              </button>
              {activeRun !== null && (
                <span className="harness__run-status">
                  <StatusBadge status={activeRun.status} />
                  <span className="harness__muted">
                    {activeRun.turns} turn{activeRun.turns === 1 ? '' : 's'} ·{' '}
                    {activeRun.usage.input} in / {activeRun.usage.output} out
                  </span>
                </span>
              )}
            </div>
          </div>

          <div className="harness__monitor-wrap">
            <div className="harness__monitor" ref={monitorRef} onScroll={onMonitorScroll}>
            {activeRunId === null ? (
              <p className="harness__muted">No run yet — pick a profile and start one.</p>
            ) : entries.length === 0 ? (
              <p className="harness__muted">Waiting for the agent…</p>
            ) : (
              entries.map((entry, i) => {
                if (entry.kind === 'text') {
                  return (
                    <div key={i} className="harness__event harness__event--text">
                      {entry.text}
                    </div>
                  )
                }
                if (entry.kind === 'thinking') {
                  return (
                    <details key={i} className="harness__event harness__event--thinking">
                      <summary>Thinking ({entry.text.length} chars)…</summary>
                      <pre>{entry.text}</pre>
                    </details>
                  )
                }
                if (entry.kind === 'tool_call') {
                  const { icon, className } = getToolIconAndCategory(entry.name)
                  return (
                    <details key={i} className={`harness__event harness__event--tool ${className}`}>
                      <summary>
                        <span className="harness__tool-icon" aria-hidden="true">
                          {icon}
                        </span>
                        <span className="harness__tool-name">{entry.name}</span>
                      </summary>
                      <pre>{JSON.stringify(entry.args, null, 2)}</pre>
                    </details>
                  )
                }
                if (entry.kind === 'tool_result') {
                  const { icon, className } = getToolIconAndCategory(entry.name)
                  return (
                    <details
                      key={i}
                      className={
                        entry.error
                          ? `harness__event harness__event--tool harness__event--error ${className}`
                          : `harness__event harness__event--tool ${className}`
                      }
                    >
                      <summary>
                        <span className="harness__tool-icon" aria-hidden="true">
                          ⤷ {icon}
                        </span>
                        <span className="harness__tool-name">{entry.name}</span>
                        {entry.error && <span className="harness__tag harness__tag--error">error</span>}
                      </summary>
                      <pre>{entry.error ? `${entry.error}\n${entry.output}` : entry.output}</pre>
                    </details>
                  )
                }
                if (entry.kind === 'error') {
                  return (
                    <div key={i} className="harness__event harness__event--error">
                      {entry.message}
                    </div>
                  )
                }
                if (entry.kind === 'warning') {
                  return (
                    <div key={i} className="harness__event harness__event--warning">
                      Budget warning: {entry.field} used {entry.used} of {entry.limit}
                    </div>
                  )
                }
                return (
                  <div key={i} className="harness__event harness__event--done">
                    Done — {entry.result.finishReason} · {entry.result.turns} turns ·{' '}
                    {entry.result.toolCallCount} tool calls · {entry.result.usage.input} in /{' '}
                    {entry.result.usage.output} out
                    {entry.result.error ? ` · ${entry.result.error}` : ''}
                  </div>
                )
              })
            )}
            </div>
            {!monitorFollowing && entries.length > 0 && (
              <button
                type="button"
                className="harness__monitor-latest"
                onClick={() => {
                  setMonitorFollowing(true)
                  const el = monitorRef.current
                  if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
                }}
              >
                Jump to latest <span aria-hidden="true">↓</span>
              </button>
            )}
          </div>
        </section>
      </div>
    </div>
  )
}
