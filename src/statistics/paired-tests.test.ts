import { describe, expect, it } from 'vitest'
import {
  DECISION_PAIRED_DELTA_STATISTIC,
  pairedBootstrap,
  pairedDeltaTieFraction,
  pairedSignTest,
  pairedTTest,
} from './index'

describe('pairedTTest', () => {
  it('rejects unequal sample sizes — regression: silent truncation gives wrong df', () => {
    expect(() => pairedTTest([1, 2], [3])).toThrow(/unequal/)
  })

  it('returns p=1 when means are identical', () => {
    const r = pairedTTest([1, 2, 3, 4, 5], [1, 2, 3, 4, 5])
    expect(r.p).toBe(1)
    expect(r.t).toBe(0)
  })

  it('detects a consistent positive shift as significant', () => {
    // Add a constant +2 to every sample
    const before = [0.4, 0.5, 0.6, 0.7, 0.8, 0.5, 0.6, 0.7]
    const after = before.map((b) => b + 0.2)
    const r = pairedTTest(before, after)
    expect(r.t).toBeGreaterThan(0)
    expect(r.p).toBeLessThan(0.01)
    expect(r.df).toBe(before.length - 1)
  })

  it('does not falsely detect random noise', () => {
    const before = [0.5, 0.6, 0.4, 0.7, 0.5, 0.6]
    const after = [0.6, 0.5, 0.5, 0.6, 0.5, 0.55]
    const r = pairedTTest(before, after)
    expect(r.p).toBeGreaterThan(0.05)
  })
})

describe('pairedBootstrap', () => {
  it('throws on unequal sample sizes — silent truncation hides bugs', () => {
    expect(() => pairedBootstrap([1, 2], [3])).toThrow(/unequal/)
  })

  it('returns the singleton on n=1', () => {
    const r = pairedBootstrap([0.5], [0.7], { seed: 42 })
    expect(r.n).toBe(1)
    expect(r.median).toBeCloseTo(0.2, 6)
    expect(r.low).toBeCloseTo(0.2, 6)
    expect(r.high).toBeCloseTo(0.2, 6)
  })

  it('returns zero on empty input rather than NaN', () => {
    const r = pairedBootstrap([], [])
    expect(r.n).toBe(0)
    expect(r.median).toBe(0)
    expect(r.low).toBe(0)
    expect(r.high).toBe(0)
  })

  it('produces a positive lower bound when after >> before', () => {
    const before = [0.1, 0.2, 0.15, 0.25, 0.18, 0.22, 0.19, 0.21]
    const after = before.map((b) => b + 0.3)
    const r = pairedBootstrap(before, after, { seed: 42, resamples: 1000 })
    expect(r.median).toBeCloseTo(0.3, 4)
    expect(r.low).toBeGreaterThan(0)
    expect(r.high).toBeGreaterThan(r.low)
  })

  it('CI straddles zero when there is no real shift', () => {
    const before = [0.5, 0.4, 0.6, 0.55, 0.45, 0.5, 0.6, 0.4]
    const after = [0.5, 0.4, 0.6, 0.55, 0.45, 0.5, 0.6, 0.4]
    const r = pairedBootstrap(before, after, { seed: 42, resamples: 1000 })
    expect(r.median).toBe(0)
    expect(r.low).toBeLessThanOrEqual(0)
    expect(r.high).toBeGreaterThanOrEqual(0)
  })

  it('is deterministic given a seed', () => {
    const before = [0.3, 0.4, 0.5, 0.6, 0.4, 0.5]
    const after = [0.5, 0.5, 0.6, 0.7, 0.5, 0.55]
    const a = pairedBootstrap(before, after, { seed: 1234, resamples: 500 })
    const b = pairedBootstrap(before, after, { seed: 1234, resamples: 500 })
    expect(a.low).toBe(b.low)
    expect(a.high).toBe(b.high)
  })

  it('rejects out-of-range confidence', () => {
    expect(() => pairedBootstrap([1], [2], { confidence: 0 })).toThrow()
    expect(() => pairedBootstrap([1], [2], { confidence: 1 })).toThrow()
  })

  it('mean statistic agrees with arithmetic mean of deltas in expectation', () => {
    const before = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8]
    const after = before.map((b) => b + 0.25)
    const r = pairedBootstrap(before, after, { seed: 7, resamples: 2000, statistic: 'mean' })
    expect(r.mean).toBeCloseTo(0.25, 4)
    expect(r.low).toBeGreaterThan(0)
  })
})

