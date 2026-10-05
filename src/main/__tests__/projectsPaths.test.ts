import { mkdtempSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { assertSubpath, projectSlug } from '../projectsPaths'

describe('assertSubpath', () => {
  it('accepts relative and absolute paths strictly inside the base', () => {
    const base = resolve('C:/workspace/project')
    expect(assertSubpath(base, 'knowledge/file.md')).toBe(resolve(base, 'knowledge/file.md'))
    expect(assertSubpath(base, resolve(base, 'AGENTS.md'))).toBe(resolve(base, 'AGENTS.md'))
  })

  it('rejects the base, parent traversal, and absolute outsiders by default', () => {
    const base = resolve('C:/workspace/project')
    expect(() => assertSubpath(base, '.')).toThrow(/strictly inside/i)
    expect(() => assertSubpath(base, '..\\escape.md')).toThrow(/strictly inside/i)
    expect(() => assertSubpath(base, '../escape.md')).toThrow(/strictly inside/i)
    expect(() => assertSubpath(base, resolve(base, '..', 'escape.md'))).toThrow(/strictly inside/i)
  })

  it('allows base when allowRoot is true, but continues to reject escapes', () => {
    const base = resolve('C:/workspace/project')
    expect(assertSubpath(base, '.', { allowRoot: true })).toBe(base)
    expect(assertSubpath(base, '', { allowRoot: true })).toBe(base)
    expect(assertSubpath(base, 'child/path.ts', { allowRoot: true })).toBe(resolve(base, 'child/path.ts'))
    expect(() => assertSubpath(base, '..\\escape.md', { allowRoot: true })).toThrow(/strictly inside/i)
    expect(() => assertSubpath(base, '../escape.md', { allowRoot: true })).toThrow(/strictly inside/i)
    expect(() => assertSubpath(base, resolve(base, '..', 'escape.md'), { allowRoot: true })).toThrow(/strictly inside/i)
  })

  it('rejects existing symlink segments', () => {
    const base = mkdtempSync(join(tmpdir(), 'opencode-projects-'))
    const outside = mkdtempSync(join(tmpdir(), 'opencode-outside-'))
    const link = join(base, 'linked')
    try {
      symlinkSync(outside, link, process.platform === 'win32' ? 'junction' : 'dir')
    } catch {
      return // Windows developer mode/privileges may prohibit creating test links.
    }
    expect(() => assertSubpath(base, join('linked', 'file.md'))).toThrow(/symbolic/i)
  })
})

describe('projectSlug', () => {
  it('normalizes names and always returns a usable slug', () => {
    expect(projectSlug('  My New Project!  ')).toBe('my-new-project')
    expect(projectSlug('***')).toBe('project')
  })
})
