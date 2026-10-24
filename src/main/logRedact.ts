/**
 * Credential scrubbing for text bound for persistent on-disk logs.
 *
 * The renderer can log anything, including a pasted key or an Authorization
 * header, so lifecycle.log passes every line through here first. Pure and
 * Electron-free so it can be unit-tested.
 */

/** Cap on a single logged line, so one huge message cannot fill the log. */
export const LOG_LINE_MAX_CHARS = 2000

export function redactSecrets(text: string): string {
  return text
    .replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [redacted]')
    .replace(
      /\b(api[_-]?key|token|secret|password|authorization)(["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
      '$1$2[redacted]'
    )
    .replace(/\b(sk|gsk|rk|pk)[-_][A-Za-z0-9_-]{16,}/g, '[redacted-key]')
    .replace(/\bAIza[0-9A-Za-z_-]{30,}/g, '[redacted-key]')
    .replace(/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, '[redacted-jwt]')
}

/** Redacts, then truncates to LOG_LINE_MAX_CHARS with a marker for the cut. */
export function sanitizeLogLine(text: string): string {
  const line = redactSecrets(text)
  return line.length > LOG_LINE_MAX_CHARS
    ? `${line.slice(0, LOG_LINE_MAX_CHARS)}... [truncated ${line.length - LOG_LINE_MAX_CHARS} chars]`
    : line
}
