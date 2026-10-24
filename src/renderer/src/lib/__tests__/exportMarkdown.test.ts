import { describe, expect, it } from 'vitest'
import { exportMarkdown } from '../exportMarkdown'
import type { MessageWithParts } from '../types'

describe('exportMarkdown', () => {
  it('serializes messages into markdown format', () => {
    const messages: MessageWithParts[] = [
      {
        info: { role: 'user', time: { created: 1000 } } as unknown as MessageWithParts['info'],
        parts: [{ type: 'text', text: 'Hello AI' } as unknown as MessageWithParts['parts'][number]]
      },
      {
        info: { role: 'assistant', time: { created: 1005 } } as unknown as MessageWithParts['info'],
        parts: [{ type: 'text', text: 'Hello human!' } as unknown as MessageWithParts['parts'][number]]
      }
    ]

    const md = exportMarkdown(messages, 'Test Session')
    expect(md).toContain('# Test Session')
    expect(md).toContain('## User')
    expect(md).toContain('Hello AI')
    expect(md).toContain('## Assistant')
    expect(md).toContain('Hello human!')
  })
})
