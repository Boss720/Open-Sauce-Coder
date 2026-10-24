import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { NanogptLimiter } from '../nanogptLimiter'

describe('NanogptLimiter', () => {
  let limiter: NanogptLimiter

  beforeEach(() => {
    vi.useFakeTimers()
    limiter = new NanogptLimiter({
      maxConcurrent: 10,
      burstLimit: 10,
      burstWindowMs: 10_000
    })
  })

  afterEach(() => {
    limiter.reset()
    vi.useRealTimers()
  })

  it('allows immediate acquisition under concurrency and burst limits', async () => {
    const release = await limiter.acquireSlot()
    expect(limiter.getActiveCount()).toBe(1)
    expect(limiter.getQueueLength()).toBe(0)

    release()
    expect(limiter.getActiveCount()).toBe(0)
  })

  it('enforces maximum concurrent requests cap (10)', async () => {
    const releases: Array<() => void> = []

    // Acquire 10 slots (at max concurrency)
    for (let i = 0; i < 10; i++) {
      const release = await limiter.acquireSlot()
      releases.push(release)
    }

    expect(limiter.getActiveCount()).toBe(10)
    expect(limiter.getQueueLength()).toBe(0)

    // 11th request must queue
    let acquired11th = false
    const p11 = limiter.acquireSlot().then((rel) => {
      acquired11th = true
      return rel
    })

    expect(limiter.getQueueLength()).toBe(1)
    expect(acquired11th).toBe(false)

    // Release 1 slot
    releases[0]()
    await vi.runAllTimersAsync()

    expect(acquired11th).toBe(true)
    const rel11 = await p11
    expect(limiter.getActiveCount()).toBe(10)
    expect(limiter.getQueueLength()).toBe(0)

    rel11()
    releases.slice(1).forEach((r) => r())
    expect(limiter.getActiveCount()).toBe(0)
  })

  it('enforces burst rate limit (10 requests per 10s window)', async () => {
    const releases: Array<() => void> = []

    // Acquire and release 10 requests rapidly
    for (let i = 0; i < 10; i++) {
      const release = await limiter.acquireSlot()
      releases.push(release)
      release()
    }

    expect(limiter.getActiveCount()).toBe(0)

    // 11th request must wait for the burst window to slide (10,000ms)
    let acquired11th = false
    const p11 = limiter.acquireSlot().then((rel) => {
      acquired11th = true
      return rel
    })

    expect(limiter.getQueueLength()).toBe(1)
    expect(acquired11th).toBe(false)

    // Advance time by 5,000ms — still blocked
    await vi.advanceTimersByTimeAsync(5000)
    expect(acquired11th).toBe(false)

    // Advance time by another 5,001ms — burst window expires
    await vi.advanceTimersByTimeAsync(5001)
    expect(acquired11th).toBe(true)

    const rel11 = await p11
    rel11()
  })

  it('release callback is idempotent', async () => {
    const release = await limiter.acquireSlot()
    expect(limiter.getActiveCount()).toBe(1)

    release()
    expect(limiter.getActiveCount()).toBe(0)

    // Calling release again should not decrement below 0 or trigger queue processing
    release()
    expect(limiter.getActiveCount()).toBe(0)
  })

  it('resets state correctly', async () => {
    await limiter.acquireSlot()
    expect(limiter.getActiveCount()).toBe(1)

    limiter.reset()
    expect(limiter.getActiveCount()).toBe(0)
    expect(limiter.getQueueLength()).toBe(0)
  })

  it('sustained limit is checked alongside burst and concurrency limits', async () => {
    // Create a limiter with smaller sustained limit for easier testing
    const smallLimiter = new NanogptLimiter({
      maxConcurrent: 10,
      burstLimit: 10,
      burstWindowMs: 10_000,
      sustainedLimit: 5,
      sustainedWindowMs: 60_000
    })

    const releases: Array<() => void> = []

    // Acquire 5 requests (hits sustained limit of 5)
    for (let i = 0; i < 5; i++) {
      const r = await smallLimiter.acquireSlot()
      releases.push(r)
    }

    expect(smallLimiter.getActiveCount()).toBe(5)

    // 6th request must queue (sustained limit reached)
    let acquired6th = false
    const p6 = smallLimiter.acquireSlot().then((rel) => {
      acquired6th = true
      return rel
    })

    expect(acquired6th).toBe(false)
    expect(smallLimiter.getQueueLength()).toBe(1)

    // Releasing a slot frees CONCURRENCY, not sustained-window capacity: the sustained
    // window is time-based, so the 6th must still wait even with 4 requests in flight.
    releases[0]()
    await Promise.resolve()
    expect(acquired6th).toBe(false)
    expect(smallLimiter.getQueueLength()).toBe(1)

    // Only once the sustained window rolls past the oldest timestamp does it proceed.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(acquired6th).toBe(true)
    const rel6 = await p6

    // Clean up
    releases.slice(1).forEach((r) => r())
    rel6()
    smallLimiter.reset()
  })

  it('enforces the documented 60 requests/minute sustained limit at default settings', async () => {
    // Raise the burst allowance so the 10-per-10s window cannot bind; sustained is left at
    // its default (60 per 60s) so this exercises the documented value, not a test-only one.
    const limiter = new NanogptLimiter({ burstLimit: 60 })

    // Release each slot immediately so concurrency never binds either.
    for (let i = 0; i < 60; i++) {
      const rel = await limiter.acquireSlot()
      rel()
    }

    // 61st within the same minute must wait.
    let acquired61st = false
    const p61 = limiter.acquireSlot().then((rel) => {
      acquired61st = true
      return rel
    })
    await Promise.resolve()
    expect(acquired61st).toBe(false)

    await vi.advanceTimersByTimeAsync(60_000)
    expect(acquired61st).toBe(true)
    ;(await p61)()
    limiter.reset()
  })

  it('enforces burst limit within 10s window', async () => {
    // Acquire and release 10 requests at time 0
    for (let i = 0; i < 10; i++) {
      const release = await limiter.acquireSlot()
      release()
    }

    // 11th request must wait
    let acquired11th = false
    const p11 = limiter.acquireSlot().then((rel) => {
      acquired11th = true
      return rel
    })

    expect(limiter.getQueueLength()).toBe(1)
    expect(acquired11th).toBe(false)

    // Advance by 10,001ms so the burst window expires
    await vi.advanceTimersByTimeAsync(10_001)
    expect(acquired11th).toBe(true)

    const rel11 = await p11
    rel11()
  })

  it('enforces concurrency limit (11th concurrent request waits)', async () => {
    // Start acquiring 11 slots concurrently
    const p1 = limiter.acquireSlot()
    const p2 = limiter.acquireSlot()
    const p3 = limiter.acquireSlot()
    const p4 = limiter.acquireSlot()
    const p5 = limiter.acquireSlot()
    const p6 = limiter.acquireSlot()
    const p7 = limiter.acquireSlot()
    const p8 = limiter.acquireSlot()
    const p9 = limiter.acquireSlot()
    const p10 = limiter.acquireSlot()

    // All 10 should resolve immediately
    const r1 = await p1
    const r2 = await p2
    const r3 = await p3
    const r4 = await p4
    const r5 = await p5
    const r6 = await p6
    const r7 = await p7
    const r8 = await p8
    const r9 = await p9
    const r10 = await p10

    expect(limiter.getActiveCount()).toBe(10)

    // 11th should queue and wait
    let acquired11th = false
    const queuedAcquisition = limiter.acquireSlot().then(() => {
      acquired11th = true
    })

    expect(acquired11th).toBe(false)
    expect(limiter.getQueueLength()).toBe(1)

    // Release one and the 11th should acquire
    r1()
    await vi.runAllTimersAsync()
    await queuedAcquisition
    expect(acquired11th).toBe(true)

    // Clean up
    r2()
    r3()
    r4()
    r5()
    r6()
    r7()
    r8()
    r9()
    r10()
  })

  it('pauseFor() defers slot acquisition', async () => {
    limiter.pauseFor(5000)

    // Request should queue (even though concurrency/burst are available)
    let acquired = false
    const p = limiter.acquireSlot().then((rel) => {
      acquired = true
      return rel
    })

    expect(acquired).toBe(false)
    expect(limiter.getQueueLength()).toBe(1)

    // Advance by 2,500ms — still paused
    await vi.advanceTimersByTimeAsync(2500)
    expect(acquired).toBe(false)

    // Advance by another 2,501ms — pause expires and slot is granted
    await vi.advanceTimersByTimeAsync(2501)
    expect(acquired).toBe(true)

    const release = await p
    release()
  })

  it('release callback is idempotent when called multiple times', async () => {
    const release = await limiter.acquireSlot()
    expect(limiter.getActiveCount()).toBe(1)

    release()
    expect(limiter.getActiveCount()).toBe(0)

    // Second and third calls should be no-ops
    release()
    release()
    expect(limiter.getActiveCount()).toBe(0)
  })
})