describe('pairedSignTest — exact one-sided paired differences', () => {
  it('returns p = 0.25 for two positive differences', () => {
    const result = pairedSignTest([1, 0.5], 'greater')
    expect(result).toEqual({
      n: 2,
      positive: 2,
      negative: 0,
      ties: 0,
      nNonTies: 2,
      alternative: 'greater',
      pValue: 0.25,
    })
  })

  it('ignores zero ties in the binomial denominator', () => {
    const result = pairedSignTest([1, 0], 'greater')
    expect(result.nNonTies).toBe(1)
    expect(result.ties).toBe(1)
    expect(result.pValue).toBe(0.5)
  })

  it('returns p = 1 when every difference is tied', () => {
    const result = pairedSignTest([0, -0, 0], 'greater')
    expect(result.nNonTies).toBe(0)
    expect(result.ties).toBe(3)
    expect(result.pValue).toBe(1)
  })

  it('supports the opposite pre-registered direction', () => {
    expect(pairedSignTest([1, 0.5], 'less').pValue).toBe(1)
    expect(pairedSignTest([-1, -0.5], 'less').pValue).toBe(0.25)
  })

  it('matches a multi-term exact binomial tail without combinatorial overflow', () => {
    const result = pairedSignTest([1, 1, 1, -1], 'greater')
    expect(result.pValue).toBeCloseTo(5 / 16, 15)
  })

  it('is symmetric under sign reversal and direction reversal', () => {
    const differences = [1, -0.5, 0, 2, 3, -4]
    const greater = pairedSignTest(differences, 'greater')
    const reflected = pairedSignTest(
      differences.map((difference) => -difference),
      'less',
    )
    expect(reflected.pValue).toBeCloseTo(greater.pValue, 15)
    expect(reflected.positive).toBe(greater.negative)
    expect(reflected.negative).toBe(greater.positive)
    expect(reflected.ties).toBe(greater.ties)
  })

  it('rejects non-finite differences and invalid directions', () => {
    expect(() => pairedSignTest([1, Number.NaN], 'greater')).toThrow(/index 1.*finite/)
    expect(() => pairedSignTest([Number.POSITIVE_INFINITY], 'less')).toThrow(/finite/)
    expect(() => pairedSignTest([1], 'two-sided' as 'greater')).toThrow(/alternative/)
  })
})

describe('bootstrap intervals declare where they are not a gate', () => {
  it('marks fewer than 20 pairs as descriptive spread', () => {
    const before = Array.from({ length: 10 }, (_, i) => i / 10)
    const after = before.map((v) => v + 0.05)
    expect(pairedBootstrap(before, after, { seed: 1 }).gateEligible).toBe(false)
  })

  it('marks 20 or more pairs as gate-eligible', () => {
    const before = Array.from({ length: 20 }, (_, i) => i / 20)
    const after = before.map((v) => v + 0.05)
    expect(pairedBootstrap(before, after, { seed: 1 }).gateEligible).toBe(true)
  })

  it('reports gateEligible on the degenerate short paths too', () => {
    expect(pairedBootstrap([], []).gateEligible).toBe(false)
    expect(pairedBootstrap([1], [2]).gateEligible).toBe(false)
  })
})

/**
 * The load-bearing statistical core of the promotion gate: `pairedBootstrap`
 * returns a CI on the paired (after − before) delta, and the gate ships ONLY
 * when `low > threshold`. These pin the decisions the whole "trustworthy gate"
 * claim rests on — a clear gain is significant, noise is not, a regression is
 * caught, degenerate n is not laundered into false significance, and mismatched
 * data fails loud. Deterministic under a fixed seed (no bare Math.random()).
 */
describe('pairedBootstrap — promotion-gate CI core', () => {
  it('a clear, consistent paired gain has CI.low > 0 (gate would SHIP)', () => {
    const before = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    const after = [0.8, 0.8, 0.8, 0.8, 0.8, 0.8] // +0.3 every pair
    const r = pairedBootstrap(before, after, { seed: 1337 })
    expect(r.n).toBe(6)
    expect(r.median).toBeCloseTo(0.3, 6)
    expect(r.low).toBeGreaterThan(0) // CI lower bound positive ⇒ real gain
    expect(r.low).toBeCloseTo(0.3, 6) // identical deltas ⇒ CI collapses to 0.3
  })

  it('pure noise (mixed-sign deltas, median 0) has a CI spanning 0 (gate would HOLD)', () => {
    const before = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    const after = [0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4] // deltas ±0.1
    const r = pairedBootstrap(before, after, { seed: 1337 })
    expect(r.low).toBeLessThanOrEqual(0)
    expect(r.high).toBeGreaterThanOrEqual(0) // brackets 0 ⇒ not significant
  })

  it('a consistent REGRESSION has CI.high < 0 (gate would HOLD / revert)', () => {
    const before = [0.8, 0.8, 0.8, 0.8, 0.8]
    const after = [0.5, 0.5, 0.5, 0.5, 0.5] // −0.3 every pair
    const r = pairedBootstrap(before, after, { seed: 1337 })
    expect(r.high).toBeLessThan(0)
  })

  it('n=1 is degenerate: low === high === the single delta (no laundered significance)', () => {
    const r = pairedBootstrap([0.5], [0.9], { seed: 1337 })
    expect(r.n).toBe(1)
    expect(r.low).toBeCloseTo(0.4, 6)
    expect(r.high).toBeCloseTo(0.4, 6)
  })

  it('throws on unequal sample sizes (fail-loud, never pairs mismatched data)', () => {
    expect(() => pairedBootstrap([1, 2, 3], [1, 2])).toThrow(/unequal sample sizes/)
  })

  it('throws on an out-of-range confidence (fail-loud)', () => {
    expect(() => pairedBootstrap([1, 2], [2, 3], { confidence: 1.5 })).toThrow(/confidence/)
  })

  it('is deterministic under a fixed seed (gate verdicts must be reproducible)', () => {
    const before = [0.5, 0.55, 0.6, 0.52, 0.58, 0.5]
    const after = [0.7, 0.72, 0.8, 0.71, 0.79, 0.7]
    expect(pairedBootstrap(before, after, { seed: 42 })).toEqual(
      pairedBootstrap(before, after, { seed: 42 }),
    )
  })
})

