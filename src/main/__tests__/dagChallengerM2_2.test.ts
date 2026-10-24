/**
 * Challenger 2 (teamwork_preview_challenger_m2_2) Empirical Stress-Testing Suite for Milestone M2.
 *
 * Verifies property invariants:
 * 1. Metric aggregation invariants: total input/output/reasoning tokens and turns must equal
 *    the exact sum of individual node outputs.
 * 2. Lifecycle state invariants: completed runs must have timestamps, cancelled runs must terminate
 *    in 'cancelled' state with aborted children.
 * 3. Event stream invariants: every node must emit dag_node_start before dag_node_complete, and
 *    every wave must emit dag_wave_start before dag_wave_complete.
 */

import { describe, expect, it, vi } from 'vitest'
import { DagRunner } from '../harness/dag/runner'
import { DagController } from '../harness/dag/controller'
import type {
  DagEvent,
  DagExecutionPlan,
  DagNodeDefinition,
  WorkflowDefinition
} from '../harness/dag/types'
import type { AgentRunner, RunnerEvent, RunnerResult } from '../harness/runner'
import type { AgentProfile } from '../harness/profiles'
import type { ProviderAdapter } from '../harness/providers/adapter'
import { ToolRegistry } from '../harness/tools/registry'
import { tmpdir } from 'node:os'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'

// Pseudo-random generator for reproducible property tests
function makeRng(seed = 1337) {
  let s = seed
  return function rand(): number {
    s = (s * 1664525 + 1013904223) % 4294967296
    return s / 4294967296
  }
}

function makeNode(overrides: Partial<DagNodeDefinition> = {}): DagNodeDefinition {
  return {
    id: 'node-' + Math.random().toString(36).slice(2, 7),
    profileId: 'mock-profile',
    prompt: 'Execute task',
    dependencies: [],
    ...overrides
  }
}

interface MockBehavior {
  result?: Partial<RunnerResult>
  delayMs?: number
  shouldThrow?: Error
  onRun?: (prompt: string, onEvent: (e: RunnerEvent) => void) => void | Promise<void>
}

function createHarnessFactory(behaviors: Record<string, MockBehavior> = {}) {
  const runnerInstances = new Map<string, { abort: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> }>()
  let activeCount = 0
  let peakActive = 0

  const factory = (params: {
    id: string
    nodeId: string
    profile: AgentProfile
    adapter: ProviderAdapter
    tools: ToolRegistry
    directory: string
  }) => {
    const b = behaviors[params.nodeId] ?? {}
    const abortFn = vi.fn()

    const runFn = vi.fn(async (prompt: string, onEvent: (e: RunnerEvent) => void): Promise<RunnerResult> => {
      activeCount++
      if (activeCount > peakActive) {
        peakActive = activeCount
      }

      if (b.delayMs) {
        await new Promise((resolve) => setTimeout(resolve, b.delayMs))
      }

      if (b.onRun) {
        await b.onRun(prompt, onEvent)
      }

      activeCount--

      if (b.shouldThrow) {
        throw b.shouldThrow
      }

      const res = b.result ?? {}
      return {
        content: res.content ?? `Result from ${params.nodeId}`,
        toolCallCount: res.toolCallCount ?? 0,
        usage: res.usage ?? { input: 10, output: 20, reasoning: 5 },
        turns: res.turns ?? 1,
        finishReason: res.finishReason ?? 'complete',
        error: res.error
      }
    })

    const mock = {
      id: params.id,
      run: runFn,
      abort: abortFn,
      getStatus: vi.fn(() => ({ turns: 1, usage: { input: 10, output: 20 }, running: false }))
    }

    runnerInstances.set(params.nodeId, mock)
    return mock as unknown as AgentRunner
  }

  return {
    factory,
    runnerInstances,
    getPeakActive: () => peakActive
  }
}

