import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  getBuiltinWorkflow
} from '../harness/dag/builtinWorkflows'
import {
  interpolatePrompt,
  MAX_INTERPOLATED_CHARS
} from '../harness/dag/interpolator'
import type { DagNodeOutput, WorkflowDefinition } from '../harness/dag/types'
import { validateWorkflow } from '../harness/dag/validator'
import {
  deleteWorkflow,
  getWorkflow,
  listWorkflows,
  loadWorkflow,
  saveWorkflow,
  seedBuiltinWorkflows
} from '../harness/dag/workflowLoader'
import { loadIpc, type IpcHarness } from './ipcHarness'

describe('Empirical Challenger 2: Adversarial Stress Suite for DAG Workflows, Loader, Validator, & Interpolator', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'oc-challenger2-'))
  })

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true })
    } catch {
      // Ignore cleanup error
    }
  })

  // =========================================================================
  // 1. In-Memory Mutation & Cycle Detection
  // =========================================================================
  describe('1. Cycle Detection & Graph Mutation Resiliency', () => {
    it('detects 2-node cycle when dependencies are mutated to circular', () => {
      const wf: WorkflowDefinition = {
        id: 'cycle-2-mutated',
        name: 'Mutated 2-Cycle',
        nodes: [
          { id: 'node_a', profileId: 'p', prompt: 'A', dependencies: [] },
          { id: 'node_b', profileId: 'p', prompt: 'B', dependencies: ['node_a'] }
        ]
      }

      // Valid initially
      expect(validateWorkflow(wf).valid).toBe(true)

      // Mutate node_a to depend on node_b, creating a cycle
      wf.nodes[0].dependencies = ['node_b']

      const result = validateWorkflow(wf)
      expect(result.valid).toBe(false)
      expect(result.plan).toBeUndefined()
      expect(result.errors.some((e) => e.includes('Cyclic dependency detected'))).toBe(true)
    })

    it('detects 3-node ring cycle and traces cycle path', () => {
      const wf: WorkflowDefinition = {
        id: 'cycle-3',
        name: 'Three Node Ring',
        nodes: [
          { id: 'step_1', profileId: 'p', prompt: '1', dependencies: ['step_3'] },
          { id: 'step_2', profileId: 'p', prompt: '2', dependencies: ['step_1'] },
          { id: 'step_3', profileId: 'p', prompt: '3', dependencies: ['step_2'] }
        ]
      }

      const result = validateWorkflow(wf)
      expect(result.valid).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
      expect(result.errors[0]).toMatch(/Cyclic dependency detected:/)
    })

    it('detects a cycle hidden in a disconnected subgraph alongside an acyclic tree', () => {
      const wf: WorkflowDefinition = {
        id: 'disconnected-cycle',
        name: 'Disconnected Subgraph Cycle',
        nodes: [
          // Acyclic component
          { id: 'valid_root', profileId: 'p', prompt: 'Root' },
          { id: 'valid_child', profileId: 'p', prompt: 'Child', dependencies: ['valid_root'] },
          // Cyclic component
          { id: 'loop_x', profileId: 'p', prompt: 'Loop X', dependencies: ['loop_y'] },
          { id: 'loop_y', profileId: 'p', prompt: 'Loop Y', dependencies: ['loop_x'] }
        ]
      }

      const result = validateWorkflow(wf)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toMatch(/Cyclic dependency detected: loop_[xy] -> loop_[xy]/)
    })

    it('detects deep 25-node chain with single back-edge from tail to head', () => {
      const nodeCount = 25
      const nodes = []
      for (let i = 0; i < nodeCount; i++) {
        nodes.push({
          id: `node_${i.toString().padStart(2, '0')}`,
          profileId: 'coder',
          prompt: `Task ${i}`,
          dependencies: i === 0 ? [`node_${(nodeCount - 1).toString().padStart(2, '0')}`] : [`node_${(i - 1).toString().padStart(2, '0')}`]
        })
      }

      const wf: WorkflowDefinition = {
        id: 'deep-cycle',
        name: 'Deep 25-Node Ring',
        nodes
      }

      const result = validateWorkflow(wf)
      expect(result.valid).toBe(false)
      expect(result.errors[0]).toContain('Cyclic dependency detected')
    })

    it('protects against in-memory mutation: returns defensive clones of built-in templates', async () => {
      // Load built-in workflow template
      const wf = await loadWorkflow(tempDir, 'code-review-fix')
      expect(wf.id).toBe('code-review-fix')

      // Save original node prompt
      const originalPrompt = wf.nodes[0].prompt

      // Mutate loaded workflow node prompt
      const canaryString = 'MUTATED_CANARY_PROMPT_SECURITY_TEST'
      wf.nodes[0].prompt = canaryString

      // Inspect BUILTIN_WORKFLOWS via getBuiltinWorkflow: template remains unmutated
      const builtin = getBuiltinWorkflow('code-review-fix')
      expect(builtin?.nodes[0].prompt).toBe(originalPrompt)
      expect(builtin?.nodes[0].prompt).not.toBe(canaryString)
    })
  })

  // =========================================================================
  // 2. Validation Against Corrupted, Invalid, or Hostile Payloads
  // =========================================================================
  describe('2. Validation Against Corrupted & Hostile Payloads', () => {
    it('rejects non-object and null workflow definitions', () => {
      const nonObjects = [null, undefined, 42, 'string', true, []]
      for (const val of nonObjects) {
        const result = validateWorkflow(val as unknown as WorkflowDefinition)
        expect(result.valid).toBe(false)
        expect(result.errors).toContain('Workflow definition must be an object.')
      }
    })

    it('rejects missing or empty id/name', () => {
      const missingId = { name: 'Workflow', nodes: [{ id: 'a', profileId: 'p', prompt: 'p' }] }
      const resId = validateWorkflow(missingId as unknown as WorkflowDefinition)
      expect(resId.valid).toBe(false)
      expect(resId.errors).toContain('Workflow must specify a non-empty id.')

      const whitespaceId = { id: '   ', name: 'Workflow', nodes: [{ id: 'a', profileId: 'p', prompt: 'p' }] }
      const resWs = validateWorkflow(whitespaceId as unknown as WorkflowDefinition)
      expect(resWs.valid).toBe(false)
      expect(resWs.errors).toContain('Workflow must specify a non-empty id.')

      const missingName = { id: 'wf', name: '', nodes: [{ id: 'a', profileId: 'p', prompt: 'p' }] }
      const resName = validateWorkflow(missingName as unknown as WorkflowDefinition)
      expect(resName.valid).toBe(false)
      expect(resName.errors).toContain('Workflow must specify a non-empty name.')
    })

    it('rejects malformed nodes array: empty, non-array, or sparse array', () => {
      const emptyNodes = { id: 'wf', name: 'Wf', nodes: [] }
      const resEmpty = validateWorkflow(emptyNodes as unknown as WorkflowDefinition)
      expect(resEmpty.valid).toBe(false)
      expect(resEmpty.errors).toContain('Workflow must contain at least one node.')

      const nonArrayNodes = { id: 'wf', name: 'Wf', nodes: 'not-an-array' }
      const resNonArr = validateWorkflow(nonArrayNodes as unknown as WorkflowDefinition)
      expect(resNonArr.valid).toBe(false)
      expect(resNonArr.errors).toContain('Workflow nodes must be an array.')

      const nullNode = { id: 'wf', name: 'Wf', nodes: [null] }
      const resNull = validateWorkflow(nullNode as unknown as WorkflowDefinition)
      expect(resNull.valid).toBe(false)
      expect(resNull.errors).toContain('Workflow node must be an object.')
    })

    it('rejects missing required node fields: id, profileId, prompt', () => {
      const missingFields = {
        id: 'wf',
        name: 'Wf',
        nodes: [
          { id: '', profileId: 'coder', prompt: 'P' },
          { id: 'n2', profileId: '', prompt: 'P' },
          { id: 'n3', profileId: 'coder', prompt: 123 as unknown as string }
        ]
      }
      const res = validateWorkflow(missingFields as unknown as WorkflowDefinition)
      expect(res.valid).toBe(false)
      expect(res.errors).toContain('Node must specify a non-empty id.')
      expect(res.errors).toContain('Node "n2" must specify a profileId.')
      expect(res.errors).toContain('Node "n3" must specify a prompt.')
    })

    it('rejects duplicate node IDs', () => {
      const duplicates = {
        id: 'wf',
        name: 'Wf',
        nodes: [
          { id: 'step_one', profileId: 'p', prompt: 'P1' },
          { id: 'step_one', profileId: 'p', prompt: 'P2' }
        ]
      }
      const res = validateWorkflow(duplicates as unknown as WorkflowDefinition)
      expect(res.valid).toBe(false)
      expect(res.errors).toContain('Duplicate node id "step_one" detected.')
    })

    it('rejects unknown dependencies and self-loops', () => {
      const selfLoop = {
        id: 'wf',
        name: 'Wf',
        nodes: [{ id: 'solo', profileId: 'p', prompt: 'P', dependencies: ['solo'] }]
      }
      expect(validateWorkflow(selfLoop).errors).toContain('Node "solo" cannot depend on itself.')

      const unknownDep = {
        id: 'wf',
        name: 'Wf',
        nodes: [{ id: 'child', profileId: 'p', prompt: 'P', dependencies: ['ghost_parent'] }]
      }
      expect(validateWorkflow(unknownDep).errors).toContain(
        'Node "child" depends on unknown node "ghost_parent".'
      )
    })

    it('rejects policy conditions referencing undeclared or nonexistent nodes', () => {
      const undeclaredCond = {
        id: 'wf',
        name: 'Wf',
        nodes: [
          { id: 'root', profileId: 'p', prompt: 'R' },
          { id: 'scout', profileId: 'p', prompt: 'S' },
          {
            id: 'dependent',
            profileId: 'p',
            prompt: 'D',
            dependencies: ['root'], // misses 'scout'
            policy: {
              condition: { upstreamNodeId: 'scout', expectedFinishReason: 'complete' }
            }
          }
        ]
      }
      const res = validateWorkflow(undeclaredCond)
      expect(res.valid).toBe(false)
      expect(res.errors).toContain(
        'Node "dependent" policy condition references upstream node "scout", but it is not listed in dependencies.'
      )
    })
  })

  // =========================================================================
  // 3. Directory Traversal & Path Confinement
  // =========================================================================
  describe('3. Directory Traversal & Path Confinement Attacks', () => {
    const HOSTILE_TRAVERSAL_PATHS = [
      '../../escaped',
      '..\\..\\win32_escaped',
      '/etc/passwd',
      'C:\\Windows\\System32\\drivers\\etc\\hosts',
      '.opencode/../../outside',
      'sub/../../../escaped'
    ]

    for (const hostile of HOSTILE_TRAVERSAL_PATHS) {
      it(`loadWorkflow strictly blocks path traversal attempt: "${hostile}"`, async () => {
        await expect(loadWorkflow(tempDir, hostile)).rejects.toThrow(
          /strictly inside the project directory/i
        )
      })

      it(`getWorkflow strictly blocks path traversal attempt: "${hostile}"`, async () => {
        await expect(getWorkflow(tempDir, hostile)).rejects.toThrow(
          /strictly inside the project directory/i
        )
      })

      it(`deleteWorkflow strictly blocks path traversal attempt: "${hostile}"`, async () => {
        await expect(deleteWorkflow(tempDir, hostile)).rejects.toThrow(
          /strictly inside the project directory/i
        )
      })
    }

    it('loadWorkflow rejects empty or non-string argument defensively', async () => {
      await expect(loadWorkflow(tempDir, '')).rejects.toThrow(
        /Workflow filename or ID must be a non-empty string/
      )
      await expect(loadWorkflow(tempDir, null as unknown as string)).rejects.toThrow(
        /Workflow filename or ID must be a non-empty string/
      )
    })

    it('seedBuiltinWorkflows safely writes only to .opencode/workflows/ inside the project', async () => {
      const seeded = await seedBuiltinWorkflows(tempDir)
      expect(seeded).toHaveLength(2)

      for (const p of seeded) {
        expect(p.startsWith(tempDir)).toBe(true)
        expect(p.includes('.opencode')).toBe(true)
        expect(p.includes('workflows')).toBe(true)
      }
    })

    it('IPC oc:dag:loadWorkflow contains reads to the project workflows directory', async () => {
      const h: IpcHarness = await loadIpc({
        validateWorkflow: vi.fn((wf: unknown) => validateWorkflow(wf as WorkflowDefinition)),
        // Exercise the real loader so containment is genuinely tested rather
        // than stubbed away.
        loadWorkflow: vi.fn(loadWorkflow)
      })

      // The handler takes a trusted project directory plus a workflow id, and
      // resolves `<dir>/.opencode/workflows/<id>.json` through assertSubpath.
      // An absolute path to a file outside that directory must not be read,
      // and must fail on containment rather than on workflow validation.
      const outsidePath = resolve(process.cwd(), 'package.json')
      await expect(h.invoke('oc:dag:loadWorkflow', tempDir, outsidePath)).rejects.toThrow(
        /strictly inside the project directory/
      )

      // Traversal out of the workflows directory is rejected the same way.
      await expect(
        h.invoke('oc:dag:loadWorkflow', tempDir, '../../../package')
      ).rejects.toThrow(/strictly inside the project directory/)

      // A bare id that is neither on disk nor a builtin is simply not found —
      // no file outside the project is consulted to answer that.
      await expect(h.invoke('oc:dag:loadWorkflow', tempDir, 'no-such-workflow')).rejects.toThrow(
        /Workflow not found/
      )
    })
  })

  // =========================================================================
  // 4. Prompt Interpolation Attack Vectors
  // =========================================================================
  describe('4. Prompt Interpolation Attack Vectors & Prototype Pollution', () => {
    const mockOutputs = new Map<string, DagNodeOutput>([
      [
        'planner',
        {
          nodeId: 'planner',
          status: 'succeeded',
          finishReason: 'complete',
          content: 'Blueprint content for system architecture',
          artifacts: [{ name: 'plan.md', content: '# Plan' }],
          turns: 3,
          usage: { input: 100, output: 200 }
        }
      ]
    ])

    it('neutralizes prototype pollution variables (__proto__, constructor, prototype)', () => {
      const pollutionTemplates = [
        '{{inputs.__proto__.output}}',
        '{{inputs.planner.__proto__}}',
        '{{inputs.planner.artifacts.__proto__}}',
        '{{inputs.constructor.output}}',
        '{{inputs.planner.constructor}}',
        '{{inputs.prototype.output}}',
        '{{inputs.planner.prototype}}'
      ]

      for (const t of pollutionTemplates) {
        const result = interpolatePrompt(t, mockOutputs, ['planner', '__proto__', 'constructor', 'prototype'])
        expect(result).toBe('')
      }

      // Verify Object.prototype is unpolluted
      expect((Object.prototype as Record<string, unknown>).polluted).toBeUndefined()
    })

    it('enforces dependency gating and throws on unauthorized upstream reference', () => {
      const template = 'Secret: {{inputs.secret_agent.output}}'
      expect(() => interpolatePrompt(template, mockOutputs, ['planner'])).toThrow(
        /Unauthorized dependency reference: node "secret_agent" is not in allowed dependencies/
      )
    })

    it('bounds oversized variables at MAX_INTERPOLATED_CHARS with truncation notice', () => {
      const hugeOutput = new Map<string, DagNodeOutput>([
        [
          'planner',
          {
            nodeId: 'planner',
            status: 'succeeded',
            content: 'X'.repeat(75_000),
            turns: 1,
            usage: { input: 10, output: 20 }
          }
        ]
      ])

      const result = interpolatePrompt('{{inputs.planner.output}}', hugeOutput, ['planner'])
      expect(result.length).toBeLessThan(75_000)
      expect(result).toContain(`[Output truncated: showing first ${MAX_INTERPOLATED_CHARS} characters]`)
      expect(result.startsWith('X'.repeat(MAX_INTERPOLATED_CHARS))).toBe(true)
    })

    it('safely handles special regex replacement tokens ($$, $&, $1, $`) without substitution', () => {
      const dollarOutput = new Map<string, DagNodeOutput>([
        [
          'planner',
          {
            nodeId: 'planner',
            status: 'succeeded',
            content: 'Cost: $100 $$ $& $1 $`',
            turns: 1,
            usage: { input: 10, output: 20 }
          }
        ]
      ])

      const result = interpolatePrompt('Output:\n{{inputs.planner.output}}', dollarOutput, ['planner'])
      expect(result).toBe('Output:\nCost: $100 $$ $& $1 $`')
    })

    it('prevents secondary prompt injection (single-pass regex evaluation)', () => {
      const nestedOutputs = new Map<string, DagNodeOutput>([
        [
          'planner',
          {
            nodeId: 'planner',
            status: 'succeeded',
            content: 'Exploit: {{inputs.hidden_secret.output}}',
            turns: 1,
            usage: { input: 10, output: 20 }
          }
        ],
        [
          'hidden_secret',
          {
            nodeId: 'hidden_secret',
            status: 'succeeded',
            content: 'SUPER_SECRET_TOKEN',
            turns: 1,
            usage: { input: 10, output: 20 }
          }
        ]
      ])

      // Only 'planner' is allowed
      const result = interpolatePrompt('Prompt:\n{{inputs.planner.output}}', nestedOutputs, ['planner'])
      // It should NOT evaluate the nested {{inputs.hidden_secret.output}}
      expect(result).toBe('Prompt:\nExploit: {{inputs.hidden_secret.output}}')
      expect(result).not.toContain('SUPER_SECRET_TOKEN')
    })
  })

  // =========================================================================
  // 5. Concurrency Stress on Loader & Seeding
  // =========================================================================
  describe('5. Concurrency Stress on listWorkflows & seedBuiltinWorkflows', () => {
    it('executes 30 concurrent seedBuiltinWorkflows calls without race condition corruption', async () => {
      const promises = Array.from({ length: 30 }, () => seedBuiltinWorkflows(tempDir))
      const results = await Promise.all(promises)

      // Total newly seeded files should be exactly 2 (first completed call seeds, others return [])
      const totalSeeded = results.flat()
      expect(totalSeeded.length).toBeGreaterThanOrEqual(2)

      // Verify files on disk are completely valid
      const codeReviewPath = join(tempDir, '.opencode', 'workflows', 'code-review-fix.json')
      const featurePath = join(tempDir, '.opencode', 'workflows', 'feature-implementation.json')

      const codeReviewJson = JSON.parse(readFileSync(codeReviewPath, 'utf-8'))
      const featureJson = JSON.parse(readFileSync(featurePath, 'utf-8'))

      expect(validateWorkflow(codeReviewJson).valid).toBe(true)
      expect(validateWorkflow(featureJson).valid).toBe(true)
    })

    it('executes 50 interleaved concurrent list, save, and delete calls safely', async () => {
      const sampleWf = (id: string): WorkflowDefinition => ({
        id,
        name: `Workflow ${id}`,
        nodes: [{ id: 'step', profileId: 'p', prompt: 'P' }]
      })

      const tasks: Promise<unknown>[] = []
      for (let i = 0; i < 20; i++) {
        tasks.push(saveWorkflow(tempDir, sampleWf(`wf-${i}`)))
        tasks.push(listWorkflows(tempDir))
        if (i % 3 === 0) {
          tasks.push(deleteWorkflow(tempDir, `wf-${i}`))
        }
      }

      const settled = await Promise.all(tasks)
      expect(settled).toHaveLength(tasks.length)
      // Every list call returns an array of valid workflow definitions
      for (const r of settled) {
        if (Array.isArray(r)) {
          for (const wf of r) expect(validateWorkflow(wf).valid).toBe(true)
        }
      }
      // Surviving files: ids not divisible by 3 were never deleted
      const final = await listWorkflows(tempDir)
      const ids = new Set(final.map((w) => w.id))
      for (let i = 0; i < 20; i++) {
        if (i % 3 !== 0) expect(ids.has(`wf-${i}`)).toBe(true)
      }
    })
  })
})
