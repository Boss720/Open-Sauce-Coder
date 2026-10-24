/**
 * Multi-Agent Directed Acyclic Graph (DAG) Orchestration types.
 *
 * Defines schemas and contracts for workflows, nodes, execution plans, waves,
 * lifecycle state machines, artifacts, and real-time events.
 */

export type DagNodeState = 'pending' | 'running' | 'succeeded' | 'failed' | 'skipped'
export type DagRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface DagNodePolicy {
  skipOnFail?: boolean
  abortOnFail?: boolean
  condition?: {
    upstreamNodeId: string
    expectedFinishReason?: string
    expectedStatus?: DagNodeState
  }
}

export interface DagNodeDefinition {
  id: string
  name?: string
  profileId: string
  prompt: string
  dependencies?: string[]
  policy?: DagNodePolicy
  maxTurns?: number
}

export interface WorkflowDefinition {
  id: string
  name: string
  description?: string
  version?: string
  nodes: DagNodeDefinition[]
  metadata?: Record<string, unknown>
}

export interface DagWave {
  waveIndex: number
  nodeIds: string[]
}

export interface DagExecutionPlan {
  workflow: WorkflowDefinition
  waves: DagWave[]
}

export interface DagNodeArtifact {
  name: string
  content: string
  mime?: string
}

export interface DagNodeOutput {
  nodeId: string
  status: DagNodeState
  finishReason?: string
  content?: string
  artifacts?: DagNodeArtifact[]
  turns: number
  usage: { input: number; output: number; reasoning?: number }
  error?: string
}

export interface DagEvent {
  type:
    | 'dag_start'
    | 'dag_wave_start'
    | 'dag_node_start'
    | 'dag_node_event'
    | 'dag_node_complete'
    | 'dag_wave_complete'
    | 'dag_complete'
    | 'dag_error'
  dagRunId: string
  timestamp: number
  waveIndex?: number
  nodeId?: string
  event?: unknown
  status?: DagRunStatus | DagNodeState
  output?: DagNodeOutput
  error?: string
}

export interface DagRunState {
  dagRunId: string
  workflowId: string
  status: DagRunStatus
  waves: DagWave[]
  currentWaveIndex: number
  nodeOutputs: Record<string, DagNodeOutput>
  nodeStates: Record<string, DagNodeState>
  startedAt: number
  completedAt?: number
  error?: string
}

export interface DagRunSummary {
  dagRunId: string
  workflowId: string
  status: DagRunStatus
  startedAt: number
  completedAt?: number
  error?: string
}

export interface WorkflowSummary {
  id: string
  name: string
  description?: string
  nodeCount: number
  /** Absolute path on disk; absent for builtin templates, which have no file. */
  filePath?: string
}
