import { describe, expect, it } from 'vitest'
import { compareIds, removeMessage, samePath, sortMessages, upsertMessage } from '../collections'
import type { MessageWithParts } from '../types'

describe('collections helpers', () => {
  it('samePath normalizes slash direction and casing on Windows', () => {
    expect(samePath('C:\\Users\\Hp\\Dev', 'c:/users/hp/dev')).toBe(true)
    expect(samePath('C:/Project', 'C:/Project/Sub')).toBe(false)
    expect(samePath(null, null)).toBe(false)
    expect(samePath(null, 'C:/Project')).toBe(false)
  })

  it('compareIds compares strings lexicographically', () => {
    expect(compareIds('msg-1', 'msg-2')).toBeLessThan(0)
    expect(compareIds('msg-2', 'msg-1')).toBeGreaterThan(0)
    expect(compareIds('msg-1', 'msg-1')).toBe(0)
  })

  it('sortMessages orders messages by created timestamp', () => {
    const m1: MessageWithParts = {
      info: { id: 'm1', sessionID: 's1', role: 'user', time: { created: 100 } } as unknown as MessageWithParts['info'],
      parts: []
    }
    const m2: MessageWithParts = {
      info: { id: 'm2', sessionID: 's1', role: 'assistant', time: { created: 200 } } as unknown as MessageWithParts['info'],
      parts: []
    }
    expect(sortMessages([m2, m1])).toEqual([m1, m2])
  })

  it('upserts and removes messages immutably', () => {
    const info1 = { id: 'm1', sessionID: 's1', role: 'user', time: { created: 100 } } as unknown as MessageWithParts['info']
    const updatedInfo = { id: 'm1', sessionID: 's1', role: 'user', time: { created: 100, completed: 150 } } as unknown as MessageWithParts['info']

    const list1 = upsertMessage([], info1)
    expect(list1).toHaveLength(1)
    expect(list1[0].info.id).toBe('m1')

    const list2 = upsertMessage(list1, updatedInfo)
    expect(list2).toHaveLength(1)
    expect((list2[0].info.time as unknown as { completed?: number }).completed).toBe(150)

    const list3 = removeMessage(list2, 'm1')
    expect(list3).toHaveLength(0)
  })
})
