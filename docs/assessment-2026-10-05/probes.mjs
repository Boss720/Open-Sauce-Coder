import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { resolve } from 'node:path'
import assert from 'node:assert/strict'
import process from 'node:process'
import console from 'node:console'
import ts from 'typescript'

// Source-level reproductions with inert tools and a fake provider. No network,
// shell execution, file writes, Electron launch, or credentials are involved.
function load(path) {
  const exports = {}
  const requireFromSource = createRequire(resolve(path))
  const source = ts.transpileModule(readFileSync(path, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 }
  }).outputText
  const mockedRequire = (specifier) => {
    if (specifier === '../policyBroker') {
      return {
        policyBroker: {
          evaluate: async (tool, { profile: current }) => {
            if (current?.readOnly && tool.category !== 'read') {
              return { allowed: false, reason: `Tool "${tool.name}" is not permitted under read-only policy.` }
            }
            if (current?.tools?.length === 0) {
              return { allowed: false, reason: `Tool "${tool.name}" is not permitted (no tools allowed).` }
            }
            return { allowed: true }
          }
        }
      }
    }
    return requireFromSource(specifier)
  }
  new Function('exports', 'require', source)(exports, mockedRequire)
  return exports
}
const { ToolRegistry } = load('src/main/harness/tools/registry.ts')
const { AgentRunner } = load('src/main/harness/runner.ts')
const { validateProfile } = load('src/main/harness/profiles.ts')
const profile = { id: 'audit', name: 'Audit', provider: 'fake', model: 'fake', readOnly: true }
const response = (finishReason, extra = {}) => ({
  id: 'fake', content: '', finishReason, usage: { input: 1, output: 1 }, ...extra
})
const toolCall = { id: 'tc', type: 'function', function: { name: 'fs_write', arguments: '{}' } }

let executed = 0
const tools = new ToolRegistry()
tools.register({ name: 'fs_write', description: 'Inert counter only', category: 'write', parameters: {} }, async () => {
  executed++
  return { output: 'inert' }
})
let calls = 0
const adapter = { abort() {}, async chat() {
  calls++
  return calls === 1 ? response('tool_calls', { toolCalls: [toolCall] }) : response('stop')
} }
const runner = new AgentRunner({ id: 'audit', profile, adapter, tools, directory: process.cwd() })
assert.equal(tools.forProfile(profile).length, 0)
await runner.run('Inert test', () => {})
assert.equal(executed, 0)
console.log('RESOLVED: a model-requested write under readOnly is blocked before the inert executor (counter = 0).')

let release
const abortIds = []
let requestId
executed = 0
const pendingAdapter = {
  abort(id) { abortIds.push(id) },
  chat(request) { requestId = request.requestId; return new Promise(resolve => { release = resolve }) }
}
const pendingRunner = new AgentRunner({ id: 'cancel-audit', profile, adapter: pendingAdapter, tools, directory: process.cwd() })
const pendingRun = pendingRunner.run('Inert cancellation test', () => {})
pendingRunner.abort()
release(response('tool_calls', { toolCalls: [toolCall] }))
const cancelled = await pendingRun
assert.ok(abortIds.includes(requestId))
assert.equal(executed, 0)
assert.equal(cancelled.finishReason, 'aborted')
console.log(`RESOLVED: Stop aborts active request ${requestId}; late tool call skipped (inert counter = 0).`)

const budgetAdapter = { abort() {}, async chat() {
  return response('stop', { usage: { input: 1, output: 100 }, content: 'fake' })
} }
const budgetRunner = new AgentRunner({ id: 'budget-audit', profile: { ...profile, tokenBudget: 2, costBudget: 0.01 }, adapter: budgetAdapter, tools, directory: process.cwd() })
const budget = await budgetRunner.run('Inert budget test', () => {})
assert.equal(budget.finishReason, 'complete')
assert.equal(budget.usage.input + budget.usage.output, 101)
console.log('CONFIRMED: tokenBudget = 2 permits a response with 101 total tokens; costBudget is not enforced by the runner.')

assert.equal(tools.forProfile({ tools: undefined }).length, 1)
assert.equal(tools.forProfile({ tools: [] }).length, 0)
console.log('CONFIRMED: tools undefined enables every registered tool; tools [] advertises none.')

assert.deepEqual(validateProfile({ ...profile, tools: [] }).tools, [])
console.log('RESOLVED: profile validation preserves an explicit empty tool allowlist.')

const truncatedAdapter = { abort() {}, async chat() { return response('length', { content: 'unfinished' }) } }
const truncatedRunner = new AgentRunner({ id: 'truncation-audit', profile, adapter: truncatedAdapter, tools, directory: process.cwd() })
const truncated = await truncatedRunner.run('Inert truncation test', () => {})
assert.equal(truncated.finishReason, 'complete')
console.log('CONFIRMED: provider finishReason length becomes runner complete, despite unfinished output.')
