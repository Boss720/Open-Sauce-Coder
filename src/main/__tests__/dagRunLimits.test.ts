import { describe, expect, it, vi } from 'vitest'
import { DagRunner } from '../harness/dag/runner'
import { validateWorkflow, MAX_NODE_TURNS, MAX_WORKFLOW_NODES } from '../harness/dag/validator'
import { extractTemplateNodeRefs } from '../harness/dag/interpolator'
import type { DagEvent, DagExecutionPlan, DagNodeDefinition, WorkflowDefinition } from '../harness/dag/types'
import type { AgentRunner, RunnerEvent, RunnerResult } from '../harness/runner'
import type { AgentProfile } from '../harness/profiles'
import type { ProfileStore } from '../harness/profileStore'

function node(id: string, extra: Partial<DagNodeDefinition> = {}): DagNodeDefinition {
  return { id, profileId: 'p', prompt: `task ${id}`, dependencies: [], ...extra }
}

function wf(nodes: DagNodeDefinition[]): WorkflowDefinition {
  return { id: 'wf', name: 'wf', nodes }
}

function planOf(nodes: DagNodeDefinition[]): DagExecutionPlan {
  return {
    workflow: wf(nodes),
    waves: nodes.map((n, i) => ({ waveIndex: i, nodeIds: [n.id] }))
  }
}

interface Behavior {
  usage?: { input: number; output: number; reasoning?: number }
  /** Resolves only on abort(), to model a hung node. */
  hang?: boolean
}

function factoryFor(behaviors: Record<string, Behavior> = {}, seenProfiles?: AgentProfile[]) {
  return (params: { nodeId: string; profile: AgentProfile }) => {
    seenProfiles?.push(params.profile)
    const b = behaviors[params.nodeId] ?? {}
    let release: (() => void) | undefined
    const run = vi.fn(async (_p: string, _e: (e: RunnerEvent) => void): Promise<RunnerResult> => {
      if (b.hang) {
        await new Promise<void>((r) => {
          release = r
        })
      }
      return {
        content: `out ${params.nodeId}`,
        toolCallCount: 0,
        usage: b.usage ?? { input: 1, output: 1, reasoning: 0 },
        turns: 1,
        finishReason: b.hang ? 'aborted' : 'complete'
      } as RunnerResult
    })
    return { run, abort: vi.fn(() => release?.()), getStatus: vi.fn() } as unknown as AgentRunner
  }
}

describe('validator limits', () => {
  it('rejects maxTurns outside 1..MAX_NODE_TURNS or non-integer', () => {
    for (const bad of [0, -1, 1.5, MAX_NODE_TURNS + 1, Number.NaN]) {
      const res = validateWorkflow(wf([node('a', { maxTurns: bad })]))
      expect(res.valid, String(bad)).toBe(false)
      expect(res.errors.join(' ')).toMatch(/maxTurns/)
    }
    expect(validateWorkflow(wf([node('a', { maxTurns: MAX_NODE_TURNS })])).valid).toBe(true)
    expect(validateWorkflow(wf([node('a', { maxTurns: 1 })])).valid).toBe(true)
  })

  it('rejects a prompt referencing a node that is not a dependency', () => {
    const res = validateWorkflow(wf([node('a'), node('b', { prompt: 'use {{inputs.a.output}}' })]))
    expect(res.valid).toBe(false)
    expect(res.errors.join(' ')).toMatch(/"a" is not listed in its dependencies/)
  })

  it('accepts a prompt referencing a declared dependency', () => {
    const res = validateWorkflow(
      wf([node('a'), node('b', { prompt: 'use {{inputs.a.output}}', dependencies: ['a'] })])
    )
    expect(res.valid).toBe(true)
  })

  it('rejects more than MAX_WORKFLOW_NODES nodes', () => {
    const nodes = Array.from({ length: MAX_WORKFLOW_NODES + 1 }, (_, i) => node(`n${i}`))
    const res = validateWorkflow(wf(nodes))
    expect(res.valid).toBe(false)
    expect(res.errors.join(' ')).toMatch(new RegExp(`maximum is ${MAX_WORKFLOW_NODES}`))
  })
})

