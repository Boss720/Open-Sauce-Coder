/**
 * DAG Runner — wave-by-wave parallel execution engine for agent workflows.
 *
 * Manages topological wave execution, concurrency throttling via Promise.allSettled,
 * safe template interpolation, condition and failure policy evaluations (abortOnFail,
 * skipOnFail), hierarchical cancellation propagation, and aggregated metrics tracking.
 */

import { randomUUID } from 'node:crypto'
import type { AgentProfile } from '../profiles'
import { ProfileStore, profileStore } from '../profileStore'
import { ProviderRegistry, providerRegistry } from '../providers/registry'
import type { ProviderAdapter } from '../providers/adapter'
import { ToolRegistry } from '../tools/registry'
import { registerBuiltins } from '../tools/builtins'
import { loadCustomTools } from '../tools/custom'
import { AgentRunner, type RunnerEvent } from '../runner'
import { interpolatePrompt } from './interpolator'
import type {
  DagEvent,
  DagExecutionPlan,
  DagNodeArtifact,
  DagNodeDefinition,
  DagNodeOutput,
  DagNodeState,
  DagRunState,
  DagRunStatus
} from './types'

export interface DagRunnerOptions {
  /** Aggregate input+output+reasoning token ceiling for the whole run. */
  maxRunTokens?: number
  /** Wall-clock ceiling for the whole run, in milliseconds. */
  maxRunDurationMs?: number
  dagRunId?: string
  maxConcurrency?: number
  signal?: AbortSignal
  profiles?: ProfileStore
  providers?: ProviderRegistry
  tools?: ToolRegistry
  runnerFactory?: (params: {
    id: string
    nodeId: string
    profile: AgentProfile
    adapter: ProviderAdapter
    tools: ToolRegistry
    directory: string
  }) => AgentRunner
}

/**
 * Worker-pool concurrency limiter executing tasks in parallel up to limit.
 */
async function runWithConcurrency<T>(
  tasks: Array<() => Promise<T>>,
  concurrency: number,
  shouldStop: () => boolean
): Promise<PromiseSettledResult<T>[]> {
  const results: PromiseSettledResult<T>[] = new Array(tasks.length)
  let nextIndex = 0

  async function worker(): Promise<void> {
    while (nextIndex < tasks.length) {
      if (shouldStop()) break
      const index = nextIndex++
      try {
        const value = await tasks[index]()
        results[index] = { status: 'fulfilled', value }
      } catch (reason) {
        results[index] = { status: 'rejected', reason }
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, tasks.length))
  const workers: Promise<void>[] = []
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker())
  }
  await Promise.allSettled(workers)
  return results
}

/** Hard ceiling on parallel node runs, whatever the caller asks for. */
export const MAX_NODE_CONCURRENCY = 8
/** Per-run defaults; budgets are otherwise only enforced per node. */
export const DEFAULT_MAX_RUN_TOKENS = 5_000_000
export const DEFAULT_MAX_RUN_DURATION_MS = 30 * 60 * 1000
/** Same 1..500 hard cap AgentProfile.maxTurns is held to. */
const MAX_PROFILE_TURNS = 500

/**
 * Applies a node's maxTurns override to its profile without ever exceeding the
 * profile's own cap, so a workflow cannot raise a limit the profile sets.
 */
function withNodeTurns(base: AgentProfile, nodeMaxTurns: number | undefined): AgentProfile {
  if (nodeMaxTurns === undefined) return base
  const ceiling = base.maxTurns ?? MAX_PROFILE_TURNS
  const requested = Number.isFinite(nodeMaxTurns) ? Math.floor(nodeMaxTurns) : ceiling
  return { ...base, maxTurns: Math.max(1, Math.min(requested, ceiling, MAX_PROFILE_TURNS)) }
}

export class DagRunner {
  readonly dagRunId: string
  readonly plan: DagExecutionPlan
  readonly directory: string
  readonly maxConcurrency: number

  status: DagRunStatus = 'pending'
  currentWaveIndex = 0
  startedAt = 0
  completedAt?: number
  error?: string

  readonly nodeOutputs = new Map<string, DagNodeOutput>()
  readonly nodeStates = new Map<string, DagNodeState>()
  readonly activeRunners = new Map<string, AgentRunner>()

  turns = 0
  totalUsage = { input: 0, output: 0, reasoning: 0 }

