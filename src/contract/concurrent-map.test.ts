import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { mapConcurrent, mapPairedConcurrent } from './concurrent-map'

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

  it('settles active work and stops dispatch after caller cancellation', async () => {
    const controller = new AbortController()
    const reason = new Error('cancelled during execution')
    const calls: number[] = []
    let settled = 0
    const run = mapConcurrent({
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

  it('stops dispatch and settles active work after the first failure', async () => {
    const failure = new Error('first cell failed')
    const calls: number[] = []
    let activeSettled = false
    let activeSignal: AbortSignal | undefined

    const run = mapConcurrent({
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
        await Promise.race([
          delay(50),
          new Promise<void>((resolve) =>
            signal?.addEventListener('abort', () => resolve(), { once: true }),
          ),
        ])
        activeSettled = true
        return index
      },
    })

    await expect(run).rejects.toBe(failure)
    const settledWhenRejected = activeSettled
    await delay(75)

    expect(settledWhenRejected).toBe(true)
    expect(activeSignal?.aborted).toBe(true)
    expect(calls).toEqual([0, 1])
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

describe('mapPairedConcurrent', () => {
  it('preserves pair order while bounding individual executions', async () => {
    let active = 0
    let maximumActive = 0
    const result = await mapPairedConcurrent({
      count: 3,
      maxConcurrency: 2,
      label: 'paired experiment',
      async map(index, arm) {
        active += 1
        maximumActive = Math.max(maximumActive, active)
        await delay(1)
        active -= 1
        return `${arm}:${index}`
      },
    })

    expect(result).toEqual([
      { baseline: 'baseline:0', candidate: 'candidate:0' },
      { baseline: 'baseline:1', candidate: 'candidate:1' },
      { baseline: 'baseline:2', candidate: 'candidate:2' },
    ])
    expect(maximumActive).toBe(2)
  })

  it('rejects invalid pair counts before scheduling', async () => {
    await expect(
      mapPairedConcurrent({
        count: 0.5,
        maxConcurrency: 1,
        label: 'paired experiment',
        async map(index) {
          return index
        },
      }),
    ).rejects.toThrow(/pair count must be a non-negative integer/)
  })
})
