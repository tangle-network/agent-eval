import padjust from '@stdlib/stats-padjust'
import { describe, expect, it } from 'vitest'
import {
  benjaminiHochberg,
  bonferroni,
  holm,
  mannWhitneyU,
  wilcoxonSignedRank,
} from '../src/statistics'

// A second independent implementation of the parts of this module that a
// maintained library DOES cover correctly. Both packages are devDependencies
// and neither is imported by `src/`: the survey behind
// docs/design/statistics-decisions.md found no npm package that computes an
// exact rank test under ties, Cliff's delta, or a paired bootstrap interval,
// so adopting one would buy zero correctness at a cost every consumer of this
// package would inherit.
//
// The imports are narrow on purpose — the correction functions and the untied
// exact null distributions, nothing else.

const FAMILIES: number[][] = [
  [0.01, 0.04, 0.05],
  [0.0125, 0.0125, 0.0125, 0.0125],
  [0.05, 0.05],
  [0.2, 0.2, 0.2, 0.2, 0.2],
  [0.001, 0.5, 0.5, 0.5],
  [
    0.001, 0.008, 0.039, 0.041, 0.042, 0.06, 0.074, 0.205, 0.212, 0.216, 0.222, 0.251, 0.269, 0.275,
    0.34,
  ],
  [0.03, 0.001, 0.6, 0.02, 0.9, 0.045],
]

/** `padjust` adjusts IN PLACE and returns the same array it was handed, so a
 *  caller that reuses its input silently corrects an already-corrected family.
 *  Copy on the way in. */
function reference(family: readonly number[], method: string): number[] {
  return padjust([...family], method) as number[]
}

describe('multiple-comparison corrections vs @stdlib/stats-padjust', () => {
  for (const family of FAMILIES) {
    it(`bonferroni matches on ${family.length} hypotheses`, () => {
      const want = reference(family, 'bonferroni')
      const ours = bonferroni(family).adjusted
      for (let i = 0; i < family.length; i++) {
        expect(Math.abs(ours[i]! - want[i]!)).toBeLessThanOrEqual(1e-12)
      }
    })

    it(`holm matches on ${family.length} hypotheses`, () => {
      const want = reference(family, 'holm')
      const ours = holm(family).adjusted
      for (let i = 0; i < family.length; i++) {
        expect(Math.abs(ours[i]! - want[i]!)).toBeLessThanOrEqual(1e-12)
      }
    })

    it(`benjamini-hochberg matches on ${family.length} hypotheses`, () => {
      const want = reference(family, 'bh')
      const ours = benjaminiHochberg(family).qValues
      for (let i = 0; i < family.length; i++) {
        expect(Math.abs(ours[i]! - want[i]!)).toBeLessThanOrEqual(1e-12)
      }
    })
  }

  it('leaves the caller-supplied family untouched, unlike padjust', () => {
    const family = [0.01, 0.04, 0.05]
    bonferroni(family)
    holm(family)
    benjaminiHochberg(family)
    expect(family).toEqual([0.01, 0.04, 0.05])

    const mutated = [0.01, 0.04, 0.05]
    padjust(mutated, 'bonferroni')
    expect(mutated).not.toEqual([0.01, 0.04, 0.05])
  })
})

describe('exact rank-test nulls vs lib-r-math.js', () => {
  // lib-r-math.js ships R's distributions, not R's tests: `pwilcox(q, m, n)`
  // and `psignrank(q, n)` take no tie vector, so they can only check the
  // UNTIED null. That is exactly why this module still has to compute the
  // tied case itself.
  it('two-sample exact p matches R pwilcox on untied designs', async () => {
    const { pwilcox } = await import('lib-r-math.js')
    const designs: Array<{ a: number[]; b: number[] }> = [
      { a: [1, 2, 3], b: [4, 5, 6] },
      { a: [1, 2, 3, 4, 5], b: [10, 11, 12, 13, 14] },
      { a: [1, 3, 5, 7], b: [2, 4, 6, 8] },
      { a: [1, 2], b: [3, 4] },
      { a: [0.1, 0.4, 0.9, 1.4, 2.2], b: [0.2, 0.5, 1.1, 1.5, 3.0] },
    ]
    for (const { a, b } of designs) {
      const ours = mannWhitneyU(a, b)
      expect(ours.method).toBe('exact')
      // R's two-sided rank-sum p from the lower tail of U.
      const reference = Math.min(1, 2 * (pwilcox(ours.u, a.length, b.length) as number))
      expect(Math.abs(ours.p - reference)).toBeLessThanOrEqual(1e-12)
    }
  })

  it('signed-rank exact p matches R psignrank on untied differences', async () => {
    const { psignrank } = await import('lib-r-math.js')
    const designs: Array<{ before: number[]; after: number[] }> = [
      { before: [0, 0, 0, 0, 0], after: [0.5, 0.9, 1.4, 2.0, 2.7] },
      { before: [0, 0, 0], after: [0.5, 0.9, 1.4] },
      { before: [1, 2, 3, 4, 5, 6], after: [2.5, 1.4, 4.7, 3.1, 6.9, 5.2] },
      {
        before: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10],
        after: [2.1, 3.2, 4.3, 5.4, 6.5, 7.6, 8.7, 9.8, 10.9, 12.1],
      },
    ]
    for (const { before, after } of designs) {
      const ours = wilcoxonSignedRank(before, after)
      expect(ours.method).toBe('exact')
      const n = ours.nNonZero
      const lower = Math.min(ours.w, (n * (n + 1)) / 2 - ours.w)
      const reference = Math.min(1, 2 * (psignrank(lower, n) as number))
      expect(Math.abs(ours.p - reference)).toBeLessThanOrEqual(1e-12)
    }
  })

  it('reproduces the exact floors the 3–10 rep regime turns on', async () => {
    const { psignrank, pwilcox } = await import('lib-r-math.js')
    // 3 v 3 cannot reach 0.05; the grid starts at 0.1.
    expect(2 * (pwilcox(0, 3, 3) as number)).toBeCloseTo(0.1, 12)
    expect(mannWhitneyU([1, 2, 3], [4, 5, 6]).pFloor).toBeCloseTo(0.1, 12)
    // 5 paired observations cannot reach 0.05; 8 can.
    expect(2 * (psignrank(0, 5) as number)).toBeCloseTo(0.0625, 12)
    expect(2 * (psignrank(0, 8) as number)).toBeCloseTo(0.0078125, 12)
    expect(wilcoxonSignedRank([0, 0, 0, 0, 0], [1, 1, 1, 1, 1]).pFloor).toBeCloseTo(0.0625, 12)
  })
})
