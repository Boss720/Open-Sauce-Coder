import { describe, expect, it, vi, beforeEach } from 'vitest'
import type { AppState, SetState, GetState } from '../slices/types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createSubagentSlice, type SubagentSlice } from '../slices/subagentSlice'

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
 * The fields `promptSubagent` must NOT touch — same single-slot reasoning as startSideChat:
 * the child session's exchange is tracked by subagentBusy/subagentError only.
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
    sessions: [],
    subagentTabs: ['child-1']
  } as unknown as Partial<AppState>)
  set(MAIN_SLOT)
  set(overrides)
  return { get, slice }
}

beforeEach(() => {
  mockApi.mockReset()
})

describe('promptSubagent', () => {
  it('prompts the child session with the parent model pick and marks the tab busy', async () => {
    const prompt = vi.fn(async (_args: { sessionID: string; text: string }) => undefined)
    mockApi.mockReturnValue({ prompt } as unknown as ReturnType<typeof api>)

    const { get, slice } = setup()
    await slice.promptSubagent('child-1', 'also check the tests')

    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toMatchObject({
      directory: '/proj',
      sessionID: 'child-1',
      providerID: 'groq',
      modelID: 'llama-3.3-70b-versatile',
      text: 'also check the tests'
    })
    expect(get().subagentBusy['child-1']).toBe(true)
    expect(get().subagentError['child-1']).toBeNull()
  })

  it('leaves the main session single-slot state completely untouched', async () => {
    mockApi.mockReturnValue({ prompt: vi.fn(async () => undefined) } as unknown as ReturnType<typeof api>)

    const { get, slice } = setup()
    await slice.promptSubagent('child-1', 'follow up')

    const state = get() as unknown as Record<string, unknown>
    expect(state.busy).toBe(true)
    expect(state.activeAttempt).toEqual({ sentinel: 'untouched' })
    expect(state.lastPrompt).toEqual({ sentinel: 'untouched' })
    expect(get().activeSessionID).toBe('main-1')
  })

  it('records a failed prompt against the tab and clears busy', async () => {
    mockApi.mockReturnValue({
      prompt: vi.fn(async () => {
        throw new Error('rate limited')
      })
    } as unknown as ReturnType<typeof api>)

    const { get, slice } = setup()
    await slice.promptSubagent('child-1', 'follow up')

    expect(get().subagentError['child-1']).toContain('rate limited')
    expect(get().subagentBusy['child-1']).toBe(false)
  })

  it('refuses to double-prompt a busy child', async () => {
    const prompt = vi.fn(async () => undefined)
    mockApi.mockReturnValue({ prompt } as unknown as ReturnType<typeof api>)

    const { slice } = setup({ subagentBusy: { 'child-1': true } })
    await slice.promptSubagent('child-1', 'follow up')
    expect(prompt).not.toHaveBeenCalled()
  })

  it('refuses sessions that are not open tabs, blank text, and missing context', async () => {
    const prompt = vi.fn(async () => undefined)
    mockApi.mockReturnValue({ prompt } as unknown as ReturnType<typeof api>)

    const cases: Array<[Partial<AppState>, string, string]> = [
      [{}, 'unknown-session', 'follow up'],
      [{}, 'child-1', '   \n  '],
      [{ directory: null } as Partial<AppState>, 'child-1', 'follow up'],
      [{ providerID: null } as unknown as Partial<AppState>, 'child-1', 'follow up'],
      [{ modelID: null } as unknown as Partial<AppState>, 'child-1', 'follow up']
    ]
    for (const [overrides, id, text] of cases) {
      const { slice } = setup(overrides)
      await slice.promptSubagent(id, text)
    }
    expect(prompt).not.toHaveBeenCalled()
  })

  it('inherits parent sessionReadOnly and sessionAgents into child session and passes them to prompt', async () => {
    const prompt = vi.fn(async (_args: Record<string, unknown>) => undefined)
    mockApi.mockReturnValue({ prompt } as unknown as ReturnType<typeof api>)

    const { get, slice } = setup({
      sessions: [
        { id: 'main-ro', parentID: null } as unknown as AppState['sessions'][number],
        { id: 'child-ro', parentID: 'main-ro' } as unknown as AppState['sessions'][number]
      ],
      subagentTabs: ['child-ro'],
      sessionReadOnly: { 'main-ro': true },
      sessionAgents: { 'main-ro': 'researcher' }
    } as unknown as Partial<AppState>)

    await slice.promptSubagent('child-ro', 'safe follow up')

    expect(get().sessionReadOnly?.['child-ro']).toBe(true)
    expect(get().sessionAgents?.['child-ro']).toBe('researcher')
    expect(prompt).toHaveBeenCalledTimes(1)
    expect(prompt.mock.calls[0][0]).toMatchObject({
      sessionID: 'child-ro',
      text: 'safe follow up',
      agent: 'researcher',
      tools: expect.any(Object)
    })
    expect((prompt.mock.calls[0][0] as { tools?: Record<string, boolean> }).tools?.write).toBe(false)
  })
})
