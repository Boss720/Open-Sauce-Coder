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

  constructor(plan: DagExecutionPlan, directory: string, options?: DagRunnerOptions) {
    this.plan = plan
    this.directory = directory
    this.dagRunId = options?.dagRunId ?? randomUUID()
    this.maxConcurrency = Math.max(1, options?.maxConcurrency ?? 4)
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
      this.abortedOnFail = true
      this.error = `Node "${nodeDef.id}" failed with abortOnFail: ${errorMessage}`
      for (const runner of this.activeRunners.values()) {
        try {
          runner.abort()
        } catch {
          // ignore
        }
      }
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
      profile = nodeDef.maxTurns !== undefined
        ? { ...baseProfile, maxTurns: nodeDef.maxTurns }
        : baseProfile
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
      profile = nodeDef.maxTurns !== undefined
        ? { ...baseProfile, maxTurns: nodeDef.maxTurns }
        : baseProfile

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

    if (this.defaultTools) {
      for (const def of this.defaultTools.forProfile(profile)) {
        const reg = this.defaultTools.resolve(def.name)
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
    } else {
      registerBuiltins(nodeTools)
      try {
        loadCustomTools(nodeTools, this.directory)
      } catch {
        // Fall back to builtins if custom directory loading encounters errors
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
    this.running = true
    this.startedAt = Date.now()

    const emitEvent = (event: DagEvent): void => {
      onEvent?.(event)
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
        await runWithConcurrency(
          tasks,
          this.maxConcurrency,
          () => this.abortController.signal.aborted || this.abortedOnFail
        )
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

    this.completedAt = Date.now()

    if ((this.status as DagRunStatus) === 'cancelled' || this.abortController.signal.aborted) {
      this.status = 'cancelled'
    } else if (this.abortedOnFail) {
      this.status = 'failed'
    } else {
      const anyNodeFailed = Array.from(this.nodeStates.values()).some((st) => st === 'failed')
      if (anyNodeFailed) {
        this.status = 'failed'
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
