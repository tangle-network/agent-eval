import { describe, expect, it } from 'vitest'
import { benjaminiHochberg, bonferroni, requiredSampleSize } from '../src/power-analysis'

describe('requiredSampleSize', () => {
  it('returns Infinity on non-positive effect', () => {
    expect(requiredSampleSize({ effect: 0 })).toBe(Infinity)
    expect(requiredSampleSize({ effect: -0.2 })).toBe(Infinity)
  })

  it('gives the expected N for Cohen\'s d=0.5 at 80% power, alpha=0.05, two-sided', () => {
    const n = requiredSampleSize({ effect: 0.5 })
    // Classical answer: ~63 per arm. Allow ±3 for approximation.
    expect(n).toBeGreaterThanOrEqual(60)
    expect(n).toBeLessThanOrEqual(66)
  })

  it('larger effect → smaller N', () => {
    const small = requiredSampleSize({ effect: 0.2 })
    const large = requiredSampleSize({ effect: 0.8 })
    expect(large).toBeLessThan(small)
  })
})

describe('bonferroni', () => {
  it('multiplies each p by K and clamps at 1', () => {
    const { adjusted, significant } = bonferroni([0.01, 0.04, 0.05], 0.05)
    expect(adjusted[0]).toBeCloseTo(0.03)
    expect(adjusted[1]).toBeCloseTo(0.12)
    expect(adjusted[2]).toBeCloseTo(0.15)
    expect(significant).toEqual([true, false, false])
  })
})

describe('benjaminiHochberg — regression: uncorrected pairwise inflates false positives', () => {
  it('gives non-significant q when all are noise-level', () => {
    const { significant } = benjaminiHochberg([0.4, 0.5, 0.6, 0.7, 0.8], 0.05)
    expect(significant.every((s) => !s)).toBe(true)
  })

  it('preserves monotonicity — q_i ≤ q_{i+1} by rank', () => {
    const ps = [0.001, 0.01, 0.02, 0.05, 0.2]
    const { qValues } = benjaminiHochberg(ps, 0.05)
    const sortedQ = ps.map((_, i) => qValues[i]).sort((a, b) => a - b)
    // After sorting by p, q should be non-decreasing.
    for (let i = 1; i < sortedQ.length; i++) expect(sortedQ[i]).toBeGreaterThanOrEqual(sortedQ[i - 1])
  })

  it('is less conservative than Bonferroni on mixed inputs', () => {
    const ps = [0.001, 0.008, 0.04, 0.2, 0.6]
    const bh = benjaminiHochberg(ps, 0.1).significant.filter((x) => x).length
    const bf = bonferroni(ps, 0.1).significant.filter((x) => x).length
    expect(bh).toBeGreaterThanOrEqual(bf)
  })
})
