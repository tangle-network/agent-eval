import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { mapConcurrent, mapConcurrentRange } from './concurrency'

describe('mapConcurrent', () => {
  it('bounds active work and preserves input order', async () => {
    let active = 0
    let maxActive = 0
    let release: (() => void) | undefined
    const twoActive = new Promise<void>((resolve) => {
      release = resolve
    })

    const result = await mapConcurrent([3, 1, 2], 2, async (value) => {
      active += 1
      maxActive = Math.max(maxActive, active)
      if (active === 2) release?.()
      await twoActive
      active -= 1
      return value * 10
    })

    expect(maxActive).toBe(2)
    expect(result).toEqual([30, 10, 20])
  })

  it('stops admitting work, settles in-flight work, and propagates the first error', async () => {
    const firstError = new Error('first failure')
    const started: number[] = []
    let releaseFailure: (() => void) | undefined
    let releaseInFlight: (() => void) | undefined
    let releaseStarted: (() => void) | undefined
    let inFlightSignal: AbortSignal | undefined
    const failNow = new Promise<void>((resolve) => {
      releaseFailure = resolve
    })
    const finishInFlight = new Promise<void>((resolve) => {
      releaseInFlight = resolve
    })
    const bothStarted = new Promise<void>((resolve) => {
      releaseStarted = resolve
    })

    let settled = false
    const run = mapConcurrent([0, 1, 2, 3], 2, async (_value, index, signal) => {
      started.push(index)
      if (started.length === 2) releaseStarted?.()
      await bothStarted
      if (index === 0) {
        await failNow
        throw firstError
      }
      inFlightSignal = signal
      await finishInFlight
      return index
    })
      .then(
        () => ({ status: 'fulfilled' as const }),
        (error: unknown) => ({ status: 'rejected' as const, error }),
      )
      .finally(() => {
        settled = true
      })

    await bothStarted
    releaseFailure?.()
    await Promise.resolve()
    await Promise.resolve()
    expect(settled).toBe(false)
    expect(started).toEqual([0, 1])

    releaseInFlight?.()
    const outcome = await run
    expect(outcome).toEqual({ status: 'rejected', error: firstError })
    expect(inFlightSignal?.aborted).toBe(true)
    expect(started).toEqual([0, 1])
  })

  it('validates the worker count and handles empty input', async () => {
    await expect(mapConcurrent([], 1, async () => 'unused')).resolves.toEqual([])
    await expect(mapConcurrent([1], 0, async (value) => value)).rejects.toThrow('positive integer')
    await expect(mapConcurrent([1], 1.5, async (value) => value)).rejects.toThrow(
      'positive integer',
    )
  })
})

describe('mapConcurrentRange', () => {
  it('rejects caller cancellation before dispatch', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled by caller'))
    let calls = 0

    await expect(
      mapConcurrentRange({
        count: 2,
        maxConcurrency: 1,
        label: 'test experiment',
        signal: controller.signal,
        async map(index) {
          calls += 1
          return index
        },
      }),
    ).rejects.toThrow('cancelled by caller')
    expect(calls).toBe(0)
  })

  it('settles active work and stops dispatch after caller cancellation', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled during execution')
    const calls: number[] = []
    let settled = 0
    const run = mapConcurrentRange({
      count: 4,
      maxConcurrency: 2,
      label: 'test experiment',
      signal: controller.signal,
      async map(index, signal) {
        calls.push(index)
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        settled += 1
        return index
      },
    })

    await delay(1)
    controller.abort(reason)

    await expect(run).rejects.toBe(reason)
    expect(settled).toBe(2)
    expect(calls).toEqual([0, 1])
  })

  it('cancels and settles active work after the first failure', async () => {
    const failure = new Error('first cell failed')
    const calls: number[] = []
    let activeSettled = false
    let activeSignal: AbortSignal | undefined

    const run = mapConcurrentRange({
      count: 4,
      maxConcurrency: 2,
      label: 'test experiment',
      async map(index, signal) {
        calls.push(index)
        if (index === 0) {
          await delay(1)
          throw failure
        }
        activeSignal = signal
        await new Promise<void>((resolve) =>
          signal.addEventListener('abort', () => resolve(), { once: true }),
        )
        activeSettled = true
        return index
      },
    })

    await expect(run).rejects.toBe(failure)
    expect(activeSettled).toBe(true)
    expect(activeSignal?.aborted).toBe(true)
    expect(calls).toEqual([0, 1])
  })

  it('rejects invalid counts and concurrency', async () => {
    await expect(
      mapConcurrentRange({
        count: -1,
        maxConcurrency: 1,
        label: 'test experiment',
        async map(index) {
          return index
        },
      }),
    ).rejects.toThrow(/count must be a non-negative integer/)
    await expect(
      mapConcurrentRange({
        count: 1,
        maxConcurrency: 0,
        label: 'test experiment',
        async map(index) {
          return index
        },
      }),
    ).rejects.toThrow(/maxConcurrency must be a positive integer/)
  })
})
