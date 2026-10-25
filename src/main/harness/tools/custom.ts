/**
 * User-defined custom tools for the agentic harness.
 *
 * Loaded per-run from `{project}/.opencode/harness/tools/*.json`. Each file is a
 * ToolDefinition-shaped object plus a `command` string:
 *
 * ```json
 * {
 *   "name": "lint_project",
 *   "description": "Run the project linter",
 *   "parameters": { "type": "object", "properties": {} },
 *   "command": "npm run lint"
 * }
 * ```
 *
 * Commands run via execFile with argv arrays (quote-aware tokenisation, NEVER a
 * shell), cwd pinned to the run's project directory, with the same timeout /
 * output bounds as the builtin shell tool. Tokens may reference tool arguments
 * with `{argName}` placeholders — substitution happens per argv token, so no
 * value is ever re-parsed by a shell.
 *
 * Invalid JSON or missing fields skip that file; loading never throws.
 */
import { execFile, type ChildProcess } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { buildChildEnv } from '../../env'
import { killProcessTree } from './processKill'
import type { ToolExecutor, ToolRegistry } from './registry'

const execFileAsync = promisify(execFile)

type ExecError = Error & {
  stdout?: string | Buffer
  stderr?: string | Buffer
}

/** Same bounds as the builtin shell tool (tools/builtins.ts). */
const MAX_BUFFER_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_CHARS = 50_000

/** Custom tools are user-authored and must not hang a run. */
const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000

/** Tool names must be safe for provider function-calling schemas. */
const NAME_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/

type CustomToolFile = {
  name: string
  description: string
  parameters: Record<string, unknown>
  command: string
  timeoutMs?: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Validate a raw parsed JSON value into a CustomToolFile, or null when invalid. */
function parseCustomTool(raw: unknown): CustomToolFile | null {
  if (!isRecord(raw)) return null
  if (typeof raw.name !== 'string' || !NAME_PATTERN.test(raw.name)) return null
  if (typeof raw.description !== 'string' || raw.description.trim().length === 0) return null
  if (!isRecord(raw.parameters)) return null
  if (typeof raw.command !== 'string' || raw.command.trim().length === 0) return null

  let timeoutMs: number | undefined
  if (typeof raw.timeoutMs === 'number' && Number.isFinite(raw.timeoutMs) && raw.timeoutMs > 0) {
    timeoutMs = Math.min(Math.round(raw.timeoutMs), MAX_TIMEOUT_MS)
  }

  return {
    name: raw.name,
    description: raw.description.trim(),
    parameters: raw.parameters,
    command: raw.command.trim(),
    ...(timeoutMs !== undefined ? { timeoutMs } : {})
  }
}

/**
 * Split a command string into an argv array. Quote-aware (single and double
 * quotes group whitespace); no escape processing, no shell. Exported for tests.
 */
export function tokenizeCommand(command: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | "'" | null = null
  let hasToken = false

  for (const ch of command) {
    if (quote !== null) {
      if (ch === quote) {
        quote = null
      } else {
        current += ch
      }
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      hasToken = true
      continue
    }
    if (/\s/.test(ch)) {
      if (hasToken || current.length > 0) {
        tokens.push(current)
        current = ''
        hasToken = false
      }
      continue
    }
    current += ch
  }
  if (hasToken || current.length > 0) tokens.push(current)
  return tokens
}

/** Substitute `{argName}` placeholders inside one argv token — never re-parsed. */
function substitute(token: string, args: Record<string, unknown>): string {
  return token.replace(/\{([a-zA-Z0-9_-]+)\}/g, (_match, key: string) => {
    const value = args[key]
    return value === undefined || value === null ? '' : String(value)
  })
}

function makeExecutor(tool: CustomToolFile): ToolExecutor {
  return async (args, context) => {
    try {
      const argv = tokenizeCommand(tool.command).map((token) => substitute(token, args))
      if (argv.length === 0 || argv[0].length === 0) {
        return { output: '', error: `Custom tool "${tool.name}" has an empty command.` }
      }
      const [cmd, ...rest] = argv
      const promise = execFileAsync(cmd, rest, {
        cwd: context.directory,
        timeout: tool.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: MAX_BUFFER_BYTES,
        env: buildChildEnv({}),
        // Not on Windows: Node's own abort handling would TerminateProcess the root first and
        // leave killProcessTree's `taskkill /T` nothing to walk, orphaning grandchildren.
        ...(process.platform === 'win32' ? {} : { signal: context.abortSignal })
      })
      const child = (promise as { child?: ChildProcess }).child
      if (child && context.abortSignal) {
        const onAbort = () => killProcessTree(child)
        if (context.abortSignal.aborted) {
          onAbort()
        } else {
          context.abortSignal.addEventListener('abort', onAbort, { once: true })
          promise.finally(() => context.abortSignal.removeEventListener('abort', onAbort)).catch(() => {})
        }
      }
      const { stdout, stderr } = await promise
      let out = String(stdout) + (stderr ? `\n${String(stderr)}` : '')
      if (out.length > MAX_OUTPUT_CHARS) {
        out = out.slice(0, MAX_OUTPUT_CHARS) + '... (truncated)'
      }
      return { output: out }
    } catch (err: unknown) {
      const execErr = err as ExecError
      if (execErr.stdout !== undefined) {
        let out = String(execErr.stdout) + '\n' + String(execErr.stderr ?? '')
        if (out.length > MAX_OUTPUT_CHARS) {
          out = out.slice(0, MAX_OUTPUT_CHARS) + '... (truncated)'
        }
        return { output: out, error: execErr.message || String(err) }
      }
      return { output: '', error: err instanceof Error ? err.message : String(err) }
    }
  }
}

/**
 * Load every valid custom tool from `{directory}/.opencode/harness/tools/*.json`
 * into the registry. A missing directory, unreadable file, or invalid definition
 * is skipped silently — loading custom tools must never fail a run. A custom
 * tool may not shadow an already-registered (e.g. builtin) tool name.
 */
export function loadCustomTools(registry: ToolRegistry, directory: string): void {
  const toolsDir = join(directory, '.opencode', 'harness', 'tools')
  let entries: string[]
  try {
    entries = readdirSync(toolsDir)
  } catch {
    return
  }

  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue
    let tool: CustomToolFile | null = null
    try {
      tool = parseCustomTool(JSON.parse(readFileSync(join(toolsDir, entry), 'utf8')) as unknown)
    } catch {
      continue
    }
    if (!tool) continue
    if (registry.resolve(tool.name)) continue
    registry.register(
      {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
        category: 'custom'
      },
      makeExecutor(tool)
    )
  }
}
