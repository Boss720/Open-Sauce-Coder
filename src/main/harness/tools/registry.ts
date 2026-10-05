export type ToolDefinition = {
  name: string
  description: string
  parameters: Record<string, unknown>
  category: 'read' | 'write' | 'shell' | 'web' | 'custom'
}

export type ToolContext = {
  directory: string
  agentId: string
  runId: string
  abortSignal: AbortSignal
  profile?: { tools?: string[]; toolDenyList?: string[]; readOnly?: boolean }
}

export type ToolResult = {
  output: string
  artifacts?: Array<{ name: string; content: string; mime: string }>
  error?: string
}

export type ToolExecutor = (
  args: Record<string, unknown>,
  context: ToolContext
) => Promise<ToolResult>

export type RegisteredTool = {
  definition: ToolDefinition
  executor: ToolExecutor
}

export class ToolRegistry {
  private readonly tools = new Map<string, RegisteredTool>()

  register(definition: ToolDefinition, executor: ToolExecutor): void {
    this.tools.set(definition.name, { definition, executor })
  }

  resolve(name: string): RegisteredTool | undefined {
    return this.tools.get(name)
  }

  forProfile(profile: { tools?: string[]; toolDenyList?: string[]; readOnly?: boolean }): ToolDefinition[] {
    if (profile.tools && profile.tools.length === 0) {
      return []
    }
    const all = Array.from(this.tools.values()).map(t => t.definition)
    
    return all.filter(def => {
      if (profile.readOnly && def.category !== 'read') {
        return false
      }

      if (profile.toolDenyList && profile.toolDenyList.includes(def.name)) {
        return false
      }

      if (profile.tools && !profile.tools.includes('*') && !profile.tools.includes(def.name)) {
        return false
      }

      return true
    })
  }

  schemas(names: string[]): Record<string, unknown>[] {
    const res: Record<string, unknown>[] = []
    for (const name of names) {
      const tool = this.tools.get(name)
      if (tool) {
        res.push({
          type: 'function',
          function: {
            name: tool.definition.name,
            description: tool.definition.description,
            parameters: tool.definition.parameters
          }
        })
      }
    }
    return res
  }

  async execute(name: string, args: Record<string, unknown>, context: ToolContext): Promise<ToolResult> {
    const tool = this.tools.get(name)
    if (!tool) {
      return { output: '', error: `Tool not found: ${name}` }
    }
    if (context.profile) {
      if (context.profile.readOnly && tool.definition.category !== 'read') {
        return { output: '', error: `Tool "${name}" is not permitted under read-only policy.` }
      }
      if (context.profile.toolDenyList && context.profile.toolDenyList.includes(name)) {
        return { output: '', error: `Tool "${name}" is denied by profile policy.` }
      }
      if (context.profile.tools && context.profile.tools.length === 0) {
        return { output: '', error: `Tool "${name}" is not permitted (no tools allowed).` }
      }
      if (context.profile.tools && !context.profile.tools.includes('*') && !context.profile.tools.includes(name)) {
        return { output: '', error: `Tool "${name}" is not in profile allowed tools.` }
      }
    }
    try {
      return await tool.executor(args, context)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      return { output: '', error: msg }
    }
  }

  listAll(): ToolDefinition[] {
    return Array.from(this.tools.values()).map(t => t.definition)
  }
}
