import { describe, expect, it } from 'vitest'
import { minimumPairsForPairedDeltaTest, pairedDeltaTest } from '../src/paired-delta-test'

describe('pairedDeltaTest', () => {
  it('uses the exact sign test below the bootstrap minimum', () => {
    const result = pairedDeltaTest(new Array(6).fill(0.2), new Array(6).fill(0.8))
    expect(result).toMatchObject({
      method: 'exact-sign',
      minimumPairs: 6,
      sufficient: true,
      significant: true,
    })
    expect(result.pValue).toBeCloseTo(1 / 64, 12)
    expect(result.bootstrap.gateEligible).toBe(false)
  })

  it('refuses a sample too small to reach the requested confidence', () => {
    const result = pairedDeltaTest(new Array(5).fill(0.2), new Array(5).fill(0.8))
    expect(result).toMatchObject({
      method: 'exact-sign',
      minimumPairs: 6,
      sufficient: false,
      significant: false,
    })
  })

  it('does not turn mixed-sign noise into a small-sample improvement', () => {
    const result = pairedDeltaTest(new Array(8).fill(0.5), [0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4])
    expect(result.method).toBe('exact-sign')
    expect(result.significant).toBe(false)
  })

  it('applies the threshold before the exact directional test', () => {
    const result = pairedDeltaTest(new Array(6).fill(0.5), new Array(6).fill(0.55), {
      threshold: 0.1,
    })
    expect(result.significant).toBe(false)
  })

  it('uses the bootstrap interval at 20 pairs', () => {
    const result = pairedDeltaTest(new Array(20).fill(0.2), new Array(20).fill(0.8))
    expect(result).toMatchObject({
      method: 'bootstrap-ci',
      sufficient: true,
      significant: true,
    })
    expect(result.pValue).toBeNull()
    expect(result.bootstrap.gateEligible).toBe(true)
  })

  it('derives the exact-test minimum from confidence', () => {
    expect(minimumPairsForPairedDeltaTest(0.95)).toBe(6)
    expect(minimumPairsForPairedDeltaTest(0.99)).toBe(8)
  })
})
