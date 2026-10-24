import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type {
  DagNodeOutput,
  DagRunSummary,
  WorkflowDefinition,
  WorkflowSummary
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
  const calls: DagApiMock = {
    listWorkflows: parts.listWorkflows ?? vi.fn(async () => []),
    loadWorkflow: parts.loadWorkflow ?? vi.fn(async () => ({ id: 'wf-1', name: 'WF 1', nodes: [] })),
    startRun: parts.startRun ?? vi.fn(async () => ({ runId: 'run-123' })),
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

describe('dagSlice', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  describe('Initial State', () => {
    it('initializes with clean default values', () => {
      const { get } = setup()
      expect(get().dagWorkflows).toEqual([])
      expect(get().dagActiveWorkflowId).toBeNull()
      expect(get().dagActiveWorkflow).toBeNull()
      expect(get().dagActiveRunId).toBeNull()
      expect(get().dagSelectedNodeId).toBeNull()
      expect(get().dagRuns).toEqual([])
      expect(get().dagNodeStates).toEqual({})
      expect(get().dagNodeOutputs).toEqual({})
      expect(get().dagNodeStreams).toEqual({})
      expect(get().dagLoading).toBe(false)
      expect(get().dagError).toBeNull()
    })
  })

  describe('loadWorkflows', () => {
    it('populates dagWorkflows and manages loading flag', async () => {
      const mockList: WorkflowSummary[] = [
        { id: 'audit', name: 'Codebase Audit', nodeCount: 3, filePath: '.opencode/workflows/audit.json' }
      ]
      const { api: fake, calls } = fakeApi({ listWorkflows: vi.fn(async () => mockList) })
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup({ directory: '/workspace/project' })
      await slice.loadWorkflows()

      expect(calls.listWorkflows).toHaveBeenCalledWith('/workspace/project')
      expect(get().dagWorkflows).toEqual(mockList)
      expect(get().dagLoading).toBe(false)
      expect(get().dagError).toBeNull()
    })

    it('sets dagError when IPC rejects', async () => {
      const { api: fake } = fakeApi({
        listWorkflows: vi.fn(async () => Promise.reject(new Error('Filesystem read error')))
      })
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup({ directory: '/workspace/project' })
      await slice.loadWorkflows()

      expect(get().dagError).toBe('Filesystem read error')
      expect(get().dagLoading).toBe(false)
    })

    it('does not call the bridge, or error, without a project directory', async () => {
      const { api: fake, calls } = fakeApi({ listWorkflows: vi.fn(async () => []) })
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup({ directory: null, dagWorkflows: [] })
      await slice.loadWorkflows()

      // Main requires a directory and no longer falls back to process.cwd(),
      // so there is nothing to list and nothing to report.
      expect(calls.listWorkflows).not.toHaveBeenCalled()
      expect(get().dagWorkflows).toEqual([])
      expect(get().dagError).toBeNull()
      expect(get().dagLoading).toBe(false)
    })
  })

  describe('loadRuns', () => {
    it('populates dagRuns on successful invocation', async () => {
      const mockRuns: DagRunSummary[] = [
        {
          dagRunId: 'run-alpha',
          workflowId: 'wf-1',
          status: 'completed',
          startedAt: 1000,
          completedAt: 2000
        }
      ]
      const { api: fake, calls } = fakeApi({ listRuns: vi.fn(async () => mockRuns) })
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup()
      await slice.loadRuns()

      expect(calls.listRuns).toHaveBeenCalled()
      expect(get().dagRuns).toEqual(mockRuns)
      expect(get().dagError).toBeNull()
    })

    it('sets dagError when listRuns throws', async () => {
      const { api: fake } = fakeApi({
        listRuns: vi.fn(async () => Promise.reject(new Error('Failed to query runs')))
      })
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup()
      await slice.loadRuns()

      expect(get().dagError).toBe('Failed to query runs')
    })
  })

  describe('selectWorkflow & selectNode', () => {
    it('loads workflow definition by directory and workflow id', async () => {
      const definition: WorkflowDefinition = {
        id: 'wf-1',
        name: 'Workflow 1',
        nodes: [{ id: 'node1', profileId: 'coder', prompt: 'test' }]
      }
      const { api: fake, calls } = fakeApi({ loadWorkflow: vi.fn(async () => definition) })
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup({
        directory: '/workspace/project',
        dagWorkflows: [{ id: 'wf-1', name: 'Workflow 1', nodeCount: 1 }]
      })

      await slice.selectWorkflow('wf-1')
      expect(get().dagActiveWorkflowId).toBe('wf-1')
      expect(calls.loadWorkflow).toHaveBeenCalledWith('/workspace/project', 'wf-1')
      expect(get().dagActiveWorkflow).toEqual(definition)
    })

    it('loads a builtin workflow that has no filePath on disk', async () => {
      const definition: WorkflowDefinition = {
        id: 'code-review-fix',
        name: 'Code Review',
        nodes: [{ id: 'node1', profileId: 'coder', prompt: 'test' }]
      }
      const { api: fake, calls } = fakeApi({ loadWorkflow: vi.fn(async () => definition) })
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup({
        directory: '/workspace/project',
        // No filePath: builtins have no file, and the summary no longer
        // fabricates one. Selection must still resolve the definition.
        dagWorkflows: [{ id: 'code-review-fix', name: 'Code Review', nodeCount: 1 }]
      })

      await slice.selectWorkflow('code-review-fix')
      expect(calls.loadWorkflow).toHaveBeenCalledWith('/workspace/project', 'code-review-fix')
      expect(get().dagActiveWorkflow).toEqual(definition)
    })

    it('selectNode updates selected node ID', () => {
      const { get, slice } = setup()
      slice.selectNode('node-42')
      expect(get().dagSelectedNodeId).toBe('node-42')
      slice.selectNode(null)
      expect(get().dagSelectedNodeId).toBeNull()
    })
  })

  describe('startWorkflow & cancelWorkflow', () => {
    it('rejects execution when no directory is open', async () => {
      const { get, slice } = setup({ directory: null })
      await slice.startWorkflow()
      expect(get().dagError).toBe('Pick a project folder first.')
    })

    it('initiates run, updates activeRunId, pending node states, and dagRuns history', async () => {
      const workflow: WorkflowDefinition = {
        id: 'flow-1',
        name: 'Flow 1',
        nodes: [
          { id: 'n1', profileId: 'coder', prompt: 'p1' },
          { id: 'n2', profileId: 'tester', prompt: 'p2' }
        ]
      }
      const { api: fake, calls } = fakeApi({ startRun: vi.fn(async () => ({ runId: 'run-99' })) })
      mockApi.mockReturnValue(fake)

      const { get, slice } = setup({ directory: '/test/dir', dagActiveWorkflow: workflow })
      await slice.startWorkflow()

      expect(calls.startRun).toHaveBeenCalledWith({ workflow, directory: '/test/dir' })
      expect(get().dagActiveRunId).toBe('run-99')
      expect(get().dagNodeStates).toEqual({ n1: 'pending', n2: 'pending' })
      expect(get().dagRuns.length).toBe(1)
      expect(get().dagRuns[0].dagRunId).toBe('run-99')
      expect(get().dagRuns[0].status).toBe('running')
    })

    it('cancelWorkflow calls stopRun for active run', async () => {
      const { api: fake, calls } = fakeApi()
      mockApi.mockReturnValue(fake)

      const { slice } = setup({ dagActiveRunId: 'run-99' })
      await slice.cancelWorkflow()

      expect(calls.stopRun).toHaveBeenCalledWith('run-99')
    })
  })

  describe('handleDagEvent (Lifecycle & Streaming Delta Reduction)', () => {
    it('folds dag_node_start into nodeStates and prepares streams', () => {
      const { get, slice } = setup({ dagActiveRunId: 'run-1' })
      slice.handleDagEvent({
        type: 'dag_node_start',
        dagRunId: 'run-1',
        nodeId: 'n1',
        timestamp: 1000
      })

      expect(get().dagNodeStates['n1']).toBe('running')
      expect(get().dagNodeStreams['n1']).toEqual({ text: '', thinking: '' })
    })

    it('accumulates streaming text and thinking deltas for active node', () => {
      const { get, slice } = setup({ dagActiveRunId: 'run-1' })

      slice.handleDagEvent({
        type: 'dag_node_event',
        dagRunId: 'run-1',
        nodeId: 'n1',
        timestamp: 1001,
        event: { type: 'thinking', delta: 'Let me ' }
      })
      slice.handleDagEvent({
        type: 'dag_node_event',
        dagRunId: 'run-1',
        nodeId: 'n1',
        timestamp: 1002,
        event: { type: 'thinking', delta: 'think...' }
      })
      slice.handleDagEvent({
        type: 'dag_node_event',
        dagRunId: 'run-1',
        nodeId: 'n1',
        timestamp: 1003,
        event: { type: 'text', delta: 'Here is ' }
      })
      slice.handleDagEvent({
        type: 'dag_node_event',
        dagRunId: 'run-1',
        nodeId: 'n1',
        timestamp: 1004,
        event: { type: 'text', delta: 'the plan.' }
      })

      expect(get().dagNodeStreams['n1'].thinking).toBe('Let me think...')
      expect(get().dagNodeStreams['n1'].text).toBe('Here is the plan.')
    })

    it('records completed node status and output artifact', () => {
      const { get, slice } = setup({ dagActiveRunId: 'run-1' })
      const output: DagNodeOutput = {
        nodeId: 'n1',
        status: 'succeeded',
        content: 'Finished successfully',
        turns: 2,
        usage: { input: 100, output: 50 }
      }

      slice.handleDagEvent({
        type: 'dag_node_complete',
        dagRunId: 'run-1',
        nodeId: 'n1',
        timestamp: 2000,
        status: 'succeeded',
        output
      })

      expect(get().dagNodeStates['n1']).toBe('succeeded')
      expect(get().dagNodeOutputs['n1']).toEqual(output)
    })

    it('updates run status on dag_complete and records dag_error', () => {
      const { get, slice } = setup({
        dagActiveRunId: 'run-1',
        dagRuns: [{ dagRunId: 'run-1', workflowId: 'wf-1', status: 'running', startedAt: 1000 }]
      })

      slice.handleDagEvent({
        type: 'dag_complete',
        dagRunId: 'run-1',
        timestamp: 3000,
        status: 'completed'
      })

      expect(get().dagRuns[0].status).toBe('completed')
      expect(get().dagRuns[0].completedAt).toBe(3000)

      slice.handleDagEvent({
        type: 'dag_error',
        dagRunId: 'run-1',
        timestamp: 3100,
        error: 'Execution aborted'
      })

      expect(get().dagError).toBe('Execution aborted')
      expect(get().dagRuns[0].status).toBe('failed')
    })
  })
})
