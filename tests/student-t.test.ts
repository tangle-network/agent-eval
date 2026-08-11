import { describe, expect, it } from 'vitest'
import { studentTCdf } from '../src/math/student-t'
import { pairedTTest } from '../src/statistics'

// ── Statistics integrity regressions ─────────────────────────────────
//
// Every assertion below fails on the shipped 0.1.0–0.133.0 implementation.
// Reference values are `scipy 1.13.1` and, for the tie-conditioned exact
// nulls that no library computes, an independent brute-force enumeration of
// every split / sign pattern.

describe('incompleteBeta symmetry branch — Student-t near t = 0', () => {
  // The Lentz continued fraction converges only for x < (a+1)/(a+b+2).
  // studentTCdf drives x → 1 as |t| → 0, so without the mirrored branch the
  // near-null region is evaluated outside the convergence domain and a
  // perfectly null paired result reports p < 0.05.
  const CASES: Array<{ t: number; df: number; cdf: number }> = [
    { t: 0.005, df: 100, cdf: 0.5019897225612608 },
    { t: 0.001, df: 7, cdf: 0.5003849913775006 },
    { t: 1e-6, df: 7, cdf: 0.5000003849914508 },
    { t: 1e-6, df: 100, cdf: 0.5000003979461869 },
    { t: 0.02, df: 3, cdf: 0.5073503985905194 },
    { t: 0.058, df: 100, cdf: 0.5230678155462486 },
    { t: 0.5, df: 2, cdf: 0.6666666666666667 },
    { t: 2.0, df: 7, cdf: 0.9571903357185121 },
    { t: -2.0, df: 7, cdf: 0.04280966428148798 },
    { t: 3.5, df: 12, cdf: 0.9978090652841259 },
    { t: 1.96, df: 60, cdf: 0.9726775351317354 },
    { t: 10, df: 5, cdf: 0.9999145262121285 },
  ]

  for (const { t, df, cdf } of CASES) {
    it(`matches scipy.stats.t.cdf at t=${t}, df=${df}`, () => {
      // 9 decimals, not more: at t = 1e-6, df = 100 the parametrisation
      // x = df/(df + t²) is 1 − 1e-14, so `1 − x` in the mirrored branch
      // costs ~14 digits to float64 cancellation. That floor is the input
      // encoding, not the approximation.
      expect(studentTCdf(t, df)).toBeCloseTo(cdf, 9)
    })
  }

  it('keeps the true Student-t tail above 100 degrees of freedom', () => {
    expect(2 * (1 - studentTCdf(1.98, 102))).toBeCloseTo(0.05039751399722791, 12)
  })

  it('reports a near-null paired shift as near-null, not significant', () => {
    // Deltas average 1e-6 of their own spread: p must be ≈ 1, not < 0.05.
    const before = [0, 1, 2, 3, 4, 5, 6, 7]
    const after = before.map((v, i) => v + (i % 2 === 0 ? 1e-6 : -1e-6) + 1e-12)
    const r = pairedTTest(before, after)
    expect(r.p).not.toBeNull()
    expect(r.p!).toBeGreaterThan(0.9)
  })

  it('is monotone in |t| across the previously discontinuous band', () => {
    const ts = [1e-7, 1e-5, 1e-3, 0.01, 0.05, 0.1, 0.5, 1, 2, 4]
    let previous = Number.POSITIVE_INFINITY
    for (const t of ts) {
      const p = 2 * (1 - studentTCdf(t, 7))
      expect(p).toBeLessThanOrEqual(previous + 1e-12)
      previous = p
    }
  })
})
