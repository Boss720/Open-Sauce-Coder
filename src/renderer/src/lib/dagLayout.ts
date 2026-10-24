/**
 * Pure DAG Layout Engine — Kahn topological wave derivation and coordinate layout.
 *
 * Zero external dependencies. Partitions nodes into horizontal waves, vertically centers
 * columns, and calculates smooth cubic bezier SVG curves for inter-node dependencies.
 */

import type { DagNodeDefinition, WorkflowDefinition } from './types'

export interface LayoutNode {
  id: string
  name: string
  profile: string
  dependencies: string[]
  waveIndex: number
  x: number
  y: number
  width: number
  height: number
}

export interface LayoutEdge {
  fromId: string
  toId: string
  pathD: string
}

export interface DagGraphLayout {
  nodes: LayoutNode[]
  edges: LayoutEdge[]
  width: number
  height: number
  waves: string[][]
  hasCycle: boolean
}

export interface DagLayoutOptions {
  nodeWidth?: number
  nodeHeight?: number
  horizontalGap?: number
  verticalGap?: number
  padding?: number
}

export interface WaveDerivationResult {
  waves: string[][]
  hasCycle: boolean
  cycleNodeIds?: string[]
}

/**
 * Derives execution waves using Kahn's topological sort algorithm.
 * Nodes with in-degree 0 form Wave 0; subsequent waves form as dependencies resolve.
 * Sorts node IDs alphabetically within each wave for deterministic rendering.
 */
export function deriveDagWaves(nodes: DagNodeDefinition[]): WaveDerivationResult {
  const nodeMap = new Map<string, DagNodeDefinition>()
  for (const node of nodes) {
    nodeMap.set(node.id, node)
  }

  const inDegree = new Map<string, number>()
  const dependents = new Map<string, string[]>()

  for (const node of nodes) {
    inDegree.set(node.id, 0)
    dependents.set(node.id, [])
  }

  for (const node of nodes) {
    const deps = (node.dependencies ?? []).filter((depId) => nodeMap.has(depId))
    inDegree.set(node.id, deps.length)
    for (const depId of deps) {
      dependents.get(depId)!.push(node.id)
    }
  }

  // Wave 0: nodes with in-degree 0
  let currentWave: string[] = []
  for (const [id, deg] of inDegree.entries()) {
    if (deg === 0) {
      currentWave.push(id)
    }
  }
  currentWave.sort()

  const waves: string[][] = []
  let visitedCount = 0

  while (currentWave.length > 0) {
    waves.push([...currentWave])
    visitedCount += currentWave.length

    const nextWaveSet = new Set<string>()
    for (const nodeId of currentWave) {
      for (const childId of dependents.get(nodeId) ?? []) {
        const remaining = (inDegree.get(childId) ?? 0) - 1
        inDegree.set(childId, remaining)
        if (remaining === 0) {
          nextWaveSet.add(childId)
        }
      }
    }

    currentWave = Array.from(nextWaveSet).sort()
  }

  const hasCycle = visitedCount < nodes.length
  let cycleNodeIds: string[] | undefined

  if (hasCycle) {
    const visitedSet = new Set(waves.flat())
    cycleNodeIds = nodes.map((n) => n.id).filter((id) => !visitedSet.has(id)).sort()
    // Place remaining cycle/unresolved nodes into a fallback wave to ensure visibility
    waves.push([...cycleNodeIds])
  }

  return { waves, hasCycle, cycleNodeIds }
}

/**
 * Calculates cubic bezier SVG path between right center of source and left center of target.
 */
export function computeBezierCurve(
  x1: number,
  y1: number,
  x2: number,
  y2: number
): string {
  const dx = x2 - x1
  const curvature = Math.max(40, dx * 0.45)
  const cx1 = x1 + curvature
  const cy1 = y1
  const cx2 = x2 - curvature
  const cy2 = y2
  return `M ${x1} ${y1} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${x2} ${y2}`
}

/**
 * Computes 2D geometric layout for a workflow or node list.
 */
export function computeDagLayout(
  workflowOrNodes: WorkflowDefinition | DagNodeDefinition[],
  options?: DagLayoutOptions
): DagGraphLayout {
  const nodes = Array.isArray(workflowOrNodes)
    ? workflowOrNodes
    : workflowOrNodes.nodes ?? []

  const nodeWidth = options?.nodeWidth ?? 240
  const nodeHeight = options?.nodeHeight ?? 96
  const horizontalGap = options?.horizontalGap ?? 96
  const verticalGap = options?.verticalGap ?? 32
  const padding = options?.padding ?? 48

  if (nodes.length === 0) {
    return {
      nodes: [],
      edges: [],
      width: padding * 2,
      height: padding * 2,
      waves: [],
      hasCycle: false
    }
  }

  const { waves, hasCycle } = deriveDagWaves(nodes)
  const nodeMap = new Map<string, DagNodeDefinition>()
  for (const node of nodes) {
    nodeMap.set(node.id, node)
  }

  // Calculate height for each wave column
  const waveHeights = waves.map((waveNodeIds) => {
    const count = waveNodeIds.length
    return count > 0 ? count * nodeHeight + (count - 1) * verticalGap : 0
  })

  const maxHeight = Math.max(...waveHeights, 0)

  // Position nodes
  const layoutNodes: LayoutNode[] = []
  const layoutNodeMap = new Map<string, LayoutNode>()

  waves.forEach((waveNodeIds, waveIndex) => {
    const colHeight = waveHeights[waveIndex]
    const offsetY = (maxHeight - colHeight) / 2
    const x = padding + waveIndex * (nodeWidth + horizontalGap)

    waveNodeIds.forEach((nodeId, nodeIndex) => {
      const def = nodeMap.get(nodeId)
      if (!def) return

      const y = padding + offsetY + nodeIndex * (nodeHeight + verticalGap)
      const layoutNode: LayoutNode = {
        id: def.id,
        name: def.name || def.id,
        profile: def.profileId,
        dependencies: def.dependencies ?? [],
        waveIndex,
        x,
        y,
        width: nodeWidth,
        height: nodeHeight
      }

      layoutNodes.push(layoutNode)
      layoutNodeMap.set(nodeId, layoutNode)
    })
  })

  // Route edges
  const edges: LayoutEdge[] = []
  for (const node of layoutNodes) {
    for (const depId of node.dependencies) {
      const sourceNode = layoutNodeMap.get(depId)
      if (!sourceNode) continue

      const x1 = sourceNode.x + nodeWidth
      const y1 = sourceNode.y + nodeHeight / 2
      const x2 = node.x
      const y2 = node.y + nodeHeight / 2

      const pathD = computeBezierCurve(x1, y1, x2, y2)
      edges.push({
        fromId: sourceNode.id,
        toId: node.id,
        pathD
      })
    }
  }

  const totalWidth =
    waves.length > 0
      ? 2 * padding + waves.length * nodeWidth + (waves.length - 1) * horizontalGap
      : 2 * padding
  const totalHeight = 2 * padding + maxHeight

  return {
    nodes: layoutNodes,
    edges,
    width: totalWidth,
    height: totalHeight,
    waves,
    hasCycle
  }
}
