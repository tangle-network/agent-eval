import { describe, expect, it } from 'vitest'
import { welchsTTest } from '../src/baseline'
import { normalCdf } from '../src/math/normal'
import { mannWhitneyU, mcnemarPower, pairedTTest, wilcoxonSignedRank } from '../src/statistics'

function unitVarianceSamples(n: number, mean = 0): number[] {
  const offset = Math.sqrt((n - 1) / n)
  return Array.from({ length: n }, (_, index) => mean + (index < n / 2 ? offset : -offset))
}

describe('normalCdf', () => {
  it('matches NIST standard normal table values', () => {
    expect(normalCdf(-3)).toBeCloseTo(0.00135, 5)
    expect(normalCdf(-1)).toBeCloseTo(0.15866, 5)
    expect(normalCdf(0)).toBe(0.5)
    expect(normalCdf(1)).toBeCloseTo(0.84134, 5)
    expect(normalCdf(1.96)).toBeCloseTo(0.975, 5)
    expect(normalCdf(3)).toBeCloseTo(0.99865, 5)
  })

  it('is symmetric across central and tail values', () => {
    for (const x of [0.1, 1, 1.96, 3, 8]) {
      expect(normalCdf(-x)).toBeCloseTo(1 - normalCdf(x), 15)
    }
  })

  it('keeps extreme tails in range', () => {
    expect(normalCdf(-Infinity)).toBe(0)
    expect(normalCdf(-8)).toBeGreaterThan(0)
    expect(normalCdf(-8)).toBeLessThan(1e-14)
    expect(normalCdf(8)).toBeGreaterThan(1 - 1e-14)
    expect(normalCdf(8)).toBeLessThan(1)
    expect(normalCdf(Infinity)).toBe(1)
  })

  it('maps z=1.96 to a two-sided p-value of approximately 0.05', () => {
    expect(2 * (1 - normalCdf(1.96))).toBeCloseTo(0.049995790296440745, 6)
  })
})

describe('public normal-approximation callers', () => {
  it('computes the Mann-Whitney tail exactly at 5 v 5, not from the normal CDF', () => {
    // Inside the enumeration threshold the CDF is not on the path at all: the
    // p is the exact conditional one, matching scipy method='exact'.
    const result = mannWhitneyU([1, 2, 3, 4, 5], [10, 11, 12, 13, 14])

    expect(result.u).toBe(0)
    expect(result.method).toBe('exact')
    expect(result.p).toBeCloseTo(0.007936507936507936, 12)
    expect(result.pFloor).toBeCloseTo(0.007936507936507936, 12)
  })

  it('computes the Wilcoxon tail exactly at n = 10, not from the normal CDF', () => {
    const result = wilcoxonSignedRank(Array<number>(10).fill(0), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10])

    expect(result.w).toBe(55)
    expect(result.method).toBe('exact')
    expect(result.p).toBeCloseTo(0.001953125, 12)
  })

  it('routes the corrected CDF into the rank-test asymptotic path above the threshold', () => {
    // The only place a rank test still consults normalCdf: an explicitly
    // requested asymptotic p outside the exact-feasible range.
    const a = Array.from({ length: 14 }, (_, index) => index + 1)
    const b = Array.from({ length: 14 }, (_, index) => index + 8)
    const result = mannWhitneyU(a, b, { method: 'asymptotic' })

    expect(result.method).toBe('asymptotic')
    // scipy.stats.mannwhitneyu(method='asymptotic', use_continuity=True).
    expect(Math.abs(result.p - 0.0007867974321958436)).toBeLessThanOrEqual(1.5e-7)
  })

  it('computes McNemar power with the corrected CDF', () => {
    expect(mcnemarPower({ p10: 0.25, p01: 0.05, nPairs: 63 })).toBeCloseTo(0.843250705551538, 6)
  })

  it('uses the Student-t tail for a paired test above 100 degrees of freedom', () => {
    const n = 102
    const result = pairedTTest(
      Array<number>(n).fill(0),
      unitVarianceSamples(n, 1.96 / Math.sqrt(n)),
    )

    expect(result.df).toBe(101)
    expect(result.t).toBeCloseTo(1.96, 12)
    expect(result.p).toBeCloseTo(0.052751249508782364, 9)
  })

  it('uses the Student-t tail for a Welch test above 100 degrees of freedom', () => {
    const n = 102
    const result = welchsTTest(
      unitVarianceSamples(n),
      unitVarianceSamples(n, 1.96 * Math.sqrt(2 / n)),
    )

    expect(result.df).toBeCloseTo(202, 12)
    expect(result.t).toBeCloseTo(1.96, 12)
    expect(result.p).toBeCloseTo(0.05137106281388464, 9)
  })
})
