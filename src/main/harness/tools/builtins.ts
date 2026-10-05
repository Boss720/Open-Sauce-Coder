import { open, readdir, writeFile } from 'node:fs/promises'
import { execFile, type ChildProcess } from 'node:child_process'
import { promisify } from 'node:util'
import { assertSubpath } from '../../projectsPaths'
import { buildChildEnv } from '../../env'
import { killProcessTree } from './processKill'
import type { ToolRegistry } from './registry'

const execFileAsync = promisify(execFile)

type ExecError = Error & {
  stdout?: string | Buffer
  stderr?: string | Buffer
}

/** Harness fs_write cap — matches the 2 MiB read bound above (fsService allows 8 MiB for the editor surface). */
const MAX_WRITE_BYTES = 2 * 1024 * 1024

/** Web tool bounds: short timeouts, capped results and body size. */
const WEB_SEARCH_TIMEOUT_MS = 10_000
const WEB_FETCH_TIMEOUT_MS = 15_000
const MAX_SEARCH_RESULTS = 10
const MAX_WEB_CHARS = 100_000
const WEB_USER_AGENT = 'OpenCode-Desktop harness (keyless web tools)'

/** Minimal entity decoding for regex-level HTML handling — deliberately tiny. */
function decodeEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;|&#x27;/g, "'")
}

/** Crude HTML → text: drop script/style, strip tags, collapse blank lines. */
function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n\s*\n+/g, '\n')
    .trim()
}

function capWebOutput(text: string): string {
  return text.length > MAX_WEB_CHARS ? text.slice(0, MAX_WEB_CHARS) + '... (truncated)' : text
}

