import type { ChatDelta } from './adapter'

/**
 * Handles real-time detection and separation of <think>...</think> tags
 * from streaming text deltas.
 */
export class ThinkTagStreamer {
  private inThinking = false
  private buffer = ''

  process(delta: string, onDelta?: (delta: ChatDelta) => void): { text: string; thinking: string } {
    let text = ''
    let thinking = ''
    this.buffer += delta

    while (this.buffer.length > 0) {
      if (!this.inThinking) {
        const thinkStart = this.buffer.indexOf('<think>')
        if (thinkStart !== -1) {
          const plain = this.buffer.slice(0, thinkStart)
          if (plain) {
            text += plain
            onDelta?.({ content: plain })
          }
          this.inThinking = true
          this.buffer = this.buffer.slice(thinkStart + 7)
        } else {
          // If buffer ends with partial '<think', wait for next chunk
          const matchPartial = this.buffer.match(/<t(?:h(?:i(?:n(?:k)?)?)?)?$/)
          if (matchPartial && matchPartial.index !== undefined) {
            const emitLen = matchPartial.index
            const plain = this.buffer.slice(0, emitLen)
            if (plain) {
              text += plain
              onDelta?.({ content: plain })
            }
            this.buffer = this.buffer.slice(emitLen)
            break
          } else {
            text += this.buffer
            onDelta?.({ content: this.buffer })
            this.buffer = ''
          }
        }
      } else {
        const thinkEnd = this.buffer.indexOf('</think>')
        if (thinkEnd !== -1) {
          const thought = this.buffer.slice(0, thinkEnd)
          if (thought) {
            thinking += thought
            onDelta?.({ thinkingContent: thought })
          }
          this.inThinking = false
          this.buffer = this.buffer.slice(thinkEnd + 8)
        } else {
          // If buffer ends with partial '</think', wait for next chunk
          const matchPartial = this.buffer.match(/<\/t(?:h(?:i(?:n(?:k)?)?)?)?$/)
          if (matchPartial && matchPartial.index !== undefined) {
            const emitLen = matchPartial.index
            const thought = this.buffer.slice(0, emitLen)
            if (thought) {
              thinking += thought
              onDelta?.({ thinkingContent: thought })
            }
            this.buffer = this.buffer.slice(emitLen)
            break
          } else {
            thinking += this.buffer
            onDelta?.({ thinkingContent: this.buffer })
            this.buffer = ''
          }
        }
      }
    }

    return { text, thinking }
  }

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

/** Extract thinking blocks and plain text from a non-streaming string containing <think>...</think>. */
export function extractThinkTags(raw: string): { text: string; thinking?: string } {
  const match = raw.match(/<think>([\s\S]*?)<\/think>/i)
  if (!match) return { text: raw }
  const thinking = match[1]
  const text = raw.replace(/<think>[\s\S]*?<\/think>/i, '').trim()
  return { text, thinking }
}
