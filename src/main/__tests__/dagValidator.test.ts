import { describe, expect, it } from 'vitest'
import { validateWorkflow } from '../harness/dag/validator'
import type { WorkflowDefinition } from '../harness/dag/types'

describe('validateWorkflow', () => {
  it('validates a simple linear DAG and partitions into sequential waves', () => {
    const workflow: WorkflowDefinition = {
      id: 'simple-pipeline',
      name: 'Simple Linear Pipeline',
      nodes: [
        {
          id: 'planner',
          name: 'Planner',
          profileId: 'gemini-pro',
          prompt: 'Create a plan'
        },
        {
          id: 'coder',
          name: 'Coder',
          profileId: 'claude-coder',
          prompt: 'Implement according to plan',
          dependencies: ['planner']
        },
        {
          id: 'reviewer',
          name: 'Reviewer',
          profileId: 'reviewer',
          prompt: 'Review the implementation',
          dependencies: ['coder']
        }
      ]
    }

    const result = validateWorkflow(workflow)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.plan).toBeDefined()
    expect(result.plan?.waves).toEqual([
      { waveIndex: 0, nodeIds: ['planner'] },
      { waveIndex: 1, nodeIds: ['coder'] },
      { waveIndex: 2, nodeIds: ['reviewer'] }
    ])
  })

  it('validates a complex multi-branch DAG and flattens parallel workers into waves', () => {
    const workflow: WorkflowDefinition = {
      id: 'feature-pipeline',
      name: 'Feature Multi-Branch Pipeline',
      nodes: [
        {
          id: 'planner',
          profileId: 'planner',
          prompt: 'Plan the architecture'
        },
        {
          id: 'frontend_dev',
          profileId: 'frontend',
          prompt: 'Build UI components',
          dependencies: ['planner']
        },
        {
          id: 'backend_dev',
          profileId: 'backend',
          prompt: 'Build backend routes',
          dependencies: ['planner']
        },
        {
          id: 'doc_writer',
          profileId: 'writer',
          prompt: 'Write specifications',
          dependencies: ['planner']
        },
        {
          id: 'integrator',
          profileId: 'integrator',
          prompt: 'Wire frontend to backend',
          dependencies: ['backend_dev', 'frontend_dev']
        },
        {
          id: 'proofreader',
          profileId: 'writer',
          prompt: 'Proofread docs',
          dependencies: ['doc_writer']
        },
        {
          id: 'qa_auditor',
          profileId: 'qa',
          prompt: 'Perform end to end audit',
          dependencies: ['integrator', 'proofreader']
        }
      ]
    }

    const result = validateWorkflow(workflow)
    expect(result.valid).toBe(true)
    expect(result.errors).toEqual([])
    expect(result.plan).toBeDefined()

    const waves = result.plan!.waves
    expect(waves.length).toBe(4)

    // Wave 0: Entry node
    expect(waves[0]).toEqual({ waveIndex: 0, nodeIds: ['planner'] })

    // Wave 1: Flat parallel worker wave (frontend, backend, docs)
    expect(waves[1]).toEqual({
      waveIndex: 1,
      nodeIds: ['backend_dev', 'doc_writer', 'frontend_dev']
    })

    // Wave 2: Downstream dependent workers
    expect(waves[2]).toEqual({
      waveIndex: 2,
      nodeIds: ['integrator', 'proofreader']
    })

    // Wave 3: Final merger
    expect(waves[3]).toEqual({ waveIndex: 3, nodeIds: ['qa_auditor'] })
  })

  it('partitions multiple independent roots into Wave 0', () => {
    const workflow: WorkflowDefinition = {
      id: 'multi-root',
      name: 'Multi-Root Workflow',
      nodes: [
        { id: 'root_a', profileId: 'p', prompt: 'Root A' },
        { id: 'root_b', profileId: 'p', prompt: 'Root B' },
        { id: 'worker_a', profileId: 'p', prompt: 'Worker A', dependencies: ['root_a'] },
        { id: 'worker_b', profileId: 'p', prompt: 'Worker B', dependencies: ['root_b'] }
      ]
    }

    const result = validateWorkflow(workflow)
    expect(result.valid).toBe(true)
    expect(result.plan?.waves).toEqual([
      { waveIndex: 0, nodeIds: ['root_a', 'root_b'] },
      { waveIndex: 1, nodeIds: ['worker_a', 'worker_b'] }
    ])
  })

  it('rejects a 2-node cycle and reports the exact cycle path', () => {
    const workflow: WorkflowDefinition = {
      id: 'cycle-2',
      name: 'Two Node Cycle',
      nodes: [
        {
          id: 'node_a',
          profileId: 'p',
          prompt: 'A',
          dependencies: ['node_b']
        },
        {
          id: 'node_b',
          profileId: 'p',
          prompt: 'B',
          dependencies: ['node_a']
        }
      ]
    }

    const result = validateWorkflow(workflow)
    expect(result.valid).toBe(false)
    expect(result.plan).toBeUndefined()
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toMatch(/Cyclic dependency detected: node_[ab] -> node_[ab] -> node_[ab]/)
  })

  it('rejects a 3-node cycle and reports the exact cycle path', () => {
    const workflow: WorkflowDefinition = {
      id: 'cycle-3',
      name: 'Three Node Cycle',
      nodes: [
        {
          id: 'alpha',
          profileId: 'p',
          prompt: 'A',
          dependencies: ['beta']
        },
        {
          id: 'beta',
          profileId: 'p',
          prompt: 'B',
          dependencies: ['gamma']
        },
        {
          id: 'gamma',
          profileId: 'p',
          prompt: 'C',
          dependencies: ['alpha']
        }
      ]
    }

    const result = validateWorkflow(workflow)
    expect(result.valid).toBe(false)
    expect(result.errors.length).toBeGreaterThan(0)
    expect(result.errors[0]).toMatch(
      /Cyclic dependency detected: (alpha -> beta -> gamma -> alpha|beta -> gamma -> alpha -> beta|gamma -> alpha -> beta -> gamma)/
    )
  })

  it('rejects self-referencing nodes', () => {
    const workflow: WorkflowDefinition = {
      id: 'self-dep',
      name: 'Self Dependent Node',
      nodes: [
        {
          id: 'solo',
          profileId: 'p',
          prompt: 'Solo task',
          dependencies: ['solo']
        }
      ]
    }

    const result = validateWorkflow(workflow)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Node "solo" cannot depend on itself.')
  })

  it('rejects missing unknown dependencies', () => {
    const workflow: WorkflowDefinition = {
      id: 'missing-dep',
      name: 'Missing Dependency Workflow',
      nodes: [
        {
          id: 'child',
          profileId: 'p',
          prompt: 'Child node',
          dependencies: ['missing_parent']
        }
      ]
    }

    const result = validateWorkflow(workflow)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Node "child" depends on unknown node "missing_parent".')
  })

  it('rejects duplicate node IDs', () => {
    const workflow: WorkflowDefinition = {
      id: 'dup-ids',
      name: 'Duplicate Node IDs',
      nodes: [
        { id: 'worker', profileId: 'p', prompt: 'First worker' },
        { id: 'worker', profileId: 'p', prompt: 'Second worker' }
      ]
    }

    const result = validateWorkflow(workflow)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Duplicate node id "worker" detected.')
  })

  it('validates policy condition references and requires condition upstream node to be in dependencies', () => {
    const validWorkflow: WorkflowDefinition = {
      id: 'valid-condition',
      name: 'Valid Condition Policy',
      nodes: [
        { id: 'planner', profileId: 'p', prompt: 'Plan' },
        {
          id: 'conditional_worker',
          profileId: 'p',
          prompt: 'Run if planner completed',
          dependencies: ['planner'],
          policy: {
            condition: {
              upstreamNodeId: 'planner',
              expectedFinishReason: 'complete'
            }
          }
        }
      ]
    }

    const validResult = validateWorkflow(validWorkflow)
    expect(validResult.valid).toBe(true)

    const invalidWorkflow: WorkflowDefinition = {
      id: 'invalid-condition',
      name: 'Invalid Condition Policy',
      nodes: [
        { id: 'planner', profileId: 'p', prompt: 'Plan' },
        { id: 'scout', profileId: 'p', prompt: 'Scout' },
        {
          id: 'conditional_worker',
          profileId: 'p',
          prompt: 'Run if scout completed',
          dependencies: ['planner'], // Missing 'scout' in dependencies!
          policy: {
            condition: {
              upstreamNodeId: 'scout',
              expectedFinishReason: 'complete'
            }
          }
        }
      ]
    }

    const invalidResult = validateWorkflow(invalidWorkflow)
    expect(invalidResult.valid).toBe(false)
    expect(invalidResult.errors).toContain(
      'Node "conditional_worker" policy condition references upstream node "scout", but it is not listed in dependencies.'
    )
  })

  it('rejects workflows with empty or invalid node arrays', () => {
    const emptyNodesWorkflow = {
      id: 'empty',
      name: 'Empty Workflow',
      nodes: []
    } as WorkflowDefinition

    const result = validateWorkflow(emptyNodesWorkflow)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Workflow must contain at least one node.')
  })

  it('rejects nodes with missing profileId or prompt', () => {
    const invalidWorkflow = {
      id: 'bad-node',
      name: 'Bad Node Workflow',
      nodes: [
        { id: 'node_1', profileId: '', prompt: 'Prompt' },
        { id: 'node_2', profileId: 'prof', prompt: '' }
      ]
    } as WorkflowDefinition

    const result = validateWorkflow(invalidWorkflow)
    expect(result.valid).toBe(false)
    expect(result.errors).toContain('Node "node_1" must specify a profileId.')
  })
})