  private readonly abortController = new AbortController()
  private readonly profiles: ProfileStore
  private readonly providers: ProviderRegistry
  private readonly defaultTools?: ToolRegistry
  private readonly runnerFactory?: DagRunnerOptions['runnerFactory']
  private running = false
  private abortedOnFail = false
  private readonly maxRunTokens: number
  private readonly maxRunDurationMs: number

  constructor(plan: DagExecutionPlan, directory: string, options?: DagRunnerOptions) {
    this.plan = plan
    this.directory = directory
    this.dagRunId = options?.dagRunId ?? randomUUID()
    const requestedConcurrency = Number.isFinite(options?.maxConcurrency)
      ? Math.floor(options!.maxConcurrency as number)
      : 4
    this.maxConcurrency = Math.min(MAX_NODE_CONCURRENCY, Math.max(1, requestedConcurrency))
    this.maxRunTokens =
      options?.maxRunTokens !== undefined && options.maxRunTokens > 0
        ? options.maxRunTokens
        : DEFAULT_MAX_RUN_TOKENS
    this.maxRunDurationMs =
      options?.maxRunDurationMs !== undefined && options.maxRunDurationMs > 0
        ? options.maxRunDurationMs
        : DEFAULT_MAX_RUN_DURATION_MS
    this.profiles = options?.profiles ?? profileStore
    this.providers = options?.providers ?? providerRegistry
    this.defaultTools = options?.tools
    this.runnerFactory = options?.runnerFactory

    // Initialize all workflow nodes to pending
    for (const node of plan.workflow.nodes) {
      this.nodeStates.set(node.id, 'pending')
    }

    if (options?.signal) {
      if (options.signal.aborted) {
        this.abort()
      } else {
        options.signal.addEventListener('abort', () => this.abort(), { once: true })
      }
    }
  }

  /**
   * Hierarchical abort: triggers master abort signal, stops future wave dispatch,
   * cascades abort() to all active node runners in flight, and marks status cancelled.
   */
  abort(): void {
    if (this.status === 'completed' || this.status === 'failed' || this.status === 'cancelled') {
      return
    }
    this.status = 'cancelled'
    this.completedAt = Date.now()
    this.abortController.abort()

    for (const runner of this.activeRunners.values()) {
      try {
        runner.abort()
      } catch {
        // Suppress individual runner abort exceptions
      }
    }
  }

  /**
   * Snapshot of current DAG execution state.
   */
  getState(): DagRunState {
    return {
      dagRunId: this.dagRunId,
      workflowId: this.plan.workflow.id,
      status: this.status,
      waves: this.plan.waves,
      currentWaveIndex: this.currentWaveIndex,
      nodeOutputs: Object.fromEntries(this.nodeOutputs),
      nodeStates: Object.fromEntries(this.nodeStates),
      startedAt: this.startedAt,
      completedAt: this.completedAt,
      error: this.error
    }
  }

  /**
   * Returns accumulated metrics across all completed nodes.
   */
  getMetrics(): { turns: number; totalUsage: { input: number; output: number; reasoning: number } } {
    return {
      turns: this.turns,
      totalUsage: { ...this.totalUsage }
    }
  }

  /**
   * Evaluates condition policy on a node against completed upstream node outputs.
   */
  private evaluateCondition(nodeDef: DagNodeDefinition): boolean {
    if (!nodeDef.policy?.condition) {
      return true
    }
    const cond = nodeDef.policy.condition
    const upstreamOutput = this.nodeOutputs.get(cond.upstreamNodeId)
    const upstreamStatus = upstreamOutput ? upstreamOutput.status : this.nodeStates.get(cond.upstreamNodeId)

    if (cond.expectedStatus !== undefined && upstreamStatus !== cond.expectedStatus) {
      return false
    }
    if (cond.expectedFinishReason !== undefined && upstreamOutput?.finishReason !== cond.expectedFinishReason) {
      return false
    }
    return true
  }

  /**
   * Verifies that all upstream dependencies succeeded or are covered by an explicit condition.
   */
  private checkDependenciesReady(nodeDef: DagNodeDefinition): boolean {
    const deps = nodeDef.dependencies ?? []
    for (const depId of deps) {
      const depState = this.nodeStates.get(depId)
      if (depState === 'failed' || depState === 'skipped') {
        const coversDep = nodeDef.policy?.condition?.upstreamNodeId === depId
        if (!coversDep) {
          return false
        }
      } else if (depState !== 'succeeded') {
        return false
      }
    }
    return true
  }

