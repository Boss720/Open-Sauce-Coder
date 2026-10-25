import type { ChatDelta } from './adapter'

const OPEN_TAG = '<think>'
const CLOSE_TAG = '</think>'
const OPEN_RE = /<think>/i
const CLOSE_RE = /<\/think>/i

/**
 * Length of the longest suffix of `buffer` that is a proper prefix of `tag`
 * (case-insensitive). That suffix might be the start of a tag whose remainder has
 * not arrived yet, so it is held back instead of being emitted. Includes a bare
 * trailing "<" or "</".
 */
function partialTagSuffix(buffer: string, tag: string): number {
  const max = Math.min(buffer.length, tag.length - 1)
  for (let len = max; len > 0; len--) {
    if (tag.startsWith(buffer.slice(buffer.length - len).toLowerCase())) return len
  }
  return 0
}

/**
 * Handles real-time detection and separation of <think>...</think> tags
 * from streaming text deltas. Tags may be split across chunk boundaries at any
 * character ("<", "<thi", "</thi", ...); matching is case-insensitive and multiple
 * think blocks per stream are supported.
 */
export class ThinkTagStreamer {
  private inThinking = false
  private buffer = ''
  /** After a closing tag, drop whitespace between it and the first answer character. */
  private trimLeading = false

  process(delta: string, onDelta?: (delta: ChatDelta) => void): { text: string; thinking: string } {
    let text = ''
    let thinking = ''
    const emitText = (value: string): void => {
      if (!value) return
      text += value
      onDelta?.({ content: value })
    }
    const emitThinking = (value: string): void => {
      if (!value) return
      thinking += value
      onDelta?.({ thinkingContent: value })
    }

    this.buffer += delta

    while (this.buffer.length > 0) {
      if (!this.inThinking) {
        if (this.trimLeading) {
          this.buffer = this.buffer.replace(/^\s+/, '')
          if (this.buffer.length === 0) break
          this.trimLeading = false
        }
        const start = this.buffer.search(OPEN_RE)
        if (start !== -1) {
          emitText(this.buffer.slice(0, start))
          this.inThinking = true
          this.buffer = this.buffer.slice(start + OPEN_TAG.length)
          continue
        }
        const hold = partialTagSuffix(this.buffer, OPEN_TAG)
        emitText(this.buffer.slice(0, this.buffer.length - hold))
        this.buffer = this.buffer.slice(this.buffer.length - hold)
        break
      }

      const end = this.buffer.search(CLOSE_RE)
      if (end !== -1) {
        emitThinking(this.buffer.slice(0, end))
        this.inThinking = false
        this.trimLeading = true
        this.buffer = this.buffer.slice(end + CLOSE_TAG.length)
        continue
      }
      const hold = partialTagSuffix(this.buffer, CLOSE_TAG)
      emitThinking(this.buffer.slice(0, this.buffer.length - hold))
      this.buffer = this.buffer.slice(this.buffer.length - hold)
      break
    }

    return { text, thinking }
  }

  /**
   * End of stream: release anything still held back. An unterminated <think> block is
   * flushed as thinking (never silently dropped, never leaked into the answer text).
   */
  flush(onDelta?: (delta: ChatDelta) => void): { text: string; thinking: string } {
    let text = ''
    let thinking = ''
    if (this.buffer.length > 0) {
      if (this.inThinking) {
        thinking = this.buffer
        onDelta?.({ thinkingContent: this.buffer })
      } else {
        text = this.buffer
        onDelta?.({ content: this.buffer })
      }
      this.buffer = ''
    }
    return { text, thinking }
  }
}

/**
 * Extract thinking blocks and plain text from a non-streaming string containing <think>...</think>.
 * Handles several blocks, an unterminated trailing block (truncated output), and a bare
 * closing tag with no opener (templates that prefill "<think>" in the prompt).
 */
export function extractThinkTags(raw: string): { text: string; thinking?: string } {
  const thoughts: string[] = []
  let remaining = raw
  let found = false

  // Bare "</think>" with no preceding "<think>": everything before it is reasoning.
  const firstClose = remaining.search(CLOSE_RE)
  const firstOpen = remaining.search(OPEN_RE)
  if (firstClose !== -1 && (firstOpen === -1 || firstClose < firstOpen)) {
    found = true
    const reasoning = remaining.slice(0, firstClose).trim()
    if (reasoning) thoughts.push(reasoning)
    remaining = remaining.slice(firstClose + CLOSE_TAG.length)
  }

  remaining = remaining.replace(/<think>([\s\S]*?)<\/think>/gi, (_match, inner: string) => {
    found = true
    const trimmed = inner.trim()
    if (trimmed) thoughts.push(trimmed)
    return ''
  })

  // Unterminated block at the end of the output.
  const dangling = remaining.search(OPEN_RE)
  if (dangling !== -1) {
    found = true
    const trailing = remaining.slice(dangling + OPEN_TAG.length).trim()
    if (trailing) thoughts.push(trailing)
    remaining = remaining.slice(0, dangling)
  }

  if (!found) return { text: raw }
  return thoughts.length > 0
    ? { text: remaining.trim(), thinking: thoughts.join('\n') }
    : { text: remaining.trim() }
}
