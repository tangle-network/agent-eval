import { describe, expect, it } from 'vitest'
import { mannWhitneyU, pairedTTest, wilcoxonSignedRank } from './index'

describe('mannWhitneyU', () => {
  it('returns significant p-value for clearly different distributions', () => {
    const a = [1, 2, 3, 4, 5]
    const b = [10, 11, 12, 13, 14]
    const result = mannWhitneyU(a, b)
    expect(result.p).toBeLessThan(0.05)
  })

  it('returns non-significant p-value for similar distributions', () => {
    const a = [5, 6, 7, 8, 9]
    const b = [5, 6, 7, 8, 9]
    const result = mannWhitneyU(a, b)
    expect(result.p).toBeGreaterThan(0.05)
  })

  it('handles empty input', () => {
    // pFloor = 1 states what p = 1 alone cannot: no outcome at this design is
    // evidence of anything.
    expect(mannWhitneyU([], [1, 2])).toEqual({
      u: 0,
      uA: 0,
      p: 1,
      method: 'exact',
      pFloor: 1,
    })
  })
})

describe('wilcoxonSignedRank', () => {
  it('rejects unequal sample sizes', () => {
    expect(() => wilcoxonSignedRank([1], [1, 2])).toThrow(/unequal/)
  })

  it('detects a consistent shift across paired samples', () => {
    const before = [0.4, 0.5, 0.6, 0.7, 0.4, 0.5, 0.6, 0.7]
    const after = before.map((b) => b + 0.3)
    const r = wilcoxonSignedRank(before, after)
    expect(r.p).toBeLessThan(0.05)
  })

  it('returns p=1 with pFloor=1 when every pair is tied', () => {
    // Zero non-zero differences: no ranks exist, so no outcome is attainable.
    expect(wilcoxonSignedRank([1, 2, 3], [1, 2, 3])).toEqual({
      w: 0,
      p: 1,
      method: 'exact',
      pFloor: 1,
      nNonZero: 0,
    })
  })
})

describe('rank tests refuse non-finite input instead of hanging', () => {
  // The tie-grouping scan advances with `combined[j] === combined[i]`, and
  // NaN === NaN is false, so a single NaN left the group boundary unable to
  // move and spun the event loop forever.
  it('mannWhitneyU throws on NaN rather than spinning', () => {
    expect(() => mannWhitneyU([1, 2, 3, 4, 5, 6], [Number.NaN, 2, 3, 4, 5, 6])).toThrow(
      /must be finite/,
    )
  })

  it('mannWhitneyU throws on Infinity', () => {
    expect(() => mannWhitneyU([1, Number.POSITIVE_INFINITY], [3, 4])).toThrow(/must be finite/)
  })

  it('wilcoxonSignedRank throws on NaN rather than spinning', () => {
    expect(() => wilcoxonSignedRank([1, 2, 3, 4, 5, 6], [2, Number.NaN, 4, 5, 6, 7])).toThrow(
      /must be finite/,
    )
  })

  it('pairedTTest throws on NaN', () => {
    expect(() => pairedTTest([1, 2, 3], [1, Number.NaN, 3])).toThrow(/must be finite/)
  })
})

