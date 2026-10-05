import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry, type ToolContext } from '../harness/tools/registry'
import { registerBuiltins } from '../harness/tools/builtins'

function contextFor(directory: string): ToolContext {
  return { directory, agentId: 'a', runId: 'r', abortSignal: new AbortController().signal }
}

function registryWithBuiltins(): ToolRegistry {
  const registry = new ToolRegistry()
  registerBuiltins(registry)
  return registry
}

/** Minimal fetch Response-alike; the executors only touch ok/status/statusText/headers/text. */
function fakeResponse(init: { ok?: boolean; status?: number; statusText?: string; contentType?: string; body?: string }) {
  return {
    ok: init.ok ?? true,
    status: init.status ?? 200,
    statusText: init.statusText ?? 'OK',
    headers: { get: (name: string) => (name === 'content-type' ? (init.contentType ?? null) : null) },
    text: async () => init.body ?? ''
  } as unknown as Response
}

describe('builtin tool: fs_write', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'opencode-fs-write-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('writes file contents inside the project directory', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute('fs_write', { path: 'out.txt', content: 'hello harness' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('Wrote 13 bytes')
    expect(readFileSync(join(projectDir, 'out.txt'), 'utf8')).toBe('hello harness')
  })

  it('rejects path escapes via assertSubpath containment', async () => {
    const registry = registryWithBuiltins()
    for (const escapePath of ['../escape.txt', '../../evil.txt', join(tmpdir(), 'abs-escape.txt')]) {
      const result = await registry.execute('fs_write', { path: escapePath, content: 'x' }, contextFor(projectDir))
      expect(result.error, `expected containment error for ${escapePath}`).toMatch(/project directory|inside/i)
    }
  })

  it('rejects writes over the 2 MiB cap', async () => {
    const registry = registryWithBuiltins()
    const big = 'x'.repeat(2 * 1024 * 1024 + 1)
    const result = await registry.execute('fs_write', { path: 'big.txt', content: big }, contextFor(projectDir))
    expect(result.error).toMatch(/Refusing to write/)
  })
})

describe('builtin tool: fs_list', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'opencode-fs-list-'))
    writeFileSync(join(projectDir, 'root-file.txt'), 'hello root')
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('lists project root directory with path "."', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute('fs_list', { path: '.' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('root-file.txt')
  })

  it('lists project root directory with empty path ""', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute('fs_list', { path: '' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('root-file.txt')
  })

  it('rejects path escape attempts', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute('fs_list', { path: '../escape' }, contextFor(projectDir))
    expect(result.error).toMatch(/project directory|inside/i)
  })
})

describe('builtin tool: web_search', () => {
  const DDG_HTML = `
    <html><body>
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=abc">First &amp; Result</a>
      <a class="result__snippet">Snippet <b>one</b> text</a>
      <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Ftwo&amp;rut=def">Second Result</a>
      <a class="result__snippet">Snippet two text</a>
    </body></html>
  `

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('parses results into compact title/URL/snippet lines', async () => {
    const fetchMock = vi.fn(async () => fakeResponse({ contentType: 'text/html', body: DDG_HTML }))
    vi.stubGlobal('fetch', fetchMock)

    const registry = registryWithBuiltins()
    const result = await registry.execute('web_search', { query: 'hello world' }, contextFor('/tmp'))

    expect(result.error).toBeUndefined()
    expect(result.output).toContain('1. First & Result')
    expect(result.output).toContain('https://example.com/one')
    expect(result.output).toContain('Snippet one text')
    expect(result.output).toContain('2. Second Result')

    const [url] = fetchMock.mock.calls[0] as unknown as [string]
    expect(url).toContain('html.duckduckgo.com')
    expect(url).toContain('q=hello%20world')
  })

  it('honours the count cap', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: DDG_HTML })))
    const registry = registryWithBuiltins()
    const result = await registry.execute('web_search', { query: 'q', count: 1 }, contextFor('/tmp'))
    expect(result.output).toContain('1. First')
    expect(result.output).not.toContain('2. Second')
  })

  it('returns an error on non-OK responses and "No results." on empty pages', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ ok: false, status: 502, statusText: 'Bad Gateway' })))
    let registry = registryWithBuiltins()
    let result = await registry.execute('web_search', { query: 'q' }, contextFor('/tmp'))
    expect(result.error).toMatch(/Search failed: 502/)

    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ body: '<html><body>nothing</body></html>' })))
    registry = registryWithBuiltins()
    result = await registry.execute('web_search', { query: 'q' }, contextFor('/tmp'))
    expect(result.error).toBeUndefined()
    expect(result.output).toBe('No results.')
  })
})

describe('builtin tool: web_fetch', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('strips HTML pages down to text', async () => {
    const html = '<html><head><style>body{color:red}</style><script>alert(1)</script></head>' +
      '<body><h1>Title</h1><p>Hello <b>world</b> &amp; friends</p></body></html>'
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ contentType: 'text/html; charset=utf-8', body: html })))

    const registry = registryWithBuiltins()
    const result = await registry.execute('web_fetch', { url: 'https://example.com/page' }, contextFor('/tmp'))

    expect(result.error).toBeUndefined()
    expect(result.output).toContain('Title')
    expect(result.output).toContain('Hello world & friends')
    expect(result.output).not.toContain('alert(1)')
    expect(result.output).not.toContain('color:red')
    expect(result.output).not.toMatch(/<[^>]+>/)
  })

  it('returns non-HTML bodies verbatim', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ contentType: 'application/json', body: '{"a":1}' })))
    const registry = registryWithBuiltins()
    const result = await registry.execute('web_fetch', { url: 'https://example.com/data.json' }, contextFor('/tmp'))
    expect(result.output).toBe('{"a":1}')
  })

  it('refuses non-http(s) URLs before fetching', async () => {
    const fetchMock = vi.fn(async () => fakeResponse({}))
    vi.stubGlobal('fetch', fetchMock)
    const registry = registryWithBuiltins()

    for (const url of ['file:///etc/passwd', 'ftp://example.com/x', 'not a url']) {
      const result = await registry.execute('web_fetch', { url }, contextFor('/tmp'))
      expect(result.error, `expected refusal for ${url}`).toBeTruthy()
    }
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('caps the returned body at 100k chars', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ contentType: 'text/plain', body: 'y'.repeat(150_000) })))
    const registry = registryWithBuiltins()
    const result = await registry.execute('web_fetch', { url: 'https://example.com/big' }, contextFor('/tmp'))
    expect(result.output.length).toBeLessThan(101_000)
    expect(result.output).toContain('... (truncated)')
  })

  it('returns an error on non-OK responses', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => fakeResponse({ ok: false, status: 404, statusText: 'Not Found' })))
    const registry = registryWithBuiltins()
    const result = await registry.execute('web_fetch', { url: 'https://example.com/missing' }, contextFor('/tmp'))
    expect(result.error).toMatch(/Fetch failed: 404/)
  })
})