describe('Challenger 2 Empirical Invariant Suite (Milestone M2)', () => {
  // ──────────────────────────────────────────────────────────────────────────
  // 1. Metric Aggregation Invariants
  // ──────────────────────────────────────────────────────────────────────────
  describe('Invariant 1: Metric Aggregation Invariant', () => {
    it('verifies exact sum equality of input, output, reasoning tokens and turns across random DAG topologies', async () => {
      const rng = makeRng(2026)

      for (let run = 0; run < 15; run++) {
        const waveCount = 2 + Math.floor(rng() * 4) // 2 to 5 waves
        const nodes: DagNodeDefinition[] = []
        const waves: Array<{ waveIndex: number; nodeIds: string[] }> = []
        const behaviors: Record<string, MockBehavior> = {}

        let expectedInput = 0
        let expectedOutput = 0
        let expectedReasoning = 0
        let expectedTurns = 0

        for (let w = 0; w < waveCount; w++) {
          const nodesInWave = 1 + Math.floor(rng() * 4) // 1 to 4 nodes per wave
          const nodeIds: string[] = []

          for (let i = 0; i < nodesInWave; i++) {
            const nodeId = `w${w}_n${i}`
            nodeIds.push(nodeId)

            const inputTokens = Math.floor(rng() * 500)
            const outputTokens = Math.floor(rng() * 300)
            const reasoningTokens = Math.floor(rng() * 100)
            const turns = 1 + Math.floor(rng() * 5)

            expectedInput += inputTokens
            expectedOutput += outputTokens
            expectedReasoning += reasoningTokens
            expectedTurns += turns

            behaviors[nodeId] = {
              result: {
                turns,
                usage: {
                  input: inputTokens,
                  output: outputTokens,
                  reasoning: reasoningTokens
                },
                finishReason: 'complete'
              }
            }

            nodes.push(
              makeNode({
                id: nodeId,
                dependencies: w > 0 ? waves[w - 1].nodeIds.slice(0, 1) : []
              })
            )
          }

          waves.push({ waveIndex: w, nodeIds })
        }

        const plan: DagExecutionPlan = {
          workflow: { id: `agg-wf-${run}`, name: `Aggregation WF ${run}`, nodes },
          waves
        }

        const { factory } = createHarnessFactory(behaviors)
        const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory, maxConcurrency: 3 })
        const state = await runner.run()

        expect(state.status).toBe('completed')

        // Direct runner property checks
        expect(runner.turns).toBe(expectedTurns)
        expect(runner.totalUsage.input).toBe(expectedInput)
        expect(runner.totalUsage.output).toBe(expectedOutput)
        expect(runner.totalUsage.reasoning).toBe(expectedReasoning)

        // getMetrics() method checks
        const metrics = runner.getMetrics()
        expect(metrics.turns).toBe(expectedTurns)
        expect(metrics.totalUsage.input).toBe(expectedInput)
        expect(metrics.totalUsage.output).toBe(expectedOutput)
        expect(metrics.totalUsage.reasoning).toBe(expectedReasoning)

        // Exact sum across all nodeOutputs
        let sumNodeInput = 0
        let sumNodeOutput = 0
        let sumNodeReasoning = 0
        let sumNodeTurns = 0

        for (const out of runner.nodeOutputs.values()) {
          sumNodeInput += out.usage.input
          sumNodeOutput += out.usage.output
          sumNodeReasoning += out.usage.reasoning ?? 0
          sumNodeTurns += out.turns
        }

        expect(sumNodeInput).toBe(expectedInput)
        expect(sumNodeOutput).toBe(expectedOutput)
        expect(sumNodeReasoning).toBe(expectedReasoning)
        expect(sumNodeTurns).toBe(expectedTurns)
      }
    })

    it('verifies exact metric aggregation with zero tokens, missing reasoning tokens, and 1,000,000+ tokens', async () => {
      const nodeZero = makeNode({ id: 'zero' })
      const nodeNoReasoning = makeNode({ id: 'no-reasoning' })
      const nodeMillion = makeNode({ id: 'million' })

      const plan: DagExecutionPlan = {
        workflow: {
          id: 'edge-metrics-wf',
          name: 'Edge Metrics WF',
          nodes: [nodeZero, nodeNoReasoning, nodeMillion]
        },
        waves: [{ waveIndex: 0, nodeIds: ['zero', 'no-reasoning', 'million'] }]
      }

      const { factory } = createHarnessFactory({
        zero: {
          result: { turns: 0, usage: { input: 0, output: 0, reasoning: 0 } }
        },
        'no-reasoning': {
          result: { turns: 2, usage: { input: 50, output: 25 } } // reasoning undefined
        },
        million: {
          result: { turns: 10, usage: { input: 1_250_000, output: 350_000, reasoning: 120_000 } }
        }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      await runner.run()

      const metrics = runner.getMetrics()
      expect(metrics.turns).toBe(12)
      expect(metrics.totalUsage.input).toBe(1_250_050)
      expect(metrics.totalUsage.output).toBe(350_025)
      expect(metrics.totalUsage.reasoning).toBe(120_000)

      // Invariant: runner metrics equal exact sum of node outputs
      const outputs = Array.from(runner.nodeOutputs.values())
      const sumInput = outputs.reduce((sum, o) => sum + o.usage.input, 0)
      const sumOutput = outputs.reduce((sum, o) => sum + o.usage.output, 0)
      const sumReasoning = outputs.reduce((sum, o) => sum + (o.usage.reasoning ?? 0), 0)
      const sumTurns = outputs.reduce((sum, o) => sum + o.turns, 0)

      expect(metrics.totalUsage.input).toBe(sumInput)
      expect(metrics.totalUsage.output).toBe(sumOutput)
      expect(metrics.totalUsage.reasoning).toBe(sumReasoning)
      expect(metrics.turns).toBe(sumTurns)
    })

    it('verifies metric aggregation holds under mixed outcomes (succeeded, failed, skipped, thrown error)', async () => {
      const nodeOk = makeNode({ id: 'node-ok' })
      const nodeFail = makeNode({ id: 'node-fail', policy: { skipOnFail: true } })
      const nodeThrow = makeNode({ id: 'node-throw', policy: { skipOnFail: true } })
      const nodeSkippedDep = makeNode({
        id: 'node-skip-dep',
        dependencies: ['node-fail'],
        policy: { skipOnFail: true }
      })
      const nodeSkippedCond = makeNode({
        id: 'node-skip-cond',
        dependencies: ['node-ok'],
        policy: { condition: { upstreamNodeId: 'node-ok', expectedFinishReason: 'budget_exceeded' } }
      })

      const plan: DagExecutionPlan = {
        workflow: {
          id: 'mixed-wf',
          name: 'Mixed Outcomes WF',
          nodes: [nodeOk, nodeFail, nodeThrow, nodeSkippedDep, nodeSkippedCond]
        },
        waves: [
          { waveIndex: 0, nodeIds: ['node-ok', 'node-fail', 'node-throw'] },
          { waveIndex: 1, nodeIds: ['node-skip-dep', 'node-skip-cond'] }
        ]
      }

      const { factory } = createHarnessFactory({
        'node-ok': {
          result: { turns: 3, usage: { input: 100, output: 50, reasoning: 20 }, finishReason: 'complete' }
        },
        'node-fail': {
          result: {
            turns: 2,
            usage: { input: 60, output: 30, reasoning: 10 },
            finishReason: 'budget_exceeded',
            error: 'Budget blown'
          }
        },
        'node-throw': {
          shouldThrow: new Error('Network crash')
        }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      await runner.run()

      // Node outcomes:
      // node-ok: succeeded (turns: 3, input: 100, output: 50, reasoning: 20)
      // node-fail: failed (turns: 2, input: 60, output: 30, reasoning: 10)
      // node-throw: failed due to thrown error (turns: 0, input: 0, output: 0, reasoning: 0)
      // node-skip-dep: skipped (turns: 0, input: 0, output: 0, reasoning: 0)
      // node-skip-cond: skipped (turns: 0, input: 0, output: 0, reasoning: 0)

      const metrics = runner.getMetrics()
      expect(metrics.turns).toBe(5)
      expect(metrics.totalUsage.input).toBe(160)
      expect(metrics.totalUsage.output).toBe(80)
      expect(metrics.totalUsage.reasoning).toBe(30)

      // Invariant: sum of all nodeOutputs matches metrics
      const outputs = Array.from(runner.nodeOutputs.values())
      const sumInput = outputs.reduce((acc, o) => acc + o.usage.input, 0)
      const sumOutput = outputs.reduce((acc, o) => acc + o.usage.output, 0)
      const sumReasoning = outputs.reduce((acc, o) => acc + (o.usage.reasoning ?? 0), 0)
      const sumTurns = outputs.reduce((acc, o) => acc + o.turns, 0)

      expect(metrics.totalUsage.input).toBe(sumInput)
      expect(metrics.totalUsage.output).toBe(sumOutput)
      expect(metrics.totalUsage.reasoning).toBe(sumReasoning)
      expect(metrics.turns).toBe(sumTurns)
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 2. Lifecycle State Invariants
  // ──────────────────────────────────────────────────────────────────────────
  describe('Invariant 2: Lifecycle State Invariants', () => {
    it('verifies completed runs have valid timestamps satisfying completedAt >= startedAt > 0', async () => {
      const nodeA = makeNode({ id: 'a' })
      const plan: DagExecutionPlan = {
        workflow: { id: 'lifecycle-completed-wf', name: 'Lifecycle Completed', nodes: [nodeA] },
        waves: [{ waveIndex: 0, nodeIds: ['a'] }]
      }

      const { factory } = createHarnessFactory({ a: { delayMs: 15 } })
      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })

      expect(runner.startedAt).toBe(0)
      expect(runner.completedAt).toBeUndefined()
      expect(runner.status).toBe('pending')

      const before = Date.now()
      const state = await runner.run()
      const after = Date.now()

      expect(state.status).toBe('completed')
      expect(typeof state.startedAt).toBe('number')
      expect(typeof state.completedAt).toBe('number')
      expect(state.startedAt).toBeGreaterThanOrEqual(before)
      expect(state.completedAt!).toBeGreaterThanOrEqual(state.startedAt)
      expect(state.completedAt!).toBeLessThanOrEqual(after + 10)
    })

    it('verifies failed runs also have valid timestamps satisfying completedAt >= startedAt > 0', async () => {
      const nodeA = makeNode({ id: 'failing', policy: { abortOnFail: true } })
      const plan: DagExecutionPlan = {
        workflow: { id: 'lifecycle-failed-wf', name: 'Lifecycle Failed', nodes: [nodeA] },
        waves: [{ waveIndex: 0, nodeIds: ['failing'] }]
      }

      const { factory } = createHarnessFactory({
        failing: {
          delayMs: 10,
          result: { finishReason: 'error', error: 'Fatal failure' }
        }
      })
      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      const state = await runner.run()

      expect(state.status).toBe('failed')
      expect(state.startedAt).toBeGreaterThan(0)
      expect(state.completedAt).toBeDefined()
      expect(state.completedAt!).toBeGreaterThanOrEqual(state.startedAt)
    })

    it('verifies cancelled runs terminate in cancelled state with children aborted and unstarted nodes pending', async () => {
      const node1 = makeNode({ id: 'n1' })
      const node2 = makeNode({ id: 'n2' })
      const node3 = makeNode({ id: 'n3', dependencies: ['n1', 'n2'] })

      const plan: DagExecutionPlan = {
        workflow: { id: 'cancel-children-wf', name: 'Cancel Children WF', nodes: [node1, node2, node3] },
        waves: [
          { waveIndex: 0, nodeIds: ['n1', 'n2'] },
          { waveIndex: 1, nodeIds: ['n3'] }
        ]
      }

      const { factory, runnerInstances } = createHarnessFactory({
        n1: { delayMs: 100 },
        n2: { delayMs: 100 }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      const runPromise = runner.run()

      // Allow wave 0 to start
      await new Promise((r) => setTimeout(r, 20))
      expect(runner.status).toBe('running')

      // Issue abort
      runner.abort()

      const state = await runPromise

      expect(state.status).toBe('cancelled')
      expect(runner.status).toBe('cancelled')
      expect(state.startedAt).toBeGreaterThan(0)
      expect(state.completedAt).toBeDefined()
      expect(state.completedAt!).toBeGreaterThanOrEqual(state.startedAt)

      // Child runners in flight must have had abort() invoked
      expect(runnerInstances.get('n1')?.abort).toHaveBeenCalled()
      expect(runnerInstances.get('n2')?.abort).toHaveBeenCalled()

      // Subsequent wave node must remain 'pending'
      expect(runner.nodeStates.get('n3')).toBe('pending')
      expect(runner.nodeOutputs.has('n3')).toBe(false)
    })

    it('verifies DagController lifecycle commands: start, query, idempotent stop, and rejection', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'challenger-controller-'))
      try {
        const { factory, runnerInstances } = createHarnessFactory({
          'c-step-1': { delayMs: 150 },
          'c-step-2': { delayMs: 150 }
        })

        const controller = new DagController({ runnerFactory: factory })
        const workflow: WorkflowDefinition = {
          id: 'ctl-lifecycle-wf',
          name: 'Controller Lifecycle Test',
          nodes: [
            makeNode({ id: 'c-step-1' }),
            makeNode({ id: 'c-step-2', dependencies: ['c-step-1'] })
          ]
        }

        const { dagRunId } = await controller.startDagRun({ workflow, directory: testDir })
        expect(typeof dagRunId).toBe('string')

        // Check running status
        const runningStatus = controller.getDagRunStatus(dagRunId)
        expect(runningStatus).not.toBeNull()
        expect(runningStatus?.status).toBe('running')

        // Stop DAG run
        const stopped = await controller.stopDagRun(dagRunId)
        expect(stopped).toBe(true)

        // Status must be cancelled immediately
        const stoppedStatus = controller.getDagRunStatus(dagRunId)
        expect(stoppedStatus?.status).toBe('cancelled')
        expect(stoppedStatus?.completedAt).toBeDefined()

        // Active child runner must be aborted
        expect(runnerInstances.get('c-step-1')?.abort).toHaveBeenCalled()

        // Stopping an already-cancelled run must return false
        const stoppedAgain = await controller.stopDagRun(dagRunId)
        expect(stoppedAgain).toBe(false)

        // Stopping a non-existent run must return false
        const stoppedNonExistent = await controller.stopDagRun('non-existent-run-id')
        expect(stoppedNonExistent).toBe(false)

        // Querying non-existent run returns null
        expect(controller.getDagRunStatus('non-existent-run-id')).toBeNull()
      } finally {
        rmSync(testDir, { recursive: true, force: true })
      }
    })

    it('verifies pre-aborted signal terminates with cancelled status and completedAt >= startedAt', async () => {
      const abortController = new AbortController()
      abortController.abort() // Pre-aborted

      const node = makeNode({ id: 'pre-abort-node' })
      const plan: DagExecutionPlan = {
        workflow: { id: 'pre-abort-wf', name: 'Pre Abort WF', nodes: [node] },
        waves: [{ waveIndex: 0, nodeIds: ['pre-abort-node'] }]
      }

      const { factory } = createHarnessFactory()
      const runner = new DagRunner(plan, '/test-dir', {
        runnerFactory: factory,
        signal: abortController.signal
      })

      const state = await runner.run()

      expect(state.status).toBe('cancelled')
      expect(runner.status).toBe('cancelled')
      expect(state.startedAt).toBeGreaterThan(0)
      expect(state.completedAt).toBeDefined()
      expect(state.completedAt!).toBeGreaterThanOrEqual(state.startedAt)
      expect(runner.nodeStates.get('pre-abort-node')).toBe('pending')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 3. Event Stream Invariants
  // ──────────────────────────────────────────────────────────────────────────
  describe('Invariant 3: Event Stream Invariants', () => {
    it('verifies that for every executed node, dag_node_start is emitted strictly before dag_node_complete', async () => {
      const nodes = [
        makeNode({ id: 'node_alpha' }),
        makeNode({ id: 'node_beta' }),
        makeNode({ id: 'node_gamma', dependencies: ['node_alpha'] }),
        makeNode({ id: 'node_delta', dependencies: ['node_beta'] })
      ]

      const plan: DagExecutionPlan = {
        workflow: { id: 'event-stream-wf', name: 'Event Stream WF', nodes },
        waves: [
          { waveIndex: 0, nodeIds: ['node_alpha', 'node_beta'] },
          { waveIndex: 1, nodeIds: ['node_gamma', 'node_delta'] }
        ]
      }

      const { factory } = createHarnessFactory({
        node_alpha: { delayMs: 15 },
        node_beta: { delayMs: 25 },
        node_gamma: { delayMs: 10 },
        node_delta: { delayMs: 20 }
      })

      const events: DagEvent[] = []
      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory, maxConcurrency: 4 })
      await runner.run((e) => events.push(e))

      for (const node of nodes) {
        const startEventIndex = events.findIndex(
          (e) => e.type === 'dag_node_start' && e.nodeId === node.id
        )
        const completeEventIndex = events.findIndex(
          (e) => e.type === 'dag_node_complete' && e.nodeId === node.id
        )

        expect(startEventIndex).toBeGreaterThan(-1)
        expect(completeEventIndex).toBeGreaterThan(-1)
        // INVARIANT: dag_node_start must precede dag_node_complete
        expect(startEventIndex).toBeLessThan(completeEventIndex)
      }
    })

    it('verifies that for every wave, dag_wave_start is emitted strictly before dag_wave_complete and frames all wave nodes', async () => {
      const nodes = [
        makeNode({ id: 'w0_a' }),
        makeNode({ id: 'w0_b' }),
        makeNode({ id: 'w1_a', dependencies: ['w0_a'] }),
        makeNode({ id: 'w2_a', dependencies: ['w1_a'] })
      ]

      const plan: DagExecutionPlan = {
        workflow: { id: 'wave-framing-wf', name: 'Wave Framing WF', nodes },
        waves: [
          { waveIndex: 0, nodeIds: ['w0_a', 'w0_b'] },
          { waveIndex: 1, nodeIds: ['w1_a'] },
          { waveIndex: 2, nodeIds: ['w2_a'] }
        ]
      }

      const { factory } = createHarnessFactory({
        w0_a: { delayMs: 10 },
        w0_b: { delayMs: 15 },
        w1_a: { delayMs: 10 },
        w2_a: { delayMs: 10 }
      })

      const events: DagEvent[] = []
      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      await runner.run((e) => events.push(e))

      for (let waveIndex = 0; waveIndex < 3; waveIndex++) {
        const waveStartIndex = events.findIndex(
          (e) => e.type === 'dag_wave_start' && e.waveIndex === waveIndex
        )
        const waveCompleteIndex = events.findIndex(
          (e) => e.type === 'dag_wave_complete' && e.waveIndex === waveIndex
        )

        expect(waveStartIndex).toBeGreaterThan(-1)
        expect(waveCompleteIndex).toBeGreaterThan(-1)
        // INVARIANT: dag_wave_start must precede dag_wave_complete
        expect(waveStartIndex).toBeLessThan(waveCompleteIndex)

        // INVARIANT: all node events belonging to this wave are strictly framed between wave_start and wave_complete
        const waveNodeIds = plan.waves[waveIndex].nodeIds
        for (const nid of waveNodeIds) {
          const nodeStartIndex = events.findIndex(
            (e) => e.type === 'dag_node_start' && e.nodeId === nid
          )
          const nodeCompleteIndex = events.findIndex(
            (e) => e.type === 'dag_node_complete' && e.nodeId === nid
          )

          expect(nodeStartIndex).toBeGreaterThan(waveStartIndex)
          expect(nodeStartIndex).toBeLessThan(waveCompleteIndex)

          expect(nodeCompleteIndex).toBeGreaterThan(waveStartIndex)
          expect(nodeCompleteIndex).toBeLessThan(waveCompleteIndex)
        }
      }
    })

    it('verifies overall sequence framing: dag_start is first event and dag_complete is final event', async () => {
      const node = makeNode({ id: 'solo' })
      const plan: DagExecutionPlan = {
        workflow: { id: 'framing-wf', name: 'Framing WF', nodes: [node] },
        waves: [{ waveIndex: 0, nodeIds: ['solo'] }]
      }

      const { factory } = createHarnessFactory({ solo: { delayMs: 10 } })
      const events: DagEvent[] = []
      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      await runner.run((e) => events.push(e))

      expect(events.length).toBeGreaterThanOrEqual(4)
      expect(events[0].type).toBe('dag_start')
      expect(events[events.length - 1].type).toBe('dag_complete')
      expect(events[events.length - 1].status).toBe('completed')
    })

    it('verifies skipped nodes emit dag_node_complete (status: skipped) without emitting dag_node_start', async () => {
      const root = makeNode({ id: 'root' })
      const skippedOnFail = makeNode({
        id: 'child_skipped_fail',
        dependencies: ['root'],
        policy: { skipOnFail: true }
      })
      const skippedOnCond = makeNode({
        id: 'child_skipped_cond',
        dependencies: ['root'],
        policy: { condition: { upstreamNodeId: 'root', expectedFinishReason: 'budget_exceeded' } }
      })

      const plan: DagExecutionPlan = {
        workflow: {
          id: 'skipped-event-wf',
          name: 'Skipped Event WF',
          nodes: [root, skippedOnFail, skippedOnCond]
        },
        waves: [
          { waveIndex: 0, nodeIds: ['root'] },
          { waveIndex: 1, nodeIds: ['child_skipped_fail', 'child_skipped_cond'] }
        ]
      }

      const { factory } = createHarnessFactory({
        root: {
          result: { finishReason: 'error', error: 'Root failed' }
        }
      })

      const events: DagEvent[] = []
      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      await runner.run((e) => events.push(e))

      for (const skippedId of ['child_skipped_fail', 'child_skipped_cond']) {
        const startEvent = events.find((e) => e.type === 'dag_node_start' && e.nodeId === skippedId)
        const completeEvent = events.find((e) => e.type === 'dag_node_complete' && e.nodeId === skippedId)

        // Skipped nodes must NOT emit dag_node_start (they never transitioned to running)
        expect(startEvent).toBeUndefined()
        // Skipped nodes MUST emit dag_node_complete with status 'skipped'
        expect(completeEvent).toBeDefined()
        expect(completeEvent?.status).toBe('skipped')
      }
    })

    it('verifies event stream invariants hold under cancellation during wave execution', async () => {
      const nodes = [
        makeNode({ id: 'slow1' }),
        makeNode({ id: 'slow2' }),
        makeNode({ id: 'downstream', dependencies: ['slow1'] })
      ]

      const plan: DagExecutionPlan = {
        workflow: { id: 'cancel-events-wf', name: 'Cancel Events WF', nodes },
        waves: [
          { waveIndex: 0, nodeIds: ['slow1', 'slow2'] },
          { waveIndex: 1, nodeIds: ['downstream'] }
        ]
      }

      const { factory } = createHarnessFactory({
        slow1: { delayMs: 150 },
        slow2: { delayMs: 150 }
      })

      const events: DagEvent[] = []
      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      const runPromise = runner.run((e) => events.push(e))

      await new Promise((r) => setTimeout(r, 20))
      runner.abort()

      await runPromise

      // Wave 0 must have wave_start and wave_complete
      const wave0Start = events.findIndex((e) => e.type === 'dag_wave_start' && e.waveIndex === 0)
      const wave0Complete = events.findIndex((e) => e.type === 'dag_wave_complete' && e.waveIndex === 0)

      expect(wave0Start).toBeGreaterThan(-1)
      expect(wave0Complete).toBeGreaterThan(-1)
      expect(wave0Start).toBeLessThan(wave0Complete)

      // Active nodes that were running must have dag_node_start before dag_node_complete
      for (const activeId of ['slow1', 'slow2']) {
        const startIdx = events.findIndex((e) => e.type === 'dag_node_start' && e.nodeId === activeId)
        const compIdx = events.findIndex((e) => e.type === 'dag_node_complete' && e.nodeId === activeId)
        expect(startIdx).toBeGreaterThan(-1)
        expect(compIdx).toBeGreaterThan(-1)
        expect(startIdx).toBeLessThan(compIdx)
      }

      // Final event must be dag_complete with status 'cancelled'
      const lastEvent = events[events.length - 1]
      expect(lastEvent.type).toBe('dag_complete')
      expect(lastEvent.status).toBe('cancelled')
    })
  })

  // ──────────────────────────────────────────────────────────────────────────
  // 4. Stress and Adversarial Edge Cases
  // ──────────────────────────────────────────────────────────────────────────
  describe('Invariant 4: Concurrency & Isolation Stress', () => {
    it('verifies that 20 parallel nodes with maxConcurrency=3 strictly limits concurrent active runners', async () => {
      const nodes = Array.from({ length: 20 }, (_, i) => makeNode({ id: `heavy-${i}` }))
      const plan: DagExecutionPlan = {
        workflow: { id: 'heavy-wf', name: 'Heavy Concurrency WF', nodes },
        waves: [{ waveIndex: 0, nodeIds: nodes.map((n) => n.id) }]
      }

      const behaviors: Record<string, MockBehavior> = {}
      for (const n of nodes) {
        behaviors[n.id] = { delayMs: 25 }
      }

      const { factory, getPeakActive } = createHarnessFactory(behaviors)
      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory, maxConcurrency: 3 })
      const state = await runner.run()

      expect(state.status).toBe('completed')
      expect(getPeakActive()).toBeLessThanOrEqual(3)
      expect(runner.nodeOutputs.size).toBe(20)
    })

    it('verifies complete memory and state isolation between multiple concurrent DAG runs', async () => {
      const plan1: DagExecutionPlan = {
        workflow: { id: 'iso-wf-1', name: 'Isolation WF 1', nodes: [makeNode({ id: 'iso-1' })] },
        waves: [{ waveIndex: 0, nodeIds: ['iso-1'] }]
      }
      const plan2: DagExecutionPlan = {
        workflow: { id: 'iso-wf-2', name: 'Isolation WF 2', nodes: [makeNode({ id: 'iso-2' })] },
        waves: [{ waveIndex: 0, nodeIds: ['iso-2'] }]
      }

      const { factory } = createHarnessFactory({
        'iso-1': { result: { turns: 5, usage: { input: 100, output: 50, reasoning: 10 } } },
        'iso-2': { result: { turns: 2, usage: { input: 20, output: 10, reasoning: 0 } } }
      })

      const runner1 = new DagRunner(plan1, '/test-dir-1', { runnerFactory: factory })
      const runner2 = new DagRunner(plan2, '/test-dir-2', { runnerFactory: factory })

      const [state1, state2] = await Promise.all([runner1.run(), runner2.run()])

      expect(state1.status).toBe('completed')
      expect(state2.status).toBe('completed')

      expect(runner1.turns).toBe(5)
      expect(runner1.totalUsage.input).toBe(100)

      expect(runner2.turns).toBe(2)
      expect(runner2.totalUsage.input).toBe(20)

      expect(runner1.nodeOutputs.has('iso-2')).toBe(false)
      expect(runner2.nodeOutputs.has('iso-1')).toBe(false)
    })
  })
})
