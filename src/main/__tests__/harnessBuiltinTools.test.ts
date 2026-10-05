import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ToolRegistry, type ToolContext } from '../harness/tools/registry'
import { registerBuiltins, fallbackGrep } from '../harness/tools/builtins'

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

  it('auto-creates intermediate directories when writing to nested path', async () => {
    const registry = registryWithBuiltins()
    const nestedPath = 'nested/sub/dir/test.txt'
    const result = await registry.execute('fs_write', { path: nestedPath, content: 'nested content' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(readFileSync(join(projectDir, nestedPath), 'utf8')).toBe('nested content')
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

describe('builtin tool: fs_read binary protection', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'opencode-fs-read-'))
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('detects binary files with null bytes and avoids dumping raw content', async () => {
    const registry = registryWithBuiltins()
    const binaryData = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x0a, 0x1a, 0x0a])
    writeFileSync(join(projectDir, 'image.png'), binaryData)

    const result = await registry.execute('fs_read', { path: 'image.png' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('[Binary file, size: 8 bytes]')
  })

  it('detects binary files with null byte at offset 0', async () => {
    const registry = registryWithBuiltins()
    const binaryData = Buffer.from([0x00, 0x41, 0x42, 0x43])
    writeFileSync(join(projectDir, 'zero.bin'), binaryData)

    const result = await registry.execute('fs_read', { path: 'zero.bin' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('[Binary file, size: 4 bytes]')
  })

  it('detects binary files with null byte within the 8 KB sniff window', async () => {
    const registry = registryWithBuiltins()
    const buffer = Buffer.alloc(10000, 0x61)
    buffer[4096] = 0 // null byte at 4 KB
    writeFileSync(join(projectDir, 'large.bin'), buffer)

    const result = await registry.execute('fs_read', { path: 'large.bin' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('[Binary file, size: 10000 bytes]')
  })

  it('reads UTF-8 text files cleanly without false binary detection', async () => {
    const registry = registryWithBuiltins()
    const text = 'Hello world! 🚀 UTF-8 characters: äöü, € and emojis work fine.\nLine 2.'
    writeFileSync(join(projectDir, 'test.txt'), text, 'utf8')

    const result = await registry.execute('fs_read', { path: 'test.txt' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toBe(text)
  })
})

describe('builtin tool: fs_patch', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'opencode-fs-patch-'))
    writeFileSync(join(projectDir, 'sample.txt'), 'const foo = 1;\nconst bar = 2;\n')
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('successfully patches a unique target block', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute(
      'fs_patch',
      { path: 'sample.txt', target: 'const bar = 2;', replacement: 'const bar = 42;' },
      contextFor(projectDir)
    )
    expect(result.error).toBeUndefined()
    expect(result.output).toBe('Successfully patched sample.txt')
    expect(readFileSync(join(projectDir, 'sample.txt'), 'utf8')).toBe('const foo = 1;\nconst bar = 42;\n')
  })

  it('returns error when target block is not found', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute(
      'fs_patch',
      { path: 'sample.txt', target: 'nonexistent', replacement: 'replacement' },
      contextFor(projectDir)
    )
    expect(result.error).toContain('Target text not found')
  })

  it('returns error when target block is not found even with allowMultiple', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute(
      'fs_patch',
      { path: 'sample.txt', target: 'nonexistent', replacement: 'replacement', allowMultiple: true },
      contextFor(projectDir)
    )
    expect(result.error).toContain('Target text not found')
  })

  it('returns error when target block appears multiple times without allowMultiple', async () => {
    writeFileSync(join(projectDir, 'dup.txt'), 'item\nitem\n')
    const registry = registryWithBuiltins()
    const result = await registry.execute(
      'fs_patch',
      { path: 'dup.txt', target: 'item', replacement: 'unique' },
      contextFor(projectDir)
    )
    expect(result.error).toContain('appears 2 times')
    expect(result.error).toContain('must be unique to patch safely')
    expect(readFileSync(join(projectDir, 'dup.txt'), 'utf8')).toBe('item\nitem\n')
  })

  it('replaces all occurrences when allowMultiple is true and reports count', async () => {
    writeFileSync(join(projectDir, 'multi.txt'), 'foo bar foo baz foo')
    const registry = registryWithBuiltins()
    const result = await registry.execute(
      'fs_patch',
      { path: 'multi.txt', target: 'foo', replacement: 'qux', allowMultiple: true },
      contextFor(projectDir)
    )
    expect(result.error).toBeUndefined()
    expect(result.output).toBe('Successfully patched 3 occurrences in multi.txt')
    expect(readFileSync(join(projectDir, 'multi.txt'), 'utf8')).toBe('qux bar qux baz qux')
  })

  it('handles single occurrence when allowMultiple is true and reports count', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute(
      'fs_patch',
      { path: 'sample.txt', target: 'const foo = 1;', replacement: 'const foo = 99;', allowMultiple: true },
      contextFor(projectDir)
    )
    expect(result.error).toBeUndefined()
    expect(result.output).toBe('Successfully patched 1 occurrence in sample.txt')
    expect(readFileSync(join(projectDir, 'sample.txt'), 'utf8')).toBe('const foo = 99;\nconst bar = 2;\n')
  })

  it('returns error when target is empty string', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute(
      'fs_patch',
      { path: 'sample.txt', target: '', replacement: 'replacement' },
      contextFor(projectDir)
    )
    expect(result.error).toContain('Target string must not be empty')
  })

  it('correctly preserves dollar signs ($&, $1, $$) without regex substitution corruption', async () => {
    writeFileSync(join(projectDir, 'dollar.txt'), 'const x = old;\n')
    const registry = registryWithBuiltins()
    const result = await registry.execute(
      'fs_patch',
      { path: 'dollar.txt', target: 'old', replacement: '$$1 + $& + $\'' },
      contextFor(projectDir)
    )
    expect(result.error).toBeUndefined()
    expect(readFileSync(join(projectDir, 'dollar.txt'), 'utf8')).toBe('const x = $$1 + $& + $\';\n')
  })

  it('rejects path escape attempts in fs_patch', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute(
      'fs_patch',
      { path: '../outside.txt', target: 'foo', replacement: 'bar' },
      contextFor(projectDir)
    )
    expect(result.error).toMatch(/project directory|inside/i)
  })
})

