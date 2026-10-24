/**
 * DAG workflow validator and topological wave partitioner.
 *
 * Validates graph referential integrity, detects cycles via Kahn's algorithm
 * and DFS 3-color cycle tracing, and partitions acyclic graphs into topological
 * execution waves (minimizing depth for flat worker waves).
 */

import { extractTemplateNodeRefs } from './interpolator'
import type {
  DagExecutionPlan,
  DagNodeDefinition,
  DagWave,
  WorkflowDefinition
} from './types'

export interface ValidationResult {
  valid: boolean
  errors: string[]
  plan?: DagExecutionPlan
}

function isRecord(val: unknown): val is Record<string, unknown> {
  return typeof val === 'object' && val !== null && !Array.isArray(val)
}

/**
 * Uses DFS 3-color graph traversal to find and trace the exact cycle path.
 * Returns an array of node IDs forming the cycle (e.g. ['A', 'B', 'A']).
 */
function findCycleDfs(nodes: DagNodeDefinition[]): string[] | null {
  const nodeMap = new Map<string, DagNodeDefinition>()
  for (const node of nodes) {
    nodeMap.set(node.id, node)
  }

  // 0: WHITE (unvisited), 1: GRAY (visiting), 2: BLACK (visited)
  const color = new Map<string, number>()
  for (const node of nodes) {
    color.set(node.id, 0)
  }

  const stack: string[] = []

  function dfs(currentId: string): string[] | null {
    color.set(currentId, 1)
    stack.push(currentId)

    const currentNode = nodeMap.get(currentId)
    // Sort dependencies alphabetically for deterministic cycle paths
    const deps = [...(currentNode?.dependencies ?? [])].sort()

    for (const depId of deps) {
      if (!nodeMap.has(depId)) continue
      const depColor = color.get(depId) ?? 0

      if (depColor === 1) {
        // Detected back-edge to a node on the recursion stack
        const cycleStartIndex = stack.indexOf(depId)
        if (cycleStartIndex !== -1) {
          return [...stack.slice(cycleStartIndex), depId]
        }
        return [currentId, depId]
      }

      if (depColor === 0) {
        const result = dfs(depId)
        if (result) return result
      }
    }

    stack.pop()
    color.set(currentId, 2)
    return null
  }

  // Sort nodes alphabetically for deterministic traversal
  const sortedNodes = [...nodes].sort((a, b) => a.id.localeCompare(b.id))
  for (const node of sortedNodes) {
    if (color.get(node.id) === 0) {
      const cycle = dfs(node.id)
      if (cycle) return cycle
    }
  }

  return null
}

/**
 * Validates a workflow definition and generates an execution plan with topological waves.
 */
/** Upper bound on nodes per workflow: each node is a paid agent run. */
export const MAX_WORKFLOW_NODES = 128
/** Mirrors the 1..500 hard cap AgentProfile.maxTurns is validated against. */
export const MAX_NODE_TURNS = 500