describe('mannWhitneyU — exact conditional null at 3–10 reps', () => {
  it('reports the attainable 0.1000 at 3 v 3, not an unreachable 0.0495', () => {
    const r = mannWhitneyU([1, 2, 3], [4, 5, 6])
    expect(r.method).toBe('exact')
    expect(r.p).toBeCloseTo(0.1, 12)
    expect(r.pFloor).toBeCloseTo(0.1, 12)
  })

  it('separates zero-tie and maximal-tie designs by their true exact p', () => {
    // Both are complete separations at 3 v 3, so both have exact p = 0.1.
    // The asymptotic answers differ (0.0809 vs 0.0469) and both are wrong.
    expect(mannWhitneyU([1, 2, 3], [4, 5, 6]).p).toBeCloseTo(0.1, 12)
    expect(mannWhitneyU([0, 0, 0], [1, 1, 1]).p).toBeCloseTo(0.1, 12)
  })

  it('cannot return a p below the design floor', () => {
    for (const [n1, n2] of [
      [1, 1],
      [2, 2],
      [3, 3],
      [3, 5],
      [5, 5],
      [8, 8],
    ] as const) {
      const a = Array.from({ length: n1 }, (_, i) => i)
      const b = Array.from({ length: n2 }, (_, i) => 100 + i)
      const r = mannWhitneyU(a, b)
      expect(r.p).toBeGreaterThanOrEqual(r.pFloor - 1e-12)
      expect(r.p).toBeCloseTo(r.pFloor, 12)
    }
  })

  it('matches scipy exact p on untied designs', () => {
    const CASES: Array<{ a: number[]; b: number[]; p: number }> = [
      { a: [1, 2, 3], b: [4, 5, 6], p: 0.1 },
      { a: [1, 2, 3, 4, 5], b: [10, 11, 12, 13, 14], p: 0.007936507936507936 },
      {
        a: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12],
        b: Array.from({ length: 12 }, (_, i) => 13 + i),
        p: 7.39602301050679e-7,
      },
    ]
    for (const { a, b, p } of CASES) expect(mannWhitneyU(a, b).p).toBeCloseTo(p, 12)
  })

  it('conditions on the observed tie pattern, which no library does', () => {
    // Brute-force enumeration of every C(N, n1) split with midranks.
    const CASES: Array<{ a: number[]; b: number[]; p: number; pFloor: number }> = [
      { a: [1, 2, 3, 4], b: [2, 3, 4, 5], p: 0.45714285714285713, pFloor: 0.05714285714285714 },
      {
        a: [1, 1, 2, 2, 3],
        b: [2, 2, 3, 3, 4],
        p: 0.19047619047619047,
        pFloor: 0.031746031746031744,
      },
      {
        a: [1, 2, 3, 4, 5, 6, 7, 8],
        b: [2, 3, 4, 5, 6, 7, 8, 9],
        p: 0.4811188811188811,
        pFloor: 0.0003108003108003108,
      },
      { a: [5, 6, 7, 8, 9], b: [5, 6, 7, 8, 9], p: 1, pFloor: 0.015873015873015872 },
    ]
    for (const { a, b, p, pFloor } of CASES) {
      const r = mannWhitneyU(a, b)
      expect(r.p).toBeCloseTo(p, 12)
      expect(r.pFloor).toBeCloseTo(pFloor, 12)
    }
  })

  it('keeps the direction of the effect in uA, which min(u1,u2) discards', () => {
    expect(mannWhitneyU([1, 2, 3], [4, 5, 6]).uA).toBe(0)
    expect(mannWhitneyU([4, 5, 6], [1, 2, 3]).uA).toBe(9)
    expect(mannWhitneyU([1, 2, 3], [4, 5, 6]).u).toBe(mannWhitneyU([4, 5, 6], [1, 2, 3]).u)
  })

  it('single observations per arm cannot reject at any alpha', () => {
    const r = mannWhitneyU([1.0], [2.0])
    expect(r.p).toBe(1)
    expect(r.pFloor).toBe(1)
  })
})

