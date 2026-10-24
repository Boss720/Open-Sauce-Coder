/**
 * DAG Controller — main-process coordinator for multi-agent DAG runs.
 *
 * Manages active run tracking, workflow validation, run-directory validation,
 * lifecycle commands (start, stop, status, list), and real-time event forwarding.
 */

import { statSync } from 'node:fs'
import { isAbsolute } from 'node:path'
import { DagRunner, type DagRunnerOptions } from './runner'
import type {
  DagEvent,
  DagNodeOutput,
  DagRunState,
  DagRunSummary,
  WorkflowDefinition
} from './types'
import { validateWorkflow } from './validator'

export type DagEventCallback = (dagRunId: string, event: DagEvent) => void

/** Maximum number of finished runs kept in memory; running runs are never evicted. */
export const MAX_RETAINED_RUNS = 20
/** Per-string cap (UTF-16 units) on node output content/errors that cross IPC. */
export const MAX_IPC_STRING_CHARS = 64 * 1024

export function truncateForIpc(value: string, max = MAX_IPC_STRING_CHARS): string {
  if (value.length <= max) return value
  return `${value.slice(0, max)}
[... truncated ${value.length - max} characters]`
}

/**
 * Returns a copy of a run state with every large string (node output content,
 * errors, artifact content) bounded, so getRunStatus cannot ship unbounded payloads.
 */
function boundNodeOutput(out: DagNodeOutput, max: number): DagNodeOutput {
  return {
    ...out,
    content: typeof out.content === 'string' ? truncateForIpc(out.content, max) : out.content,
    error: typeof out.error === 'string' ? truncateForIpc(out.error, max) : out.error,
    artifacts: out.artifacts?.map((a) => ({ ...a, content: truncateForIpc(a.content, max) }))
  }
}

export function boundRunState(state: DagRunState, max = MAX_IPC_STRING_CHARS): DagRunState {
  const nodeOutputs: DagRunState['nodeOutputs'] = {}
  for (const [id, out] of Object.entries(state.nodeOutputs ?? {})) {
    nodeOutputs[id] = boundNodeOutput(out, max)
  }
  return {
    ...state,
    nodeOutputs,
    error: typeof state.error === 'string' ? truncateForIpc(state.error, max) : state.error
  }
}

/**
 * Returns a copy of a DAG event with its node output and error bounded, so the
 * oc:dag:event broadcast obeys the same per-string cap as getRunStatus.
 */
export function boundDagEvent(event: DagEvent, max = MAX_IPC_STRING_CHARS): DagEvent {
  if (!event.output && typeof event.error !== 'string') return event
  return {
    ...event,
    output: event.output ? boundNodeOutput(event.output, max) : event.output,
    error: typeof event.error === 'string' ? truncateForIpc(event.error, max) : event.error
  }
}

