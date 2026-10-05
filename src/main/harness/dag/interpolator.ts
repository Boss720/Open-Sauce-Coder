/**
 * Safe parameter interpolator for DAG prompt templates.
 *
 * Supports single-pass regex parameter substitution:
 * - {{inputs.<nodeId>.output}}
 * - {{inputs.<nodeId>.artifacts.<name>}}
 * - {{inputs.<nodeId>.status}}
 * - {{inputs.<nodeId>.finishReason}}
 *
 * Enforces declared dependency gating, prototype pollution protection,
 * and per-variable character bounds (50,000 characters).
 */

import type { DagNodeOutput } from './types'

export const MAX_INTERPOLATED_CHARS = 50_000

const TEMPLATE_VAR_REGEX = /\{\{\s*inputs\.([a-zA-Z0-9_-]+)(?:\.([a-zA-Z0-9_.-]+))?\s*\}\}/g
const FORBIDDEN_PROPERTIES = new Set(['__proto__', 'constructor', 'prototype'])

export interface InterpolateOptions {
  strict?: boolean
  maxVariableChars?: number
}

/**
 * Interpolates upstream node outputs into a task prompt template.
 *
 * @param template Prompt template with {{inputs.<nodeId>.<field>}} markers.
 * @param upstreamOutputs Map or Record of completed upstream node outputs.
 * @param allowedDependencyIds Array of declared dependency IDs for this node.
 * @param options Interpolation options (strict dependency enforcement, max chars).
 * @returns Interpolated prompt string.
 */
export function interpolatePrompt(
  template: string,
  upstreamOutputs: Map<string, DagNodeOutput> | Record<string, DagNodeOutput>,
  allowedDependencyIds?: string[],
  options?: InterpolateOptions
): string {
  if (typeof template !== 'string') {
    return ''
  }

  const allowedList = allowedDependencyIds ?? []
  const allowedSet = new Set(allowedList)
  const maxChars = options?.maxVariableChars ?? MAX_INTERPOLATED_CHARS
  const strict = options?.strict !== false

  function getOutput(nodeId: string): DagNodeOutput | undefined {
    if (upstreamOutputs instanceof Map) {
      return upstreamOutputs.get(nodeId)
    }
    return (upstreamOutputs as Record<string, DagNodeOutput>)?.[nodeId]
  }

  return template.replace(TEMPLATE_VAR_REGEX, (_match, nodeId: string, field?: string) => {
    // Prototype pollution guard
    if (
      FORBIDDEN_PROPERTIES.has(nodeId) ||
      (field && field.split('.').some((part) => FORBIDDEN_PROPERTIES.has(part)))
    ) {
      return ''
    }

    // Dependency gating: reject unauthorized dependency references
    if (!allowedSet.has(nodeId)) {
      if (strict) {
        throw new Error(
          `Unauthorized dependency reference: node "${nodeId}" is not in allowed dependencies [${allowedList.join(', ')}].`
        )
      }
      return _match
    }

    const output = getOutput(nodeId)
    if (!output) {
      return ''
    }

    let val = ''
    if (!field || field === 'output') {
      val = output.content ?? ''
    } else if (field === 'status') {
      val = output.status ?? ''
    } else if (field === 'finishReason') {
      val = output.finishReason ?? ''
    } else if (field.startsWith('artifacts.')) {
      const artifactName = field.slice('artifacts.'.length)
      const artifact = output.artifacts?.find((a) => a.name === artifactName)
      val = artifact?.content ?? ''
    } else if (field === 'error') {
      val = output.error ?? ''
    } else if (field === 'turns') {
      val = String(output.turns ?? 0)
    }

    // String length bounding: cap individual variable to prevent prompt exhaustion
    if (val.length > maxChars) {
      val = val.slice(0, maxChars) + `\n\n[Output truncated: showing first ${maxChars} characters]`
    }

    return val
  })
}
