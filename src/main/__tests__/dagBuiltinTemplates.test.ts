import { existsSync, readFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  BUILTIN_WORKFLOWS,
  CODE_REVIEW_FIX_WORKFLOW,
  FEATURE_IMPLEMENTATION_WORKFLOW,
  getBuiltinWorkflow
} from '../harness/dag/builtinWorkflows'
import { interpolatePrompt } from '../harness/dag/interpolator'
import type { DagNodeOutput, WorkflowDefinition } from '../harness/dag/types'
import { validateWorkflow } from '../harness/dag/validator'

const ROOT_DIR = resolve(__dirname, '../../..')
const WORKFLOWS_DIR = join(ROOT_DIR, '.opencode', 'workflows')

describe('Built-in Workflow Templates (Requirement R2)', () => {
  describe('In-Memory Workflow Definitions', () => {
    it('exports BUILTIN_WORKFLOWS catalog containing both templates', () => {
      expect(BUILTIN_WORKFLOWS).toHaveLength(2)
      expect(BUILTIN_WORKFLOWS.map((w) => w.id)).toEqual([
        'code-review-fix',
        'feature-implementation'
      ])
    })

    it('retrieves workflows by ID via getBuiltinWorkflow helper', () => {
      const reviewClone = getBuiltinWorkflow('code-review-fix')
      expect(reviewClone).toEqual(CODE_REVIEW_FIX_WORKFLOW)
      expect(reviewClone).not.toBe(CODE_REVIEW_FIX_WORKFLOW)

      const featureClone = getBuiltinWorkflow('feature-implementation')
      expect(featureClone).toEqual(FEATURE_IMPLEMENTATION_WORKFLOW)
      expect(featureClone).not.toBe(FEATURE_IMPLEMENTATION_WORKFLOW)

      expect(getBuiltinWorkflow('unknown-workflow-id')).toBeUndefined()
    })

    it('validates CODE_REVIEW_FIX_WORKFLOW with zero errors and exactly 3 topological waves', () => {
      const result = validateWorkflow(CODE_REVIEW_FIX_WORKFLOW)
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.plan).toBeDefined()

      const waves = result.plan!.waves
      expect(waves).toHaveLength(3)
      expect(waves[0]).toEqual({ waveIndex: 0, nodeIds: ['code_reviewer'] })
      expect(waves[1]).toEqual({ waveIndex: 1, nodeIds: ['test_writer'] })
      expect(waves[2]).toEqual({ waveIndex: 2, nodeIds: ['fixer'] })

      // Verify node policies and profiles
      const nodes = CODE_REVIEW_FIX_WORKFLOW.nodes
      expect(nodes).toHaveLength(3)

      const reviewerNode = nodes.find((n) => n.id === 'code_reviewer')!
      expect(reviewerNode.name).toBe('Code Reviewer')
      expect(reviewerNode.profileId).toBe('reviewer')
      expect(reviewerNode.dependencies ?? []).toEqual([])
      expect(reviewerNode.policy?.abortOnFail).toBe(true)

      const testWriterNode = nodes.find((n) => n.id === 'test_writer')!
      expect(testWriterNode.name).toBe('Test Writer')
      expect(testWriterNode.profileId).toBe('coder')
      expect(testWriterNode.dependencies).toEqual(['code_reviewer'])
      expect(testWriterNode.policy?.abortOnFail).toBe(true)

      const fixerNode = nodes.find((n) => n.id === 'fixer')!
      expect(fixerNode.name).toBe('Fixer')
      expect(fixerNode.profileId).toBe('coder')
      expect(fixerNode.dependencies).toEqual(['code_reviewer', 'test_writer'])
      expect(fixerNode.policy?.abortOnFail).toBe(true)
    })

    it('validates FEATURE_IMPLEMENTATION_WORKFLOW with zero errors and exactly 3 topological waves', () => {
      const result = validateWorkflow(FEATURE_IMPLEMENTATION_WORKFLOW)
      expect(result.valid).toBe(true)
      expect(result.errors).toEqual([])
      expect(result.plan).toBeDefined()

      const waves = result.plan!.waves
      expect(waves).toHaveLength(3)
      expect(waves[0]).toEqual({ waveIndex: 0, nodeIds: ['architect'] })
      expect(waves[1]).toEqual({ waveIndex: 1, nodeIds: ['implementer'] })
      expect(waves[2]).toEqual({ waveIndex: 2, nodeIds: ['verifier'] })

      // Verify node policies and profiles
      const nodes = FEATURE_IMPLEMENTATION_WORKFLOW.nodes
      expect(nodes).toHaveLength(3)

      const architectNode = nodes.find((n) => n.id === 'architect')!
      expect(architectNode.name).toBe('Architecture Planner')
      expect(architectNode.profileId).toBe('orchestrator')
      expect(architectNode.dependencies ?? []).toEqual([])
      expect(architectNode.policy?.abortOnFail).toBe(true)

      const implementerNode = nodes.find((n) => n.id === 'implementer')!
      expect(implementerNode.name).toBe('Implementer')
      expect(implementerNode.profileId).toBe('coder')
      expect(implementerNode.dependencies).toEqual(['architect'])
      expect(implementerNode.policy?.abortOnFail).toBe(true)

      const verifierNode = nodes.find((n) => n.id === 'verifier')!
      expect(verifierNode.name).toBe('Verifier')
      expect(verifierNode.profileId).toBe('coder')
      expect(verifierNode.dependencies).toEqual(['architect', 'implementer'])
      expect(verifierNode.policy?.abortOnFail).toBe(true)
    })
  })

  describe('On-Disk Workflow JSON Files (.opencode/workflows/)', () => {
    it('verifies code-review-fix.json exists and strictly matches CODE_REVIEW_FIX_WORKFLOW', () => {
      const filePath = join(WORKFLOWS_DIR, 'code-review-fix.json')
      expect(existsSync(filePath)).toBe(true)

      const raw = readFileSync(filePath, 'utf-8')
      const parsed: WorkflowDefinition = JSON.parse(raw)

      expect(parsed).toEqual(CODE_REVIEW_FIX_WORKFLOW)

      const validation = validateWorkflow(parsed)
      expect(validation.valid).toBe(true)
      expect(validation.errors).toEqual([])
      expect(validation.plan?.waves).toEqual([
        { waveIndex: 0, nodeIds: ['code_reviewer'] },
        { waveIndex: 1, nodeIds: ['test_writer'] },
        { waveIndex: 2, nodeIds: ['fixer'] }
      ])
    })

    it('verifies feature-implementation.json exists and strictly matches FEATURE_IMPLEMENTATION_WORKFLOW', () => {
      const filePath = join(WORKFLOWS_DIR, 'feature-implementation.json')
      expect(existsSync(filePath)).toBe(true)

      const raw = readFileSync(filePath, 'utf-8')
      const parsed: WorkflowDefinition = JSON.parse(raw)

      expect(parsed).toEqual(FEATURE_IMPLEMENTATION_WORKFLOW)

      const validation = validateWorkflow(parsed)
      expect(validation.valid).toBe(true)
      expect(validation.errors).toEqual([])
      expect(validation.plan?.waves).toEqual([
        { waveIndex: 0, nodeIds: ['architect'] },
        { waveIndex: 1, nodeIds: ['implementer'] },
        { waveIndex: 2, nodeIds: ['verifier'] }
      ])
    })
  })

  describe('Dependency Graph Invariants & Prompt Parameter Interpolation', () => {
    const workflows: Array<{ name: string; workflow: WorkflowDefinition }> = [
      { name: 'CODE_REVIEW_FIX_WORKFLOW', workflow: CODE_REVIEW_FIX_WORKFLOW },
      { name: 'FEATURE_IMPLEMENTATION_WORKFLOW', workflow: FEATURE_IMPLEMENTATION_WORKFLOW }
    ]

    for (const { name, workflow } of workflows) {
      it(`ensures all prompt input references in ${name} match declared dependencies`, () => {
        const regex = /\{\{\s*inputs\.([a-zA-Z0-9_-]+)/g

        for (const node of workflow.nodes) {
          const declaredDeps = new Set(node.dependencies ?? [])
          const referencedDeps = new Set<string>()

          let match: RegExpExecArray | null
          while ((match = regex.exec(node.prompt)) !== null) {
            referencedDeps.add(match[1])
          }

          for (const dep of referencedDeps) {
            expect(
              declaredDeps.has(dep),
              `Node "${node.id}" in ${name} references "{{inputs.${dep}...}}" but "${dep}" is not in dependencies [${[...declaredDeps].join(', ')}]`
            ).toBe(true)
          }
        }
      })

      it(`ensures all nodes in ${name} are visited across waves with zero unreachable nodes`, () => {
        const result = validateWorkflow(workflow)
        expect(result.valid).toBe(true)

        const visitedNodeIds = new Set<string>()
        for (const wave of result.plan!.waves) {
          for (const nodeId of wave.nodeIds) {
            visitedNodeIds.add(nodeId)
          }
        }

        const allNodeIds = new Set(workflow.nodes.map((n) => n.id))
        expect(visitedNodeIds).toEqual(allNodeIds)
      })

      it(`safely interpolates simulated upstream outputs into ${name} downstream prompts without error`, () => {
        const mockOutputs: Record<string, DagNodeOutput> = {}
        for (const node of workflow.nodes) {
          mockOutputs[node.id] = {
            nodeId: node.id,
            status: 'succeeded',
            content: `Simulated output payload from ${node.id}`,
            turns: 3,
            usage: { input: 100, output: 200 }
          }
        }

        for (const node of workflow.nodes) {
          expect(() => {
            const interpolated = interpolatePrompt(
              node.prompt,
              mockOutputs,
              node.dependencies ?? [],
              { strict: true }
            )
            expect(interpolated).toBeDefined()
            for (const dep of node.dependencies ?? []) {
              if (node.prompt.includes(`{{inputs.${dep}.output}}`)) {
                expect(interpolated).toContain(`Simulated output payload from ${dep}`)
              }
            }
          }).not.toThrow()
        }
      })
    }
  })
})
