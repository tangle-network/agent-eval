import { describe, expect, it } from 'vitest'
import { minimumPairsForPairedDeltaTest, pairedDeltaTest } from '../src/paired-delta-test'

describe('pairedDeltaTest', () => {
  it('uses the exact sign test below the bootstrap minimum', () => {
    // Deltas must not be IDENTICAL: n identical deltas give a zero-width
    // interval, which is refused whatever the sign test says (see the
    // zero-width case below). All six still improve, so the sign test is the
    // thing under measurement here.
    const result = pairedDeltaTest(
      [0.2, 0.2, 0.2, 0.2, 0.2, 0.2],
      [0.8, 0.75, 0.82, 0.79, 0.85, 0.77],
    )
    expect(result).toMatchObject({
      method: 'exact-sign',
      minimumPairs: 6,
      sufficient: true,
      indeterminate: false,
      significant: true,
    })
    expect(result.pValue).toBeCloseTo(1 / 64, 12)
    expect(result.bootstrap.gateEligible).toBe(false)
  })

  it('refuses a zero-width interval on BOTH paths, however positive the deltas', () => {
    // n identical deltas make every resample identical, so the interval is a
    // point and says nothing about how far the estimate could be wrong. Under a
    // bounded asymmetric null whose true mean paired delta is exactly 0, every
    // sample that misses the rare drop has this shape — deciding on `low >
    // threshold` promoted 88.20% of them at n=6 and 65.65% at n=20 against a
    // nominal 5%. The exact-sign path is not exempt: it tests the MEDIAN, which
    // is not the parameter a mean threshold is about.
    for (const n of [6, 20]) {
      const result = pairedDeltaTest(new Array(n).fill(0.2), new Array(n).fill(0.8))
      expect(result.bootstrap.low, `n=${n}`).toBe(result.bootstrap.high)
      expect(result.indeterminate, `n=${n}`).toBe(true)
      expect(result.significant, `n=${n}`).toBe(false)
    }
    // And at a NEGATIVE threshold, where an all-tie [0,0] would otherwise clear.
    const tied = pairedDeltaTest(new Array(20).fill(0.5), new Array(20).fill(0.5), {
      threshold: -0.05,
    })
    expect(tied.bootstrap.low).toBe(0)
    expect(tied.indeterminate).toBe(true)
    expect(tied.significant).toBe(false)
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
    // Real spread, so the interval has width and the bootstrap arm is what is
    // under measurement (identical deltas are covered by the zero-width case).
    const result = pairedDeltaTest(
      new Array(20).fill(0.2),
      Array.from({ length: 20 }, (_, i) => 0.8 + (i % 4) * 0.02),
    )
    expect(result).toMatchObject({
      method: 'bootstrap-ci',
      sufficient: true,
      indeterminate: false,
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
