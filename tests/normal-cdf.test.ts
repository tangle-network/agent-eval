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

describe('normalCdf — standard normal against published reference values', () => {
  // Abramowitz & Stegun 7.1.26 bounds erf to |ε| ≤ 1.5e-7. Φ(x) = ½(1 + erf(z))
  // halves that to 7.5e-8; a two-sided p = 2(1 − Φ) doubles it back to 1.5e-7.
  const PHI_TOL = 7.5e-8
  const P_TOL = 1.5e-7

  const twoSidedP = (z: number): number => 2 * (1 - normalCdf(z))

  // Quantiles carried to full double precision. Rounding z to 1.96 moves the
  // true p by ~4e-6 — thirty times the tolerance being asserted — so a test
  // written against rounded z cannot state a bound this tight.
  const CRITICAL: Array<{ label: string; z: number; phi: number; p: number }> = [
    { label: '80% two-sided', z: 1.2815515655446004, phi: 0.9, p: 0.2 },
    { label: '90% two-sided', z: 1.6448536269514722, phi: 0.95, p: 0.1 },
    { label: '95% two-sided', z: 1.959963984540054, phi: 0.975, p: 0.05 },
    { label: '99% two-sided', z: 2.5758293035489004, phi: 0.995, p: 0.01 },
    { label: '99.9% two-sided', z: 3.2905267314919255, phi: 0.9995, p: 0.001 },
    { label: '99.99% two-sided', z: 3.890591886413094, phi: 0.99995, p: 0.0001 },
  ]

  for (const { label, z, phi, p } of CRITICAL) {
    it(`reproduces the ${label} critical value at z=${z.toFixed(6)}`, () => {
      expect(Math.abs(normalCdf(z) - phi)).toBeLessThanOrEqual(PHI_TOL)
      expect(Math.abs(twoSidedP(z) - p)).toBeLessThanOrEqual(P_TOL)
    })
  }

  it('matches the reference CDF at the rounded z-scores quoted in tables', () => {
    // Reference values from the exact standard normal, not from this function.
    const table: Array<[z: number, p: number]> = [
      [1.645, 0.09996981147155819],
      [1.96, 0.04999579029644087],
      [2.576, 0.009995064584707569],
      [3.059, 0.002220771493670643],
    ]
    for (const [z, p] of table) {
      expect(Math.abs(twoSidedP(z) - p)).toBeLessThanOrEqual(P_TOL)
    }
  })

  it('is symmetric: Φ(−x) = 1 − Φ(x)', () => {
    for (let z = 0; z <= 6.0001; z += 0.25) {
      expect(Math.abs(normalCdf(-z) - (1 - normalCdf(z)))).toBeLessThanOrEqual(P_TOL)
    }
  })

  it('centres at Φ(0) = 0.5', () => {
    expect(Math.abs(normalCdf(0) - 0.5)).toBeLessThanOrEqual(PHI_TOL)
  })

  it('stays inside [0,1] and strictly increases across the sampled range', () => {
    let prev = -Infinity
    for (let z = -6; z <= 6.0001; z += 0.05) {
      const phi = normalCdf(z)
      expect(phi).toBeGreaterThanOrEqual(0)
      expect(phi).toBeLessThanOrEqual(1)
      expect(phi).toBeGreaterThan(prev)
      prev = phi
    }
  })

  it('never lets a two-sided p exceed 1 for a non-negative z', () => {
    for (let z = 0; z <= 4.0001; z += 0.01) {
      expect(twoSidedP(z)).toBeLessThanOrEqual(1)
    }
  })

  it('covers the tails and the infinities', () => {
    expect(Math.abs(normalCdf(-8) - 6.106226635438361e-16)).toBeLessThanOrEqual(PHI_TOL)
    expect(normalCdf(-40)).toBe(0)
    expect(normalCdf(40)).toBe(1)
    expect(normalCdf(-Infinity)).toBe(0)
    expect(normalCdf(Infinity)).toBe(1)
  })

  it('agrees with the mid-range reference away from the critical points', () => {
    const table: Array<[x: number, phi: number]> = [
      [0.25, 0.5987063256829237],
      [0.5, 0.6914624612740131],
      [1, 0.8413447460685429],
      [2, 0.9772498680518208],
      [3, 0.9986501019683699],
      [4, 0.9999683287581669],
    ]
    for (const [x, phi] of table) {
      expect(Math.abs(normalCdf(x) - phi)).toBeLessThanOrEqual(PHI_TOL)
    }
  })
})
