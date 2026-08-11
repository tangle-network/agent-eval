import { describe, expect, it } from 'vitest'
import {
  isBinaryOutcomeVector,
  mcnemar,
  pairedBinaryScale,
  pairedBootstrap,
  pairedRiskDifference,
  pairedRiskDifferenceExact,
  passAtK,
  wilson,
} from './index'

describe('wilson — binomial proportion CI', () => {
  it('matches the textbook interval for 8/10 at 95%', () => {
    const { estimate, lower, upper } = wilson(8, 10)
    expect(estimate).toBeCloseTo(0.8, 10)
    expect(lower).toBeCloseTo(0.4901, 3) // canonical Wilson value
    expect(upper).toBeCloseTo(0.9433, 3)
  })

  it('never escapes [0,1] at the boundary (10/10 upper clamps to 1)', () => {
    const { estimate, lower, upper } = wilson(10, 10)
    expect(estimate).toBe(1)
    expect(upper).toBe(1) // Wald would give >1
    expect(lower).toBeGreaterThan(0)
    expect(lower).toBeLessThan(1)
  })

  it('0/n is a one-sided interval anchored at 0', () => {
    const { estimate, lower, upper } = wilson(0, 10)
    expect(estimate).toBe(0)
    expect(lower).toBe(0)
    expect(upper).toBeGreaterThan(0)
    expect(upper).toBeLessThan(1)
  })

  it('n = 0 ⇒ degenerate zeros (no division by zero)', () => {
    expect(wilson(0, 0)).toEqual({ estimate: 0, lower: 0, upper: 0 })
  })

  it('a wider interval at smaller n for the same proportion', () => {
    const small = wilson(4, 5)
    const large = wilson(80, 100)
    expect(small.estimate).toBeCloseTo(large.estimate, 10)
    expect(small.upper - small.lower).toBeGreaterThan(large.upper - large.lower)
  })

  it('throws when successes is out of range', () => {
    expect(() => wilson(11, 10)).toThrow(/must be in/)
    expect(() => wilson(-1, 10)).toThrow(/must be in/)
  })
})

describe('mcnemar — paired-binary significance (exact)', () => {
  // control first; entries are 0/1 (or boolean).
  it('a strong, one-directional shift is significant (exact doubled binomial tail)', () => {
    // 10 pairs where treatment newly succeeds, 0 the other way → p = 2·0.5^10.
    const control = Array(10).fill(0).concat(Array(20).fill(1))
    const treatment = Array(10).fill(1).concat(Array(20).fill(1))
    const r = mcnemar(control, treatment)
    expect(r.b).toBe(10)
    expect(r.c).toBe(0)
    expect(r.nDiscordant).toBe(10)
    expect(r.pValue).toBeCloseTo(2 * 0.5 ** 10, 10) // 0.001953125
    expect(r.pValue).toBeLessThan(0.05)
  })

  it('symmetric discordance is non-significant (p clamps at 1)', () => {
    const control = [0, 0, 0, 0, 1, 1, 1, 1]
    const treatment = [1, 1, 1, 1, 0, 0, 0, 0] // b = c = 4
    const r = mcnemar(control, treatment)
    expect(r.b).toBe(4)
    expect(r.c).toBe(4)
    expect(r.pValue).toBe(1)
  })

  it('reproduces a known small-sample exact p-value (b=12, c=2)', () => {
    const control = Array(12).fill(0).concat(Array(2).fill(1))
    const treatment = Array(12).fill(1).concat(Array(2).fill(0))
    const r = mcnemar(control, treatment)
    // 2·(C(14,0)+C(14,1)+C(14,2))/2^14 = 2·106/16384
    expect(r.pValue).toBeCloseTo((2 * 106) / 16384, 10)
    expect(r.pValue).toBeLessThan(0.05)
  })

  it('no discordant pairs ⇒ no evidence ⇒ p = 1', () => {
    const control = [0, 1, 0, 1, 1]
    const treatment = [0, 1, 0, 1, 1] // all concordant
    const r = mcnemar(control, treatment)
    expect(r.nDiscordant).toBe(0)
    expect(r.statistic).toBe(0)
    expect(r.pValue).toBe(1)
  })

  it('accepts booleans and counts direction correctly', () => {
    const control = [false, false, true]
    const treatment = [true, true, false]
    const r = mcnemar(control, treatment)
    expect(r.b).toBe(2) // false→true
    expect(r.c).toBe(1) // true→false
  })

  it('throws on unequal lengths', () => {
    expect(() => mcnemar([0, 1], [0])).toThrow(/unequal sample sizes/)
  })
})

