import { describe, expect, it } from 'vitest'
import { mapConcurrent } from './concurrency'

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
    const run = mapConcurrent([0, 1, 2, 3], 2, async (_value, index) => {
      started.push(index)
      if (started.length === 2) releaseStarted?.()
      await bothStarted
      if (index === 0) {
        await failNow
        throw firstError
      }
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
