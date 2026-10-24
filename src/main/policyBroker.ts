/**
 * Policy broker for project permissions.
 *
 * Provides a unified, main-process authority that evaluates whether a tool
 * (read, write, shell, web, custom) is permitted under the project's
 * configured permission preset / `opencode.json` permission block and profile policy.
 *
 * Shared across OpenCode sessions, direct harness, and subagents.
 */
import { getPermissionConfig, type PermissionConfig } from './configService'
import { getClient } from './server'
import type { ToolDefinition } from './harness/tools/registry'
import type { AgentProfile } from './harness/profiles'

export type PolicyEvaluation = {
  allowed: boolean
  requiresApproval?: boolean
  reason?: string
}

export type PolicyContext = {
  directory: string
  profile?: Pick<AgentProfile, 'readOnly' | 'tools' | 'toolDenyList'>
  permissionConfig?: PermissionConfig
}

export class PolicyBroker {
  /**
   * Evaluate whether a tool execution is permitted before invoking an executor.
   */
  async evaluate(tool: ToolDefinition, context: PolicyContext): Promise<PolicyEvaluation> {
    const { profile, directory } = context

    // 1. Profile-level restrictions
    if (profile) {
      if (profile.readOnly && tool.category !== 'read') {
        return {
          allowed: false,
          reason: `Tool "${tool.name}" is not permitted under read-only policy.`
        }
      }

      if (profile.toolDenyList && profile.toolDenyList.includes(tool.name)) {
        return {
          allowed: false,
          reason: `Tool "${tool.name}" is denied by profile policy.`
        }
      }

      if (profile.tools && profile.tools.length === 0) {
        return {
          allowed: false,
          reason: `Tool "${tool.name}" is not permitted (no tools allowed).`
        }
      }

      if (profile.tools && !profile.tools.includes('*') && !profile.tools.includes(tool.name)) {
        return {
          allowed: false,
          reason: `Tool "${tool.name}" is not in profile allowed tools.`
        }
      }
    }

    // 2. Project-level OpenCode permissions (edit, bash, webfetch)
    let config = context.permissionConfig
    if (!config && directory) {
      try {
        const client = getClient()
        config = await getPermissionConfig(client, directory)
      } catch {
        // Fall back to default permissions if client/server unavailable
      }
    }

    if (config) {
      // Write tools check `edit` permission
      if (tool.category === 'write') {
        const editPolicy = config.edit ?? 'allow'
        if (editPolicy === 'deny') {
          return {
            allowed: false,
            reason: `Tool "${tool.name}" is denied: project policy denies edits.`
          }
        }
        if (editPolicy === 'ask') {
          return {
            allowed: false,
            requiresApproval: true,
            reason: `Tool "${tool.name}" requires user approval under project edit policy.`
          }
        }
      }

      // Shell & custom command tools check `bash` permission
      if (tool.category === 'shell' || tool.category === 'custom') {
        const bashPolicy = config.bash
        if (typeof bashPolicy === 'string') {
          if (bashPolicy === 'deny') {
            return {
              allowed: false,
              reason: `Tool "${tool.name}" is denied: project policy denies shell commands.`
            }
          }
          if (bashPolicy === 'ask') {
            return {
              allowed: false,
              requiresApproval: true,
              reason: `Tool "${tool.name}" requires user approval under project bash policy.`
            }
          }
        }
      }

      // Web tools check `webfetch` permission
      if (tool.category === 'web') {
        const webPolicy = config.webfetch ?? 'allow'
        if (webPolicy === 'deny') {
          return {
            allowed: false,
            reason: `Tool "${tool.name}" is denied: project policy denies web access.`
          }
        }
        if (webPolicy === 'ask') {
          return {
            allowed: false,
            requiresApproval: true,
            reason: `Tool "${tool.name}" requires user approval under project webfetch policy.`
          }
        }
      }
    }

    return { allowed: true }
  }
}

export const policyBroker = new PolicyBroker()