describe('pairedRiskDifference — paired-binary effect size + CI', () => {
  it('rate change equals (b − c)/n and the CI brackets it', () => {
    const control = [0, 0, 0, 0, 0, 1, 1, 1, 1, 1]
    const treatment = [1, 1, 1, 0, 0, 1, 1, 1, 1, 1] // b=3 (0→1), c=0
    const r = pairedRiskDifference(control, treatment)
    expect(r.b).toBe(3)
    expect(r.c).toBe(0)
    expect(r.riskDifference).toBeCloseTo(0.3, 10)
    expect(r.lower).toBeLessThanOrEqual(r.riskDifference)
    expect(r.upper).toBeGreaterThanOrEqual(r.riskDifference)
  })

  it('symmetric discordance ⇒ rd 0 and a CI bracketing 0', () => {
    const control = [0, 0, 1, 1]
    const treatment = [1, 1, 0, 0] // b=c=2
    const r = pairedRiskDifference(control, treatment)
    expect(r.riskDifference).toBe(0)
    expect(r.lower).toBeLessThanOrEqual(0)
    expect(r.upper).toBeGreaterThanOrEqual(0)
  })

  it('all-win is rd 1 with a degenerate (zero-width) interval, clamped to [-1,1]', () => {
    const control = Array(10).fill(0)
    const treatment = Array(10).fill(1)
    const r = pairedRiskDifference(control, treatment)
    expect(r.riskDifference).toBe(1)
    expect(r.lower).toBe(1)
    expect(r.upper).toBe(1)
  })

  it('n = 0 ⇒ degenerate zeros', () => {
    const r = pairedRiskDifference([], [])
    expect(r).toMatchObject({ n: 0, b: 0, c: 0, riskDifference: 0, lower: 0, upper: 0 })
  })

  it('throws on unequal lengths', () => {
    expect(() => pairedRiskDifference([0, 1, 1], [0, 1])).toThrow(/unequal sample sizes/)
  })
})

describe('pairedRiskDifferenceExact — the interval a gate may decide on', () => {
  /** b treatment-wins, c control-wins, `ties` concordant pairs. */
  const arms = (b: number, c: number, ties: number) => {
    const control: number[] = []
    const treatment: number[] = []
    for (let i = 0; i < b; i++) {
      control.push(0)
      treatment.push(1)
    }
    for (let i = 0; i < c; i++) {
      control.push(1)
      treatment.push(0)
    }
    for (let i = 0; i < ties; i++) {
      control.push(1)
      treatment.push(1)
    }
    return { control, treatment }
  }

  it('matches the closed-form Clopper-Pearson bound (Beta(2,1) ⇒ √0.025)', () => {
    // b=2 of m=2 discordant: the exact lower bound on π is qbeta(0.025, 2, 1),
    // and Beta(2,1)'s CDF is x², so the bound is exactly √0.025 = 0.1581139.
    // RD = (2π − 1)·m/n with m=2, n=3.
    const { control, treatment } = arms(2, 0, 1)
    const r = pairedRiskDifferenceExact(control, treatment, 0.95)
    expect(r.riskDifference).toBeCloseTo(2 / 3, 12)
    expect(r.lower).toBeCloseTo((2 * Math.sqrt(0.025) - 1) * (2 / 3), 5)
    expect(r.upper).toBeCloseTo(2 / 3, 12)
  })

  it('DOES NOT exclude 0 where the Wald interval does — the small-n undercoverage', () => {
    const { control, treatment } = arms(2, 0, 1)
    expect(pairedRiskDifference(control, treatment, 0.95).lower).toBeGreaterThan(0)
    expect(pairedRiskDifferenceExact(control, treatment, 0.95).lower).toBeLessThan(0)
    expect(pairedRiskDifferenceExact(control, treatment, 0.95).pValue).toBeCloseTo(0.5, 12)
  })

  it("is DUAL to McNemar's exact test over every shape up to 25×25", () => {
    // The property a promotion gate rests on: the interval excludes 0 exactly
    // when the exact test rejects, so a gate keyed on `lower > 0` can never
    // promote what the exact test refuses — at any confidence level.
    let checked = 0
    for (const confidence of [0.8, 0.9, 0.95, 0.99]) {
      const alpha = 1 - confidence
      for (let b = 0; b <= 25; b++) {
        for (let c = 0; c <= 25; c++) {
          for (const ties of [0, 3, 40]) {
            const { control, treatment } = arms(b, c, ties)
            if (control.length === 0) continue
            const r = pairedRiskDifferenceExact(control, treatment, confidence)
            const rejects = mcnemar(control, treatment).pValue < alpha
            expect(r.pValue).toBe(mcnemar(control, treatment).pValue)
            expect(r.lower > 0 || r.upper < 0).toBe(rejects)
            checked++
          }
        }
      }
    }
    expect(checked).toBe(8108)
  })

  it('no discordant pairs ⇒ a degenerate [0,0] the caller must read as "cannot decide"', () => {
    const r = pairedRiskDifferenceExact([1, 1, 1, 1], [1, 1, 1, 1], 0.95)
    expect(r).toMatchObject({ nDiscordant: 0, riskDifference: 0, lower: 0, upper: 0, pValue: 1 })
  })

  it('fails loud on mismatched input', () => {
    expect(() => pairedRiskDifferenceExact([0, 1, 1], [0, 1])).toThrow(/unequal sample sizes/)
    expect(() => pairedRiskDifferenceExact([0, 1], [0, 1], 1.5)).toThrow(/confidence/)
  })
})

