/**
 * Harness controller — main-process entry point for the agentic harness.
 *
 * Manages profile CRUD, run lifecycle, and tool listing.
 * IPC handlers in ipc.ts delegate to this controller.
 */
import { randomUUID } from 'node:crypto'
import type { AgentProfile } from './profiles'
import { ProfileStore, profileStore } from './profileStore'
import { AgentRunner, type RunnerEvent, type RunnerResult } from './runner'
import { ToolRegistry, type ToolDefinition } from './tools/registry'
import { registerBuiltins } from './tools/builtins'
import { loadCustomTools } from './tools/custom'
import { ProviderRegistry, providerRegistry } from './providers/registry'

export type RunStatus = {
  id: string
  profileId: string
  status: 'running' | 'completed' | 'failed' | 'cancelled'
  turns: number
  usage: { input: number; output: number }
  startedAt: number
  completedAt?: number
  result?: RunnerResult
  error?: string
}

export type EventCallback = (runId: string, event: RunnerEvent) => void

export class HarnessController {
  private readonly profiles: ProfileStore
  private readonly providers: ProviderRegistry
  private readonly tools: ToolRegistry
  private readonly runs = new Map<string, { runner: AgentRunner; status: RunStatus }>()
  private onEvent: EventCallback | null = null

  constructor(
    profiles?: ProfileStore,
    providers?: ProviderRegistry
  ) {
    this.profiles = profiles ?? profileStore
    this.providers = providers ?? providerRegistry
    this.tools = new ToolRegistry()
    registerBuiltins(this.tools)
  }

  /** Set the event callback for forwarding runner events to the renderer. */
  setEventCallback(callback: EventCallback): void {
    this.onEvent = callback
  }

  // ── Profile CRUD ──

  listProfiles(): AgentProfile[] {
    return this.profiles.list()
  }

  getProfile(id: string): AgentProfile | undefined {
    return this.profiles.get(id)
  }

  async saveProfile(raw: unknown): Promise<AgentProfile> {
    return this.profiles.save(raw)
  }

  async deleteProfile(id: string): Promise<boolean> {
    return this.profiles.delete(id)
  }

  async testProfile(id: string): Promise<boolean> {
    const profile = this.profiles.get(id)
    if (!profile) return false
    return this.providers.probe(profile.provider)
  }

  // ── Run lifecycle ──

  async startRun(params: {
    profileId: string
    task: string
    directory: string
  }): Promise<string> {
    const profile = this.profiles.get(params.profileId)
    if (!profile) {
      throw new Error(`Profile not found: "${params.profileId}".`)
    }

    if (!this.providers.isSupported(profile.provider)) {
      throw new Error(
        `Provider "${profile.provider}" is not supported by the harness. ` +
        `Supported: ${this.providers.list().join(', ')}.`
      )
    }

    const adapter = this.providers.resolve(profile.provider)
    const runId = randomUUID()

    // Per-run tool registry: builtins plus any custom tools defined under the
    // run's own project directory, so tools from one project never leak into
    // a run rooted at another.
    const runTools = new ToolRegistry()
    registerBuiltins(runTools)
    loadCustomTools(runTools, params.directory)

    const runner = new AgentRunner({
      id: runId,
      profile,
      adapter,
      tools: runTools,
      directory: params.directory
    })

    const status: RunStatus = {
      id: runId,
      profileId: params.profileId,
      status: 'running',
      turns: 0,
      usage: { input: 0, output: 0 },
      startedAt: Date.now()
    }

    this.runs.set(runId, { runner, status })

    // Fire-and-forget — events stream back through onEvent
    void runner.run(params.task, (event) => {
      // Update status from runner on each event
      const live = runner.getStatus()
      status.turns = live.turns
      status.usage = { input: live.usage.input, output: live.usage.output }

      if (event.type === 'done') {
        if (status.status !== 'cancelled') {
          status.status = event.result.finishReason === 'complete' ? 'completed'
            : event.result.finishReason === 'aborted' ? 'cancelled'
              : 'failed'
        }
        status.completedAt = Date.now()
        status.result = event.result
        if (event.result.error) status.error = event.result.error
      }

      if (event.type === 'error' && status.status === 'running') {
        status.status = 'failed'
        status.completedAt = Date.now()
        status.error = event.message
      }

      this.onEvent?.(runId, event)
    }).catch((error: unknown) => {
      if (status.status !== 'cancelled') {
        status.status = 'failed'
        status.completedAt = Date.now()
        status.error = error instanceof Error ? error.message : String(error)
      }
      this.onEvent?.(runId, { type: 'error', message: status.error ?? 'Unknown error' })
    })

    return runId
  }

  stopRun(runId: string): void {
    const run = this.runs.get(runId)
    if (!run || run.status.status !== 'running') return
    run.runner.abort()
    run.status.status = 'cancelled'
    run.status.completedAt = Date.now()
  }

  getRunStatus(runId: string): RunStatus | undefined {
    const run = this.runs.get(runId)
    if (!run) return undefined

    // Sync live metrics for running tasks
    if (run.status.status === 'running') {
      const live = run.runner.getStatus()
      run.status.turns = live.turns
      run.status.usage = { input: live.usage.input, output: live.usage.output }
    }

    return { ...run.status }
  }

  listRuns(): RunStatus[] {
    return [...this.runs.values()].map((r) => ({ ...r.status }))
  }

  // ── Tools ──

  listTools(): ToolDefinition[] {
    return this.tools.listAll()
  }
}

/** Main-process singleton. Lazy construction — no I/O at import time. */
let singleton: HarnessController | null = null

export function getHarnessController(): HarnessController {
  if (!singleton) {
    singleton = new HarnessController()
  }
  return singleton
}
