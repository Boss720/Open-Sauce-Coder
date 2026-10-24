import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import type { OpencodeApi } from '../slices/api'
import type { AppState, SetState, GetState } from '../slices/types'
import type { FileDiff, GitStatus } from '../types'

vi.mock('../slices/api', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../slices/api')>()
  return { ...actual, api: vi.fn() }
})

import { api } from '../slices/api'
import { createGitSlice, type GitSlice } from '../slices/gitSlice'

const mockApi = vi.mocked(api)

function createStore(): { get: GetState; set: SetState } {
  let state = {} as AppState
  const set = ((partial: unknown) => {
    const patch = typeof partial === 'function' ? (partial as (s: AppState) => Partial<AppState>)(state) : partial
    state = { ...state, ...(patch as Partial<AppState>) }
  }) as SetState
  const get: GetState = () => state
  return { get, set }
}

/**
 * Installs the slice's own defaults first, then layers the test's overrides on top —
 * calling `set(slice)` *after* the overrides would clobber them with the slice's
 * initial values (gitStatus: null, gitStatusFor: null, etc).
 */
function setup(overrides: Partial<AppState> = {}): { get: GetState; slice: GitSlice } {
  const { get, set } = createStore()
  const slice = createGitSlice(set, get)
  set(slice)
  set(overrides)
  return { get, slice }
}

function status(overrides: Partial<GitStatus> = {}): GitStatus {
  return { branch: 'main', upstream: null, ahead: 0, behind: 0, entries: [], clean: true, ...overrides }
}

function fakeApi(overrides: Partial<OpencodeApi['git']> = {}): OpencodeApi {
  return { git: { status: vi.fn(), branches: vi.fn(async () => []), ...overrides } } as unknown as OpencodeApi
}

