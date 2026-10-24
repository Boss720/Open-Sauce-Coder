/**
 * Declarative workflow filesystem loader, saver, and discovery engine.
 *
 * Scans, loads, saves, and deletes workflow definitions under {directory}/.opencode/workflows/*.json
 * with strict assertSubpath project containment.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, stat, unlink, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { assertSubpath } from '../../projectsPaths'
import type { WorkflowDefinition } from './types'
import { validateWorkflow } from './validator'
import { BUILTIN_WORKFLOWS, getBuiltinWorkflow } from './builtinWorkflows'

const WORKFLOWS_SUBDIR = join('.opencode', 'workflows')

/**
 * Maximum size of a single workflow JSON file. Parsing happens on the main
 * thread, so an oversized file would stall or OOM the whole process.
 */
const MAX_WORKFLOW_BYTES = 1024 * 1024

/**
 * Reads a workflow JSON file, refusing anything above MAX_WORKFLOW_BYTES.
 */
async function readWorkflowFile(filePath: string): Promise<string> {
  const info = await stat(filePath)
  if (info.size > MAX_WORKFLOW_BYTES) {
    throw new Error(
      `Workflow file exceeds the ${MAX_WORKFLOW_BYTES} byte limit: ${basename(filePath)}`
    )
  }
  return readFile(filePath, 'utf-8')
}

/**
 * Resolves and verifies the containment of the workflows folder within the project.
 */
function resolveWorkflowsDir(projectDir: string): string {
  return assertSubpath(projectDir, WORKFLOWS_SUBDIR)
}

/**
 * Resolves and verifies the containment of an individual workflow JSON file.
 */
function resolveWorkflowPath(projectDir: string, workflowId: string): string {
  if (!workflowId || typeof workflowId !== 'string') {
    throw new Error('Workflow id must be a non-empty string.')
  }
  const workflowsDir = resolveWorkflowsDir(projectDir)
  return assertSubpath(workflowsDir, `${workflowId}.json`)
}

/**
 * Options for workflow discovery and listing.
 */
export interface ListWorkflowsOptions {
  /**
   * When true, built-in workflow templates are merged into the returned list.
   * Disk workflows override built-in templates with matching IDs.
   * Defaults to false (disk-only).
   */
  includeBuiltin?: boolean
}

/**
 * Discovers and returns valid workflow definitions in {directory}/.opencode/workflows/*.json.
 * If options.includeBuiltin is true, built-in workflow templates are merged into the list.
 * By default (includeBuiltin: false), only disk-persisted workflows are returned.
 */
export async function listWorkflows(
  directory: string,
  options?: ListWorkflowsOptions
): Promise<WorkflowDefinition[]> {
  const workflowsDir = resolveWorkflowsDir(directory)
  const diskMap = new Map<string, WorkflowDefinition>()

  if (existsSync(workflowsDir)) {
    try {
      const entries = await readdir(workflowsDir, { withFileTypes: true })
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.json')) {
          continue
        }

        try {
          const filePath = assertSubpath(workflowsDir, entry.name)
          const raw = await readWorkflowFile(filePath)
          const parsed = JSON.parse(raw)
          const validation = validateWorkflow(parsed)
          if (validation.valid && validation.plan) {
            diskMap.set(validation.plan.workflow.id, validation.plan.workflow)
          }
        } catch {
          // Ignore unparseable or invalid workflow files
        }
      }
    } catch {
      // Ignore directory read errors
    }
  }

  // If includeBuiltin is not requested, return only disk workflows
  if (!options?.includeBuiltin) {
    return Array.from(diskMap.values()).sort((a, b) => a.id.localeCompare(b.id))
  }

  // Merge built-in workflows: disk workflows override built-in templates with the same id
  const mergedMap = new Map<string, WorkflowDefinition>()

  for (const builtin of BUILTIN_WORKFLOWS) {
    mergedMap.set(builtin.id, structuredClone(builtin))
  }

  for (const [id, diskWf] of diskMap.entries()) {
    mergedMap.set(id, diskWf)
  }

  return Array.from(mergedMap.values()).sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Loads and validates a single workflow definition by ID.
 * Falls back to built-in workflow template if not found on disk.
 * Returns null if the workflow does not exist or fails validation.
 */
