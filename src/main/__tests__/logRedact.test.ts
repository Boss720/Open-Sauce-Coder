import { describe, expect, it } from 'vitest'
import { LOG_LINE_MAX_CHARS, redactSecrets, sanitizeLogLine } from '../logRedact'

describe('redactSecrets', () => {
  it('redacts Bearer and Basic credentials', () => {
    expect(redactSecrets('Authorization: Bearer abcdef1234567890')).not.toContain('abcdef1234567890')
    expect(redactSecrets('Basic dXNlcjpwYXNzd29yZA==')).toBe('Basic [redacted]')
  })

  it('redacts key/value style secrets but keeps the key name', () => {
    const out = redactSecrets('{"apiKey":"supersecretvalue","user":"bob"}')
    expect(out).toContain('apiKey')
    expect(out).not.toContain('supersecretvalue')
    expect(out).toContain('bob')
    expect(redactSecrets('password=hunter2hunter2')).toBe('password=[redacted]')
  })

  it('redacts provider key shapes and JWTs', () => {
    expect(redactSecrets('key sk-abcdefghijklmnopqrstuv')).toBe('key [redacted-key]')
    expect(redactSecrets('gsk_abcdefghijklmnopqrstuvwx')).toBe('[redacted-key]')
    expect(redactSecrets('AIza' + 'A'.repeat(35))).toBe('[redacted-key]')
    expect(redactSecrets('eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.abcdefghijkl123')).toBe('[redacted-jwt]')
  })

  it('leaves ordinary text alone', () => {
    const t = 'Renderer warning: component re-rendered 3 times'
    expect(redactSecrets(t)).toBe(t)
  })
})

describe('sanitizeLogLine', () => {
  it('truncates long lines with a marker', () => {
    const out = sanitizeLogLine('x'.repeat(LOG_LINE_MAX_CHARS + 50))
    expect(out.startsWith('x'.repeat(LOG_LINE_MAX_CHARS))).toBe(true)
    expect(out).toMatch(/\[truncated 50 chars\]$/)
  })

  it('redacts before truncating', () => {
    expect(sanitizeLogLine('token=abcdefghijkl')).toBe('token=[redacted]')
  })
})