describe('passAtK — unbiased coding-eval estimator', () => {
  it('0 correct ⇒ 0, all correct ⇒ 1', () => {
    expect(passAtK(5, 0, 1)).toBe(0)
    expect(passAtK(5, 5, 1)).toBe(1)
  })

  it('matches the closed-form for known (n, c, k)', () => {
    expect(passAtK(10, 1, 1)).toBeCloseTo(0.1, 10)
    expect(passAtK(5, 2, 1)).toBeCloseTo(0.4, 10) // 1 − (4/5)(3/4)
    expect(passAtK(10, 3, 5)).toBeCloseTo(1 - (3 / 8) * (4 / 9) * (5 / 10), 10)
  })

  it('returns 1 when fewer than k samples could fail (n − c < k)', () => {
    expect(passAtK(5, 3, 5)).toBe(1) // n−c = 2 < 5
  })

  it('is monotonically non-decreasing in k', () => {
    const c = 2
    const n = 10
    let prev = -1
    for (let k = 1; k <= n; k++) {
      const v = passAtK(n, c, k)
      expect(v).toBeGreaterThanOrEqual(prev)
      prev = v
    }
  })

  it('throws on out-of-range or non-integer args', () => {
    expect(() => passAtK(5, 6, 1)).toThrow(/0 ≤ c ≤ n/)
    expect(() => passAtK(5, 2, 0)).toThrow(/1 ≤ k ≤ n/)
    expect(() => passAtK(5, 2, 6)).toThrow(/1 ≤ k ≤ n/)
    expect(() => passAtK(5.5, 2, 1)).toThrow(/integers/)
  })
})

describe('isBinaryOutcomeVector — the statistic discriminator', () => {
  it('accepts only vectors whose every value is exactly 0 or 1', () => {
    expect(isBinaryOutcomeVector([0, 1, 1, 0, 1])).toBe(true)
    expect(isBinaryOutcomeVector([1, 1, 1])).toBe(true)
    expect(isBinaryOutcomeVector([0, 0])).toBe(true)
    expect(isBinaryOutcomeVector([0, 1, 0.5])).toBe(false)
    expect(isBinaryOutcomeVector([0, 1, 2])).toBe(false)
    expect(isBinaryOutcomeVector([0, 1, -0.0])).toBe(true) // -0 === 0
    expect(isBinaryOutcomeVector([0, Number.NaN])).toBe(false)
  })

  it('treats an empty vector as NOT binary — no evidence of the outcome shape', () => {
    expect(isBinaryOutcomeVector([])).toBe(false)
  })

  it('names the regime where the median paired delta goes blind', () => {
    // 15 wins, 5 losses, 56 ties: a real +13.2pp shift whose median is 0.
    const before = [...Array(15).fill(0), ...Array(5).fill(1), ...Array(56).fill(1)]
    const after = [...Array(15).fill(1), ...Array(5).fill(0), ...Array(56).fill(1)]
    expect(isBinaryOutcomeVector(before) && isBinaryOutcomeVector(after)).toBe(true)
    const med = pairedBootstrap(before, after, { statistic: 'median', seed: 1337 })
    const avg = pairedBootstrap(before, after, { statistic: 'mean', seed: 1337 })
    expect(med.low).toBe(0)
    expect(med.high).toBe(0)
    expect(avg.mean).toBeCloseTo(10 / 76, 6)
    expect(avg.low).toBeGreaterThan(0)
  })
})

/**
 * The DISCRIMINATOR a gate actually needs. `isBinaryOutcomeVector` answers
 * "is this literally {0,1}", which is a strictly narrower question than "can
 * the median see this data" — and every gap between the two was a measured
 * fail-open: a 0-100 pass/fail dimension, one partial-credit score in an
 * otherwise pass/fail vector, block scores averaged from pass/fail leaves, and
 * a pass/fail baseline against a partial-credit candidate all read
 * "not binary" and fell back to the blind median.
 */
describe('pairedBinaryScale — two-point outcomes on ANY encoding', () => {
  it('returns the common positive level, whatever the encoding', () => {
    expect(pairedBinaryScale([0, 1, 1], [1, 1, 0])).toBe(1)
    expect(pairedBinaryScale([0, 100, 100], [100, 100, 0])).toBe(100)
    expect(pairedBinaryScale([0, 5], [5, 5])).toBe(5)
    expect(pairedBinaryScale([0, 0, 0], [0, 1, 0])).toBe(1) // level seen on one arm only
  })

  it('rejects anything that is not two-point at a COMMON level', () => {
    expect(pairedBinaryScale([0, 1, 0.5], [1, 1, 1])).toBeNull() // partial credit
    expect(pairedBinaryScale([0, 1], [0, 0.4])).toBeNull() // arms disagree on the level
    expect(pairedBinaryScale([2 / 3, 1], [1, 1])).toBeNull() // block scores
    expect(pairedBinaryScale([0, -1], [0, 0])).toBeNull() // negative
    expect(pairedBinaryScale([0, Number.NaN], [0, 1])).toBeNull() // unusable
    expect(pairedBinaryScale([0, 0], [0, 0])).toBeNull() // level not identified
    expect(pairedBinaryScale([], [])).toBeNull()
  })
})
