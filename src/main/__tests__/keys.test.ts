import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { mkdirSync, rmSync, existsSync, readFileSync } from 'node:fs'

// Create a unique temp directory for this test suite
const testTmpDir = join(tmpdir(), `opencode-test-${Date.now()}-${Math.random().toString(36).slice(2)}`)
mkdirSync(testTmpDir, { recursive: true })

// Mock electron BEFORE importing keys.ts
vi.mock('electron', () => ({
  app: {
    getPath: () => testTmpDir
  },
  safeStorage: {
    isEncryptionAvailable: () => true,
    encryptString: (s: string) => Buffer.from('enc:' + s, 'utf8'),
    decryptString: (b: Buffer) => b.toString('utf8').replace(/^enc:/, '')
  }
}))

// Now import keys module (which will use the mocked electron)
import { setKey, deleteKey, listKeys, loadByokEnv, setMcpSecrets, getMcpSecrets, deleteMcpSecrets } from '../keys'

describe('keys module', () => {
  beforeEach(() => {
    // Clean up encrypted stores before each test.
    for (const filename of ['byok-keys.json', 'mcp-secrets.json']) {
      const storePath = join(testTmpDir, filename)
      if (existsSync(storePath)) rmSync(storePath)
    }
  })

  afterEach(() => {
    // Clean up encrypted stores after each test.
    for (const filename of ['byok-keys.json', 'mcp-secrets.json']) {
      const storePath = join(testTmpDir, filename)
      if (existsSync(storePath)) rmSync(storePath)
    }
  })

  it('setKey and listKeys with masked tail for last 4 chars', () => {
    setKey('nanogpt', 'nano_secret123')
    const rows = listKeys()

    const nanoRow = rows.find((r) => r.providerID === 'nanogpt')
    expect(nanoRow).toBeDefined()
    expect(nanoRow?.maskedTail).toBe('t123') // last 4 chars of 'nano_secret123'
    expect(nanoRow?.envVar).toBe('NANOGPT_API_KEY')

    // Ensure the full key is never exposed
    const fullKeyInRows = rows.some((r) => JSON.stringify(r).includes('nano_secret123'))
    expect(fullKeyInRows).toBe(false)
  })

  it('loadByokEnv returns plaintext via mocked decrypt', () => {
    setKey('nanogpt', 'nano_secret123')
    const env = loadByokEnv()

    expect(env.NANOGPT_API_KEY).toBe('nano_secret123')
  })

  it('loadByokEnv includes alias expansion for GEMINI_API_KEY', () => {
    setKey('google', 'test-gemini-key')
    const env = loadByokEnv()

    expect(env.GEMINI_API_KEY).toBe('test-gemini-key')
    // Check for Gemini aliases defined in env.ts
    expect(env.GOOGLE_GENERATIVE_AI_API_KEY).toBe('test-gemini-key')
    expect(env.GOOGLE_API_KEY).toBe('test-gemini-key')
  })

  it('listKeys never exposes the full key', () => {
    setKey('nanogpt', 'nano_verylongsecretkey123')
    setKey('google', 'gemini_abcdefghijklmnop')

    const rows = listKeys()
    const rowsJson = JSON.stringify(rows)

    expect(rowsJson).not.toContain('nano_verylongsecretkey123')
    expect(rowsJson).not.toContain('gemini_abcdefghijklmnop')

    // Only masked tails should be present
    expect(rowsJson).toContain('y123')
    expect(rowsJson).toContain('mnop')
  })

  it('deleteKey removes key from listKeys', () => {
    setKey('nanogpt', 'nano_secret123')
    let rows = listKeys()
    expect(rows.some((r) => r.providerID === 'nanogpt')).toBe(true)

    deleteKey('nanogpt')
    rows = listKeys()
    expect(rows.some((r) => r.providerID === 'nanogpt')).toBe(false)
  })

  it('deleteKey removes key from loadByokEnv', () => {
    setKey('nanogpt', 'nano_secret123')
    let env = loadByokEnv()
    expect(env.NANOGPT_API_KEY).toBe('nano_secret123')

    deleteKey('nanogpt')
    env = loadByokEnv()
    expect(env.NANOGPT_API_KEY).toBeUndefined()
  })

  it('setKey with unknown providerID throws', () => {
    expect(() => setKey('unknown-provider', 'some_key')).toThrow('Unknown provider: unknown-provider')
  })

  it('setKey with empty key throws', () => {
    expect(() => setKey('nanogpt', '')).toThrow(/empty key/)
    expect(() => setKey('nanogpt', '   ')).toThrow(/empty key/)
  })

  it('encrypts MCP credentials separately from workspace configuration', () => {
    setMcpSecrets('C:\\Workspace', 'remote', {
      headers: { Authorization: 'Bearer secret' },
      oauthClientSecret: 'oauth-secret'
    })
    expect(getMcpSecrets('C:\\Workspace', 'remote')).toEqual({
      headers: { Authorization: 'Bearer secret' },
      oauthClientSecret: 'oauth-secret'
    })
    const raw = readFileSync(join(testTmpDir, 'mcp-secrets.json'), 'utf8')
    expect(raw).not.toContain('Bearer secret')
    expect(raw).not.toContain('oauth-secret')
    deleteMcpSecrets('C:\\Workspace', 'remote')
    expect(getMcpSecrets('C:\\Workspace', 'remote')).toBeUndefined()
  })

  it('multiple keys can be stored and listed independently', () => {
    setKey('nanogpt', 'nano_secret123')
    setKey('google', 'gemini_secret123')

    const rows = listKeys()
    expect(rows).toHaveLength(2)
    expect(rows.map((r) => r.providerID).sort()).toEqual(['google', 'nanogpt'])
  })

  it('listKeys with short key produces null maskedTail', () => {
    setKey('nanogpt', 'abc') // Only 3 chars, less than 4
    const rows = listKeys()

    const nanoRow = rows.find((r) => r.providerID === 'nanogpt')
    expect(nanoRow?.maskedTail).toBeNull()
  })
})