describe('wilcoxonSignedRank — exact conditional null, no n<6 dead zone', () => {
  it('measures a clean 5-of-5 positive shift instead of returning p = 1', () => {
    const r = wilcoxonSignedRank([0, 0, 0, 0, 0], [0.5, 0.5, 0.5, 0.5, 0.5])
    expect(r.method).toBe('exact')
    expect(r.p).toBeCloseTo(0.0625, 12)
    expect(r.pFloor).toBeCloseTo(0.0625, 12)
    expect(r.nNonZero).toBe(5)
  })

  it('measures a design that ties push under the old n<6 threshold', () => {
    // Ten pairs, five exact ties: the old code dropped to n = 5 and returned
    // p = 1 with nothing in the result to say so.
    const before = [0, 0, 0, 0, 0, 1, 2, 3, 4, 5]
    const after = [0.5, 0.5, 0.5, 0.5, 0.5, 1, 2, 3, 4, 5]
    const r = wilcoxonSignedRank(before, after)
    expect(r.nNonZero).toBe(5)
    expect(r.p).toBeCloseTo(0.0625, 12)
  })

  it('matches scipy exact p on untied differences', () => {
    const CASES: Array<{ before: number[]; after: number[]; p: number }> = [
      {
        before: [0.4, 0.5, 0.6, 0.7, 0.4, 0.5, 0.6, 0.7],
        after: [0.7, 0.8, 0.9, 1.0, 0.7, 0.8, 0.9, 1.0],
        p: 0.0078125,
      },
      { before: [0, 0, 0], after: [0.5, 0.5, 0.5], p: 0.25 },
      { before: [1, 2, 3, 4, 5, 6], after: [2, 1, 4, 3, 6, 5], p: 1 },
      {
        before: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        after: [2, 3, 4, 5, 6, 7, 8, 9, 10, 11],
        p: 0.001953125,
      },
    ]
    for (const { before, after, p } of CASES) {
      expect(wilcoxonSignedRank(before, after).p).toBeCloseTo(p, 12)
    }
  })

  it('conditions on tied absolute differences', () => {
    // Brute-force enumeration of all 2^8 sign patterns over the midranks.
    const r = wilcoxonSignedRank(
      [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8],
      [0.15, 0.18, 0.35, 0.44, 0.52, 0.7, 0.72, 0.9],
    )
    expect(r.w).toBeCloseTo(34, 12)
    expect(r.p).toBeCloseTo(0.03125, 12)
    expect(r.pFloor).toBeCloseTo(0.0078125, 12)
  })

  it('exposes 2^(1-n) as the floor so a gate can see it is underpowered', () => {
    for (let n = 1; n <= 6; n++) {
      const before = Array.from({ length: n }, () => 0)
      const after = Array.from({ length: n }, () => 1)
      const r = wilcoxonSignedRank(before, after)
      expect(r.pFloor).toBeCloseTo(2 ** (1 - n), 12)
      expect(r.p).toBeGreaterThanOrEqual(r.pFloor - 1e-12)
    }
    // n = 5 cannot reach 0.05 at all; n = 6 can.
    expect(wilcoxonSignedRank([0, 0, 0, 0, 0], [1, 1, 1, 1, 1]).pFloor).toBeGreaterThan(0.05)
    expect(wilcoxonSignedRank([0, 0, 0, 0, 0, 0], [1, 1, 1, 1, 1, 1]).pFloor).toBeLessThan(0.05)
  })
})

