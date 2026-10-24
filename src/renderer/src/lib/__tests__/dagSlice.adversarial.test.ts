import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type {
  DagEvent,
  DagNodeOutput,
  WorkflowDefinition
} from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createDagSlice, type DagSlice } from '../slices/dagSlice'

const mockApi = vi.mocked(api)

function createStore(): { get: GetState; set: SetState } {
  let state = {} as AppState
  const set = ((partial: unknown) => {
    const patch =
      typeof partial === 'function' ? (partial as (s: AppState) => Partial<AppState>)(state) : partial
    state = { ...state, ...(patch as Partial<AppState>) }
  }) as SetState
  const get: GetState = () => state
  return { get, set }
}

function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: DagSlice } {
  const { get, set } = createStore()
  const slice = createDagSlice(set, get)
  set(slice)
  set(overrides)
  return { get, slice }
}

type DagApiMock = {
  listWorkflows: ReturnType<typeof vi.fn>
  loadWorkflow: ReturnType<typeof vi.fn>
  startRun: ReturnType<typeof vi.fn>
  stopRun: ReturnType<typeof vi.fn>
  getRunStatus: ReturnType<typeof vi.fn>
  listRuns: ReturnType<typeof vi.fn>
  onEvent: ReturnType<typeof vi.fn>
}

function fakeApi(parts: Partial<DagApiMock> = {}): { api: OpencodeApi; calls: DagApiMock } {
  let runCounter = 100
  const calls: DagApiMock = {
    listWorkflows: parts.listWorkflows ?? vi.fn(async () => []),
    loadWorkflow: parts.loadWorkflow ?? vi.fn(async () => ({ id: 'wf-stress', name: 'WF Stress', nodes: [] })),
    startRun: parts.startRun ?? vi.fn(async () => ({ runId: `run-${++runCounter}` })),
    stopRun: parts.stopRun ?? vi.fn(async () => ({ success: true })),
    getRunStatus: parts.getRunStatus ?? vi.fn(async () => null),
    listRuns: parts.listRuns ?? vi.fn(async () => []),
    onEvent: parts.onEvent ?? vi.fn(() => () => {})
  }
  return {
    api: {
      dag: {
        listWorkflows: calls.listWorkflows,
        loadWorkflow: calls.loadWorkflow,
        startRun: calls.startRun,
        stopRun: calls.stopRun,
        getRunStatus: calls.getRunStatus,
        listRuns: calls.listRuns,
        onEvent: calls.onEvent
      }
    } as unknown as OpencodeApi,
    calls
  }
}