describe('builtin tool: grep fallback', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'opencode-grep-'))
    writeFileSync(
      join(projectDir, 'code.ts'),
      'function calculateTax() { return 10 }\nfunction calculateDiscount() { return 5 }\n'
    )
    writeFileSync(join(projectDir, 'notes.md'), 'Tax calculation overview\n')
  })

  afterEach(() => {
    rmSync(projectDir, { recursive: true, force: true })
  })

  it('finds matches in project files', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute('grep', { pattern: 'calculateTax' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('code.ts')
    expect(result.output).toContain('calculateTax')
  })

  it('filters results by include pattern', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute(
      'grep',
      { pattern: 'Tax', include: '*.ts' },
      contextFor(projectDir)
    )
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('code.ts')
    expect(result.output).not.toContain('notes.md')
  })

  it('skips ignored directories like node_modules', async () => {
    mkdirSync(join(projectDir, 'node_modules', 'dep'), { recursive: true })
    writeFileSync(join(projectDir, 'node_modules', 'dep', 'dep.ts'), 'function calculateTax() {}\n')

    const registry = registryWithBuiltins()
    const result = await registry.execute('grep', { pattern: 'calculateTax' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('code.ts')
    expect(result.output).not.toContain('node_modules')
  })

  it('skips binary files containing null bytes', async () => {
    const binary = Buffer.from('function calculateTax() \0 binary content')
    writeFileSync(join(projectDir, 'binary.bin'), binary)

    const registry = registryWithBuiltins()
    const result = await registry.execute('grep', { pattern: 'calculateTax' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('code.ts')
    expect(result.output).not.toContain('binary.bin')
  })

  it('searches within a specific subpath', async () => {
    mkdirSync(join(projectDir, 'sub'), { recursive: true })
    writeFileSync(join(projectDir, 'sub', 'inner.ts'), 'function innerCalculateTax() {}\n')

    const registry = registryWithBuiltins()
    const result = await registry.execute('grep', { pattern: 'calculateTax', path: 'sub' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('inner.ts')
    expect(result.output).not.toContain('code.ts:1')
  })

  it('returns clean empty output when no matches are found', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute('grep', { pattern: 'nonexistent_pattern_12345' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toBe('')
  })

  it('directly verifies fallbackGrep with regex, pattern escaping, and cancellation', async () => {
    const out = await fallbackGrep(projectDir, projectDir, 'calculateDiscount')
    expect(out).toContain('code.ts:2:function calculateDiscount')

    // Pattern with special regex characters
    const specialOut = await fallbackGrep(projectDir, projectDir, 'calculateDiscount()')
    expect(specialOut).toContain('code.ts:2:function calculateDiscount() { return 5 }')

    // Aborted signal returns early
    const controller = new AbortController()
    controller.abort()
    const cancelled = await fallbackGrep(projectDir, projectDir, 'calculateDiscount', undefined, controller.signal)
    expect(cancelled).toBe('')
  })
})

describe('builtin tool: shell', () => {
  let projectDir: string

  beforeEach(() => {
    projectDir = mkdtempSync(join(tmpdir(), 'opencode-shell-'))
  })

  afterEach(async () => {
    for (let i = 0; i < 5; i++) {
      try {
        rmSync(projectDir, { recursive: true, force: true })
        break
      } catch {
        await new Promise((r) => setTimeout(r, 100))
      }
    }
  })

  it('executes a basic command and captures output', async () => {
    const registry = registryWithBuiltins()
    const isWin = process.platform === 'win32'
    const command = isWin ? 'echo hello shell' : 'echo "hello shell"'
    const result = await registry.execute('shell', { command }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('hello shell')
  })

  it('respects cwd within project containment', async () => {
    mkdirSync(join(projectDir, 'subfolder'), { recursive: true })
    writeFileSync(join(projectDir, 'subfolder', 'marker.txt'), 'sub-marker')
    const registry = registryWithBuiltins()
    const isWin = process.platform === 'win32'
    const command = isWin ? 'type marker.txt' : 'cat marker.txt'
    const result = await registry.execute('shell', { command, cwd: 'subfolder' }, contextFor(projectDir))
    expect(result.error).toBeUndefined()
    expect(result.output).toContain('sub-marker')
  })

  it('rejects cwd outside project containment', async () => {
    const registry = registryWithBuiltins()
    const result = await registry.execute('shell', { command: 'echo x', cwd: '../outside' }, contextFor(projectDir))
    expect(result.error).toMatch(/project directory|inside/i)
  })

  it('handles abort signal cancellation', async () => {
    const registry = registryWithBuiltins()
    const controller = new AbortController()
    controller.abort()
    const context: ToolContext = {
      directory: projectDir,
      agentId: 'a',
      runId: 'r',
      abortSignal: controller.signal
    }
    const isWin = process.platform === 'win32'
    const command = isWin ? 'ping -n 5 127.0.0.1' : 'sleep 5'
    const result = await registry.execute('shell', { command }, context)
    expect(result.error).toBeDefined()
  })
})

