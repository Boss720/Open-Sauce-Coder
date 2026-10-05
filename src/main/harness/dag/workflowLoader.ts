/**
 * Declarative workflow filesystem loader, saver, and discovery engine.
 *
 * Scans, loads, saves, and deletes workflow definitions under {directory}/.opencode/workflows/*.json
 * with strict assertSubpath project containment.
 */

import { existsSync } from 'node:fs'
import { mkdir, readFile, readdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { assertSubpath } from '../../projectsPaths'
import type { WorkflowDefinition } from './types'
import { validateWorkflow } from './validator'

const WORKFLOWS_SUBDIR = join('.opencode', 'workflows')

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
 * Discovers and returns all valid workflow definitions in {directory}/.opencode/workflows/*.json.
 */
export async function listWorkflows(directory: string): Promise<WorkflowDefinition[]> {
  const workflowsDir = resolveWorkflowsDir(directory)
  if (!existsSync(workflowsDir)) {
    return []
  }

  const entries = await readdir(workflowsDir, { withFileTypes: true })
  const workflows: WorkflowDefinition[] = []

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) {
      continue
    }

    try {
      const filePath = assertSubpath(workflowsDir, entry.name)
      const raw = await readFile(filePath, 'utf-8')
      const parsed = JSON.parse(raw)
      const validation = validateWorkflow(parsed)
      if (validation.valid && validation.plan) {
        workflows.push(validation.plan.workflow)
      }
    } catch {
      // Ignore unparseable or invalid workflow files
    }
  }

  return workflows.sort((a, b) => a.id.localeCompare(b.id))
}

/**
 * Loads and validates a single workflow definition by ID.
 * Returns null if the file does not exist or fails validation.
 */
export async function getWorkflow(
  directory: string,
  workflowId: string
): Promise<WorkflowDefinition | null> {
  const filePath = resolveWorkflowPath(directory, workflowId)
  if (!existsSync(filePath)) {
    return null
  }

  try {
    const raw = await readFile(filePath, 'utf-8')
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
