import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { mapPairedConcurrent } from './concurrent-map'

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