  private markNodeSkipped(
    nodeDef: DagNodeDefinition,
    waveIndex: number,
    finishReason: string,
    emitEvent: (e: DagEvent) => void
  ): void {
    this.nodeStates.set(nodeDef.id, 'skipped')
    const output: DagNodeOutput = {
      nodeId: nodeDef.id,
      status: 'skipped',
      finishReason,
      content: '',
      turns: 0,
      usage: { input: 0, output: 0, reasoning: 0 }
    }
    this.nodeOutputs.set(nodeDef.id, output)
    emitEvent({
      type: 'dag_node_complete',
      dagRunId: this.dagRunId,
      timestamp: Date.now(),
      waveIndex,
      nodeId: nodeDef.id,
      status: 'skipped',
      output
    })
  }

  /**
   * Stops the run as failed: records why, prevents further dispatch, and aborts
   * every in-flight node. Unlike abort(), the run ends 'failed', not 'cancelled'.
   */
  private haltRun(reason: string): void {
    if (this.abortedOnFail || this.abortController.signal.aborted) return
    this.abortedOnFail = true
    if (!this.error) this.error = reason
    for (const runner of this.activeRunners.values()) {
      try {
        runner.abort()
      } catch {
        // ignore
      }
    }
  }

  private handleNodeFailure(
    nodeDef: DagNodeDefinition,
    waveIndex: number,
    errorMessage: string,
    emitEvent: (event: DagEvent) => void,
    finishReason = 'error',
    turns = 0,
    usage = { input: 0, output: 0, reasoning: 0 },
    content = '',
    artifacts: DagNodeArtifact[] = []
  ): void {
    this.nodeStates.set(nodeDef.id, 'failed')
    const output: DagNodeOutput = {
      nodeId: nodeDef.id,
      status: 'failed',
      finishReason,
      content,
      artifacts,
      turns,
      usage: {
        input: usage.input,
        output: usage.output,
        reasoning: usage.reasoning ?? 0
      },
      error: errorMessage
    }
    this.nodeOutputs.set(nodeDef.id, output)
    emitEvent({
      type: 'dag_node_complete',
      dagRunId: this.dagRunId,
      timestamp: Date.now(),
      waveIndex,
      nodeId: nodeDef.id,
      status: 'failed',
      output,
      error: errorMessage
    })

    if (nodeDef.policy?.abortOnFail) {
      this.haltRun(`Node "${nodeDef.id}" failed with abortOnFail: ${errorMessage}`)
    }
  }

