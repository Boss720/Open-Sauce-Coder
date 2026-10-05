import { describe, it, expect } from 'vitest'
import { PolicyBroker } from '../policyBroker'
import type { ToolDefinition } from '../harness/tools/registry'

describe('PolicyBroker', () => {
  const readTool: ToolDefinition = {
    name: 'fs_read',
    description: 'Read file',
    category: 'read',
    parameters: {}
  }

  const writeTool: ToolDefinition = {
    name: 'fs_write',
    description: 'Write file',
    category: 'write',
    parameters: {}
  }

  const shellTool: ToolDefinition = {
    name: 'shell',
    description: 'Execute command',
    category: 'shell',
    parameters: {}
  }

  const customTool: ToolDefinition = {
    name: 'run_tests',
    description: 'Custom command',
    category: 'custom',
    parameters: {}
  }

  const webTool: ToolDefinition = {
    name: 'web_fetch',
    description: 'Fetch web page',
    category: 'web',
    parameters: {}
  }

  it('allows read tools under read-only profile but denies write and shell', async () => {
    const broker = new PolicyBroker()
    const readEval = await broker.evaluate(readTool, {
      directory: '/fake',
      profile: { readOnly: true }
    })
    expect(readEval.allowed).toBe(true)

    const writeEval = await broker.evaluate(writeTool, {
      directory: '/fake',
      profile: { readOnly: true }
    })
    expect(writeEval.allowed).toBe(false)
    expect(writeEval.reason).toMatch(/read-only/)

    const shellEval = await broker.evaluate(shellTool, {
      directory: '/fake',
      profile: { readOnly: true }
    })
    expect(shellEval.allowed).toBe(false)
  })

  it('enforces profile toolDenyList and empty tools collection', async () => {
    const broker = new PolicyBroker()
    const denyEval = await broker.evaluate(shellTool, {
      directory: '/fake',
      profile: { toolDenyList: ['shell'] }
    })
    expect(denyEval.allowed).toBe(false)
    expect(denyEval.reason).toMatch(/profile policy/i)

    const emptyEval = await broker.evaluate(readTool, {
      directory: '/fake',
      profile: { tools: [] }
    })
    expect(emptyEval.allowed).toBe(false)
    expect(emptyEval.reason).toMatch(/no tools allowed/i)
  })

  it('enforces project-level edit, bash, and webfetch policies', async () => {
    const broker = new PolicyBroker()

    // Edit policy deny
    const writeDenied = await broker.evaluate(writeTool, {
      directory: '/fake',
      permissionConfig: { edit: 'deny' }
    })
    expect(writeDenied.allowed).toBe(false)
    expect(writeDenied.reason).toMatch(/denies edits/)

    // Edit policy ask
    const writeAsk = await broker.evaluate(writeTool, {
      directory: '/fake',
      permissionConfig: { edit: 'ask' }
    })
    expect(writeAsk.allowed).toBe(false)
    expect(writeAsk.requiresApproval).toBe(true)

    // Bash policy deny (applies to shell and custom)
    const shellDenied = await broker.evaluate(shellTool, {
      directory: '/fake',
      permissionConfig: { bash: 'deny' }
    })
    expect(shellDenied.allowed).toBe(false)

    const customDenied = await broker.evaluate(customTool, {
      directory: '/fake',
      permissionConfig: { bash: 'deny' }
    })
    expect(customDenied.allowed).toBe(false)

    // Webfetch policy deny
    const webDenied = await broker.evaluate(webTool, {
      directory: '/fake',
      permissionConfig: { webfetch: 'deny' }
    })
    expect(webDenied.allowed).toBe(false)
    expect(webDenied.reason).toMatch(/denies web access/)
  })
})