describe('extractTemplateNodeRefs', () => {
  it('returns distinct node ids in first-seen order', () => {
    expect(
      extractTemplateNodeRefs('{{inputs.b.output}} {{inputs.a.status}} {{inputs.b.status}}')
    ).toEqual(['b', 'a'])
  })

  it('returns [] for no markers and for non-strings', () => {
    expect(extractTemplateNodeRefs('plain text')).toEqual([])
    expect(extractTemplateNodeRefs(undefined as unknown as string)).toEqual([])
  })

  it('is stable across repeated calls (no shared regex lastIndex)', () => {
    const t = '{{inputs.a.output}}'
    expect(extractTemplateNodeRefs(t)).toEqual(['a'])
    expect(extractTemplateNodeRefs(t)).toEqual(['a'])
  })
})

describe('DagRunner run-level limits', () => {
  it('node maxTurns cannot exceed the profile maxTurns cap', async () => {
    const seen: AgentProfile[] = []
    const profiles = {
      get: () => ({ id: 'p', name: 'p', provider: 'mock', model: 'm', maxTurns: 5 })
    } as unknown as ProfileStore
    const nodes = [node('a', { maxTurns: 400 }), node('b', { maxTurns: 2, dependencies: ['a'] })]
    const runner = new DagRunner(planOf(nodes), '/d', {
      profiles,
      runnerFactory: factoryFor({}, seen) as never
    })
    await runner.run()
    expect(seen.map((p) => p.maxTurns)).toEqual([5, 2])
  })

  it('halts as failed when aggregate tokens exceed maxRunTokens', async () => {
    const nodes = [node('a'), node('b', { dependencies: ['a'] }), node('c', { dependencies: ['b'] })]
    const runner = new DagRunner(planOf(nodes), '/d', {
      maxRunTokens: 100,
      runnerFactory: factoryFor({ a: { usage: { input: 80, output: 40 } } }) as never
    })
    const state = await runner.run()
    expect(state.status).toBe('failed')
    expect(state.error).toMatch(/token budget exceeded/i)
    expect(runner.nodeStates.get('c')).not.toBe('succeeded')
  })

  it('halts as failed when maxRunDurationMs elapses', async () => {
    const nodes = [node('a'), node('b', { dependencies: ['a'] })]
    const runner = new DagRunner(planOf(nodes), '/d', {
      maxRunDurationMs: 30,
      runnerFactory: factoryFor({ a: { hang: true } }) as never
    })
    const state = await runner.run()
    expect(state.status).toBe('failed')
    expect(state.error).toMatch(/time limit/)
    expect(runner.nodeStates.get('b')).not.toBe('succeeded')
  })

  it('a throwing onEvent listener does not fail the run or reject run()', async () => {
    const runner = new DagRunner(planOf([node('a')]), '/d', {
      runnerFactory: factoryFor() as never
    })
    const state = await runner.run(() => {
      throw new Error('webContents destroyed')
    })
    expect(state.status).toBe('completed')
    expect(runner.nodeStates.get('a')).toBe('succeeded')
  })

  it('a second run() call on the same runner throws', async () => {
    const runner = new DagRunner(planOf([node('a')]), '/d', {
      runnerFactory: factoryFor({ a: { hang: true } }) as never
    })
    const first = runner.run()
    await expect(runner.run()).rejects.toThrow(/already been started/)
    runner.abort()
    await first
  })

  it('still emits dag_start first with a healthy listener', async () => {
    const events: DagEvent[] = []
    const runner = new DagRunner(planOf([node('a')]), '/d', { runnerFactory: factoryFor() as never })
    await runner.run((e) => events.push(e))
    expect(events[0].type).toBe('dag_start')
  })
})