export async function getWorkflow(
  directory: string,
  workflowId: string
): Promise<WorkflowDefinition | null> {
  const filePath = resolveWorkflowPath(directory, workflowId)
  if (existsSync(filePath)) {
    try {
      const raw = await readWorkflowFile(filePath)
      const parsed = JSON.parse(raw)
      const validation = validateWorkflow(parsed)
      if (!validation.valid || !validation.plan) {
        return null
      }
      return validation.plan.workflow
    } catch {
      return null
    }
  }

  const builtin = getBuiltinWorkflow(workflowId)
  return builtin ?? null
}

/**
 * Loads and validates a workflow definition by filename or ID.
 * If the file exists on disk, it is loaded, validated, and returned.
 * If the file does not exist on disk and matches a built-in workflow ID,
 * the built-in workflow template is returned.
 * Strictly enforces project containment.
 */
export async function loadWorkflow(
  directory: string,
  filenameOrId: string
): Promise<WorkflowDefinition> {
  if (!filenameOrId || typeof filenameOrId !== 'string') {
    throw new Error('Workflow filename or ID must be a non-empty string.')
  }

  const rawId = filenameOrId.endsWith('.json')
    ? filenameOrId.slice(0, -5)
    : filenameOrId

  // Containment check: throws if rawId contains path traversal attempting to escape project
  const filePath = resolveWorkflowPath(directory, rawId)

  if (existsSync(filePath)) {
    const raw = await readWorkflowFile(filePath)
    const parsed = JSON.parse(raw)
    const validation = validateWorkflow(parsed)
    if (!validation.valid || !validation.plan) {
      throw new Error(`Invalid workflow definition: ${validation.errors.join('; ')}`)
    }
    return validation.plan.workflow
  }

  // Built-in fallback: match rawId, baseId, or filenameOrId
  const baseId = basename(rawId)
  const builtin =
    getBuiltinWorkflow(rawId) ??
    getBuiltinWorkflow(baseId) ??
    getBuiltinWorkflow(filenameOrId)
  if (builtin) {
    return builtin
  }

  throw new Error(`Workflow not found: ${filenameOrId}`)
}

/**
 * Seeds built-in workflow templates to {directory}/.opencode/workflows/*.json.
 * Only writes templates that do not already exist on disk.
 * Returns an array of paths to the newly seeded files.
 */
export async function seedBuiltinWorkflows(directory: string): Promise<string[]> {
  const workflowsDir = resolveWorkflowsDir(directory)
  await mkdir(workflowsDir, { recursive: true })

  const seededPaths: string[] = []

  for (const workflow of BUILTIN_WORKFLOWS) {
    const filePath = assertSubpath(workflowsDir, `${workflow.id}.json`)
    if (!existsSync(filePath)) {
      await writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf-8')
      seededPaths.push(filePath)
    }
  }

  return seededPaths
}

/**
 * Validates and persists a workflow definition to {directory}/.opencode/workflows/${workflow.id}.json.
 */
export async function saveWorkflow(
  directory: string,
  workflow: WorkflowDefinition
): Promise<void> {
  const validation = validateWorkflow(workflow)
  if (!validation.valid) {
    throw new Error(`Invalid workflow definition: ${validation.errors.join('; ')}`)
  }

  const filePath = resolveWorkflowPath(directory, workflow.id)
  await mkdir(dirname(filePath), { recursive: true })
  await writeFile(filePath, JSON.stringify(workflow, null, 2), 'utf-8')
}

/**
 * Deletes a workflow JSON file by ID.
 * Returns true if deleted, false if file did not exist.
 */
export async function deleteWorkflow(
  directory: string,
  workflowId: string
): Promise<boolean> {
  const filePath = resolveWorkflowPath(directory, workflowId)
  if (!existsSync(filePath)) {
    return false
  }

  await unlink(filePath)
  return true
}

export { BUILTIN_WORKFLOWS, getBuiltinWorkflow } from './builtinWorkflows'
