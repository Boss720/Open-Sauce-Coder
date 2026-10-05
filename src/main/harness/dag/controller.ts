/**
 * DAG Controller — main-process coordinator for multi-agent DAG runs.
 *
 * Manages active run tracking, workflow validation, assertSubpath project containment,
 * lifecycle commands (start, stop, status, list), and real-time event forwarding.
 */

import { assertSubpath } from '../../projectsPaths'
import { DagRunner, type DagRunnerOptions } from './runner'
import type {
  DagEvent,
  DagRunState,
  DagRunSummary,
  WorkflowDefinition
} from './types'
import { validateWorkflow } from './validator'

export type DagEventCallback = (dagRunId: string, event: DagEvent) => void

export class DagController {
  private readonly runs = new Map<string, { runner: DagRunner; state: DagRunState }>()
  private onEvent: DagEventCallback | null = null
  private readonly options?: DagRunnerOptions

  constructor(options?: DagRunnerOptions) {
    this.options = options
  }

  /**
   * Sets event listener callback for forwarding DAG events to renderer windows.
   */
  setEventCallback(callback: DagEventCallback): void {
    this.onEvent = callback
  }

  /**
   * Validates workflow, enforces directory containment, initializes DagRunner,
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

    // Path containment check on directory
    assertSubpath(directory, '.', { allowRoot: true })

    const runner = new DagRunner(validation.plan, directory, {
      ...this.options,
      maxConcurrency: options?.maxConcurrency ?? this.options?.maxConcurrency
    })

    const dagRunId = runner.dagRunId
    const entry = { runner, state: runner.getState() }
    this.runs.set(dagRunId, entry)

    // Execute asynchronously (fire-and-forget), forwarding events through callback
    void runner
      .run((event) => {
        entry.state = runner.getState()
        this.onEvent?.(dagRunId, event)
      })
      .catch((err: unknown) => {
        entry.state = runner.getState()
        const errMsg = err instanceof Error ? err.message : String(err)
        this.onEvent?.(dagRunId, {
          type: 'dag_error',
          dagRunId,
          timestamp: Date.now(),
          error: errMsg
        })
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
    return run.runner.getState()
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
        error: s.error
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