describe('pairedDeltaTieFraction + DECISION_PAIRED_DELTA_STATISTIC', () => {
  it('counts exact ties', () => {
    expect(pairedDeltaTieFraction([1, 1, 0, 1], [1, 0, 0, 1])).toBe(0.75)
    expect(pairedDeltaTieFraction([], [])).toBe(0)
    expect(() => pairedDeltaTieFraction([1, 2], [1])).toThrow(/unequal sample sizes/)
  })

  it('is the MEAN, and every shape below is why', () => {
    expect(DECISION_PAIRED_DELTA_STATISTIC).toBe('mean')
  })

  /** Each case: the median CI cannot see the effect, the mean CI can. These are
   *  the measured shapes, not hypotheticals — the reason the decision statistic
   *  is a constant and not a tie-fraction heuristic. */
  const blind = (before: number[], after: number[]) => {
    const med = pairedBootstrap(before, after, { statistic: 'median', seed: 1337 })
    const avg = pairedBootstrap(before, after, { statistic: 'mean', seed: 1337 })
    return { med, avg, tieFraction: pairedDeltaTieFraction(before, after) }
  }

  it('pass/fail on {0,1}: median CI [0,0], mean CI excludes 0', () => {
    const before = [...Array(15).fill(0), ...Array(5).fill(1), ...Array(56).fill(1)]
    const after = [...Array(15).fill(1), ...Array(5).fill(0), ...Array(56).fill(1)]
    const { med, avg } = blind(before, after)
    expect([med.low, med.high]).toEqual([0, 0])
    expect(avg.low).toBeGreaterThan(0)
  })

  it('the same pass/fail data on 0-100: identical blindness, one encoding over', () => {
    const before = [...Array(15).fill(0), ...Array(5).fill(100), ...Array(56).fill(100)]
    const after = [...Array(15).fill(100), ...Array(5).fill(0), ...Array(56).fill(100)]
    const { med, avg } = blind(before, after)
    expect([med.low, med.high]).toEqual([0, 0])
    expect(avg.low).toBeGreaterThan(0)
  })

  it('one partial-credit pair does not un-blind the median', () => {
    const before = [...Array(15).fill(0), ...Array(5).fill(1), ...Array(56).fill(1), 0.5]
    const after = [...Array(15).fill(1), ...Array(5).fill(0), ...Array(56).fill(1), 0.5]
    const { med, avg } = blind(before, after)
    expect([med.low, med.high]).toEqual([0, 0])
    expect(avg.low).toBeGreaterThan(0)
  })

  it('asymmetric arms (pass/fail vs partial credit): median CI [0,0] on a −15.8pp drop', () => {
    const before = [...Array(20).fill(1), ...Array(56).fill(1)]
    const after = [...Array(20).fill(0.4), ...Array(56).fill(1)]
    const { med, avg } = blind(before, after)
    expect([med.low, med.high]).toEqual([0, 0])
    expect(avg.high).toBeLessThan(0)
  })

  it('LOW-CARDINALITY lattice at only 23% ties: median lower bound pins to 0 on a real +12.8pp lift', () => {
    // 26 blocks of 3 pass/fail leaves, scored as the block mean ⇒ scores in
    // {2/3, 1}: 15 blocks up, 5 down, 6 tied. This is the case a tie-fraction
    // cutoff misses — the median is not pinned by ties, it is pinned by the
    // lattice its bootstrap percentiles land on.
    const third = 1 / 3
    const before = [...Array(15).fill(2 / 3), ...Array(5).fill(1), ...Array(6).fill(1)]
    const after = [...Array(15).fill(1), ...Array(5).fill(2 / 3), ...Array(6).fill(1)]
    const { med, avg, tieFraction } = blind(before, after)
    expect(tieFraction).toBeCloseTo(6 / 26, 12)
    expect(med.median).toBeCloseTo(third, 12)
    expect(med.low).toBe(0) // ⇒ `low > 0` is false ⇒ a real lift refused
    expect(avg.mean).toBeCloseTo(10 / 3 / 26, 12)
    expect(avg.low).toBeGreaterThan(0) // the mean sees it
  })

  it('genuinely continuous data: both statistics see the same clear gain', () => {
    const before = [0.5, 0.55, 0.6, 0.52, 0.58, 0.51, 0.49, 0.53]
    const after = [0.7, 0.72, 0.8, 0.71, 0.79, 0.7, 0.68, 0.74]
    const { med, avg } = blind(before, after)
    expect(med.low).toBeGreaterThan(0)
    expect(avg.low).toBeGreaterThan(0)
  })
})