export function validateWorkflow(workflow: WorkflowDefinition): ValidationResult {
  const errors: string[] = []

  if (!isRecord(workflow)) {
    return { valid: false, errors: ['Workflow definition must be an object.'] }
  }

  if (typeof workflow.id !== 'string' || !workflow.id.trim()) {
    errors.push('Workflow must specify a non-empty id.')
  }

  if (typeof workflow.name !== 'string' || !workflow.name.trim()) {
    errors.push('Workflow must specify a non-empty name.')
  }

  if (!Array.isArray(workflow.nodes)) {
    return { valid: false, errors: [...errors, 'Workflow nodes must be an array.'] }
  }

  if (workflow.nodes.length === 0) {
    return { valid: false, errors: [...errors, 'Workflow must contain at least one node.'] }
  }

  if (workflow.nodes.length > MAX_WORKFLOW_NODES) {
    return {
      valid: false,
      errors: [
        ...errors,
        `Workflow has ${workflow.nodes.length} nodes; the maximum is ${MAX_WORKFLOW_NODES}.`
      ]
    }
  }

  const seenIds = new Set<string>()
  const nodeMap = new Map<string, DagNodeDefinition>()

  // Stage 1: Validate individual node properties and check for duplicate IDs
  for (const node of workflow.nodes) {
    if (!isRecord(node)) {
      errors.push('Workflow node must be an object.')
      continue
    }

    if (typeof node.id !== 'string' || !node.id.trim()) {
      errors.push('Node must specify a non-empty id.')
      continue
    }

    if (seenIds.has(node.id)) {
      errors.push(`Duplicate node id "${node.id}" detected.`)
    } else {
      seenIds.add(node.id)
      nodeMap.set(node.id, node)
    }

    if (typeof node.profileId !== 'string' || !node.profileId.trim()) {
      errors.push(`Node "${node.id}" must specify a profileId.`)
    }

    if (typeof node.prompt !== 'string') {
      errors.push(`Node "${node.id}" must specify a prompt.`)
    }

    if (
      node.maxTurns !== undefined &&
      (typeof node.maxTurns !== 'number' ||
        !Number.isInteger(node.maxTurns) ||
        node.maxTurns < 1 ||
        node.maxTurns > MAX_NODE_TURNS)
    ) {
      errors.push(`Node "${node.id}" maxTurns must be an integer between 1 and ${MAX_NODE_TURNS}.`)
    }

    if (node.dependencies !== undefined && !Array.isArray(node.dependencies)) {
      errors.push(`Node "${node.id}" dependencies must be an array.`)
    }
  }

  // If duplicate IDs or invalid nodes exist, abort further relational validation
  if (errors.length > 0) {
    return { valid: false, errors }
  }

  // Stage 2: Validate dependency references and policy condition references
  for (const node of workflow.nodes) {
    const deps = node.dependencies ?? []

    for (const depId of deps) {
      if (depId === node.id) {
        errors.push(`Node "${node.id}" cannot depend on itself.`)
      } else if (!nodeMap.has(depId)) {
        errors.push(`Node "${node.id}" depends on unknown node "${depId}".`)
      }
    }

    // A prompt may only reference declared dependencies. The interpolator throws
    // on anything else at run time, after earlier waves have already spent budget,
    // so reject it up front.
    for (const refId of extractTemplateNodeRefs(node.prompt)) {
      if (!deps.includes(refId)) {
        errors.push(
          `Node "${node.id}" prompt references "{{inputs.${refId}}}", but "${refId}" is not listed in its dependencies.`
        )
      }
    }

    if (node.policy?.condition?.upstreamNodeId) {
      const condUpstream = node.policy.condition.upstreamNodeId
      if (!deps.includes(condUpstream)) {
        errors.push(
          `Node "${node.id}" policy condition references upstream node "${condUpstream}", but it is not listed in dependencies.`
        )
      }
      if (!nodeMap.has(condUpstream)) {
        errors.push(
          `Node "${node.id}" policy condition references unknown node "${condUpstream}".`
        )
      }
    }
  }

  if (errors.length > 0) {
    return { valid: false, errors }
  }

  // Stage 3: Kahn's algorithm for topological sorting and wave partitioning
  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const node of workflow.nodes) {
    const deps = node.dependencies ?? []
    inDegree.set(node.id, deps.length)
    dependents.set(node.id, [])
  }

  for (const node of workflow.nodes) {
    const deps = node.dependencies ?? []
    for (const depId of deps) {
      dependents.get(depId)!.push(node.id)
    }
  }

  let currentWaveNodeIds: string[] = []
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      currentWaveNodeIds.push(id)
    }
  }

  currentWaveNodeIds.sort()

  const waves: DagWave[] = []
  let visitedCount = 0
  let waveIndex = 0

  while (currentWaveNodeIds.length > 0) {
    waves.push({ waveIndex, nodeIds: [...currentWaveNodeIds] })
    visitedCount += currentWaveNodeIds.length

    const nextWaveNodeIds: string[] = []
    for (const nodeId of currentWaveNodeIds) {
      for (const childId of dependents.get(nodeId) ?? []) {
        const remaining = (inDegree.get(childId) ?? 0) - 1
        inDegree.set(childId, remaining)
        if (remaining === 0) {
          nextWaveNodeIds.push(childId)
        }
      }
    }

    nextWaveNodeIds.sort()
    currentWaveNodeIds = nextWaveNodeIds
    waveIndex++
  }

  // Stage 4: Detect cycle if not all nodes were visited
  if (visitedCount < workflow.nodes.length) {
    const cycle = findCycleDfs(workflow.nodes)
    if (cycle && cycle.length > 0) {
      errors.push(`Cyclic dependency detected: ${cycle.join(' -> ')}`)
    } else {
      errors.push('Cyclic dependency detected: graph contains a cycle.')
    }
    return { valid: false, errors }
  }

  return {
    valid: true,
    errors: [],
    plan: {
      workflow,
      waves
    }
  }
}
