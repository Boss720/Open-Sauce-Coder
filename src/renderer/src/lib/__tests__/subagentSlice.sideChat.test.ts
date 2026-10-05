import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppState, SetState, GetState } from '../slices/types'
import type { Session } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createSubagentSlice, type SubagentSlice } from '../slices/subagentSlice'
import { isSideChatTitle } from '../subagents'

const mockApi = vi.mocked(api)

function createStore(): { get: GetState; set: SetState } {
  let state = {} as AppState
  const set = ((partial: unknown) => {
    const patch =
      typeof partial === 'function' ? (partial as (s: AppState) => Partial<AppState>)(state) : partial
    state = { ...state, ...(patch as Partial<AppState>) }
  }) as SetState
  const get: GetState = () => state
  return { get, set }
}

/**
 * The fields `startSideChat` must NOT touch. They belong to the main session's single
 * in-flight exchange slot; writing them from a child session would make the main chat
 * attribute a side chat's reply to itself.
 */
const MAIN_SLOT = {
  busy: true,
  activeAttempt: { sentinel: 'untouched' },
  lastPrompt: { sentinel: 'untouched' }
} as unknown as Partial<AppState>

function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: SubagentSlice } {
  const { get, set } = createStore()
  const slice = createSubagentSlice(set, get)
  set(slice)
  set({
    directory: '/proj',
    activeSessionID: 'main-1',
    providerID: 'groq',
    modelID: 'llama-3.3-70b-versatile',
    sessions: []
  } as unknown as Partial<AppState>)
  set(MAIN_SLOT)
  set(overrides)
  return { get, slice }
}

function child(id: string, title: string): Session {
  return {
    id,
    parentID: 'main-1',
    directory: '/proj',
    projectID: 'p1',
    title,
    time: { created: 1, updated: 1 }
  } as unknown as Session
}

beforeEach(() => {
  mockApi.mockReset()
})

describe('startSideChat', () => {
  it('creates a CHILD session and prompts into it, not the main session', async () => {
    const create = vi.fn(async (_d: string, title?: string) =>
      child('side-1', title ?? '')
    )
    // Typed arg — `mock.calls[0][0]` is asserted below, and a zero-arg mock types
    // `calls` as an empty tuple.
    const prompt = vi.fn(async (_args: { sessionID: string; text: string }) => undefined)
    mockApi.mockReturnValue({
      sessions: { create },
      prompt,
      messages: vi.fn(async () => [])
    } as unknown as ReturnType<typeof api>)

    const { get, slice } = setup()
    await slice.startSideChat('why is the router picking groq?')

    // parentID is the third argument — this is what routes the traffic away from the
    // main reducer via applySubagentEvent.
    expect(create).toHaveBeenCalledWith('/proj', expect.any(String), 'main-1')
    expect(isSideChatTitle(create.mock.calls[0][1])).toBe(true)

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toMatchObject({
      sessionID: 'side-1',
      text: 'why is the router picking groq?'
    })
    expect(get().activeSubagentTab).toBe('side-1')
    expect(get().subagentTabs).toContain('side-1')
  })

  it('leaves the main session single-slot state completely untouched', async () => {
    mockApi.mockReturnValue({
      sessions: { create: vi.fn(async () => child('side-1', 'q (side chat)')) },
      prompt: vi.fn(async () => undefined),
      messages: vi.fn(async () => [])
    } as unknown as ReturnType<typeof api>)

    const { get, slice } = setup()
    await slice.startSideChat('a tangent')

    const state = get() as unknown as Record<string, unknown>
    expect(state.busy).toBe(true)
    expect(state.activeAttempt).toEqual({ sentinel: 'untouched' })
    expect(state.lastPrompt).toEqual({ sentinel: 'untouched' })
    expect(get().activeSessionID).toBe('main-1')
  })

  it('records a failed prompt against the tab, never as a main-session error', async () => {
    mockApi.mockReturnValue({
      sessions: { create: vi.fn(async () => child('side-1', 'q (side chat)')) },
      prompt: vi.fn(async () => {
        throw new Error('rate limited')
      }),
      messages: vi.fn(async () => [])
    } as unknown as ReturnType<typeof api>)

    const { get, slice } = setup()
    await slice.startSideChat('a tangent')

    expect(get().subagentError['side-1']).toContain('rate limited')
    expect(get().subagentBusy['side-1']).toBe(false)
    expect((get() as unknown as Record<string, unknown>).busy).toBe(true)
  })

  it('does nothing without a directory, an active session, or a model', async () => {
    const create = vi.fn()
    mockApi.mockReturnValue({ sessions: { create } } as unknown as ReturnType<typeof api>)

    for (const missing of [
      { directory: null },
      { activeSessionID: null },
      { providerID: null },
      { modelID: null }
    ]) {
      const { slice } = setup(missing as Partial<AppState>)
      await slice.startSideChat('a tangent')
    }
    expect(create).not.toHaveBeenCalled()
  })

  it('ignores a blank question rather than creating an empty session', async () => {
    const create = vi.fn()
    mockApi.mockReturnValue({ sessions: { create } } as unknown as ReturnType<typeof api>)

    const { slice } = setup()
    await slice.startSideChat('   \n  ')
    expect(create).not.toHaveBeenCalled()
  })

  it('inherits parent sessionReadOnly and sessionAgents into child session and passes them to prompt', async () => {
    const create = vi.fn(async (_d: string, title?: string, _parentID?: string) =>
      child('side-ro', title ?? '')
    )
    const prompt = vi.fn(async (_args: Record<string, unknown>) => undefined)
    mockApi.mockReturnValue({
      sessions: { create },
      prompt,
      messages: vi.fn(async () => [])
    } as unknown as ReturnType<typeof api>)

    const { get, slice } = setup({
      activeSessionID: 'main-ro',
      sessionReadOnly: { 'main-ro': true },
      sessionAgents: { 'main-ro': 'reviewer' }
    } as unknown as Partial<AppState>)

    await slice.startSideChat('inspect something safely')

    expect(get().sessionReadOnly?.['side-ro']).toBe(true)
    expect(get().sessionAgents?.['side-ro']).toBe('reviewer')
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toMatchObject({
      sessionID: 'side-ro',
      text: 'inspect something safely',
      agent: 'reviewer',
      tools: expect.any(Object)
    })
    expect((prompt.mock.calls[0][0] as { tools?: Record<string, boolean> }).tools?.write).toBe(false)
  })
})