describe('rank tests: exact-versus-asymptotic policy', () => {
  it('refuses an asymptotic p where an exact one exists, naming the floor', () => {
    expect(() => mannWhitneyU([1, 2, 3], [4, 5, 6], { method: 'asymptotic' })).toThrow(
      /refused at n1=3, n2=3 .* starts at 0\.1000/s,
    )
    expect(() =>
      wilcoxonSignedRank([0, 0, 0, 0, 0], [1, 1, 1, 1, 1], { method: 'asymptotic' }),
    ).toThrow(/refused at n=5 non-zero differences .* starts at 0\.0625/s)
  })

  it('refuses an exact request outside the enumeration threshold', () => {
    const a = Array.from({ length: 20 }, (_, i) => i)
    const b = Array.from({ length: 20 }, (_, i) => i + 0.5)
    expect(() => mannWhitneyU(a, b, { method: 'exact' })).toThrow(/out of range/)
  })

  it('uses exact work estimates for an imbalanced 1+24 design', () => {
    const r = mannWhitneyU(
      [0],
      Array.from({ length: 24 }, (_, index) => index + 1),
    )
    expect(r.method).toBe('exact')
    expect(r.p).toBeCloseTo(0.08, 12)
    expect(r.pFloor).toBeCloseTo(0.08, 12)
  })

  it("'auto' takes the permutation path above the threshold, never asymptotic", () => {
    const a = Array.from({ length: 14 }, (_, i) => i + 1)
    const b = Array.from({ length: 14 }, (_, i) => i + 8)
    const r = mannWhitneyU(a, b, { permutations: 20000, seed: 7 })
    expect(r.method).toBe('permutation')
    expect(r.pFloor).toBeCloseTo(1 / 20001, 12)
    // scipy's exact answer for this design is 4.2127e-4.
    expect(r.p).toBeGreaterThan(1e-4)
    expect(r.p).toBeLessThan(3e-3)
  })

  it('applies the tie and continuity corrections on the asymptotic path', () => {
    // scipy.stats.mannwhitneyu(method='asymptotic', use_continuity=True).
    const a = Array.from({ length: 14 }, (_, i) => i + 1)
    const b = Array.from({ length: 14 }, (_, i) => i + 8)
    const r = mannWhitneyU(a, b, { method: 'asymptotic' })
    expect(r.method).toBe('asymptotic')
    // Bound is normalCdf's own: A&S 7.1.26 holds Φ to 7.5e-8, so a two-sided
    // tail is good to 1.5e-7 and no tighter.
    expect(Math.abs(r.p - 0.0007867974321958436)).toBeLessThanOrEqual(1.5e-7)
  })

  it('permutation results are invariant to observation order without an explicit seed', () => {
    const a = Array.from({ length: 13 }, (_, index) => index)
    const b = a.map((value) => value + 3.5)
    const forward = mannWhitneyU(a, b, { permutations: 10_000 })
    const reversed = mannWhitneyU([...a].reverse(), [...b].reverse(), {
      permutations: 10_000,
    })
    expect(forward.p).toBe(reversed.p)
  })

  it('permutation results are invariant when the two groups are swapped', () => {
    const a = Array.from({ length: 13 }, (_, index) => index)
    const b = a.map((value) => value + 3.5)
    const forward = mannWhitneyU(a, b, { permutations: 10_000 })
    const swapped = mannWhitneyU(b, a, { permutations: 10_000 })
    expect(forward.p).toBe(swapped.p)
    expect(forward.pFloor).toBe(swapped.pFloor)
  })

  it('uses the conditional tie floor and never samples below it', () => {
    const a = Array<number>(13).fill(0)
    const b = [...Array<number>(7).fill(0), ...Array<number>(6).fill(1)]
    const r = mannWhitneyU(a, b, { permutations: 10_000, seed: 8 })
    expect(r.method).toBe('permutation')
    expect(r.pFloor).toBeCloseTo(0.014906832298136646, 12)
    expect(r.p).toBe(r.pFloor)
  })

  it('reports an all-tied sampled design as incapable of rejecting', () => {
    const r = mannWhitneyU(Array<number>(13).fill(0), Array<number>(13).fill(0))
    expect(r.method).toBe('permutation')
    expect(r.pFloor).toBe(1)
    expect(r.p).toBe(1)
  })

  it('prints a non-zero exact floor with significant digits', () => {
    const a = Array.from({ length: 12 }, (_, index) => index)
    const b = Array.from({ length: 12 }, (_, index) => index + 12)
    expect(() => mannWhitneyU(a, b, { method: 'asymptotic' })).toThrow(/starts at 7\.396e-7/)
  })

  it('rejects a non-integer permutation count', () => {
    const a = Array.from({ length: 14 }, (_, i) => i)
    const b = Array.from({ length: 14 }, (_, i) => i + 1)
    expect(() => mannWhitneyU(a, b, { permutations: 0 })).toThrow(/positive integer/)
  })
})
