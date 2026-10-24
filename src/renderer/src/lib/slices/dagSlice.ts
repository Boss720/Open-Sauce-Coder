/**
 * Zustand state slice for Multi-Agent DAG Orchestration.
 *
 * Manages workflow loading, active run state, node selection,
 * and real-time event stream reduction with streaming text/thinking delta
 * accumulation.
 */

import { api, errText } from './api'
import type { AppState, SetState, GetState } from './types'
import type {
  DagEvent,
  DagNodeState,
  DagRunSummary,
  WorkflowDefinition
} from '../types'

export type DagSlice = Pick<
  AppState,
  | 'dagWorkflows'
  | 'dagActiveWorkflowId'
  | 'dagActiveWorkflow'
  | 'dagActiveRunId'
  | 'dagSelectedNodeId'
  | 'dagRuns'
  | 'dagNodeStates'
  | 'dagNodeOutputs'
  | 'dagNodeStreams'
  | 'dagLoading'
  | 'dagError'
  | 'loadWorkflows'
  | 'loadRuns'
  | 'selectWorkflow'
  | 'startWorkflow'
  | 'cancelWorkflow'
  | 'selectNode'
  | 'handleDagEvent'
>

export function createDagSlice(set: SetState, get: GetState): DagSlice {
  return {
    dagWorkflows: [],
    dagActiveWorkflowId: null,
    dagActiveWorkflow: null,
    dagActiveRunId: null,
    dagSelectedNodeId: null,
    dagRuns: [],
    dagNodeStates: {},
    dagNodeOutputs: {},
    dagNodeStreams: {},
    dagLoading: false,
    dagError: null,

    async loadWorkflows(): Promise<void> {
      set({ dagLoading: true, dagError: null })
      try {
        // The project directory is required: main no longer falls back to
        // process.cwd(), so there is nothing to list without one.
        const directory = get().directory
        const bridge = api()
        if (!directory || !bridge.dag?.listWorkflows) {
          set({ dagWorkflows: [], dagLoading: false })
          return
        }
        const workflows = await bridge.dag.listWorkflows(directory)
        set({ dagWorkflows: workflows ?? [], dagLoading: false })
      } catch (e) {
        set({ dagError: errText(e), dagLoading: false })
      }
    },

    async loadRuns(): Promise<void> {
      try {
        const bridge = api()
        if (!bridge.dag?.listRuns) return
        const runs = await bridge.dag.listRuns()
        set({ dagRuns: runs ?? [] })
      } catch (e) {
        set({ dagError: errText(e) })
      }
    },

    async selectWorkflow(workflowId: string): Promise<void> {
      set({ dagActiveWorkflowId: workflowId, dagError: null })
      const directory = get().directory
      if (!directory) {
        set({ dagError: 'Pick a project folder first.' })
        return
      }
      try {
        const bridge = api()
        if (bridge.dag?.loadWorkflow) {
          // Loaded by id against the project directory. Builtin templates have
          // no filePath, so the summary's path cannot be the lookup key.
          const definition = await bridge.dag.loadWorkflow(directory, workflowId)
          set({ dagActiveWorkflow: definition })
        }
      } catch (e) {
        set({ dagError: errText(e) })
      }
    },

    async startWorkflow(workflowParam?: WorkflowDefinition): Promise<void> {
      const directory = get().directory
      if (!directory) {
        set({ dagError: 'Pick a project folder first.' })
        return
      }

      const workflow = workflowParam ?? get().dagActiveWorkflow
      if (!workflow) {
        set({ dagError: 'No active workflow selected to run.' })
        return
      }

      // Reset node state BEFORE starting the run. Events can arrive while the
      // invoke is still in flight, and resetting afterwards would discard them
      // (leaving the run stuck 'running' with every node 'pending').
      set({
        dagLoading: true,
        dagError: null,
        dagActiveRunId: null,
        dagSelectedNodeId: null,
            dagNodeStates: Object.fromEntries(workflow.nodes.map((n) => [n.id, 'pending'])),
        dagNodeOutputs: {},
        dagNodeStreams: {}
      })
      try {
        const bridge = api()
        if (!bridge.dag?.startRun) {
          throw new Error('DAG engine API is unavailable.')
        }

        const { runId } = await bridge.dag.startRun({ workflow, directory })
        set((state) => ({
          // Only adopt runId if dag_start has not already set it, and never
          // overwrite node state that events have since populated.
          dagActiveRunId: state.dagActiveRunId ?? runId,
          dagLoading: false,
          dagRuns: state.dagRuns.some((r) => r.dagRunId === runId)
            ? state.dagRuns
            : [
                {
                  dagRunId: runId,
                  workflowId: workflow.id,
                  status: 'running' as const,
                  startedAt: Date.now()
                },
                ...state.dagRuns
              ]
        }))
      } catch (e) {
        set({ dagError: errText(e), dagLoading: false })
      }
    },

    async cancelWorkflow(runIdParam?: string): Promise<void> {
      const runId = runIdParam ?? get().dagActiveRunId
      if (!runId) return

      try {
        const bridge = api()
        if (bridge.dag?.stopRun) {
          await bridge.dag.stopRun(runId)
        }
      } catch (e) {
        set({ dagError: errText(e) })
      }
    },

    selectNode(nodeId: string | null): void {
      set({ dagSelectedNodeId: nodeId })
    },

    handleDagEvent(event: DagEvent): void {
      set((state) => {
        // Node-level state is single-run, so an event from a previous or
        // concurrent run must not be folded into the active run's maps.
        // dag_start is exempt: it is what makes a run active.
        const isForeignRun =
          event.type !== 'dag_start' &&
          state.dagActiveRunId !== null &&
          event.dagRunId !== state.dagActiveRunId
        if (isForeignRun && event.type !== 'dag_complete' && event.type !== 'dag_error') {
          return {}
        }

        const nextState: Partial<AppState> = {}

        // Reduce event into active run and node state structures
        switch (event.type) {
          case 'dag_start': {
            // A new run owns the node maps: clear them rather than carrying
            // the previous run's states, outputs and streams forward.
            const isSameRun = state.dagActiveRunId === event.dagRunId
            nextState.dagActiveRunId = event.dagRunId
            if (!isSameRun) {
              nextState.dagNodeStates = {}
              nextState.dagNodeOutputs = {}
              nextState.dagNodeStreams = {}
            }
            // Upsert so a run whose dag_start beat startRun's resolution is
            // still tracked (otherwise it stays absent and never completes).
            nextState.dagRuns = state.dagRuns.some((r) => r.dagRunId === event.dagRunId)
              ? state.dagRuns
              : [
                  {
                    dagRunId: event.dagRunId,
                    workflowId: state.dagActiveWorkflowId ?? '',
                    status: 'running' as const,
                    startedAt: event.timestamp
                  },
                  ...state.dagRuns
                ]
            break
          }

          case 'dag_node_start': {
            if (event.nodeId) {
              nextState.dagNodeStates = {
                ...state.dagNodeStates,
                [event.nodeId]: 'running'
              }
              nextState.dagNodeStreams = {
                ...state.dagNodeStreams,
                [event.nodeId]: state.dagNodeStreams[event.nodeId] ?? { text: '', thinking: '' }
              }
            }
            break
          }

          case 'dag_node_event': {
            if (event.nodeId && event.event) {
              const runnerEvent = event.event as {
                type: string
                delta?: string
                content?: string
              }
              const currentStream = state.dagNodeStreams[event.nodeId] ?? {
                text: '',
                thinking: ''
              }

              let text = currentStream.text
              let thinking = currentStream.thinking

              if (runnerEvent.type === 'text' && runnerEvent.delta) {
                text += runnerEvent.delta
              } else if (runnerEvent.type === 'thinking') {
                if (runnerEvent.content) {
                  thinking = runnerEvent.content
                } else if (runnerEvent.delta) {
                  thinking += runnerEvent.delta
                }
              }

              nextState.dagNodeStreams = {
                ...state.dagNodeStreams,
                [event.nodeId]: { text, thinking }
              }
            }
            break
          }

          case 'dag_node_complete': {
            if (event.nodeId) {
              const nodeStatus: DagNodeState =
                (event.status as DagNodeState) || event.output?.status || 'succeeded'
              nextState.dagNodeStates = {
                ...state.dagNodeStates,
                [event.nodeId]: nodeStatus
              }
              if (event.output) {
                nextState.dagNodeOutputs = {
                  ...state.dagNodeOutputs,
                  [event.nodeId]: event.output
                }
              }
            }
            break
          }

          case 'dag_complete': {
            const finalStatus = event.status ?? 'completed'
            const known = state.dagRuns.some((r) => r.dagRunId === event.dagRunId)
            nextState.dagRuns = known
              ? state.dagRuns.map((run) =>
                  run.dagRunId === event.dagRunId
                    ? {
                        ...run,
                        status: finalStatus as DagRunSummary['status'],
                        completedAt: event.timestamp
                      }
                    : run
                )
              : [
                  {
                    dagRunId: event.dagRunId,
                    workflowId: state.dagActiveWorkflowId ?? '',
                    status: finalStatus as DagRunSummary['status'],
                    startedAt: event.timestamp,
                    completedAt: event.timestamp
                  },
                  ...state.dagRuns
                ]
            break
          }

          case 'dag_error': {
            // Only the active run's failure belongs in the panel-level error.
            if (!isForeignRun) {
              nextState.dagError = event.error || 'DAG execution failure'
            }
            if (event.dagRunId) {
              const known = state.dagRuns.some((r) => r.dagRunId === event.dagRunId)
              nextState.dagRuns = known
                ? state.dagRuns.map((run) =>
                    run.dagRunId === event.dagRunId
                      ? {
                          ...run,
                          status: 'failed' as const,
                          completedAt: event.timestamp,
                          error: event.error
                        }
                      : run
                  )
                : [
                    {
                      dagRunId: event.dagRunId,
                      workflowId: state.dagActiveWorkflowId ?? '',
                      status: 'failed' as const,
                      startedAt: event.timestamp,
                      completedAt: event.timestamp,
                      error: event.error
                    },
                    ...state.dagRuns
                  ]
            }
            break
          }

          default:
            break
        }

        return nextState
      })
    }
  }
}
