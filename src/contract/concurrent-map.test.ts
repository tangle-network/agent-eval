import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { mapConcurrent } from './concurrent-map'

describe('mapConcurrent', () => {
  it('preserves signed-cell order while bounding active work', async () => {
    let active = 0
    let maximumActive = 0
    const result = await mapConcurrent({
      count: 6,
      maxConcurrency: 2,
      label: 'test experiment',
      async map(index) {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await delay((6 - index) * 2)
        active -= 1
        return index * 10
      },
    })

    expect(result).toEqual([0, 10, 20, 30, 40, 50])
    expect(maximumActive).toBe(2)
  })

  it('propagates cancellation before dispatching another cell', async () => {
    const controller = new AbortController()
    controller.abort(new Error('cancelled by caller'))
    let calls = 0

    await expect(
      mapConcurrent({
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

  it('rejects invalid counts and concurrency', async () => {
    await expect(
      mapConcurrent({
        count: -1,
        maxConcurrency: 1,
        label: 'test experiment',
        async map(index) {
          return index
        },
      }),
    ).rejects.toThrow(/cell count must be a non-negative integer/)
    await expect(
      mapConcurrent({
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