describe('gitSlice', () => {
  beforeEach(() => {
    mockApi.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('gitStatus === null semantics', () => {
    it('before the first fetch lands: gitStatusFor is null even though a directory is set', () => {
      const { get } = setup({ directory: '/proj' })

      // Freshly created slice, no refresh has resolved yet.
      expect(get().gitStatus).toBeNull()
      expect(get().gitStatusFor).toBeNull()
      // The UI can tell this apart from "not a repo" because gitStatusFor !== directory.
      expect(get().gitStatusFor).not.toBe(get().directory)
    })

    it('after a fetch resolves for a non-git directory: status is null AND gitStatusFor names that directory', async () => {
      vi.useFakeTimers()
      mockApi.mockReturnValue(fakeApi({ status: vi.fn(async () => null), branches: vi.fn(async () => []) }))

      const { get, slice } = setup({ directory: '/not-a-repo' })

      const p = slice.refreshGit()
      await vi.advanceTimersByTimeAsync(300)
      await p

      expect(get().gitStatus).toBeNull()
      expect(get().gitStatusFor).toBe('/not-a-repo')
    })

    it('after a fetch resolves for a real repo: status is populated and gitStatusFor matches', async () => {
      vi.useFakeTimers()
      const real = status({ branch: 'feat/x' })
      mockApi.mockReturnValue(fakeApi({ status: vi.fn(async () => real), branches: vi.fn(async () => []) }))

      const { get, slice } = setup({ directory: '/repo' })

      const p = slice.refreshGit()
      await vi.advanceTimersByTimeAsync(300)
      await p

      expect(get().gitStatus).toEqual(real)
      expect(get().gitStatusFor).toBe('/repo')
    })
  })

  describe('refreshGit debounce', () => {
    it('collapses a burst of calls into one status/branches round-trip', async () => {
      vi.useFakeTimers()
      const statusFn = vi.fn(async () => status())
      const branchesFn = vi.fn(async () => [])
      mockApi.mockReturnValue(fakeApi({ status: statusFn, branches: branchesFn }))

      const { get, slice } = setup({ directory: '/proj' })

      // Each call clears the previous call's pending setTimeout, so only the LAST
      // call's returned promise ever resolves — the earlier ones hang forever by
      // design. Only await the final one.
      slice.refreshGit()
      slice.refreshGit()
      const last = slice.refreshGit()

      await vi.advanceTimersByTimeAsync(300)
      await last

      expect(statusFn).toHaveBeenCalledTimes(1)
      expect(branchesFn).toHaveBeenCalledTimes(1)
      expect(get().gitStatusFor).toBe('/proj')
    })

    it('does nothing when no directory is set', async () => {
      vi.useFakeTimers()
      const statusFn = vi.fn(async () => status())
      mockApi.mockReturnValue(fakeApi({ status: statusFn }))

      const { get, slice } = setup({ directory: null })

      const p = slice.refreshGit()
      await vi.advanceTimersByTimeAsync(300)
      await p

      expect(statusFn).not.toHaveBeenCalled()
      expect(get().gitStatusFor).toBeNull()
    })
  })

  describe('stagePaths / unstagePaths', () => {
    it('stagePaths updates gitStatus from the response', async () => {
      const staged = status({ clean: false })
      mockApi.mockReturnValue(fakeApi({ stage: vi.fn(async () => staged) } as unknown as Partial<OpencodeApi['git']>))

      const { get, slice } = setup({ directory: '/proj' })

      await slice.stagePaths(['a.ts'])
      expect(get().gitStatus).toEqual(staged)
    })

    it('is a no-op for an empty path list', async () => {
      const stageFn = vi.fn(async () => status())
      mockApi.mockReturnValue(fakeApi({ stage: stageFn } as unknown as Partial<OpencodeApi['git']>))

      const { get, slice } = setup({ directory: '/proj' })

      await slice.stagePaths([])
      expect(stageFn).not.toHaveBeenCalled()
      expect(get().gitStatus).toBeNull()
    })
  })

  describe('checkoutBranch', () => {
    it('switches branch then closes the open file and reloads the tree, since both go stale', async () => {
      const newStatus = status({ branch: 'develop' })
      mockApi.mockReturnValue(fakeApi({ checkout: vi.fn(async () => newStatus) } as unknown as Partial<OpencodeApi['git']>))

      const closeFile = vi.fn()
      const loadTree = vi.fn(async () => {})
      const { get, slice } = setup({ directory: '/proj', closeFile, loadTree })

      await slice.checkoutBranch('develop')
      expect(get().gitStatus).toEqual(newStatus)
      expect(closeFile).toHaveBeenCalledTimes(1)
      expect(loadTree).toHaveBeenCalledTimes(1)
    })

    it('sets error and does not touch the file/tree when the checkout fails', async () => {
      mockApi.mockReturnValue(
        fakeApi({
          checkout: vi.fn(async () => {
            throw new Error('local changes would be overwritten')
          })
        } as unknown as Partial<OpencodeApi['git']>)
      )

      const closeFile = vi.fn()
      const loadTree = vi.fn(async () => {})
      const { get, slice } = setup({ directory: '/proj', closeFile, loadTree })

      await slice.checkoutBranch('develop')
      expect(get().error).toBe('local changes would be overwritten')
      expect(closeFile).not.toHaveBeenCalled()
      expect(loadTree).not.toHaveBeenCalled()
    })
  })

  describe('stageHunks', () => {
    const diff: FileDiff = {
      path: 'a.ts',
      binary: false,
      truncated: false,
      hunks: [
        {
          id: '1-1',
          header: '@@ -1,1 +1,1 @@',
          oldStart: 1,
          oldLines: 1,
          newStart: 1,
          newLines: 1,
          lines: [
            { kind: 'del', text: 'old' },
            { kind: 'add', text: 'new' }
          ]
        }
      ]
    }

    it('reuses the already-open diff for the same path instead of re-fetching', async () => {
      const diffFn = vi.fn()
      const stageHunksFn = vi.fn(async () => status({ clean: false }))
      mockApi.mockReturnValue(fakeApi({ diff: diffFn, stageHunks: stageHunksFn } as unknown as Partial<OpencodeApi['git']>))

      const { get, slice } = setup({ directory: '/proj', openFileDiff: diff })

      await slice.stageHunks('a.ts', ['1-1'])
      expect(diffFn).not.toHaveBeenCalled()
      expect(stageHunksFn).toHaveBeenCalledWith({ directory: '/proj', path: 'a.ts', patch: expect.stringContaining('@@') })
      expect(get().gitStatus).toEqual(status({ clean: false }))
    })

    it('fetches a fresh diff when none is open for that path', async () => {
      const diffFn = vi.fn(async () => diff)
      mockApi.mockReturnValue(fakeApi({ diff: diffFn, stageHunks: vi.fn(async () => status()) } as unknown as Partial<OpencodeApi['git']>))

      const { get, slice } = setup({ directory: '/proj', openFileDiff: null })

      await slice.stageHunks('a.ts', ['1-1'])
      expect(diffFn).toHaveBeenCalledWith({ directory: '/proj', path: 'a.ts' })
      expect(get().error).toBeUndefined()
    })

    it('refuses to stage hunks of a truncated diff', async () => {
      const truncated: FileDiff = { ...diff, truncated: true }
      mockApi.mockReturnValue(fakeApi({} as unknown as Partial<OpencodeApi['git']>))

      const { get, slice } = setup({ directory: '/proj', openFileDiff: truncated })

      await slice.stageHunks('a.ts', ['1-1'])
      expect(get().error).toMatch(/partial diff/)
    })

    it('translates the "unexpected file" backend error into a rename-specific message', async () => {
      mockApi.mockReturnValue(
        fakeApi({
          stageHunks: vi.fn(async () => {
            throw new Error('unexpected file in patch: a.ts')
          })
        } as unknown as Partial<OpencodeApi['git']>)
      )

      const { get, slice } = setup({ directory: '/proj', openFileDiff: diff })

      await slice.stageHunks('a.ts', ['1-1'])
      expect(get().error).toMatch(/was renamed/)
    })

    it('passes through an unrelated backend error verbatim', async () => {
      mockApi.mockReturnValue(
        fakeApi({
          stageHunks: vi.fn(async () => {
            throw new Error('disk full')
          })
        } as unknown as Partial<OpencodeApi['git']>)
      )

      const { get, slice } = setup({ directory: '/proj', openFileDiff: diff })

      await slice.stageHunks('a.ts', ['1-1'])
      expect(get().error).toBe('disk full')
    })
  })

  describe('commit', () => {
    it('rejects an empty/whitespace message without calling the backend', async () => {
      const commitFn = vi.fn()
      mockApi.mockReturnValue(fakeApi({ commit: commitFn } as unknown as Partial<OpencodeApi['git']>))

      const { get, slice } = setup({ directory: '/proj' })

      await slice.commit('   ')
      expect(commitFn).not.toHaveBeenCalled()
      expect(get().error).toBe('Enter a commit message first.')
    })

    it('commits then immediately refreshes status — not through the debounce', async () => {
      const commitFn = vi.fn(async () => ({ sha: 'abc123' }))
      const statusFn = vi.fn(async () => status({ clean: true }))
      mockApi.mockReturnValue(fakeApi({ commit: commitFn, status: statusFn, branches: vi.fn(async () => []) } as unknown as Partial<OpencodeApi['git']>))

      const { get, slice } = setup({ directory: '/proj' })

      // No fake timers here: commit() calls doRefreshGit directly, bypassing the debounce.
      await slice.commit('fix: thing')
      expect(commitFn).toHaveBeenCalledWith({ directory: '/proj', message: 'fix: thing' })
      expect(statusFn).toHaveBeenCalledTimes(1)
      expect(get().gitStatus).toEqual(status({ clean: true }))
    })
  })

  describe('generateCommitMessage', () => {
    it('names the single changed file with a verb derived from its status', async () => {
      const { slice } = setup({
        directory: '/proj',
        gitStatus: status({
          clean: false,
          entries: [{ path: 'new.ts', index: 'added', worktree: null }]
        })
      })

      expect(await slice.generateCommitMessage()).toBe('Add new.ts')
    })

    it('falls back to unstaged entries when nothing is staged', async () => {
      const { slice } = setup({
        directory: '/proj',
        gitStatus: status({
          clean: false,
          entries: [{ path: 'gone.ts', index: null, worktree: 'deleted' }]
        })
      })

      expect(await slice.generateCommitMessage()).toBe('Remove gone.ts')
    })

    it('summarizes multiple changed files by count', async () => {
      const { slice } = setup({
        directory: '/proj',
        gitStatus: status({
          clean: false,
          entries: [
            { path: 'a.ts', index: 'modified', worktree: null },
            { path: 'b.ts', index: 'modified', worktree: null }
          ]
        })
      })

      expect(await slice.generateCommitMessage()).toBe('Update 2 files')
    })

    it('returns empty string when the working tree is clean', async () => {
      const { slice } = setup({ directory: '/proj', gitStatus: status({ clean: true, entries: [] }) })

      expect(await slice.generateCommitMessage()).toBe('')
    })
  })
})