  private async executeNode(
    nodeDef: DagNodeDefinition,
    waveIndex: number,
    emitEvent: (event: DagEvent) => void
  ): Promise<void> {
    if (this.abortController.signal.aborted || this.abortedOnFail) {
      return
    }

    this.nodeStates.set(nodeDef.id, 'running')
    emitEvent({
      type: 'dag_node_start',
      dagRunId: this.dagRunId,
      timestamp: Date.now(),
      waveIndex,
      nodeId: nodeDef.id,
      status: 'running'
    })

    // Interpolate template parameters from upstream outputs
    let interpolatedPrompt: string
    try {
      interpolatedPrompt = interpolatePrompt(
        nodeDef.prompt,
        this.nodeOutputs,
        nodeDef.dependencies ?? [],
        { strict: true }
      )
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.handleNodeFailure(nodeDef, waveIndex, errMsg, emitEvent)
      return
    }

    // Resolve profile and provider adapter
    let profile: AgentProfile
    let adapter: ProviderAdapter

    if (this.runnerFactory) {
      const baseProfile = this.profiles.get(nodeDef.profileId) ?? {
        id: nodeDef.profileId,
        name: nodeDef.profileId,
        provider: 'mock',
        model: 'mock'
      }
      profile = withNodeTurns(baseProfile, nodeDef.maxTurns)
      adapter = this.providers.isSupported(profile.provider)
        ? this.providers.resolve(profile.provider)
        : ({
            id: profile.provider,
            chat: async () => ({ id: 'mock', content: '', finishReason: 'stop', usage: { input: 0, output: 0 } }),
            abort: () => {},
            probe: async () => true
          } as unknown as ProviderAdapter)
    } else {
      const baseProfile = this.profiles.get(nodeDef.profileId)
      if (!baseProfile) {
        this.handleNodeFailure(nodeDef, waveIndex, `Profile not found: "${nodeDef.profileId}".`, emitEvent)
        return
      }
      profile = withNodeTurns(baseProfile, nodeDef.maxTurns)

      if (!this.providers.isSupported(profile.provider)) {
        this.handleNodeFailure(
          nodeDef,
          waveIndex,
          `Provider "${profile.provider}" is not supported by harness.`,
          emitEvent
        )
        return
      }
      adapter = this.providers.resolve(profile.provider)
    }

    // Build tool registry with artifact interception
    const nodeArtifacts: DagNodeArtifact[] = []
    const nodeTools = new ToolRegistry()

    const sourceTools = this.defaultTools ?? (() => {
      const registry = new ToolRegistry()
      registerBuiltins(registry)
      try {
        loadCustomTools(registry, this.directory)
      } catch {
        // Fall back to builtins if custom directory loading encounters errors
      }
      return registry
    })()

    for (const def of sourceTools.forProfile(profile)) {
      const reg = sourceTools.resolve(def.name)
      if (reg) {
        nodeTools.register(reg.definition, async (args, ctx) => {
          const res = await reg.executor(args, ctx)
          if (res.artifacts) {
            nodeArtifacts.push(...res.artifacts)
          }
          return res
        })
      }
    }

    const runnerId = `${this.dagRunId}-${nodeDef.id}`
    const runner = this.runnerFactory
      ? this.runnerFactory({
          id: runnerId,
          nodeId: nodeDef.id,
          profile,
          adapter,
          tools: nodeTools,
          directory: this.directory
        })
      : new AgentRunner({
          id: runnerId,
          profile,
          adapter,
          tools: nodeTools,
          directory: this.directory
        })

    this.activeRunners.set(nodeDef.id, runner)

    try {
      const result = await runner.run(interpolatedPrompt, (runnerEvent: RunnerEvent) => {
        emitEvent({
          type: 'dag_node_event',
          dagRunId: this.dagRunId,
          timestamp: Date.now(),
          waveIndex,
          nodeId: nodeDef.id,
          event: runnerEvent
        })
      })

      this.activeRunners.delete(nodeDef.id)

      // Aggregate metrics
      this.turns += result.turns
      this.totalUsage.input += result.usage.input
      this.totalUsage.output += result.usage.output
      this.totalUsage.reasoning += (result.usage.reasoning ?? 0)

      const spent = this.totalUsage.input + this.totalUsage.output + this.totalUsage.reasoning
      if (spent > this.maxRunTokens) {
        this.haltRun(
          `Run token budget exceeded: ${spent} tokens used, limit ${this.maxRunTokens}.`
        )
      }

      if (result.finishReason === 'complete') {
        const output: DagNodeOutput = {
          nodeId: nodeDef.id,
          status: 'succeeded',
          finishReason: result.finishReason,
          content: result.content,
          artifacts: nodeArtifacts,
          turns: result.turns,
          usage: {
            input: result.usage.input,
            output: result.usage.output,
            reasoning: result.usage.reasoning ?? 0
          }
        }
        this.nodeStates.set(nodeDef.id, 'succeeded')
        this.nodeOutputs.set(nodeDef.id, output)
        emitEvent({
          type: 'dag_node_complete',
          dagRunId: this.dagRunId,
          timestamp: Date.now(),
          waveIndex,
          nodeId: nodeDef.id,
          status: 'succeeded',
          output
        })
      } else {
        const errMsg = result.error ?? `Node execution terminated with finishReason: "${result.finishReason}".`
        this.handleNodeFailure(
          nodeDef,
          waveIndex,
          errMsg,
          emitEvent,
          result.finishReason,
          result.turns,
          {
            input: result.usage.input,
            output: result.usage.output,
            reasoning: result.usage.reasoning ?? 0
          },
          result.content,
          nodeArtifacts
        )
      }
    } catch (err) {
      this.activeRunners.delete(nodeDef.id)
      const errMsg = err instanceof Error ? err.message : String(err)
      this.handleNodeFailure(nodeDef, waveIndex, errMsg, emitEvent)
    }
  }

