import { describe, expect, it, vi } from 'vitest'
import { DagRunner, MAX_NODE_CONCURRENCY } from '../harness/dag/runner'
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

function makeNode(overrides: Partial<DagNodeDefinition> = {}): DagNodeDefinition {
  return {
    id: 'node-' + Math.random().toString(36).slice(2, 7),
    profileId: 'mock-profile',
    prompt: 'Default task prompt',
    dependencies: [],
    ...overrides
  }
}

interface MockBehavior {
  delayMs?: number
  result?: Partial<RunnerResult>
  shouldThrow?: Error
  onRun?: (prompt: string, onEvent: (e: RunnerEvent) => void) => void | Promise<void>
}

function createStressRunnerFactory(behaviors: Record<string, MockBehavior> = {}, defaultDelayMs = 0) {
  let activeCount = 0
  let maxActiveObserved = 0
  const activeTimeline: number[] = []
  const runnerInstances = new Map<string, { abort: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> }>()

  const factory = (params: { id: string; nodeId: string; profile: AgentProfile; adapter: ProviderAdapter; tools: ToolRegistry; directory: string }) => {
    const b = behaviors[params.nodeId] ?? {}
    const delay = b.delayMs ?? defaultDelayMs
    const abortFn = vi.fn()

    const runFn = vi.fn(async (prompt: string, onEvent: (e: RunnerEvent) => void): Promise<RunnerResult> => {
      activeCount++
      activeTimeline.push(activeCount)
      if (activeCount > maxActiveObserved) {
        maxActiveObserved = activeCount
      }

      try {
        if (delay > 0) {
          await new Promise((resolve) => setTimeout(resolve, delay))
        }

        if (b.onRun) {
          await b.onRun(prompt, onEvent)
        }

        if (b.shouldThrow) {
          throw b.shouldThrow
        }

        const res = b.result ?? {}
        return {
          content: res.content ?? `Output for ${params.nodeId}`,
          toolCallCount: res.toolCallCount ?? 0,
          usage: res.usage ?? { input: 10, output: 20, reasoning: 0 },
          turns: res.turns ?? 1,
          finishReason: res.finishReason ?? 'complete',
          error: res.error
        }
      } finally {
        activeCount--
        activeTimeline.push(activeCount)
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
    getActiveCount: () => activeCount,
    getMaxActiveObserved: () => maxActiveObserved,
    getActiveTimeline: () => activeTimeline
  }
}

describe('M2 Stress-Test Suite — Empirical Concurrency & Edge Cases', () => {
  // -------------------------------------------------------------------------
  // 1. CONCURRENCY LIMITER (maxConcurrency)
  // -------------------------------------------------------------------------
  describe('1. Concurrency Limiter Stress-Tests', () => {
    it('strictly bounds concurrent active runners to maxConcurrency=4 with 16 wide parallel nodes', async () => {
      const nodeCount = 16
      const concurrencyLimit = 4
      const nodes = Array.from({ length: nodeCount }, (_, i) => makeNode({ id: `wide-${i}` }))
      const plan: DagExecutionPlan = {
        workflow: { id: 'wide-wf', name: 'Wide Workflow', nodes },
        waves: [{ waveIndex: 0, nodeIds: nodes.map((n) => n.id) }]
      }

      const { factory, getMaxActiveObserved, getActiveCount } = createStressRunnerFactory({}, 25)

      const runner = new DagRunner(plan, '/test-dir', {
        maxConcurrency: concurrencyLimit,
        runnerFactory: factory
      })

      const state = await runner.run()

      expect(state.status).toBe('completed')
      expect(getMaxActiveObserved()).toBe(concurrencyLimit)
      expect(getActiveCount()).toBe(0)
      for (const node of nodes) {
        expect(runner.nodeStates.get(node.id)).toBe('succeeded')
      }
    })

    it('bounds concurrency with jittered variable-duration tasks (20 nodes, maxConcurrency=3)', async () => {
      const nodeCount = 20
      const concurrencyLimit = 3
      const nodes = Array.from({ length: nodeCount }, (_, i) => makeNode({ id: `jitter-${i}` }))
      const plan: DagExecutionPlan = {
        workflow: { id: 'jitter-wf', name: 'Jitter Workflow', nodes },
        waves: [{ waveIndex: 0, nodeIds: nodes.map((n) => n.id) }]
      }

      const behaviors: Record<string, MockBehavior> = {}
      for (let i = 0; i < nodeCount; i++) {
        // Varying delay from 5ms to 35ms
        behaviors[`jitter-${i}`] = { delayMs: 5 + (i % 7) * 5 }
      }

      const { factory, getMaxActiveObserved, getActiveCount } = createStressRunnerFactory(behaviors)

      const runner = new DagRunner(plan, '/test-dir', {
        maxConcurrency: concurrencyLimit,
        runnerFactory: factory
      })

      const state = await runner.run()

      expect(state.status).toBe('completed')
      expect(getMaxActiveObserved()).toBeLessThanOrEqual(concurrencyLimit)
      expect(getActiveCount()).toBe(0)
      for (const node of nodes) {
        expect(runner.nodeStates.get(node.id)).toBe('succeeded')
      }
    })

    it('enforces strict serialization when maxConcurrency=1', async () => {
      const nodeCount = 8
      const nodes = Array.from({ length: nodeCount }, (_, i) => makeNode({ id: `seq-${i}` }))
      const plan: DagExecutionPlan = {
        workflow: { id: 'seq-wf', name: 'Seq Workflow', nodes },
        waves: [{ waveIndex: 0, nodeIds: nodes.map((n) => n.id) }]
      }

      const { factory, getMaxActiveObserved } = createStressRunnerFactory({}, 10)

      const runner = new DagRunner(plan, '/test-dir', {
        maxConcurrency: 1,
        runnerFactory: factory
      })

      const state = await runner.run()

      expect(state.status).toBe('completed')
      expect(getMaxActiveObserved()).toBe(1)
    })

    it('safely handles non-positive maxConcurrency (0 and negative values floor to 1)', async () => {
      const nodesZero = [makeNode({ id: 'z1' }), makeNode({ id: 'z2' })]
      const planZero: DagExecutionPlan = {
        workflow: { id: 'zero-wf', name: 'Zero WF', nodes: nodesZero },
        waves: [{ waveIndex: 0, nodeIds: ['z1', 'z2'] }]
      }

      const { factory: factoryZero, getMaxActiveObserved: maxObservedZero } = createStressRunnerFactory({}, 15)
      const runnerZero = new DagRunner(planZero, '/test-dir', {
        maxConcurrency: 0,
        runnerFactory: factoryZero
      })

      expect(runnerZero.maxConcurrency).toBe(1)
      await runnerZero.run()
      expect(maxObservedZero()).toBe(1)

      const { factory: factoryNeg, getMaxActiveObserved: maxObservedNeg } = createStressRunnerFactory({}, 15)
      const runnerNeg = new DagRunner(planZero, '/test-dir', {
        maxConcurrency: -5,
        runnerFactory: factoryNeg
      })

      expect(runnerNeg.maxConcurrency).toBe(1)
      await runnerNeg.run()
      expect(maxObservedNeg()).toBe(1)
    })

    it('clamps a requested maxConcurrency of 30 to MAX_NODE_CONCURRENCY without stalling', async () => {
      const nodeCount = 30
      const nodes = Array.from({ length: nodeCount }, (_, i) => makeNode({ id: `scale-${i}` }))
      const plan: DagExecutionPlan = {
        workflow: { id: 'scale-wf', name: 'Scale WF', nodes },
        waves: [{ waveIndex: 0, nodeIds: nodes.map((n) => n.id) }]
      }

      const { factory, getMaxActiveObserved } = createStressRunnerFactory({}, 15)
      const runner = new DagRunner(plan, '/test-dir', {
        maxConcurrency: 30,
        runnerFactory: factory
      })

      // Asking for 30 must not allow 30 parallel paid runs: the runner holds
      // the ceiling and still drains all 30 nodes.
      expect(runner.maxConcurrency).toBe(MAX_NODE_CONCURRENCY)
      const state = await runner.run()
      expect(state.status).toBe('completed')
      expect(getMaxActiveObserved()).toBeLessThanOrEqual(MAX_NODE_CONCURRENCY)
      expect(getMaxActiveObserved()).toBeGreaterThan(1)
      expect(runner.turns).toBe(30)
    })
  })

  // -------------------------------------------------------------------------
  // 2. RAPID AND ADVERSARIAL ABORT CALLS
  // -------------------------------------------------------------------------
  describe('2. Rapid and Adversarial Abort Stress-Tests', () => {
    it('synchronously aborts immediately after run() invocation without hanging', async () => {
      const nodes = [makeNode({ id: 'imm-1' }), makeNode({ id: 'imm-2' })]
      const plan: DagExecutionPlan = {
        workflow: { id: 'imm-wf', name: 'Imm WF', nodes },
        waves: [{ waveIndex: 0, nodeIds: ['imm-1', 'imm-2'] }]
      }

      const { factory } = createStressRunnerFactory({}, 100)
      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })

      const runPromise = runner.run()
      // Synchronous immediate abort
      runner.abort()

      const state = await runPromise
      expect(state.status).toBe('cancelled')
      expect(runner.status).toBe('cancelled')
      expect(runner.activeRunners.size).toBe(0)
    })

    it('propagates abort to all running instances in wide wave and terminates remaining wave queue', async () => {
      const nodeCount = 12
      const nodes = Array.from({ length: nodeCount }, (_, i) => makeNode({ id: `wave-abort-${i}` }))
      const plan: DagExecutionPlan = {
        workflow: { id: 'wave-abort-wf', name: 'Wave Abort WF', nodes },
        waves: [{ waveIndex: 0, nodeIds: nodes.map((n) => n.id) }]
      }

      const { factory, runnerInstances, getActiveCount } = createStressRunnerFactory({}, 200)
      const runner = new DagRunner(plan, '/test-dir', {
        maxConcurrency: 4,
        runnerFactory: factory
      })

      const runPromise = runner.run()

      // Allow wave 0 to start first 4 runners
      await new Promise((r) => setTimeout(r, 30))
      expect(runner.activeRunners.size).toBe(4)

      // Trigger abort
      runner.abort()

      const state = await runPromise
      expect(state.status).toBe('cancelled')

      // All 4 active runners should have received abort()
      for (const inst of runnerInstances.values()) {
        expect(inst.abort).toHaveBeenCalled()
      }

      // Remaining 8 nodes in the wave were never started
      expect(runnerInstances.size).toBe(4)
      for (let i = 4; i < nodeCount; i++) {
        expect(runner.nodeStates.get(`wave-abort-${i}`)).toBe('pending')
      }

      // No active runners left
      expect(runner.activeRunners.size).toBe(0)
      expect(getActiveCount()).toBe(0)
    })

    it('is strictly idempotent under rapid repeated abort() calls (50 concurrent abort calls)', async () => {
      const node = makeNode({ id: 'rapid-node' })
      const plan: DagExecutionPlan = {
        workflow: { id: 'rapid-wf', name: 'Rapid WF', nodes: [node] },
        waves: [{ waveIndex: 0, nodeIds: ['rapid-node'] }]
      }

      const { factory } = createStressRunnerFactory({}, 100)
      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })

      const events: DagEvent[] = []
      const runPromise = runner.run((e) => events.push(e))

      await new Promise((r) => setTimeout(r, 20))

      // Bombard with 50 abort() calls
      for (let i = 0; i < 50; i++) {
        runner.abort()
      }

      const state = await runPromise
      expect(state.status).toBe('cancelled')

      // dag_complete event emitted exactly once
      const completeEvents = events.filter((e) => e.type === 'dag_complete')
      expect(completeEvents.length).toBe(1)
    })

    it('controller handles rapid concurrent stopDagRun requests safely', async () => {
      const testDir = mkdtempSync(join(tmpdir(), 'dag-stress-ctrl-'))
      try {
        const { factory } = createStressRunnerFactory({}, 150)
        const controller = new DagController({ runnerFactory: factory })

        const workflow: WorkflowDefinition = {
          id: 'ctrl-stress-wf',
          name: 'Ctrl Stress',
          nodes: [
            makeNode({ id: 'c1' }),
            makeNode({ id: 'c2', dependencies: ['c1'] })
          ]
        }

        const { dagRunId } = await controller.startDagRun({ workflow, directory: testDir })

        // Fire 20 parallel stopDagRun calls
        const stopResults = await Promise.all(
          Array.from({ length: 20 }, () => controller.stopDagRun(dagRunId))
        )

        // Exactly one should return true, rest false
        const trueCount = stopResults.filter((r) => r === true).length
        const falseCount = stopResults.filter((r) => r === false).length
        expect(trueCount).toBe(1)
        expect(falseCount).toBe(19)

        const status = controller.getDagRunStatus(dagRunId)
        expect(status?.status).toBe('cancelled')
      } finally {
        rmSync(testDir, { recursive: true, force: true })
      }
    })

    it('prevents future waves from starting if abort occurs at boundary between waves', async () => {
      const nodeW1 = makeNode({ id: 'w1' })
      const nodeW2 = makeNode({ id: 'w2', dependencies: ['w1'] })

      const plan: DagExecutionPlan = {
        workflow: { id: 'boundary-wf', name: 'Boundary WF', nodes: [nodeW1, nodeW2] },
        waves: [
          { waveIndex: 0, nodeIds: ['w1'] },
          { waveIndex: 1, nodeIds: ['w2'] }
        ]
      }

      let w2Ran = false
      const { factory } = createStressRunnerFactory({
        w1: {
          delayMs: 10
        },
        w2: {
          delayMs: 100,
          onRun: () => {
            w2Ran = true
          }
        }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })

      // Trigger abort exactly on wave 0 completion
      const state = await runner.run((event) => {
        if (event.type === 'dag_wave_complete' && event.waveIndex === 0) {
          runner.abort()
        }
      })

      expect(state.status).toBe('cancelled')
      expect(w2Ran).toBe(false)
      expect(runner.nodeStates.get('w2')).toBe('pending')
    })
  })

  // -------------------------------------------------------------------------
  // 3. CASCADING FAILURES AND POLICY INTERACTIONS
  // -------------------------------------------------------------------------
  describe('3. Cascading Failures and Policy Interactions', () => {
    it('aborts sibling runners and halts future waves when abortOnFail triggers in a wide wave', async () => {
      const nodes = [
        makeNode({ id: 'fast-fail', policy: { abortOnFail: true } }),
        makeNode({ id: 'slow-sibling-1' }),
        makeNode({ id: 'slow-sibling-2' }),
        makeNode({ id: 'downstream-future', dependencies: ['fast-fail'] })
      ]

      const plan: DagExecutionPlan = {
        workflow: { id: 'abort-on-fail-wf', name: 'AbortOnFail WF', nodes },
        waves: [
          { waveIndex: 0, nodeIds: ['fast-fail', 'slow-sibling-1', 'slow-sibling-2'] },
          { waveIndex: 1, nodeIds: ['downstream-future'] }
        ]
      }

      const { factory, runnerInstances } = createStressRunnerFactory({
        'fast-fail': {
          delayMs: 15,
          result: { finishReason: 'error', error: 'Critical crash' }
        },
        'slow-sibling-1': {
          delayMs: 200
        },
        'slow-sibling-2': {
          delayMs: 200
        }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      const state = await runner.run()

      expect(state.status).toBe('failed')
      expect(runner.nodeStates.get('fast-fail')).toBe('failed')
      expect(runnerInstances.get('slow-sibling-1')?.abort).toHaveBeenCalled()
      expect(runnerInstances.get('slow-sibling-2')?.abort).toHaveBeenCalled()
      expect(runner.nodeStates.get('downstream-future')).toBe('pending')
    })

    it('safely handles simultaneous multiple abortOnFail crashes without uncaught rejection', async () => {
      const nodes = [
        makeNode({ id: 'fail-1', policy: { abortOnFail: true } }),
        makeNode({ id: 'fail-2', policy: { abortOnFail: true } }),
        makeNode({ id: 'fail-3', policy: { abortOnFail: true } })
      ]

      const plan: DagExecutionPlan = {
        workflow: { id: 'multi-fail-wf', name: 'Multi Fail WF', nodes },
        waves: [{ waveIndex: 0, nodeIds: ['fail-1', 'fail-2', 'fail-3'] }]
      }

      const { factory } = createStressRunnerFactory({
        'fail-1': { delayMs: 10, result: { finishReason: 'error', error: 'Crash 1' } },
        'fail-2': { delayMs: 10, result: { finishReason: 'error', error: 'Crash 2' } },
        'fail-3': { delayMs: 10, result: { finishReason: 'error', error: 'Crash 3' } }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      const state = await runner.run()

      expect(state.status).toBe('failed')
      expect(runner.nodeStates.get('fail-1')).toBe('failed')
      expect(runner.nodeStates.get('fail-2')).toBe('failed')
      expect(runner.nodeStates.get('fail-3')).toBe('failed')
    })

    it('cascades skips down deep dependency chains while independent subgraphs complete', async () => {
      // Chain: A -> B -> C -> D
      // Independent: X -> Y
      const nodeA = makeNode({ id: 'A' })
      const nodeB = makeNode({ id: 'B', dependencies: ['A'] })
      const nodeC = makeNode({ id: 'C', dependencies: ['B'] })
      const nodeD = makeNode({ id: 'D', dependencies: ['C'] })

      const nodeX = makeNode({ id: 'X' })
      const nodeY = makeNode({ id: 'Y', dependencies: ['X'] })

      const plan: DagExecutionPlan = {
        workflow: { id: 'cascade-wf', name: 'Cascade WF', nodes: [nodeA, nodeB, nodeC, nodeD, nodeX, nodeY] },
        waves: [
          { waveIndex: 0, nodeIds: ['A', 'X'] },
          { waveIndex: 1, nodeIds: ['B', 'Y'] },
          { waveIndex: 2, nodeIds: ['C'] },
          { waveIndex: 3, nodeIds: ['D'] }
        ]
      }

      let ranB = false
      let ranC = false
      let ranD = false

      const { factory } = createStressRunnerFactory({
        A: { result: { finishReason: 'error', error: 'A failed' } },
        B: { onRun: () => { ranB = true } },
        C: { onRun: () => { ranC = true } },
        D: { onRun: () => { ranD = true } },
        X: { result: { finishReason: 'complete', content: 'X success' } },
        Y: { result: { finishReason: 'complete', content: 'Y success' } }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      const state = await runner.run()

      expect(state.status).toBe('failed')
      expect(runner.nodeStates.get('A')).toBe('failed')

      expect(ranB).toBe(false)
      expect(ranC).toBe(false)
      expect(ranD).toBe(false)

      expect(runner.nodeStates.get('B')).toBe('skipped')
      expect(runner.nodeOutputs.get('B')?.finishReason).toBe('upstream_failed')

      expect(runner.nodeStates.get('C')).toBe('skipped')
      expect(runner.nodeOutputs.get('C')?.finishReason).toBe('upstream_failed')

      expect(runner.nodeStates.get('D')).toBe('skipped')
      expect(runner.nodeOutputs.get('D')?.finishReason).toBe('upstream_failed')

      expect(runner.nodeStates.get('X')).toBe('succeeded')
      expect(runner.nodeStates.get('Y')).toBe('succeeded')
    })

    it('correctly gates diamond dependency when one parent fails', async () => {
      // Diamond:
      //      root
      //     /    \
      //  left   right(fails)
      //     \    /
      //      join
      const root = makeNode({ id: 'root' })
      const left = makeNode({ id: 'left', dependencies: ['root'] })
      const right = makeNode({ id: 'right', dependencies: ['root'] })
      const joinNode = makeNode({ id: 'join', dependencies: ['left', 'right'] })

      const plan: DagExecutionPlan = {
        workflow: { id: 'diamond-wf', name: 'Diamond WF', nodes: [root, left, right, joinNode] },
        waves: [
          { waveIndex: 0, nodeIds: ['root'] },
          { waveIndex: 1, nodeIds: ['left', 'right'] },
          { waveIndex: 2, nodeIds: ['join'] }
        ]
      }

      let joinRan = false
      const { factory } = createStressRunnerFactory({
        root: { result: { finishReason: 'complete', content: 'root ok' } },
        left: { result: { finishReason: 'complete', content: 'left ok' } },
        right: { result: { finishReason: 'error', error: 'right failed' } },
        join: { onRun: () => { joinRan = true } }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      const state = await runner.run()

      expect(state.status).toBe('failed')
      expect(runner.nodeStates.get('left')).toBe('succeeded')
      expect(runner.nodeStates.get('right')).toBe('failed')
      expect(joinRan).toBe(false)
      expect(runner.nodeStates.get('join')).toBe('skipped')
      expect(runner.nodeOutputs.get('join')?.finishReason).toBe('upstream_failed')
    })

    it('enables error recovery branch when condition checks expectedStatus: "failed"', async () => {
      const unstableTask = makeNode({ id: 'unstable' })
      const errorHandler = makeNode({
        id: 'error-handler',
        dependencies: ['unstable'],
        policy: {
          condition: {
            upstreamNodeId: 'unstable',
            expectedStatus: 'failed'
          }
        }
      })
      const successHandler = makeNode({
        id: 'success-handler',
        dependencies: ['unstable'],
        policy: {
          condition: {
            upstreamNodeId: 'unstable',
            expectedStatus: 'succeeded'
          }
        }
      })

      const plan: DagExecutionPlan = {
        workflow: { id: 'recovery-wf', name: 'Recovery WF', nodes: [unstableTask, errorHandler, successHandler] },
        waves: [
          { waveIndex: 0, nodeIds: ['unstable'] },
          { waveIndex: 1, nodeIds: ['error-handler', 'success-handler'] }
        ]
      }

      let errorHandlerRan = false
      let successHandlerRan = false

      const { factory } = createStressRunnerFactory({
        unstable: { result: { finishReason: 'error', error: 'Something broke' } },
        'error-handler': {
          onRun: () => { errorHandlerRan = true },
          result: { finishReason: 'complete', content: 'Handled error cleanly' }
        },
        'success-handler': {
          onRun: () => { successHandlerRan = true }
        }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      const state = await runner.run()

      expect(errorHandlerRan).toBe(true)
      expect(successHandlerRan).toBe(false)
      expect(runner.nodeStates.get('error-handler')).toBe('succeeded')
      expect(runner.nodeStates.get('success-handler')).toBe('skipped')
      // Note: Because unstable failed, DAG status is failed
      expect(state.status).toBe('failed')
    })

    it('captures unexpected thrown exceptions from node runner and marks node as failed', async () => {
      const crashingNode = makeNode({ id: 'crash-node' })
      const plan: DagExecutionPlan = {
        workflow: { id: 'throw-wf', name: 'Throw WF', nodes: [crashingNode] },
        waves: [{ waveIndex: 0, nodeIds: ['crash-node'] }]
      }

      const { factory } = createStressRunnerFactory({
        'crash-node': {
          shouldThrow: new Error('Simulated internal runner segmentation fault')
        }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      const state = await runner.run()

      expect(state.status).toBe('failed')
      expect(runner.nodeStates.get('crash-node')).toBe('failed')
      expect(runner.nodeOutputs.get('crash-node')?.error).toContain('Simulated internal runner segmentation fault')
    })

    it('fails the node and the run when runnerFactory throws synchronously during instantiation', async () => {
      const crashingNode = makeNode({ id: 'inst-fail-node' })
      const plan: DagExecutionPlan = {
        workflow: { id: 'inst-throw-wf', name: 'Inst Throw WF', nodes: [crashingNode] },
        waves: [{ waveIndex: 0, nodeIds: ['inst-fail-node'] }]
      }

      const runner = new DagRunner(plan, '/test-dir', {
        runnerFactory: () => {
          throw new Error('Factory instantiation failed')
        }
      })

      const state = await runner.run()

      // A rejection thrown before executeNode's own try/catch is reached is
      // recorded from the settled results of runWithConcurrency, so:
      // 1. The node reaches a terminal 'failed' state rather than staying 'running'
      expect(state.nodeStates['inst-fail-node']).toBe('failed')
      // 2. The failure is recorded as node output, carrying the reason
      expect(state.nodeOutputs['inst-fail-node']?.status).toBe('failed')
      expect(state.nodeOutputs['inst-fail-node']?.error).toMatch(/Factory instantiation failed/)
      // 3. The run as a whole reports failure instead of a false 'completed'
      expect(state.status).toBe('failed')
    })

    it('observes skipOnFail field behavior across node definitions', async () => {
      // Test empirical behavior of skipOnFail: true vs skipOnFail: false vs omitted
      const failedRoot = makeNode({ id: 'failed-root' })
      const nodeWithSkip = makeNode({
        id: 'node-with-skip',
        dependencies: ['failed-root'],
        policy: { skipOnFail: true }
      })
      const nodeWithoutSkip = makeNode({
        id: 'node-without-skip',
        dependencies: ['failed-root'],
        policy: { skipOnFail: false }
      })
      const nodeOmitted = makeNode({
        id: 'node-omitted',
        dependencies: ['failed-root']
      })

      const plan: DagExecutionPlan = {
        workflow: {
          id: 'skip-policy-wf',
          name: 'Skip Policy WF',
          nodes: [failedRoot, nodeWithSkip, nodeWithoutSkip, nodeOmitted]
        },
        waves: [
          { waveIndex: 0, nodeIds: ['failed-root'] },
          { waveIndex: 1, nodeIds: ['node-with-skip', 'node-without-skip', 'node-omitted'] }
        ]
      }

      const { factory } = createStressRunnerFactory({
        'failed-root': { result: { finishReason: 'error', error: 'Root failed' } }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      await runner.run()

      // In the current runner.ts implementation:
      // All nodes whose upstream failed are skipped with 'upstream_failed' regardless of skipOnFail boolean
      expect(runner.nodeStates.get('node-with-skip')).toBe('skipped')
      expect(runner.nodeStates.get('node-without-skip')).toBe('skipped')
      expect(runner.nodeStates.get('node-omitted')).toBe('skipped')
    })

    it('multi-wave execution strictly bounds concurrency within each wave (2 waves x 10 nodes, maxConcurrency=3)', async () => {
      const wave0Nodes = Array.from({ length: 10 }, (_, i) => makeNode({ id: `w0-n${i}` }))
      const wave1Nodes = Array.from({ length: 10 }, (_, i) =>
        makeNode({ id: `w1-n${i}`, dependencies: [`w0-n${i}`] })
      )

      const plan: DagExecutionPlan = {
        workflow: {
          id: 'multi-wave-concurrency',
          name: 'Multi Wave Concurrency',
          nodes: [...wave0Nodes, ...wave1Nodes]
        },
        waves: [
          { waveIndex: 0, nodeIds: wave0Nodes.map((n) => n.id) },
          { waveIndex: 1, nodeIds: wave1Nodes.map((n) => n.id) }
        ]
      }

      const { factory, getMaxActiveObserved, getActiveTimeline } = createStressRunnerFactory({}, 15)
      const runner = new DagRunner(plan, '/test-dir', {
        maxConcurrency: 3,
        runnerFactory: factory
      })

      const state = await runner.run()

      expect(state.status).toBe('completed')
      expect(getMaxActiveObserved()).toBe(3)
      const timeline = getActiveTimeline()
      expect(timeline.every((c) => c <= 3)).toBe(true)
      expect(timeline[timeline.length - 1]).toBe(0)
    })

    it('honors pre-aborted external AbortSignal immediately without executing any node', async () => {
      const node = makeNode({ id: 'pre-aborted-node' })
      const plan: DagExecutionPlan = {
        workflow: { id: 'pre-abort-wf', name: 'Pre Abort WF', nodes: [node] },
        waves: [{ waveIndex: 0, nodeIds: ['pre-aborted-node'] }]
      }

      const ac = new AbortController()
      ac.abort()

      let ran = false
      const { factory } = createStressRunnerFactory({
        'pre-aborted-node': { onRun: () => { ran = true } }
      })

      const runner = new DagRunner(plan, '/test-dir', {
        signal: ac.signal,
        runnerFactory: factory
      })

      const state = await runner.run()

      expect(state.status).toBe('cancelled')
      expect(ran).toBe(false)
      expect(runner.nodeStates.get('pre-aborted-node')).toBe('pending')
    })

    it('honors live external AbortSignal fired during active execution', async () => {
      const nodes = [makeNode({ id: 'live-1' }), makeNode({ id: 'live-2' })]
      const plan: DagExecutionPlan = {
        workflow: { id: 'live-abort-wf', name: 'Live Abort WF', nodes },
        waves: [{ waveIndex: 0, nodeIds: ['live-1', 'live-2'] }]
      }

      const ac = new AbortController()
      const { factory, runnerInstances } = createStressRunnerFactory({}, 150)

      const runner = new DagRunner(plan, '/test-dir', {
        signal: ac.signal,
        runnerFactory: factory
      })

      const runPromise = runner.run()

      // Allow nodes to start
      await new Promise((r) => setTimeout(r, 20))
      ac.abort()

      const state = await runPromise
      expect(state.status).toBe('cancelled')
      expect(runnerInstances.get('live-1')?.abort).toHaveBeenCalled()
      expect(runnerInstances.get('live-2')?.abort).toHaveBeenCalled()
    })

    it('does not trigger abortOnFail if a node with abortOnFail is skipped due to upstream failure', async () => {
      const rootFailed = makeNode({ id: 'root-failed' })
      const skippedAbortNode = makeNode({
        id: 'skipped-with-abort',
        dependencies: ['root-failed'],
        policy: { abortOnFail: true }
      })
      const independentNode = makeNode({ id: 'independent' })

      const plan: DagExecutionPlan = {
        workflow: {
          id: 'skip-abort-wf',
          name: 'Skip Abort WF',
          nodes: [rootFailed, skippedAbortNode, independentNode]
        },
        waves: [
          { waveIndex: 0, nodeIds: ['root-failed', 'independent'] },
          { waveIndex: 1, nodeIds: ['skipped-with-abort'] }
        ]
      }

      const { factory } = createStressRunnerFactory({
        'root-failed': { result: { finishReason: 'error', error: 'Root failed' } },
        independent: { result: { finishReason: 'complete', content: 'Indy ok' } }
      })

      const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
      const state = await runner.run()

      expect(runner.nodeStates.get('root-failed')).toBe('failed')
      expect(runner.nodeStates.get('independent')).toBe('succeeded')
      expect(runner.nodeStates.get('skipped-with-abort')).toBe('skipped')
      // Sibling independent node succeeded; skipped-with-abort was skipped, NOT failed
      expect(state.status).toBe('failed') // because root-failed was failed
    })
  })
})
