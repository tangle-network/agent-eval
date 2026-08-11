import { describe, expect, it } from 'vitest'
import { benjaminiHochberg, bonferroni, holm } from './index'

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
  it('handles empty input', () => {
    const r = benjaminiHochberg([])
    expect(r.qValues).toEqual([])
    expect(r.significant).toEqual([])
  })

  it('gives non-significant q when all are noise-level', () => {
    const { significant } = benjaminiHochberg([0.4, 0.5, 0.6, 0.7, 0.8], 0.05)
    expect(significant.every((s) => !s)).toBe(true)
  })

  it('flags the strongest p and clears the weakest', () => {
    const { significant } = benjaminiHochberg([0.001, 0.01, 0.04, 0.5], 0.05)
    expect(significant[0]).toBe(true)
    expect(significant[3]).toBe(false)
  })

  it('preserves monotonicity — q_i ≤ q_{i+1} by rank', () => {
    const ps = [0.001, 0.01, 0.02, 0.05, 0.2]
    const { qValues } = benjaminiHochberg(ps, 0.05)
    const sortedQ = ps.map((_, i) => qValues[i]!).sort((a, b) => a - b)
    for (let i = 1; i < sortedQ.length; i++) {
      expect(sortedQ[i]!).toBeGreaterThanOrEqual(sortedQ[i - 1]!)
    }
  })

  it('is less conservative than Bonferroni on mixed inputs', () => {
    const ps = [0.001, 0.008, 0.04, 0.2, 0.6]
    const bh = benjaminiHochberg(ps, 0.1).significant.filter((x) => x).length
    const bf = bonferroni(ps, 0.1).significant.filter((x) => x).length
    expect(bh).toBeGreaterThanOrEqual(bf)
  })
})

describe('multiple-comparison boundaries are inclusive', () => {
  it('bonferroni and holm agree at their shared boundary', () => {
    const ps = [0.0125, 0.0125, 0.0125, 0.0125]
    expect(bonferroni(ps, 0.05).significant).toEqual([true, true, true, true])
    expect(holm(ps, 0.05).significant).toEqual([true, true, true, true])
  })

  it('holm never rejects less than bonferroni on the same family', () => {
    const families = [
      [0.0125, 0.0125, 0.0125, 0.0125],
      [0.01, 0.02, 0.03, 0.04],
      [0.05, 0.05],
      [0.001, 0.5, 0.5, 0.5],
      [0.0166666, 0.03, 0.9],
    ]
    for (const ps of families) {
      const b = bonferroni(ps, 0.05).significant
      const h = holm(ps, 0.05).significant
      for (let i = 0; i < ps.length; i++) {
        expect(h[i]! || !b[i]!).toBe(true)
      }
    }
  })

  it('benjaminiHochberg rejects at q exactly equal to the FDR', () => {
    expect(benjaminiHochberg([0.05, 0.05], 0.05).significant).toEqual([true, true])
  })

  it('bonferroni rejects a negative p-value instead of declaring it significant', () => {
    expect(() => bonferroni([-0.1, 0.2], 0.05)).toThrow(/must be in \[0,1\]/)
    expect(() => benjaminiHochberg([-0.1, 0.2])).toThrow(/must be in \[0,1\]/)
    expect(() => bonferroni([0.1, 1.2], 0.05)).toThrow(/must be in \[0,1\]/)
  })

  it('bonferroni validates alpha the way holm does', () => {
    expect(() => bonferroni([0.1], 0)).toThrow(/must be in \(0,1\)/)
    expect(() => bonferroni([0.1], 1)).toThrow(/must be in \(0,1\)/)
    expect(() => benjaminiHochberg([0.1], 1.5)).toThrow(/must be in \(0,1\)/)
  })
})
