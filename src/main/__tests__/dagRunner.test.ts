import { describe, expect, it, vi } from 'vitest'
import { DagRunner } from '../harness/dag/runner'
import type {
  DagEvent,
  DagExecutionPlan,
  DagNodeDefinition,
} from '../harness/dag/types'
import type { AgentRunner, RunnerEvent, RunnerResult } from '../harness/runner'
import type { AgentProfile } from '../harness/profiles'
import type { ProviderAdapter } from '../harness/providers/adapter'
import { ToolRegistry } from '../harness/tools/registry'
import { ProfileStore } from '../harness/profileStore'
import { ProviderRegistry } from '../harness/providers/registry'
import * as customToolsModule from '../harness/tools/custom'

function makeNode(overrides: Partial<DagNodeDefinition> = {}): DagNodeDefinition {
  return {
    id: 'node-' + Math.random().toString(36).slice(2, 7),
    profileId: 'mock-profile',
    prompt: 'Default task prompt',
    dependencies: [],
    ...overrides
  }
}



interface MockRunnerBehavior {
  result?: Partial<RunnerResult>
  delayMs?: number
  onRun?: (prompt: string, onEvent: (e: RunnerEvent) => void) => void | Promise<void>
  shouldThrow?: Error
}

function createMockRunnerFactory(behaviors: Record<string, MockRunnerBehavior> = {}) {
  const runnerInstances = new Map<string, { abort: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> }>()
  let activeCount = 0
  let maxActiveObserved = 0

  const factory = (params: { id: string; nodeId: string; profile: AgentProfile; adapter: ProviderAdapter; tools: ToolRegistry; directory: string }) => {
    const b = behaviors[params.nodeId] ?? {}
    const abortFn = vi.fn()

    const runFn = vi.fn(async (prompt: string, onEvent: (e: RunnerEvent) => void): Promise<RunnerResult> => {
      activeCount++
      if (activeCount > maxActiveObserved) {
        maxActiveObserved = activeCount
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
        content: res.content ?? `Output for ${params.nodeId}`,
        toolCallCount: res.toolCallCount ?? 0,
        usage: res.usage ?? { input: 10, output: 20, reasoning: 0 },
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
    getMaxActiveObserved: () => maxActiveObserved
  }
}

describe('DagRunner', () => {
  it('executes nodes wave-by-wave in strict topological order', async () => {
    const nodeA = makeNode({ id: 'nodeA', prompt: 'Task A' })
    const nodeB = makeNode({ id: 'nodeB', prompt: 'Task B', dependencies: ['nodeA'] })
    const nodeC = makeNode({ id: 'nodeC', prompt: 'Task C', dependencies: ['nodeB'] })

    const plan: DagExecutionPlan = {
      workflow: { id: 'linear-wf', name: 'Linear Workflow', nodes: [nodeA, nodeB, nodeC] },
      waves: [
        { waveIndex: 0, nodeIds: ['nodeA'] },
        { waveIndex: 1, nodeIds: ['nodeB'] },
        { waveIndex: 2, nodeIds: ['nodeC'] }
      ]
    }

    const executionOrder: string[] = []
    const { factory } = createMockRunnerFactory({
      nodeA: {
        onRun: () => { executionOrder.push('nodeA') }
      },
      nodeB: {
        onRun: () => { executionOrder.push('nodeB') }
      },
      nodeC: {
        onRun: () => { executionOrder.push('nodeC') }
      }
    })

    const events: DagEvent[] = []
    const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
    const finalState = await runner.run((e) => events.push(e))

    expect(executionOrder).toEqual(['nodeA', 'nodeB', 'nodeC'])
    expect(finalState.status).toBe('completed')
    expect(runner.nodeStates.get('nodeA')).toBe('succeeded')
    expect(runner.nodeStates.get('nodeB')).toBe('succeeded')
    expect(runner.nodeStates.get('nodeC')).toBe('succeeded')

    const waveStartEvents = events.filter((e) => e.type === 'dag_wave_start')
    expect(waveStartEvents.map((e) => e.waveIndex)).toEqual([0, 1, 2])
  })

  it('executes nodes in the same wave in parallel with concurrency control', async () => {
    const nodeP1 = makeNode({ id: 'p1' })
    const nodeP2 = makeNode({ id: 'p2' })
    const nodeP3 = makeNode({ id: 'p3' })

    const plan: DagExecutionPlan = {
      workflow: { id: 'parallel-wf', name: 'Parallel Workflow', nodes: [nodeP1, nodeP2, nodeP3] },
      waves: [{ waveIndex: 0, nodeIds: ['p1', 'p2', 'p3'] }]
    }

    const { factory, getMaxActiveObserved } = createMockRunnerFactory({
      p1: { delayMs: 40 },
      p2: { delayMs: 40 },
      p3: { delayMs: 40 }
    })

    const runner = new DagRunner(plan, '/test-dir', {
      maxConcurrency: 3,
      runnerFactory: factory
    })

    const finalState = await runner.run()

    expect(finalState.status).toBe('completed')
    expect(getMaxActiveObserved()).toBeGreaterThanOrEqual(2)
    expect(runner.nodeStates.get('p1')).toBe('succeeded')
    expect(runner.nodeStates.get('p2')).toBe('succeeded')
    expect(runner.nodeStates.get('p3')).toBe('succeeded')
  })

  it('interpolates upstream outputs into downstream node prompts between waves', async () => {
    const nodeWriter = makeNode({ id: 'writer', prompt: 'Write intro' })
    const nodeEditor = makeNode({
      id: 'editor',
      prompt: 'Review this draft: {{inputs.writer.output}} (status: {{inputs.writer.status}})',
      dependencies: ['writer']
    })

    const plan: DagExecutionPlan = {
      workflow: { id: 'handoff-wf', name: 'Handoff Workflow', nodes: [nodeWriter, nodeEditor] },
      waves: [
        { waveIndex: 0, nodeIds: ['writer'] },
        { waveIndex: 1, nodeIds: ['editor'] }
      ]
    }

    let receivedEditorPrompt = ''
    const { factory } = createMockRunnerFactory({
      writer: {
        result: { content: 'Draft of chapter 1' }
      },
      editor: {
        onRun: (prompt) => {
          receivedEditorPrompt = prompt
        }
      }
    })

    const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
    await runner.run()

    expect(receivedEditorPrompt).toBe('Review this draft: Draft of chapter 1 (status: succeeded)')
    expect(runner.nodeOutputs.get('writer')?.content).toBe('Draft of chapter 1')
  })

  it('halts subsequent waves and aborts running siblings when abortOnFail triggers', async () => {
    const nodeFailing = makeNode({ id: 'failing', policy: { abortOnFail: true } })
    const nodeSlowSibling = makeNode({ id: 'slowSibling' })
    const nodeDownstream = makeNode({ id: 'downstream', dependencies: ['failing'] })

    const plan: DagExecutionPlan = {
      workflow: { id: 'abort-wf', name: 'AbortOnFail Workflow', nodes: [nodeFailing, nodeSlowSibling, nodeDownstream] },
      waves: [
        { waveIndex: 0, nodeIds: ['failing', 'slowSibling'] },
        { waveIndex: 1, nodeIds: ['downstream'] }
      ]
    }

    const { factory, runnerInstances } = createMockRunnerFactory({
      failing: {
        delayMs: 10,
        result: { finishReason: 'error', error: 'Fatal compilation exception' }
      },
      slowSibling: {
        delayMs: 100,
        result: { content: 'Should be aborted' }
      },
      downstream: {
        result: { content: 'Should never run' }
      }
    })

    const events: DagEvent[] = []
    const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
    const finalState = await runner.run((e) => events.push(e))

    expect(finalState.status).toBe('failed')
    expect(runner.nodeStates.get('failing')).toBe('failed')
    // Sibling runner should have received abort()
    expect(runnerInstances.get('slowSibling')?.abort).toHaveBeenCalled()
    // Downstream node was never executed
    expect(runner.nodeStates.get('downstream')).toBe('pending')

    const waveCompletedEvents = events.filter((e) => e.type === 'dag_wave_complete')
    expect(waveCompletedEvents.length).toBe(1)
  })

  it('allows independent branches to proceed when skipOnFail is active', async () => {
    const branch1Root = makeNode({ id: 'b1-root' })
    const branch2Root = makeNode({ id: 'b2-root' })
    const branch1Downstream = makeNode({
      id: 'b1-downstream',
      dependencies: ['b1-root'],
      policy: { skipOnFail: true }
    })
    const branch2Downstream = makeNode({
      id: 'b2-downstream',
      dependencies: ['b2-root']
    })

    const plan: DagExecutionPlan = {
      workflow: {
        id: 'skip-on-fail-wf',
        name: 'Skip On Fail Workflow',
        nodes: [branch1Root, branch2Root, branch1Downstream, branch2Downstream]
      },
      waves: [
        { waveIndex: 0, nodeIds: ['b1-root', 'b2-root'] },
        { waveIndex: 1, nodeIds: ['b1-downstream', 'b2-downstream'] }
      ]
    }

    let b2DownstreamRan = false
    const { factory } = createMockRunnerFactory({
      'b1-root': {
        result: { finishReason: 'error', error: 'Non-fatal branch 1 error' }
      },
      'b2-root': {
        result: { content: 'Branch 2 succeeded' }
      },
      'b2-downstream': {
        onRun: () => {
          b2DownstreamRan = true
        }
      }
    })

    const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
    const finalState = await runner.run()

    expect(runner.nodeStates.get('b1-root')).toBe('failed')
    expect(runner.nodeStates.get('b1-downstream')).toBe('skipped')
    expect(runner.nodeOutputs.get('b1-downstream')?.finishReason).toBe('upstream_failed')

    expect(runner.nodeStates.get('b2-root')).toBe('succeeded')
    expect(runner.nodeStates.get('b2-downstream')).toBe('succeeded')
    expect(b2DownstreamRan).toBe(true)

    expect(finalState.status).toBe('failed')
  })

  it('activates conditional branch based on upstream finish reason or status', async () => {
    const rootNode = makeNode({ id: 'root' })
    const onBudgetHandler = makeNode({
      id: 'budget-handler',
      dependencies: ['root'],
      policy: {
        condition: {
          upstreamNodeId: 'root',
          expectedFinishReason: 'budget_exceeded'
        }
      }
    })
    const onCompleteHandler = makeNode({
      id: 'complete-handler',
      dependencies: ['root'],
      policy: {
        condition: {
          upstreamNodeId: 'root',
          expectedFinishReason: 'complete'
        }
      }
    })

    const plan: DagExecutionPlan = {
      workflow: {
        id: 'condition-wf',
        name: 'Condition Workflow',
        nodes: [rootNode, onBudgetHandler, onCompleteHandler]
      },
      waves: [
        { waveIndex: 0, nodeIds: ['root'] },
        { waveIndex: 1, nodeIds: ['budget-handler', 'complete-handler'] }
      ]
    }

    let budgetHandlerRan = false
    let completeHandlerRan = false

    const { factory } = createMockRunnerFactory({
      root: {
        result: { finishReason: 'budget_exceeded', error: 'Token limit reached' }
      },
      'budget-handler': {
        onRun: () => {
          budgetHandlerRan = true
        }
      },
      'complete-handler': {
        onRun: () => {
          completeHandlerRan = true
        }
      }
    })

    const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
    await runner.run()

    expect(budgetHandlerRan).toBe(true)
    expect(completeHandlerRan).toBe(false)
    expect(runner.nodeStates.get('budget-handler')).toBe('succeeded')
    expect(runner.nodeStates.get('complete-handler')).toBe('skipped')
    expect(runner.nodeOutputs.get('complete-handler')?.finishReason).toBe('condition_unmet')
  })

  it('cleanly aborts active runners and updates status to cancelled on hierarchical abort()', async () => {
    const nodeA = makeNode({ id: 'nodeA' })
    const nodeB = makeNode({ id: 'nodeB', dependencies: ['nodeA'] })

    const plan: DagExecutionPlan = {
      workflow: { id: 'abort-wf', name: 'Abort Workflow', nodes: [nodeA, nodeB] },
      waves: [
        { waveIndex: 0, nodeIds: ['nodeA'] },
        { waveIndex: 1, nodeIds: ['nodeB'] }
      ]
    }


    const { factory, runnerInstances } = createMockRunnerFactory({
      nodeA: {
        delayMs: 200,
        result: { content: 'Finished' }
      }
    })

    const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })

    const runPromise = runner.run()

    // Give it a moment to enter wave 0 and start nodeA
    await new Promise((r) => setTimeout(r, 20))
    expect(runner.status).toBe('running')

    // Call hierarchical abort
    runner.abort()

    const finalState = await runPromise

    expect(finalState.status).toBe('cancelled')
    expect(runner.status).toBe('cancelled')
    expect(runnerInstances.get('nodeA')?.abort).toHaveBeenCalled()
    expect(runner.nodeStates.get('nodeB')).toBe('pending')
  })

  it('aggregates turns and token usage accurately across all executed nodes', async () => {
    const node1 = makeNode({ id: 'node1' })
    const node2 = makeNode({ id: 'node2' })
    const node3 = makeNode({ id: 'node3', dependencies: ['node1', 'node2'] })

    const plan: DagExecutionPlan = {
      workflow: { id: 'metrics-wf', name: 'Metrics Workflow', nodes: [node1, node2, node3] },
      waves: [
        { waveIndex: 0, nodeIds: ['node1', 'node2'] },
        { waveIndex: 1, nodeIds: ['node3'] }
      ]
    }

    const { factory } = createMockRunnerFactory({
      node1: {
        result: { turns: 3, usage: { input: 120, output: 40, reasoning: 15 } }
      },
      node2: {
        result: { turns: 2, usage: { input: 80, output: 60, reasoning: 0 } }
      },
      node3: {
        result: { turns: 4, usage: { input: 200, output: 100, reasoning: 50 } }
      }
    })

    const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
    await runner.run()

    const metrics = runner.getMetrics()
    expect(metrics.turns).toBe(9)
    expect(metrics.totalUsage.input).toBe(400)
    expect(metrics.totalUsage.output).toBe(200)
    expect(metrics.totalUsage.reasoning).toBe(65)
  })

  it('executes genuine AgentRunner instances with real ProviderAdapter without runnerFactory', async () => {
    const testProfile: AgentProfile = {
      id: 'real-coder',
      name: 'Real Coder',
      provider: 'custom-stub',
      model: 'test-model'
    }

    const mockProfileStore = {
      get: (id: string) => (id === 'real-coder' ? testProfile : undefined),
      list: () => [testProfile],
      save: async () => testProfile,
      delete: async () => true
    } as unknown as ProfileStore

    const mockAdapter: ProviderAdapter = {
      id: 'custom-stub',
      chat: vi.fn(async (req) => ({
        id: 'resp-1',
        content: `Executed prompt: ${req.messages[req.messages.length - 1].content}`,
        finishReason: 'stop' as const,
        usage: { input: 25, output: 15 }
      })),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }

    const mockProviderRegistry = {
      isSupported: (p: string) => p === 'custom-stub',
      resolve: (p: string) => (p === 'custom-stub' ? mockAdapter : null),
      list: () => ['custom-stub']
    } as unknown as ProviderRegistry

    const node1 = makeNode({ id: 'step-1', profileId: 'real-coder', prompt: 'Build core logic' })
    const node2 = makeNode({
      id: 'step-2',
      profileId: 'real-coder',
      prompt: 'Verify: {{inputs.step-1.output}}',
      dependencies: ['step-1']
    })

    const plan: DagExecutionPlan = {
      workflow: { id: 'real-wf', name: 'Real AgentRunner Workflow', nodes: [node1, node2] },
      waves: [
        { waveIndex: 0, nodeIds: ['step-1'] },
        { waveIndex: 1, nodeIds: ['step-2'] }
      ]
    }

    const runner = new DagRunner(plan, '/test-dir', {
      profiles: mockProfileStore,
      providers: mockProviderRegistry
    })

    const state = await runner.run()

    expect(state.status).toBe('completed')
    expect(state.nodeStates['step-1']).toBe('succeeded')
    expect(state.nodeStates['step-2']).toBe('succeeded')
    expect(state.nodeOutputs['step-2'].content).toContain('Executed prompt: Verify: Executed prompt: Build core logic')
    expect(runner.turns).toBe(2)
    expect(runner.totalUsage.input).toBe(50)
    expect(runner.totalUsage.output).toBe(30)
  })

  it('strictly limits active concurrency when wave contains more nodes than maxConcurrency', async () => {
    const nodes = Array.from({ length: 6 }, (_, i) => makeNode({ id: `c-node-${i}` }))
    const plan: DagExecutionPlan = {
      workflow: { id: 'concurrency-wf', name: 'Concurrency Test', nodes },
      waves: [{ waveIndex: 0, nodeIds: nodes.map((n) => n.id) }]
    }

    const behaviors: Record<string, MockRunnerBehavior> = {}
    for (const node of nodes) {
      behaviors[node.id] = { delayMs: 40 }
    }

    const { factory, getMaxActiveObserved } = createMockRunnerFactory(behaviors)

    const runner = new DagRunner(plan, '/test-dir', {
      maxConcurrency: 2,
      runnerFactory: factory
    })

    await runner.run()

    expect(getMaxActiveObserved()).toBeLessThanOrEqual(2)
    for (const node of nodes) {
      expect(runner.nodeStates.get(node.id)).toBe('succeeded')
    }
  })

  it('captures artifacts produced by tools during node execution', async () => {
    const testProfile: AgentProfile = {
      id: 'art-coder',
      name: 'Artifact Coder',
      provider: 'custom-art',
      model: 'art-model'
    }

    const mockProfileStore = {
      get: (id: string) => (id === 'art-coder' ? testProfile : undefined),
      list: () => [testProfile],
      save: async () => testProfile,
      delete: async () => true
    } as unknown as ProfileStore

    const tools = new ToolRegistry()
    tools.register(
      {
        name: 'generate_artifact',
        description: 'Creates a code artifact',
        parameters: { type: 'object' },
        category: 'read'
      },
      async () => ({
        output: 'Created artifact',
        artifacts: [{ name: 'patch.diff', content: '@@ -1 +1 @@\n-old\n+new', mime: 'text/x-diff' }]
      })
    )

    let callCount = 0
    const mockAdapter: ProviderAdapter = {
      id: 'custom-art',
      chat: vi.fn(async () => {
        if (callCount++ === 0) {
          return {
            id: 'call-1',
            content: '',
            finishReason: 'tool_calls' as const,
            toolCalls: [
              {
                id: 'call-art',
                type: 'function' as const,
                function: { name: 'generate_artifact', arguments: '{}' }
              }
            ],
            usage: { input: 10, output: 10 }
          }
        }
        return {
          id: 'call-2',
          content: 'Artifact created successfully',
          finishReason: 'stop' as const,
          usage: { input: 15, output: 10 }
        }
      }),
      abort: vi.fn(),
      probe: vi.fn(async () => true)
    }

    const mockProviderRegistry = {
      isSupported: (p: string) => p === 'custom-art',
      resolve: (p: string) => (p === 'custom-art' ? mockAdapter : null),
      list: () => ['custom-art']
    } as unknown as ProviderRegistry

    const node = makeNode({ id: 'art-node', profileId: 'art-coder', prompt: 'Run tool' })
    const plan: DagExecutionPlan = {
      workflow: { id: 'artifact-wf', name: 'Artifact Workflow', nodes: [node] },
      waves: [{ waveIndex: 0, nodeIds: ['art-node'] }]
    }

    const runner = new DagRunner(plan, '/test-dir', {
      profiles: mockProfileStore,
      providers: mockProviderRegistry,
      tools
    })

    const state = await runner.run()

    expect(state.status).toBe('completed')
    const nodeOutput = runner.nodeOutputs.get('art-node')
    expect(nodeOutput?.artifacts).toBeDefined()
    expect(nodeOutput?.artifacts?.length).toBe(1)
    expect(nodeOutput?.artifacts?.[0].name).toBe('patch.diff')
    expect(nodeOutput?.artifacts?.[0].content).toContain('-old\n+new')
  })

  it('wraps tool execution with artifact capture even when defaultTools is not pre-supplied', async () => {
    let capturedNodeTools: ToolRegistry | undefined
    const mockProfileStore = {
      get: (id: string) => ({
        id,
        name: id,
        provider: 'mock-p',
        model: 'mock-m',
        tools: ['*']
      })
    } as unknown as ProfileStore

    const spy = vi.spyOn(customToolsModule, 'loadCustomTools').mockImplementation((registry) => {
      registry.register(
        {
          name: 'custom_artifact_tool',
          description: 'Generates custom artifact',
          parameters: { type: 'object' },
          category: 'custom'
        },
        async () => ({
          output: 'artifact generated',
          artifacts: [
            {
              name: 'report.json',
              content: '{"vulnerabilities": 0}',
              mime: 'application/json'
            }
          ]
        })
      )
    })

    try {
      const node = makeNode({ id: 'wrap-node', profileId: 'default-profile', prompt: 'Run tool' })
      const plan: DagExecutionPlan = {
        workflow: { id: 'artifact-no-tools-wf', name: 'Artifact Without Default Tools', nodes: [node] },
        waves: [{ waveIndex: 0, nodeIds: ['wrap-node'] }]
      }

      const runner = new DagRunner(plan, '/test-dir', {
        profiles: mockProfileStore,
        runnerFactory: (params) => {
          capturedNodeTools = params.tools
          return {
            id: params.id,
            run: async () => {
              // Execute the custom tool through the wrapped registry
              const toolResult = await params.tools.execute('custom_artifact_tool', {}, {
                directory: '/test-dir',
                agentId: params.id,
                runId: 'dag-run-1',
                abortSignal: new AbortController().signal
              })
              expect(toolResult.output).toBe('artifact generated')
              return {
                content: 'Tool executed',
                toolCallCount: 1,
                usage: { input: 10, output: 10 },
                turns: 1,
                finishReason: 'complete' as const
              }
            },
            abort: vi.fn(),
            getStatus: vi.fn(() => ({ turns: 1, usage: { input: 10, output: 10 }, running: false }))
          } as unknown as AgentRunner
        }
      })

      const state = await runner.run()
      expect(state.status).toBe('completed')
      expect(capturedNodeTools).toBeDefined()
      expect(capturedNodeTools?.resolve('custom_artifact_tool')).toBeDefined()

      // Deep verification: assert that the returned artifact was captured into node output!
      const nodeOutput = runner.nodeOutputs.get('wrap-node')
      expect(nodeOutput?.artifacts).toBeDefined()
      expect(nodeOutput?.artifacts).toHaveLength(1)
      expect(nodeOutput?.artifacts?.[0]).toEqual({
        name: 'report.json',
        content: '{"vulnerabilities": 0}',
        mime: 'application/json'
      })
    } finally {
      spy.mockRestore()
    }
  })

  it('marks node failed when prompt interpolation fails due to undeclared dependency', async () => {
    const nodeA = makeNode({ id: 'nodeA', prompt: 'Task A' })
    // nodeB references undeclared node ghost without listing in dependencies
    const nodeB = makeNode({ id: 'nodeB', prompt: 'Summarize {{inputs.ghost.output}}' })

    const plan: DagExecutionPlan = {
      workflow: { id: 'bad-interpolation-wf', name: 'Bad Interpolation', nodes: [nodeA, nodeB] },
      waves: [{ waveIndex: 0, nodeIds: ['nodeA', 'nodeB'] }]
    }

    const { factory } = createMockRunnerFactory({
      nodeA: { result: { content: 'Task A done' } }
    })

    const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })
    const state = await runner.run()

    expect(runner.nodeStates.get('nodeA')).toBe('succeeded')
    expect(runner.nodeStates.get('nodeB')).toBe('failed')
    expect(runner.nodeOutputs.get('nodeB')?.error).toMatch(/Unauthorized dependency reference/i)
    expect(state.status).toBe('failed')
  })

  it('terminates immediately with cancelled status if aborted before run() is invoked', async () => {
    const node1 = makeNode({ id: 'n1' })
    const plan: DagExecutionPlan = {
      workflow: { id: 'early-abort-wf', name: 'Early Abort', nodes: [node1] },
      waves: [{ waveIndex: 0, nodeIds: ['n1'] }]
    }

    const { factory } = createMockRunnerFactory()
    const runner = new DagRunner(plan, '/test-dir', { runnerFactory: factory })

    // Abort before run
    runner.abort()
    const state = await runner.run()

    expect(state.status).toBe('cancelled')
    expect(runner.status).toBe('cancelled')
    expect(runner.nodeStates.get('n1')).toBe('pending')
  })
})