  /**
   * Main DAG execution loop: iterates waves sequentially, executes nodes concurrently,
   * evaluates conditions and failure policies, and collects outputs.
   */
  async run(onEvent?: (event: DagEvent) => void): Promise<DagRunState> {
    if (this.running) {
      throw new Error(`DAG run ${this.dagRunId} has already been started.`)
    }
    this.running = true
    this.startedAt = Date.now()

    // A throwing listener (e.g. a destroyed webContents) must never be able to
    // fail a node that succeeded or reject run().
    const emitEvent = (event: DagEvent): void => {
      try {
        onEvent?.(event)
      } catch {
        // listener errors are not run failures
      }
    }

    if (this.abortController.signal.aborted || this.status === 'cancelled') {
      this.status = 'cancelled'
      this.completedAt = Date.now()
      emitEvent({
        type: 'dag_complete',
        dagRunId: this.dagRunId,
        timestamp: Date.now(),
        status: 'cancelled'
      })
      return this.getState()
    }

    const runTimer = setTimeout(() => {
      this.haltRun(`Run exceeded its ${this.maxRunDurationMs}ms time limit.`)
    }, this.maxRunDurationMs)
    runTimer.unref?.()

    this.status = 'running'
    emitEvent({
      type: 'dag_start',
      dagRunId: this.dagRunId,
      timestamp: Date.now(),
      status: 'running'
    })

    const nodeMap = new Map<string, DagNodeDefinition>()
    for (const node of this.plan.workflow.nodes) {
      nodeMap.set(node.id, node)
    }

    for (let waveIndex = 0; waveIndex < this.plan.waves.length; waveIndex++) {
      if (this.abortController.signal.aborted || this.abortedOnFail) {
        break
      }

      this.currentWaveIndex = waveIndex
      const wave = this.plan.waves[waveIndex]

      emitEvent({
        type: 'dag_wave_start',
        dagRunId: this.dagRunId,
        timestamp: Date.now(),
        waveIndex
      })

      const eligibleNodes: DagNodeDefinition[] = []

      for (const nodeId of wave.nodeIds) {
        const nodeDef = nodeMap.get(nodeId)
        if (!nodeDef) continue

        // Check condition gating
        const condPassed = this.evaluateCondition(nodeDef)
        if (!condPassed) {
          this.markNodeSkipped(nodeDef, waveIndex, 'condition_unmet', emitEvent)
          continue
        }

        // Check upstream dependency status
        const depsReady = this.checkDependenciesReady(nodeDef)
        if (!depsReady) {
          this.markNodeSkipped(nodeDef, waveIndex, 'upstream_failed', emitEvent)
          continue
        }

        eligibleNodes.push(nodeDef)
      }

      // Execute eligible nodes with concurrency throttling
      if (eligibleNodes.length > 0) {
        const tasks = eligibleNodes.map((nodeDef) => () => this.executeNode(nodeDef, waveIndex, emitEvent))
        const settled = await runWithConcurrency(
          tasks,
          this.maxConcurrency,
          () => this.abortController.signal.aborted || this.abortedOnFail
        )

        // executeNode can reject before its own try/catch is reached (profile
        // lookup, provider resolution, tool registry, runner construction).
        // Those rejections must be recorded, or the node is left 'running' and
        // the run reports 'completed' despite having failed.
        settled.forEach((result, index) => {
          if (result?.status !== 'rejected') return
          const nodeDef = eligibleNodes[index]
          if (!nodeDef) return
          if (this.nodeStates.get(nodeDef.id) === 'failed') return
          this.handleNodeFailure(
            nodeDef,
            waveIndex,
            result.reason instanceof Error ? result.reason.message : String(result.reason),
            emitEvent
          )
        })
      }

      emitEvent({
        type: 'dag_wave_complete',
        dagRunId: this.dagRunId,
        timestamp: Date.now(),
        waveIndex
      })

      if (this.abortedOnFail || this.abortController.signal.aborted) {
        break
      }
    }

    clearTimeout(runTimer)
    this.completedAt = Date.now()

    if ((this.status as DagRunStatus) === 'cancelled' || this.abortController.signal.aborted) {
      this.status = 'cancelled'
    } else if (this.abortedOnFail) {
      this.status = 'failed'
    } else {
      const states = Array.from(this.nodeStates.entries())
      const anyNodeFailed = states.some(([, st]) => st === 'failed')
      // A node still 'pending' or 'running' after the loop never reached a
      // terminal state, so the run did not actually succeed.
      const stranded = states
        .filter(([, st]) => st === 'pending' || st === 'running')
        .map(([id]) => id)
      if (anyNodeFailed || stranded.length > 0) {
        this.status = 'failed'
        if (!this.error && stranded.length > 0) {
          this.error = `Run ended with ${stranded.length} node(s) in a non-terminal state: ${stranded.join(', ')}.`
        }
      } else {
        this.status = 'completed'
      }
    }

    if (this.status === 'failed') {
      emitEvent({
        type: 'dag_error',
        dagRunId: this.dagRunId,
        timestamp: Date.now(),
        status: 'failed',
        error: this.error
      })
    }

    emitEvent({
      type: 'dag_complete',
      dagRunId: this.dagRunId,
      timestamp: Date.now(),
      status: this.status,
      error: this.error
    })

    return this.getState()
  }
}