describe('dagSlice Adversarial Stress Tests', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  describe('2. Concurrent Node Delta Streaming (10 concurrent nodes)', () => {
    it('interleaves streaming text and thinking deltas for 10 concurrent nodes without buffer corruption or cross-talk', () => {
      const { get, slice } = setup({ dagActiveRunId: 'run-concurrent' })
      const nodeCount = 10
      const chunksPerNode = 40
      const nodeIds = Array.from({ length: nodeCount }, (_, i) => `worker-node-${i}`)

      // Initialize all nodes
      for (const nodeId of nodeIds) {
        slice.handleDagEvent({
          type: 'dag_node_start',
          dagRunId: 'run-concurrent',
          nodeId,
          timestamp: 100
        })
      }

      // Expected outputs
      const expectedTexts: Record<string, string> = {}
      const expectedThinkings: Record<string, string> = {}
      for (const nodeId of nodeIds) {
        expectedTexts[nodeId] = ''
        expectedThinkings[nodeId] = ''
      }

      // Emit interleaved deltas in round-robin fashion
      for (let round = 0; round < chunksPerNode; round++) {
        for (const nodeId of nodeIds) {
          const textChunk = `[${nodeId}:t${round}] `
          expectedTexts[nodeId] += textChunk

          slice.handleDagEvent({
            type: 'dag_node_event',
            dagRunId: 'run-concurrent',
            nodeId,
            timestamp: 200 + round,
            event: { type: 'text', delta: textChunk }
          })

          const thinkingChunk = `[${nodeId}:th${round}] `
          expectedThinkings[nodeId] += thinkingChunk

          slice.handleDagEvent({
            type: 'dag_node_event',
            dagRunId: 'run-concurrent',
            nodeId,
            timestamp: 300 + round,
            event: { type: 'thinking', delta: thinkingChunk }
          })
        }
      }

      const streams = get().dagNodeStreams
      expect(Object.keys(streams).length).toBe(nodeCount)

      for (const nodeId of nodeIds) {
        expect(streams[nodeId]).toBeDefined()
        expect(streams[nodeId].text).toBe(expectedTexts[nodeId])
        expect(streams[nodeId].thinking).toBe(expectedThinkings[nodeId])
        // Verify length invariant
        expect(streams[nodeId].text.length).toBe(expectedTexts[nodeId].length)
        expect(streams[nodeId].thinking.length).toBe(expectedThinkings[nodeId].length)
      }
    })

    it('handles thinking full content replacement alongside delta accumulation', () => {
      const { get, slice } = setup({ dagActiveRunId: 'run-thinking-switch' })
      const nodeId = 'thinker-1'

      slice.handleDagEvent({
        type: 'dag_node_start',
        dagRunId: 'run-thinking-switch',
        nodeId,
        timestamp: 1
      })

      // 1. Initial deltas
      slice.handleDagEvent({
        type: 'dag_node_event',
        dagRunId: 'run-thinking-switch',
        nodeId,
        timestamp: 2,
        event: { type: 'thinking', delta: 'Initial thought.' }
      })
      expect(get().dagNodeStreams[nodeId].thinking).toBe('Initial thought.')

      // 2. Full content replacement (as emitted by runner upon turn finalization)
      slice.handleDagEvent({
        type: 'dag_node_event',
        dagRunId: 'run-thinking-switch',
        nodeId,
        timestamp: 3,
        event: { type: 'thinking', content: 'Comprehensive structured reasoning block.' }
      })
      expect(get().dagNodeStreams[nodeId].thinking).toBe('Comprehensive structured reasoning block.')

      // 3. Subsequent deltas append to the replaced content
      slice.handleDagEvent({
        type: 'dag_node_event',
        dagRunId: 'run-thinking-switch',
        nodeId,
        timestamp: 4,
        event: { type: 'thinking', delta: ' Additional note.' }
      })
      expect(get().dagNodeStreams[nodeId].thinking).toBe('Comprehensive structured reasoning block. Additional note.')
    })
  })

  describe('3. Out-of-Order Lifecycle Events & Adversarial Payloads', () => {
    it('handles dag_node_complete before dag_node_start without throwing', () => {
      const { get, slice } = setup({ dagActiveRunId: 'run-ooo' })
      const output: DagNodeOutput = {
        nodeId: 'early-node',
        status: 'succeeded',
        content: 'Finished before start event arrived',
        turns: 1,
        usage: { input: 10, output: 20 }
      }

      expect(() => {
        // Complete arrives FIRST
        slice.handleDagEvent({
          type: 'dag_node_complete',
          dagRunId: 'run-ooo',
          nodeId: 'early-node',
          timestamp: 100,
          status: 'succeeded',
          output
        })
      }).not.toThrow()

      expect(get().dagNodeStates['early-node']).toBe('succeeded')
      expect(get().dagNodeOutputs['early-node']).toEqual(output)

      expect(() => {
        // Start arrives LATE
        slice.handleDagEvent({
          type: 'dag_node_start',
          dagRunId: 'run-ooo',
          nodeId: 'early-node',
          timestamp: 105
        })
      }).not.toThrow()

      // Late start flips state to running as received from event stream
      expect(get().dagNodeStates['early-node']).toBe('running')
      // Existing output payload is preserved
      expect(get().dagNodeOutputs['early-node']).toEqual(output)
    })

    it('handles dag_node_event before dag_node_start gracefully', () => {
      const { get, slice } = setup({ dagActiveRunId: 'run-ooo' })

      expect(() => {
        slice.handleDagEvent({
          type: 'dag_node_event',
          dagRunId: 'run-ooo',
          nodeId: 'ghost-node',
          timestamp: 200,
          event: { type: 'text', delta: 'Premature text' }
        })
      }).not.toThrow()

      expect(get().dagNodeStreams['ghost-node']).toEqual({
        text: 'Premature text',
        thinking: ''
      })
    })

    it('resists malformed events, null objects, and invalid IDs without throwing', () => {
      const { get, slice } = setup({ dagActiveRunId: 'run-malformed' })

      const malformedEvents: DagEvent[] = [
        // Missing nodeId
        { type: 'dag_node_start', dagRunId: 'run-malformed', timestamp: 1 },
        { type: 'dag_node_complete', dagRunId: 'run-malformed', timestamp: 2 },
        { type: 'dag_node_event', dagRunId: 'run-malformed', timestamp: 3 },
        // Empty string nodeId
        { type: 'dag_node_start', dagRunId: 'run-malformed', nodeId: '', timestamp: 4 },
        { type: 'dag_node_complete', dagRunId: 'run-malformed', nodeId: '', timestamp: 5 },
        // event is null/undefined/primitive
        { type: 'dag_node_event', dagRunId: 'run-malformed', nodeId: 'node-x', event: null, timestamp: 6 },
        { type: 'dag_node_event', dagRunId: 'run-malformed', nodeId: 'node-x', event: undefined, timestamp: 7 },
        { type: 'dag_node_event', dagRunId: 'run-malformed', nodeId: 'node-x', event: 'string-event', timestamp: 8 },
        { type: 'dag_node_event', dagRunId: 'run-malformed', nodeId: 'node-x', event: 12345, timestamp: 9 },
        // event has unknown type
        { type: 'dag_node_event', dagRunId: 'run-malformed', nodeId: 'node-x', event: { type: 'custom_ping' }, timestamp: 10 },
        // complete with null output and undefined status
        { type: 'dag_node_complete', dagRunId: 'run-malformed', nodeId: 'node-x', status: undefined, output: undefined, timestamp: 11 },
        // dag_complete for non-existent runId
        { type: 'dag_complete', dagRunId: 'non-existent-run', timestamp: 12 },
        // dag_error with undefined error message
        { type: 'dag_error', dagRunId: 'non-existent-run', timestamp: 13, error: undefined },
        // unknown event type
        { type: 'unrecognized_event', dagRunId: 'run-malformed', timestamp: 14 } as unknown as DagEvent
      ]

      for (const ev of malformedEvents) {
        expect(() => slice.handleDagEvent(ev)).not.toThrow()
      }

      // Verify node-x fell back to 'succeeded' default status
      expect(get().dagNodeStates['node-x']).toBe('succeeded')
      // A dag_error for a DIFFERENT run must not be surfaced as the active
      // run's error, so the panel error stays clear here.
      expect(get().dagError).toBeNull()

      // An error for the active run does set it, falling back to a default
      // message when the event carries none.
      slice.handleDagEvent({
        type: 'dag_error',
        dagRunId: 'run-malformed',
        timestamp: 15,
        error: undefined
      } as unknown as DagEvent)
      expect(get().dagError).toBe('DAG execution failure')
    })

    it('prevents prototype pollution via adversarial node IDs (__proto__, constructor)', () => {
      const { slice } = setup({ dagActiveRunId: 'run-proto' })

      expect(() => {
        slice.handleDagEvent({
          type: 'dag_node_start',
          dagRunId: 'run-proto',
          nodeId: '__proto__',
          timestamp: 1
        })
        slice.handleDagEvent({
          type: 'dag_node_event',
          dagRunId: 'run-proto',
          nodeId: '__proto__',
          timestamp: 2,
          event: { type: 'text', delta: 'pollution attempt' }
        })
        slice.handleDagEvent({
          type: 'dag_node_complete',
          dagRunId: 'run-proto',
          nodeId: '__proto__',
          timestamp: 3,
          status: 'failed'
        })
      }).not.toThrow()

      // Global Object.prototype must NOT be polluted
      const prototype = Object.prototype as Record<string, unknown>
      expect(prototype.text).toBeUndefined()
      expect(prototype.thinking).toBeUndefined()
      expect(prototype.running).toBeUndefined()
      expect(prototype.failed).toBeUndefined()
    })
  })

  describe('4. Rapid startRun and cancelRun State Transitions', () => {
    it('survives rapid parallel startWorkflow requests without corrupting state', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-rapid',
        name: 'Rapid WF',
        nodes: [{ id: 'n1', profileId: 'p', prompt: 'test' }]
      }
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup({
        directory: '/test/workspace',
        dagActiveWorkflow: workflow
      })

      // Fire 20 startWorkflow calls in parallel
      const startPromises = Array.from({ length: 20 }, () => slice.startWorkflow())
      await Promise.all(startPromises)

      expect(calls.startRun).toHaveBeenCalledTimes(20)
      // dagLoading must reset to false
      expect(get().dagLoading).toBe(false)
      expect(get().dagError).toBeNull()
      // dagRuns must have recorded all 20 runs
      expect(get().dagRuns.length).toBe(20)
      // active run ID must be a valid run ID
      expect(get().dagActiveRunId).toMatch(/^run-\d+$/)
    })

    it('survives rapid concurrent cancelWorkflow calls without errors', async () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup({ dagActiveRunId: 'run-to-cancel' })

      // Fire 30 cancel calls concurrently
      const cancelPromises = Array.from({ length: 30 }, () => slice.cancelWorkflow())
      await Promise.all(cancelPromises)

      expect(calls.stopRun).toHaveBeenCalledTimes(30)
      expect(calls.stopRun).toHaveBeenCalledWith('run-to-cancel')
      expect(get().dagError).toBeNull()
    })

    it('handles interleaved rapid start, event, and cancel sequences', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-interleaved',
        name: 'Interleaved WF',
        nodes: [{ id: 'node-a', profileId: 'coder', prompt: 'code' }]
      }
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup({
        directory: '/workspace',
        dagActiveWorkflow: workflow
      })

      for (let cycle = 0; cycle < 10; cycle++) {
        // Start run
        await slice.startWorkflow()
        const activeRunId = get().dagActiveRunId!
        expect(activeRunId).toBeDefined()

        // Stream some events
        slice.handleDagEvent({
          type: 'dag_node_start',
          dagRunId: activeRunId,
          nodeId: 'node-a',
          timestamp: Date.now()
        })
        slice.handleDagEvent({
          type: 'dag_node_event',
          dagRunId: activeRunId,
          nodeId: 'node-a',
          timestamp: Date.now(),
          event: { type: 'text', delta: `Cycle ${cycle} output` }
        })

        // Cancel run
        await slice.cancelWorkflow()

        // Stream complete/error event
        slice.handleDagEvent({
          type: 'dag_complete',
          dagRunId: activeRunId,
          timestamp: Date.now(),
          status: 'cancelled'
        })
      }

      expect(calls.startRun).toHaveBeenCalledTimes(10)
      expect(calls.stopRun).toHaveBeenCalledTimes(10)
      expect(get().dagRuns.length).toBe(10)
      // Every run in dagRuns should have finished cleanly as cancelled
      for (const run of get().dagRuns) {
        expect(run.status).toBe('cancelled')
      }
    })

    it('captures bridge failures gracefully during startRun and cancelRun without crashing', async () => {
      const workflow: WorkflowDefinition = {
        id: 'wf-fail',
        name: 'Fail WF',
        nodes: [{ id: 'n1', profileId: 'p', prompt: 'hi' }]
      }
      const { api: fake } = fakeApi({
        startRun: vi.fn(async () => {
          throw new Error('IPC Bridge Disconnected')
        }),
        stopRun: vi.fn(async () => {
          throw new Error('Process Kill Permission Denied')
        })
      })
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup({
        directory: '/test/dir',
        dagActiveWorkflow: workflow,
        dagActiveRunId: 'run-fail'
      })

      // start failure
      await slice.startWorkflow()
      expect(get().dagError).toBe('IPC Bridge Disconnected')
      expect(get().dagLoading).toBe(false)

      // The attempted run cleared the previous active run, and the start
      // failed, so there is no run left to cancel implicitly.
      expect(get().dagActiveRunId).toBeNull()
      await slice.cancelWorkflow()
      expect(get().dagError).toBe('IPC Bridge Disconnected')

      // Cancelling an explicit run id still surfaces the stopRun failure.
      await slice.cancelWorkflow('run-fail')
      expect(get().dagError).toBe('Process Kill Permission Denied')
    })
  })
})