export function registerBuiltins(registry: ToolRegistry): void {
  registry.register(
    {
      name: 'fs_read',
      description: 'Read file contents',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' }
        },
        required: ['path']
      },
      category: 'read'
    },
    async (args, context) => {
      try {
        const path = String(args.path)
        const abs = assertSubpath(context.directory, path)
        const handle = await open(abs, 'r')
        try {
          const chunk = Buffer.alloc(2 * 1024 * 1024)
          const { bytesRead } = await handle.read(chunk, 0, chunk.length, 0)
          return { output: chunk.toString('utf8', 0, bytesRead) }
        } finally {
          await handle.close()
        }
      } catch (err) {
        return { output: '', error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  registry.register(
    {
      name: 'fs_list',
      description: 'List directory contents',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          recursive: { type: 'boolean' }
        },
        required: ['path']
      },
      category: 'read'
    },
    async (args, context) => {
      try {
        const raw = typeof args.path === 'string' ? args.path : String(args.path ?? '')
        const path = raw.trim().length === 0 ? '.' : raw
        const recursive = Boolean(args.recursive)
        const abs = assertSubpath(context.directory, path, { allowRoot: true })
        const entries = await readdir(abs, { recursive })
        return { output: entries.join('\n') }
      } catch (err) {
        return { output: '', error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  registry.register(
    {
      name: 'fs_write',
      description: 'Write file contents (creates or overwrites the file)',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          content: { type: 'string' }
        },
        required: ['path', 'content']
      },
      category: 'write'
    },
    async (args, context) => {
      try {
        const path = String(args.path)
        const content = typeof args.content === 'string' ? args.content : String(args.content ?? '')
        const abs = assertSubpath(context.directory, path)
        const bytes = Buffer.from(content, 'utf8')
        if (bytes.byteLength > MAX_WRITE_BYTES) {
          return { output: '', error: `Refusing to write ${bytes.byteLength} bytes; limit is ${MAX_WRITE_BYTES}.` }
        }
        // No baseSha gate: the agent never reads files through fsService, so it has no
        // sha to supply — containment + the size cap are the guardrails here.
        await writeFile(abs, bytes)
        return { output: `Wrote ${bytes.byteLength} bytes to ${path}` }
      } catch (err) {
        return { output: '', error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  registry.register(
    {
      name: 'grep',
      description: 'Search files',
      parameters: {
        type: 'object',
        properties: {
          pattern: { type: 'string' },
          path: { type: 'string' },
          include: { type: 'string' }
        },
        required: ['pattern']
      },
      category: 'read'
    },
    async (args, context) => {
      try {
        const pattern = String(args.pattern)
        const searchPath = args.path ? assertSubpath(context.directory, String(args.path), { allowRoot: true }) : context.directory
        
        const rgArgs = ['-n', pattern]
        if (typeof args.include === 'string' && args.include) {
          rgArgs.push('-g', args.include)
        }
        rgArgs.push(searchPath)
        
        const promise = execFileAsync('rg', rgArgs, {
          cwd: context.directory,
          maxBuffer: 2 * 1024 * 1024,
          env: buildChildEnv({}),
          signal: context.abortSignal
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
        const { stdout } = await promise
        return { output: stdout }
      } catch (err: unknown) {
        const execErr = err as ExecError
        if (execErr.stdout !== undefined) {
          return { output: String(execErr.stdout) }
        }
        return { output: '', error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  registry.register(
    {
      name: 'shell',
      description: 'Execute a command',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' }
        },
        required: ['command']
      },
      category: 'shell'
    },
    async (args, context) => {
      try {
        const command = String(args.command)
        let cwd = context.directory
        if (typeof args.cwd === 'string' && args.cwd) {
          cwd = assertSubpath(context.directory, args.cwd)
        }
        
        const isWin = process.platform === 'win32'
        const sh = isWin ? 'cmd.exe' : '/bin/sh'
        const shArgs = isWin ? ['/d', '/s', '/c', command] : ['-c', command]
        
        const promise = execFileAsync(sh, shArgs, {
          cwd,
          maxBuffer: 2 * 1024 * 1024,
          env: buildChildEnv({}),
          signal: context.abortSignal
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
        
        let out = stdout + (stderr ? '\n' + stderr : '')
        if (out.length > 50000) {
          out = out.slice(0, 50000) + '... (truncated)'
        }
        
        return { output: out }
      } catch (err: unknown) {
        const execErr = err as ExecError
        if (execErr.stdout !== undefined) {
           let out = String(execErr.stdout) + '\n' + String(execErr.stderr || '')
           if (out.length > 50000) {
             out = out.slice(0, 50000) + '... (truncated)'
           }
           return { output: out, error: execErr.message || String(err) }
        }
        return { output: '', error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  registry.register(
    {
      name: 'web_search',
      description: 'Search the web via the keyless DuckDuckGo HTML endpoint. Returns compact title/URL/snippet lines.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          count: { type: 'number' }
        },
        required: ['query']
      },
      category: 'web'
    },
    async (args, context) => {
      try {
        const query = String(args.query)
        let count = typeof args.count === 'number' && Number.isFinite(args.count) ? Math.round(args.count) : 5
        count = Math.max(1, Math.min(count, MAX_SEARCH_RESULTS))

        const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
          headers: { 'User-Agent': WEB_USER_AGENT },
          signal: AbortSignal.any([context.abortSignal, AbortSignal.timeout(WEB_SEARCH_TIMEOUT_MS)])
        })
        if (!res.ok) {
          return { output: '', error: `Search failed: ${res.status} ${res.statusText}` }
        }
        const html = await res.text()

        // Regex-level extraction: result anchors carry the target in the `uddg` redirect
        // parameter; snippets are matched separately and zipped by index.
        const links = [...html.matchAll(/<a[^>]*class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)]
        const snippets = [...html.matchAll(/<a[^>]*class="result__snippet"[^>]*>([\s\S]*?)<\/a>/g)]
        if (links.length === 0) return { output: 'No results.' }

        const lines: string[] = []
        for (let i = 0; i < Math.min(count, links.length); i++) {
          const [, href, titleHtml] = links[i]
          const uddg = /[?&]uddg=([^&]+)/.exec(href)
          const url = uddg ? decodeURIComponent(uddg[1]) : href
          const title = decodeEntities(htmlToText(titleHtml))
          const snippet = snippets[i] ? decodeEntities(htmlToText(snippets[i][1])) : ''
          lines.push(`${i + 1}. ${title}\n   ${url}${snippet ? `\n   ${snippet}` : ''}`)
        }
        return { output: capWebOutput(lines.join('\n')) }
      } catch (err) {
        if (context.abortSignal.aborted) return { output: '', error: 'Search aborted.' }
        return { output: '', error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  registry.register(
    {
      name: 'web_fetch',
      description: 'Fetch a URL and return its content as text (HTML is stripped to text).',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string' }
        },
        required: ['url']
      },
      category: 'web'
    },
    async (args, context) => {
      try {
        const raw = String(args.url)
        let parsed: URL
        try {
          parsed = new URL(raw)
        } catch {
          return { output: '', error: `Malformed URL: ${raw}` }
        }
        if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
          return { output: '', error: `Refusing non-http(s) URL: ${raw}` }
        }

        const res = await fetch(parsed.toString(), {
          headers: { 'User-Agent': WEB_USER_AGENT },
          signal: AbortSignal.any([context.abortSignal, AbortSignal.timeout(WEB_FETCH_TIMEOUT_MS)])
        })
        if (!res.ok) {
          return { output: '', error: `Fetch failed: ${res.status} ${res.statusText}` }
        }
        const contentType = res.headers.get('content-type') ?? ''
        const body = await res.text()
        const text = contentType.includes('html') ? decodeEntities(htmlToText(body)) : body
        return { output: capWebOutput(text) }
      } catch (err) {
        if (context.abortSignal.aborted) return { output: '', error: 'Fetch aborted.' }
        return { output: '', error: err instanceof Error ? err.message : String(err) }
      }
    }
  )

  registry.register(
    {
      name: 'think',
      description: 'Scratchpad tool that returns its input as output.',
      parameters: {
        type: 'object',
        properties: {
          thought: { type: 'string' }
        },
        required: ['thought']
      },
      category: 'read'
    },
    async (args) => {
      return { output: String(args.thought) }
    }
  )
}
