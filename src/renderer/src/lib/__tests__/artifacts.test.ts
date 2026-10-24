import { describe, expect, it } from 'vitest'
import {
  extractArtifactsFromMessages,
  getArtifactTitle,
  parseFenceHeader
} from '../artifacts'
import type { MessageWithParts } from '../types'

describe('Artifact detection & extraction (artifacts.ts)', () => {
  it('parses fence header into language and filename hint', () => {
    expect(parseFenceHeader('typescript src/main.ts')).toEqual({
      lang: 'typescript',
      filename: 'src/main.ts'
    })
    expect(parseFenceHeader('html')).toEqual({ lang: 'html' })
    expect(parseFenceHeader('component.tsx')).toEqual({
      lang: 'tsx',
      filename: 'component.tsx'
    })
  })

  it('formats appropriate titles', () => {
    expect(getArtifactTitle('html', 'html')).toBe('HTML Component')
    expect(getArtifactTitle('code', 'typescript', 'src/app.ts')).toBe('src/app.ts')
    expect(getArtifactTitle('svg')).toBe('SVG Graphic')
    expect(getArtifactTitle('mermaid')).toBe('Mermaid Diagram')
  })

  it('extracts HTML, SVG, and Mermaid artifacts from assistant messages', () => {
    const messages: MessageWithParts[] = [
      {
        info: { id: 'm1', sessionID: 's1', role: 'assistant', time: { created: 100 } } as unknown as MessageWithParts['info'],
        parts: [
          {
            id: 'p1',
            messageID: 'm1',
            sessionID: 's1',
            type: 'text',
            text: 'Here is a custom button:\n```html button.html\n<button className="btn">Click me</button>\n```'
          }
        ]
      },
      {
        info: { id: 'm2', sessionID: 's1', role: 'assistant', time: { created: 101 } } as unknown as MessageWithParts['info'],
        parts: [
          {
            id: 'p2',
            messageID: 'm2',
            sessionID: 's1',
            type: 'text',
            text: 'And here is a diagram:\n```mermaid\ngraph TD;\n  A-->B;\n```'
          }
        ]
      }
    ]

    const artifacts = extractArtifactsFromMessages(messages)
    expect(artifacts.length).toBe(2)

    const htmlArtifact = artifacts.find((a) => a.type === 'html')
    expect(htmlArtifact).toBeDefined()
    expect(htmlArtifact?.title).toBe('button.html')
    expect(htmlArtifact?.currentContent).toContain('<button')

    const mermaidArtifact = artifacts.find((a) => a.type === 'mermaid')
    expect(mermaidArtifact).toBeDefined()
    expect(mermaidArtifact?.type).toBe('mermaid')
  })

  it('extracts code blocks >= 15 lines or >= 800 chars and ignores small snippets', () => {
    const smallSnippet = '```typescript\nconst x = 1;\nconsole.log(x);\n```'
    const longCodeLines = Array.from({ length: 20 }, (_, i) => `const val${i} = ${i};`).join('\n')
    const longCodeFence = `\`\`\`typescript long.ts\n${longCodeLines}\n\`\`\``

    const messages: MessageWithParts[] = [
      {
        info: { id: 'm1', sessionID: 's1', role: 'assistant', time: { created: 100 } } as unknown as MessageWithParts['info'],
        parts: [
          {
            id: 'p1',
            messageID: 'm1',
            sessionID: 's1',
            type: 'text',
            text: `Short:\n${smallSnippet}\n\nLong:\n${longCodeFence}`
          }
        ]
      }
    ]

    const artifacts = extractArtifactsFromMessages(messages)
    expect(artifacts.length).toBe(1)
    expect(artifacts[0].title).toBe('long.ts')
    expect(artifacts[0].type).toBe('code')
  })

  it('tracks multiple versions of the same artifact across messages', () => {
    const messages: MessageWithParts[] = [
      {
        info: { id: 'm1', sessionID: 's1', role: 'assistant', time: { created: 100 } } as unknown as MessageWithParts['info'],
        parts: [
          {
            id: 'p1',
            messageID: 'm1',
            sessionID: 's1',
            type: 'text',
            text: '```html app.html\n<div>Version 1</div>\n```'
          }
        ]
      },
      {
        info: { id: 'm2', sessionID: 's1', role: 'assistant', time: { created: 101 } } as unknown as MessageWithParts['info'],
        parts: [
          {
            id: 'p2',
            messageID: 'm2',
            sessionID: 's1',
            type: 'text',
            text: 'Here is the updated app:\n```html app.html\n<div>Version 2</div>\n```'
          }
        ]
      }
    ]

    const artifacts = extractArtifactsFromMessages(messages)
    expect(artifacts.length).toBe(1)
    const appArtifact = artifacts[0]
    expect(appArtifact.version).toBe(2)
    expect(appArtifact.versions.length).toBe(2)
    expect(appArtifact.versions[0].content).toContain('Version 1')
    expect(appArtifact.versions[1].content).toContain('Version 2')
    expect(appArtifact.currentContent).toContain('Version 2')
  })
})
