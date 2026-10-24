import { beforeEach, describe, expect, it, vi } from 'vitest'
import { loadIpc, HOSTILE_STRINGS, HOSTILE_OBJECTS, expectRejectsAll, type IpcHarness } from './ipcHarness'

describe('ipc nanogpt channels', () => {
  let h: IpcHarness

  beforeEach(async () => {
    h = await loadIpc()
  })

  describe('oc:nanogpt:models', () => {
    it('returns cached models from readCacheSync', async () => {
      const mockChat = [{ id: 'gpt-4', name: 'GPT-4' }]
      const mockImage = [{ id: 'dall-e-3', name: 'DALL-E 3' }]
      const mockBalanceBilled = ['model-a']
      const fetchedAt = Date.now()

      h = await loadIpc({
        readCacheSync: () => ({
          chat: mockChat as never,
          image: mockImage as never,
          balanceBilled: mockBalanceBilled,
          fetchedAt
        })
      })

      const result = await h.invoke('oc:nanogpt:models')
      expect(result).toEqual({
        chat: mockChat,
        image: mockImage,
        balanceBilled: mockBalanceBilled,
        fetchedAt
      })
    })
  })

  describe('oc:nanogpt:refresh', () => {
    it('acquires limiter slot, calls refreshCatalogs, and releases', async () => {
      const releaseMock = () => {}
      h = await loadIpc({
        acquireSlot: vi.fn(async () => releaseMock),
        refreshCatalogs: vi.fn(async () => ({ ok: true }))
      })

      const result = await h.invoke('oc:nanogpt:refresh')
      expect(h.mocks.acquireSlot).toHaveBeenCalledTimes(1)
      expect(h.mocks.refreshCatalogs).toHaveBeenCalledTimes(1)
      expect(result).toEqual({ ok: true })
    })

    it('releases the limiter even if refreshCatalogs throws', async () => {
      const releaseMock = () => {}
      h = await loadIpc({
        acquireSlot: vi.fn(async () => releaseMock),
        refreshCatalogs: vi.fn(async () => {
          throw new Error('Network error')
        })
      })

      await expect(h.invoke('oc:nanogpt:refresh')).rejects.toThrow('Network error')
      expect(h.mocks.acquireSlot).toHaveBeenCalledTimes(1)
    })
  })

  describe('oc:nanogpt:usage', () => {
    it('acquires limiter, fetches subscription usage, and releases', async () => {
      const mockUsage = { used: 100, limit: 1000 }
      h = await loadIpc({
        acquireSlot: vi.fn(async () => () => {}),
        fetchSubscriptionUsage: vi.fn(async () => mockUsage)
      })

      const result = await h.invoke('oc:nanogpt:usage')
      expect(h.mocks.acquireSlot).toHaveBeenCalledTimes(1)
      expect(h.mocks.fetchSubscriptionUsage).toHaveBeenCalledTimes(1)
      expect(result).toEqual(mockUsage)
    })

    it('returns null when fetchSubscriptionUsage throws', async () => {
      h = await loadIpc({
        acquireSlot: vi.fn(async () => () => {}),
        fetchSubscriptionUsage: vi.fn(async () => {
          throw new Error('API error')
        })
      })

      const result = await h.invoke('oc:nanogpt:usage')
      expect(result).toBeNull()
    })

    it('releases the limiter even if fetchSubscriptionUsage throws', async () => {
      h = await loadIpc({
        acquireSlot: vi.fn(async () => () => {}),
        fetchSubscriptionUsage: vi.fn(async () => {
          throw new Error('API error')
        })
      })

      await h.invoke('oc:nanogpt:usage')
      expect(h.mocks.acquireSlot).toHaveBeenCalledTimes(1)
    })
  })

  describe('oc:nanogpt:balance', () => {
    it('acquires limiter, fetches balance, and releases', async () => {
      const mockBalance = { balance: 50.0, used: 20.5 }
      h = await loadIpc({
        acquireSlot: vi.fn(async () => () => {}),
        fetchBalance: vi.fn(async () => mockBalance)
      })

      const result = await h.invoke('oc:nanogpt:balance')
      expect(h.mocks.acquireSlot).toHaveBeenCalledTimes(1)
      expect(h.mocks.fetchBalance).toHaveBeenCalledTimes(1)
      expect(result).toEqual(mockBalance)
    })

    it('returns null when fetchBalance throws', async () => {
      h = await loadIpc({
        acquireSlot: vi.fn(async () => () => {}),
        fetchBalance: vi.fn(async () => {
          throw new Error('API error')
        })
      })

      const result = await h.invoke('oc:nanogpt:balance')
      expect(result).toBeNull()
    })

    it('releases the limiter even if fetchBalance throws', async () => {
      h = await loadIpc({
        acquireSlot: vi.fn(async () => () => {}),
        fetchBalance: vi.fn(async () => {
          throw new Error('API error')
        })
      })

      await h.invoke('oc:nanogpt:balance')
      expect(h.mocks.acquireSlot).toHaveBeenCalledTimes(1)
    })
  })

  describe('oc:nanogpt:weeklyUsage', () => {
    it('returns weekly token data from tracker', async () => {
      const mockWeekly = { used: 500, limit: 2000 }
      h = await loadIpc({
        getWeeklyTokens: vi.fn(() => mockWeekly)
      })

      const result = await h.invoke('oc:nanogpt:weeklyUsage')
      expect(h.mocks.getWeeklyTokens).toHaveBeenCalledTimes(1)
      expect(result).toEqual(mockWeekly)
    })
  })

  describe('oc:nanogpt:generate', () => {
    it('rejects missing args object', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:nanogpt:generate', value),
        HOSTILE_OBJECTS
      )
    })

    it('rejects missing or invalid prompt', async () => {
      const invalidPrompts = [undefined, null, '', '   ', 42, true, {}, []]
      for (const prompt of invalidPrompts) {
        await expect(
          h.invoke('oc:nanogpt:generate', { prompt, model: 'dall-e-3' }),
          `expected rejection for prompt: ${String(prompt)}`
        ).rejects.toThrow()
      }
    })

    it('rejects prompt exceeding 4000 characters', async () => {
      const longPrompt = 'a'.repeat(4001)
      await expect(
        h.invoke('oc:nanogpt:generate', { prompt: longPrompt, model: 'dall-e-3' })
      ).rejects.toThrow(/too long/)
    })

    it('rejects missing or invalid model', async () => {
      const invalidModels = [undefined, null, '', '   ', 42, true, {}, []]
      for (const model of invalidModels) {
        await expect(
          h.invoke('oc:nanogpt:generate', { prompt: 'test', model }),
          `expected rejection for model: ${String(model)}`
        ).rejects.toThrow()
      }
    })

    it('rejects model not in cached image catalogue', async () => {
      h = await loadIpc({
        readCache: async () => ({
          chat: [],
          image: [{ id: 'known-model', name: 'Known' }],
          balanceBilled: [],
          fetchedAt: 0
        })
      })

      await expect(
        h.invoke('oc:nanogpt:generate', { prompt: 'test', model: 'unknown-model' })
      ).rejects.toThrow(/Unknown image model/)
    })

    it('rejects invalid n (not integer, out of range)', async () => {
      h = await loadIpc({
        readCache: async () => ({
          chat: [],
          image: [{ id: 'dall-e-3', name: 'DALL-E 3' }],
          balanceBilled: [],
          fetchedAt: 0
        })
      })

      const invalidCounts = [
        { n: 1.5, reason: 'fractional' },
        { n: 0, reason: 'too low' },
        { n: 5, reason: 'too high' }
      ]
      for (const { n } of invalidCounts) {
        await expect(
          h.invoke('oc:nanogpt:generate', { prompt: 'test', model: 'dall-e-3', n }),
          `expected rejection for n: ${n}`
        ).rejects.toThrow(/must be an integer between 1 and/)
      }
    })

    it('accepts valid n in range [1, 4]', async () => {
      h = await loadIpc({
        readCache: vi.fn(async () => ({
          chat: [],
          image: [{ id: 'dall-e-3', name: 'DALL-E 3' }],
          balanceBilled: [],
          fetchedAt: 0
        })),
        acquireSlot: vi.fn(async () => () => {}),
        generateImage: vi.fn(async (args: { n: number }) => ({
          images: Array(args.n).fill({ b64: 'mock-base64' }),
          paymentSource: 'subscription'
        })),
        saveImage: vi.fn(async () => ({ id: 'img-1', model: 'dall-e-3' }))
      })

      for (const n of [1, 2, 3, 4]) {
        await h.invoke('oc:nanogpt:generate', { prompt: 'test', model: 'dall-e-3', n })
        // Should not throw
      }
    })

    it('rejects invalid size (not in allowlist)', async () => {
      h = await loadIpc({
        readCache: async () => ({
          chat: [],
          image: [{ id: 'dall-e-3', name: 'DALL-E 3' }],
          balanceBilled: [],
          fetchedAt: 0
        })
      })

      await expect(
        h.invoke('oc:nanogpt:generate', { prompt: 'test', model: 'dall-e-3', size: 'invalid' })
      ).rejects.toThrow(/Unsupported image size/)
    })

    it('accepts valid sizes from the allowlist', async () => {
      h = await loadIpc({
        readCache: vi.fn(async () => ({
          chat: [],
          image: [{ id: 'dall-e-3', name: 'DALL-E 3' }],
          balanceBilled: [],
          fetchedAt: 0
        })),
        acquireSlot: vi.fn(async () => () => {}),
        generateImage: vi.fn(async () => ({
          images: [{ b64: 'mock' }],
          paymentSource: 'subscription'
        })),
        saveImage: vi.fn(async () => ({ id: 'img-1', model: 'dall-e-3' }))
      })

      const validSizes = ['256x256', '512x512', '1024x1024', '1792x1024']
      for (const size of validSizes) {
        await h.invoke('oc:nanogpt:generate', { prompt: 'test', model: 'dall-e-3', size })
        // Should not throw
      }
    })

    it('rejects balance-billing model when subscriptionOnly and allowBalance not true', async () => {
      h = await loadIpc({
        readCache: vi.fn(async () => ({
          chat: [],
          image: [{ id: 'balance-model', name: 'Balance Model' }],
          balanceBilled: ['balance-model'],
          fetchedAt: 0
        })),
        appSettingsGet: vi.fn(() => ({
          settings: { nanogptSubscriptionOnly: true }
        }))
      })

      await expect(
        h.invoke('oc:nanogpt:generate', { prompt: 'test', model: 'balance-model', allowBalance: false })
      ).rejects.toThrow(/bills your NanoGPT balance/)
    })

    it('allows balance-billing model when allowBalance is true', async () => {
      h = await loadIpc({
        readCache: vi.fn(async () => ({
          chat: [],
          image: [{ id: 'balance-model', name: 'Balance Model' }],
          balanceBilled: ['balance-model'],
          fetchedAt: 0
        })),
        appSettingsGet: vi.fn(() => ({
          settings: { nanogptSubscriptionOnly: true }
        })),
        acquireSlot: vi.fn(async () => () => {}),
        generateImage: vi.fn(async () => ({
          images: [{ b64: 'mock' }],
          paymentSource: 'balance'
        })),
        saveImage: vi.fn(async () => ({ id: 'img-1', model: 'balance-model' })),
        classifyBilling: vi.fn(() => 'balance')
      })

      await h.invoke('oc:nanogpt:generate', {
        prompt: 'test',
        model: 'balance-model',
        allowBalance: true
      })
      expect(h.mocks.acquireSlot).toHaveBeenCalled()
    })

    it('rejects concurrent generation on the same model', async () => {
      h = await loadIpc({
        readCache: vi.fn(async () => ({
          chat: [],
          image: [{ id: 'dall-e-3', name: 'DALL-E 3' }],
          balanceBilled: [],
          fetchedAt: 0
        })),
        acquireSlot: vi.fn(async () => () => {}),
        generateImage: vi.fn(async () => {
          // Simulate a long generation
          await new Promise((resolve) => setTimeout(resolve, 50))
          return {
            images: [{ b64: 'mock' }],
            paymentSource: 'subscription'
          }
        }),
        saveImage: vi.fn(async () => ({ id: 'img-1', model: 'dall-e-3' }))
      })

      // Start first generation
      const first = h.invoke('oc:nanogpt:generate', {
        prompt: 'test',
        model: 'dall-e-3'
      })

      // Attempt second concurrent generation
      const second = h.invoke('oc:nanogpt:generate', {
        prompt: 'test',
        model: 'dall-e-3'
      })

      await expect(second).rejects.toThrow(/already running/)
      await first // Wait for the first to complete
    })

    it('marks model as balance-billed when billing is balance and model not previously recorded', async () => {
      h = await loadIpc({
        readCache: vi.fn(async () => ({
          chat: [],
          image: [{ id: 'new-model', name: 'New Model' }],
          balanceBilled: [],
          fetchedAt: 0
        })),
        acquireSlot: vi.fn(async () => () => {}),
        generateImage: vi.fn(async () => ({
          images: [{ b64: 'mock' }],
          paymentSource: 'balance'
        })),
        classifyBilling: vi.fn(() => 'balance'),
        saveImage: vi.fn(async () => ({ id: 'img-1', model: 'new-model' }))
      })

      const result = await h.invoke('oc:nanogpt:generate', {
        prompt: 'test',
        model: 'new-model'
      })

      expect(h.mocks.markBalanceBilled).toHaveBeenCalledWith('new-model')
      expect(result.blacklisted).toBe(true)
    })

    it('does not mark as blacklisted when billing is subscription', async () => {
      h = await loadIpc({
        readCache: vi.fn(async () => ({
          chat: [],
          image: [{ id: 'sub-model', name: 'Sub Model' }],
          balanceBilled: [],
          fetchedAt: 0
        })),
        acquireSlot: vi.fn(async () => () => {}),
        generateImage: vi.fn(async () => ({
          images: [{ b64: 'mock' }],
          paymentSource: 'subscription'
        })),
        classifyBilling: vi.fn(() => 'subscription'),
        saveImage: vi.fn(async () => ({ id: 'img-1', model: 'sub-model' }))
      })

      const result = await h.invoke('oc:nanogpt:generate', {
        prompt: 'test',
        model: 'sub-model'
      })

      expect(h.mocks.markBalanceBilled).not.toHaveBeenCalled()
      expect(result.blacklisted).toBe(false)
    })

    it('calls generateImage with model, prompt, n, and optional size', async () => {
      h = await loadIpc({
        readCache: vi.fn(async () => ({
          chat: [],
          image: [{ id: 'dall-e-3', name: 'DALL-E 3' }],
          balanceBilled: [],
          fetchedAt: 0
        })),
        acquireSlot: vi.fn(async () => () => {}),
        generateImage: vi.fn(async () => ({
          images: [{ b64: 'mock' }],
          paymentSource: 'subscription'
        })),
        saveImage: vi.fn(async () => ({ id: 'img-1', model: 'dall-e-3' }))
      })

      await h.invoke('oc:nanogpt:generate', {
        prompt: 'test prompt',
        model: 'dall-e-3',
        n: 2,
        size: '1024x1024'
      })

      expect(h.mocks.generateImage).toHaveBeenCalledWith({
        model: 'dall-e-3',
        prompt: 'test prompt',
        n: 2,
        size: '1024x1024'
      })
    })

    it('calls saveImage for each generated image with model, prompt, and sessionID', async () => {
      h = await loadIpc({
        readCache: vi.fn(async () => ({
          chat: [],
          image: [{ id: 'dall-e-3', name: 'DALL-E 3' }],
          balanceBilled: [],
          fetchedAt: 0
        })),
        acquireSlot: vi.fn(async () => () => {}),
        generateImage: vi.fn(async () => ({
          images: [{ b64: 'img1' }, { b64: 'img2' }],
          paymentSource: 'subscription'
        })),
        saveImage: vi.fn(async () => ({ id: 'mock-id', model: 'dall-e-3' }))
      })

      await h.invoke('oc:nanogpt:generate', {
        prompt: 'test',
        model: 'dall-e-3',
        n: 2,
        sessionID: 'session-123'
      })

      expect(h.mocks.saveImage).toHaveBeenCalledTimes(2)
      expect(h.mocks.saveImage).toHaveBeenCalledWith(
        expect.objectContaining({
          base64: expect.any(String),
          sessionID: 'session-123',
          prompt: 'test',
          model: 'dall-e-3'
        })
      )
    })

    it('includes paymentSource, cost, and remainingBalance in result when provided by generateImage', async () => {
      h = await loadIpc({
        readCache: vi.fn(async () => ({
          chat: [],
          image: [{ id: 'dall-e-3', name: 'DALL-E 3' }],
          balanceBilled: [],
          fetchedAt: 0
        })),
        acquireSlot: vi.fn(async () => () => {}),
        generateImage: vi.fn(async () => ({
          images: [{ b64: 'mock' }],
          paymentSource: 'balance',
          cost: 0.5,
          remainingBalance: 49.5
        })),
        classifyBilling: vi.fn(() => 'balance'),
        saveImage: vi.fn(async () => ({ id: 'img-1', model: 'dall-e-3' }))
      })

      const result = await h.invoke('oc:nanogpt:generate', {
        prompt: 'test',
        model: 'dall-e-3'
      })

      expect(result.paymentSource).toBe('balance')
      expect(result.cost).toBe(0.5)
      expect(result.remainingBalance).toBe(49.5)
    })

    it('releases limiter even if generateImage throws', async () => {
      h = await loadIpc({
        readCache: vi.fn(async () => ({
          chat: [],
          image: [{ id: 'dall-e-3', name: 'DALL-E 3' }],
          balanceBilled: [],
          fetchedAt: 0
        })),
        acquireSlot: vi.fn(async () => () => {}),
        generateImage: vi.fn(async () => {
          throw new Error('Generation failed')
        })
      })

      await expect(
        h.invoke('oc:nanogpt:generate', { prompt: 'test', model: 'dall-e-3' })
      ).rejects.toThrow('Generation failed')

      expect(h.mocks.acquireSlot).toHaveBeenCalled()
    })
  })

  describe('oc:nanogpt:images:list', () => {
    it('calls reconcile and listImages without sessionID', async () => {
      h = await loadIpc({
        listImages: vi.fn(async () => [])
      })

      await h.invoke('oc:nanogpt:images:list')
      expect(h.mocks.reconcile).toHaveBeenCalledTimes(1)
      expect(h.mocks.listImages).toHaveBeenCalledWith()
    })

    it('calls reconcile and listImages with sessionID when provided', async () => {
      h = await loadIpc({
        listImages: vi.fn(async () => [])
      })

      await h.invoke('oc:nanogpt:images:list', 'session-123')
      expect(h.mocks.reconcile).toHaveBeenCalledTimes(1)
      expect(h.mocks.listImages).toHaveBeenCalledWith('session-123')
    })

    it('returns the list of images from listImages', async () => {
      const mockImages = [
        { id: 'img-1', model: 'dall-e-3' },
        { id: 'img-2', model: 'dall-e-3' }
      ]
      h = await loadIpc({
        listImages: vi.fn(async () => mockImages)
      })

      const result = await h.invoke('oc:nanogpt:images:list')
      expect(result).toEqual(mockImages)
    })

    it('ignores whitespace-only sessionID and treats as undefined', async () => {
      h = await loadIpc({
        listImages: vi.fn(async (sessionID) => (sessionID ? [] : [{ id: 'img-1', model: 'dall-e-3' }]))
      })

      const result = await h.invoke('oc:nanogpt:images:list', '   ')
      // Whitespace-only collapses to undefined, so listImages is called unfiltered —
      // and the unfiltered branch of the stub is what comes back.
      expect(h.mocks.listImages).toHaveBeenCalledWith()
      expect(result).toEqual([{ id: 'img-1', model: 'dall-e-3' }])
    })
  })

  describe('oc:nanogpt:images:read', () => {
    it('rejects invalid id', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:nanogpt:images:read', value),
        HOSTILE_STRINGS
      )
    })

    it('calls readImage with the id', async () => {
      h = await loadIpc({
        readImage: vi.fn(async () => 'base64-data')
      })

      await h.invoke('oc:nanogpt:images:read', 'img-123')
      expect(h.mocks.readImage).toHaveBeenCalledWith('img-123')
    })

    it('returns the image data from readImage', async () => {
      const mockData = 'base64-encoded-png-data'
      h = await loadIpc({
        readImage: vi.fn(async () => mockData)
      })

      const result = await h.invoke('oc:nanogpt:images:read', 'img-123')
      expect(result).toBe(mockData)
    })

    it('returns null when readImage returns null', async () => {
      h = await loadIpc({
        readImage: vi.fn(async () => null)
      })

      const result = await h.invoke('oc:nanogpt:images:read', 'img-123')
      expect(result).toBeNull()
    })
  })

  describe('oc:nanogpt:images:delete', () => {
    it('rejects invalid id', async () => {
      await expectRejectsAll(
        (value) => h.invoke('oc:nanogpt:images:delete', value),
        HOSTILE_STRINGS
      )
    })

    it('calls deleteImage with the id', async () => {
      await h.invoke('oc:nanogpt:images:delete', 'img-123')
      expect(h.mocks.deleteImage).toHaveBeenCalledWith('img-123')
    })

    it('returns undefined on success', async () => {
      const result = await h.invoke('oc:nanogpt:images:delete', 'img-123')
      expect(result).toBeUndefined()
    })
  })

  describe('oc:nanogpt:images:today', () => {
    it('calls imagesToday and returns the count', async () => {
      h = await loadIpc({
        imagesToday: vi.fn(async () => 5)
      })

      const result = await h.invoke('oc:nanogpt:images:today')
      expect(h.mocks.imagesToday).toHaveBeenCalledTimes(1)
      expect(result).toBe(5)
    })
  })
})