function isFinishedStatus(status: string): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export class DagController {
  private readonly runs = new Map<string, { runner: DagRunner; state: DagRunState }>()
  private onEvent: DagEventCallback | null = null
  private readonly options?: DagRunnerOptions

  constructor(options?: DagRunnerOptions) {
    this.options = options
  }

  /** Evicts the oldest finished runs beyond MAX_RETAINED_RUNS. Never evicts running ones. */
  private pruneFinishedRuns(): void {
    const finished: string[] = []
    for (const [id, entry] of this.runs) {
      // Map iteration is insertion order, i.e. oldest first.
      if (isFinishedStatus(entry.state.status) || isFinishedStatus(entry.runner.getState().status)) {
        finished.push(id)
      }
    }
    for (const id of finished.slice(0, Math.max(0, finished.length - MAX_RETAINED_RUNS))) {
      this.runs.delete(id)
    }
  }

  /**
   * Sets event listener callback for forwarding DAG events to renderer windows.
   */
  setEventCallback(callback: DagEventCallback): void {
    this.onEvent = callback
  }

  /**
   * Validates the workflow and the run directory, initializes DagRunner,
   * wires event callbacks, and starts execution asynchronously.
   */
  async startDagRun(params: {
    workflow: WorkflowDefinition
    directory: string
    options?: { maxConcurrency?: number }
  }): Promise<{ dagRunId: string }> {
    const { workflow, directory, options } = params

    // Validate workflow definition and generate execution plan
    const validation = validateWorkflow(workflow)
    if (!validation.valid || !validation.plan) {
      throw new Error(`Invalid workflow definition: ${validation.errors.join('; ')}`)
    }

    // The run directory becomes the cwd for every node's agent and tools, so it
    // must be an absolute path to a real directory. Note that assertSubpath is
    // deliberately NOT used here: there is no outer base to contain against, and
    // assertSubpath(directory, '.') would compare the directory with itself and
    // always pass. Callers are responsible for having validated the directory
    // (the IPC layer does so via requireDirectory).
    if (!directory || typeof directory !== 'string' || !isAbsolute(directory)) {
      throw new Error('DAG run directory must be an absolute path.')
    }
    let dirInfo: ReturnType<typeof statSync>
    try {
      dirInfo = statSync(directory)
    } catch {
      throw new Error(`DAG run directory does not exist: ${directory}`)
    }
    if (!dirInfo.isDirectory()) {
      throw new Error(`DAG run directory is not a directory: ${directory}`)
    }

    const runner = new DagRunner(validation.plan, directory, {
      ...this.options,
      maxConcurrency: options?.maxConcurrency ?? this.options?.maxConcurrency
    })

    const dagRunId = runner.dagRunId
    const entry = { runner, state: runner.getState() }
    this.runs.set(dagRunId, entry)
    this.pruneFinishedRuns()

    // Execute asynchronously (fire-and-forget), forwarding events through callback
    void runner
      .run((event) => {
        entry.state = runner.getState()
        this.onEvent?.(dagRunId, boundDagEvent(event))
      })
      .catch((err: unknown) => {
        // run() rejected, so nothing else will stop its in-flight nodes.
        try {
          runner.abort()
        } catch {
          // ignore
        }
        entry.state = runner.getState()
        const errMsg = err instanceof Error ? err.message : String(err)
        this.onEvent?.(dagRunId, {
          type: 'dag_error',
          dagRunId,
          timestamp: Date.now(),
          error: truncateForIpc(errMsg)
        })
      })
      .finally(() => {
        entry.state = runner.getState()
        this.pruneFinishedRuns()
      })

    return { dagRunId }
  }

  /**
   * Stops an active DAG run by triggering runner abort.
   * Returns true if run was active and aborted, false otherwise.
   */
  async stopDagRun(dagRunId: string): Promise<boolean> {
    const run = this.runs.get(dagRunId)
    if (!run) {
      return false
    }

    if (run.state.status !== 'running' && run.state.status !== 'pending') {
      return false
    }

    run.runner.abort()
    run.state = run.runner.getState()
    run.state.status = 'cancelled'
    run.state.completedAt = Date.now()
    return true
  }

  /**
   * Retrieves current status and node state for a DAG run.
   */
  getDagRunStatus(dagRunId: string): DagRunState | null {
    const run = this.runs.get(dagRunId)
    if (!run) {
      return null
    }
    return boundRunState(run.runner.getState())
  }

  /**
   * Lists summaries of all known DAG runs.
   */
  listDagRuns(): DagRunSummary[] {
    return [...this.runs.values()].map(({ runner }) => {
      const s = runner.getState()
      return {
        dagRunId: s.dagRunId,
        workflowId: s.workflowId,
        status: s.status,
        startedAt: s.startedAt,
        completedAt: s.completedAt,
        error: typeof s.error === 'string' ? truncateForIpc(s.error) : s.error
      }
    })
  }
}

/**
 * Main-process singleton for DagController.
 */
let singleton: DagController | null = null

export function getDagController(): DagController {
  if (!singleton) {
    singleton = new DagController()
  }
  return singleton
}
