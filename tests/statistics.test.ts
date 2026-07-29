import { describe, expect, it } from 'vitest'
import { compareToBaseline, welchsTTest } from '../src/baseline'
import { normalCdf } from '../src/math/normal'
import { studentTCdf } from '../src/math/student-t'
import {
  benjaminiHochberg,
  bonferroni,
  type CorpusScoreRecord,
  cohensD,
  confidenceInterval,
  corpusInterRaterAgreement,
  corpusInterRaterAgreementFromJudgeScores,
  holm,
  interRaterReliability,
  mannWhitneyU,
  mcnemar,
  mcnemarPower,
  mcnemarRequiredN,
  mulberry32,
  normalizeScores,
  pairedBootstrap,
  pairedCohensDz,
  pairedMde,
  pairedRiskDifference,
  pairedRiskDifferenceExact,
  pairedSignTest,
  pairedTTest,
  partialCredit,
  passAtK,
  pearsonR,
  ranks,
  requiredPairedSampleSize,
  requiredSampleSize,
  spearmanR,
  weightedMean,
  wilcoxonSignedRank,
  wilson,
} from '../src/statistics'
import type { JudgeScore } from '../src/types'

function makeScore(dimension: string, score: number): JudgeScore {
  return { judgeName: 'test', dimension, score, reasoning: '' }
}

describe('normalizeScores', () => {
  it('passes through inverted dimensions unchanged (already normalized in prompt)', () => {
    const scores = [
      makeScore('hallucination', 8),
      makeScore('false_confidence', 7),
      makeScore('worst_failure', 9),
      makeScore('domain_accuracy', 6),
    ]
    const normalized = normalizeScores(scores)
    expect(normalized).toHaveLength(4)
    expect(normalized.find((s) => s.dimension === 'hallucination')!.score).toBe(8)
    expect(normalized.find((s) => s.dimension === 'domain_accuracy')!.score).toBe(6)
  })

  it('handles empty input', () => {
    expect(normalizeScores([])).toEqual([])
  })
})

describe('weightedMean', () => {
  it('computes simple average with no weights', () => {
    expect(weightedMean([{ score: 4 }, { score: 6 }, { score: 8 }])).toBeCloseTo(6)
  })

  it('computes weighted average', () => {
    expect(
      weightedMean([
        { score: 10, weight: 3 },
        { score: 0, weight: 1 },
      ]),
    ).toBeCloseTo(7.5)
  })

  it('returns 0 for empty input', () => {
    expect(weightedMean([])).toBe(0)
  })
})

describe('confidenceInterval', () => {
  it('returns reasonable bounds for uniform data', () => {
    const scores = [5, 5, 5, 5, 5]
    const ci = confidenceInterval(scores)
    expect(ci.mean).toBe(5)
    expect(ci.lower).toBeCloseTo(5, 1)
    expect(ci.upper).toBeCloseTo(5, 1)
  })

  it('returns wider bounds for varied data', () => {
    const scores = [1, 3, 5, 7, 9]
    const ci = confidenceInterval(scores)
    expect(ci.mean).toBe(5)
    expect(ci.lower).toBeLessThan(ci.mean)
    expect(ci.upper).toBeGreaterThan(ci.mean)
    expect(ci.upper - ci.lower).toBeGreaterThan(0)
  })

  it('handles single value', () => {
    const ci = confidenceInterval([7])
    expect(ci.mean).toBe(7)
    expect(ci.lower).toBe(7)
    expect(ci.upper).toBe(7)
  })

  it('handles empty input', () => {
    const ci = confidenceInterval([])
    expect(ci.mean).toBe(0)
  })
})

describe('partialCredit', () => {
  it('returns correct ratios', () => {
    expect(partialCredit(3, 5)).toBeCloseTo(0.6)
    expect(partialCredit(5, 5)).toBeCloseTo(1)
    expect(partialCredit(0, 5)).toBeCloseTo(0)
  })

  it('clamps above target to 1', () => {
    expect(partialCredit(10, 5)).toBe(1)
  })

  it('returns 1 for zero target', () => {
    expect(partialCredit(0, 0)).toBe(1)
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

describe('cohensD', () => {
  it('returns 0 on tied means — regression: non-zero effect size from tied data misleads decisions', () => {
    expect(cohensD([1, 2, 3], [1, 2, 3])).toBe(0)
  })

  it('positive d when group b is higher', () => {
    const a = [1, 2, 3, 4, 5]
    const b = [6, 7, 8, 9, 10]
    expect(cohensD(a, b)).toBeGreaterThan(0.8) // large effect
  })

  it('negative d when group b is lower', () => {
    const a = [10, 11, 12, 13, 14]
    const b = [1, 2, 3, 4, 5]
    expect(cohensD(a, b)).toBeLessThan(-0.8)
  })

  it('small-effect rule of thumb (0.2 < |d| < 0.5)', () => {
    const a = [0.4, 0.5, 0.6, 0.5, 0.4, 0.6]
    const b = [0.5, 0.6, 0.7, 0.6, 0.5, 0.7]
    const d = cohensD(a, b)
    expect(Math.abs(d)).toBeGreaterThan(0.2)
    expect(Math.abs(d)).toBeLessThan(1.2)
  })

  it('returns null for under-sized groups rather than a measured zero', () => {
    expect(cohensD([1], [2])).toBeNull()
  })
})

describe('pairedCohensDz', () => {
  it('standardizes within-pair deltas', () => {
    const value = pairedCohensDz([0.1, 0.4, 0.3, 0.8], [0.3, 0.5, 0.7, 0.9])
    expect(value).not.toBeNull()
    expect(value!).toBeGreaterThan(1)
  })

  it('returns null for a non-zero constant delta instead of a huge finite value', () => {
    expect(pairedCohensDz([0.1, 0.1, 0.1], [0.9, 0.9, 0.9])).toBeNull()
  })

  it('rejects unequal vector lengths', () => {
    expect(() => pairedCohensDz([0.1], [0.2, 0.3])).toThrow(/unequal sample sizes/)
  })
})

// ── corpusInterRaterAgreement ──────────────────────────────────────

function makeRecord(
  itemId: string,
  judgeName: string,
  dimension: string,
  score: number,
): CorpusScoreRecord {
  return { itemId, judgeName, dimension, score }
}

describe('corpusInterRaterAgreement', () => {
  it('returns ICC=1 and κ_w=1 when every judge produces the same score on every item', () => {
    const dims = ['accuracy', 'depth']
    const items = ['s1', 's2', 's3', 's4', 's5']
    const judges = ['claude', 'gpt', 'gemini']
    const records: CorpusScoreRecord[] = []
    for (const it of items) {
      // Per-item baseline varies across items so MSR ≠ 0 (otherwise ICC is degenerate).
      const base = (items.indexOf(it) + 1) * 0.15
      for (const d of dims) {
        for (const j of judges) {
          records.push(makeRecord(it, j, d, base))
        }
      }
    }
    const report = corpusInterRaterAgreement(records, { bootstrap: 0 })
    expect(report.dimensions).toEqual(['accuracy', 'depth'])
    expect(report.judgeIds).toEqual(['claude', 'gemini', 'gpt'])
    expect(report.perDimension).toHaveLength(2)
    for (const pd of report.perDimension) {
      expect(pd.icc).toBeCloseTo(1, 5)
      expect(pd.weightedKappa).toBeCloseTo(1, 5)
      expect(pd.n).toBe(5)
      expect(pd.raters).toBe(3)
    }
    expect(report.overallIcc).toBeCloseTo(1, 5)
    expect(report.overallWeightedKappa).toBeCloseTo(1, 5)
  })

  it('matches a hand-computed ICC(2,1) on a synthetic two-judge case', () => {
    // Two judges, four items. Construction:
    //   judge A: 0.1, 0.4, 0.6, 0.9
    //   judge B: 0.2, 0.5, 0.5, 1.0
    // Expected ICC(2,1) ≈ 0.93 — high agreement with a slight scale offset
    // on item 3 only. Computed once with the local icc21 formula and pinned.
    const records: CorpusScoreRecord[] = [
      makeRecord('i1', 'A', 'q', 0.1),
      makeRecord('i2', 'A', 'q', 0.4),
      makeRecord('i3', 'A', 'q', 0.6),
      makeRecord('i4', 'A', 'q', 0.9),
      makeRecord('i1', 'B', 'q', 0.2),
      makeRecord('i2', 'B', 'q', 0.5),
      makeRecord('i3', 'B', 'q', 0.5),
      makeRecord('i4', 'B', 'q', 1.0),
    ]
    const report = corpusInterRaterAgreement(records, { bootstrap: 0 })
    expect(report.perDimension).toHaveLength(1)
    const pd = report.perDimension[0]!
    expect(pd.dimension).toBe('q')
    expect(pd.itemIds).toEqual(['i1', 'i2', 'i3', 'i4'])
    expect(pd.judgeIds).toEqual(['A', 'B'])
    expect(pd.icc).toBeGreaterThan(0.85)
    expect(pd.icc).toBeLessThan(1)
    expect(pd.weightedKappa).toBeGreaterThan(0.85)
    expect(pd.weightedKappa).toBeLessThan(1)
  })

  it('drops to low agreement when one judge is anti-correlated with the panel', () => {
    const items = ['i1', 'i2', 'i3', 'i4', 'i5', 'i6']
    const judgeA = [0.1, 0.3, 0.5, 0.6, 0.8, 0.95]
    const judgeB = [0.15, 0.32, 0.48, 0.6, 0.79, 0.93]
    const judgeC = [0.95, 0.8, 0.6, 0.5, 0.3, 0.1] // reversed
    const records: CorpusScoreRecord[] = []
    items.forEach((it, k) => {
      records.push(makeRecord(it, 'A', 'q', judgeA[k]!))
      records.push(makeRecord(it, 'B', 'q', judgeB[k]!))
      records.push(makeRecord(it, 'C', 'q', judgeC[k]!))
    })
    const report = corpusInterRaterAgreement(records, { bootstrap: 0 })
    const pd = report.perDimension[0]!
    expect(pd.icc).toBeLessThan(0.5)
  })

  it('fail-loud: empty input throws', () => {
    expect(() => corpusInterRaterAgreement([], { bootstrap: 0 })).toThrow(/no score records/)
  })

  it('fail-loud: judge with zero items on a dimension throws (silent NaN forbidden)', () => {
    const records: CorpusScoreRecord[] = [
      makeRecord('i1', 'A', 'accuracy', 0.5),
      makeRecord('i2', 'A', 'accuracy', 0.6),
      makeRecord('i1', 'B', 'accuracy', 0.55),
      makeRecord('i2', 'B', 'accuracy', 0.62),
      // 'depth' only has judge A — judge B never scored it.
      makeRecord('i1', 'A', 'depth', 0.4),
      makeRecord('i2', 'A', 'depth', 0.5),
    ]
    expect(() => corpusInterRaterAgreement(records, { bootstrap: 0 })).toThrow(
      /dimension 'depth' has no scores from judge\(s\) B/,
    )
  })

  it('fail-loud: fewer than 2 common items per dimension throws', () => {
    const records: CorpusScoreRecord[] = [
      makeRecord('i1', 'A', 'q', 0.5),
      makeRecord('i2', 'A', 'q', 0.6), // B never rated i2
      makeRecord('i1', 'B', 'q', 0.55),
    ]
    expect(() => corpusInterRaterAgreement(records, { bootstrap: 0 })).toThrow(
      /1 item\(s\) rated by all 2 judges/,
    )
  })

  it('fail-loud: duplicate (item, judge, dim) records throw', () => {
    const records: CorpusScoreRecord[] = [
      makeRecord('i1', 'A', 'q', 0.5),
      makeRecord('i1', 'A', 'q', 0.6),
    ]
    expect(() => corpusInterRaterAgreement(records, { bootstrap: 0 })).toThrow(/duplicate record/)
  })

  it('fail-loud: non-finite score throws', () => {
    const records: CorpusScoreRecord[] = [
      makeRecord('i1', 'A', 'q', 0.5),
      makeRecord('i1', 'B', 'q', Number.NaN),
    ]
    expect(() => corpusInterRaterAgreement(records, { bootstrap: 0 })).toThrow(/non-finite score/)
  })

  it('fail-loud: requested dimension absent from input throws', () => {
    const records: CorpusScoreRecord[] = [
      makeRecord('i1', 'A', 'accuracy', 0.5),
      makeRecord('i2', 'A', 'accuracy', 0.6),
      makeRecord('i1', 'B', 'accuracy', 0.55),
      makeRecord('i2', 'B', 'accuracy', 0.62),
    ]
    expect(() =>
      corpusInterRaterAgreement(records, { bootstrap: 0, dimensions: ['accuracy', 'depth'] }),
    ).toThrow(/dimension 'depth' was requested/)
  })

  it('corpusInterRaterAgreementFromJudgeScores: flattens per-item JudgeScore arrays correctly', () => {
    const mk = (judge: string, dim: string, score: number): JudgeScore => ({
      judgeName: judge,
      dimension: dim,
      score,
      reasoning: '',
    })
    const itemsScores = [
      {
        itemId: 's1',
        scores: [mk('A', 'q', 0.1), mk('B', 'q', 0.12), mk('A', 'd', 0.2), mk('B', 'd', 0.22)],
      },
      {
        itemId: 's2',
        scores: [mk('A', 'q', 0.5), mk('B', 'q', 0.48), mk('A', 'd', 0.6), mk('B', 'd', 0.62)],
      },
      {
        itemId: 's3',
        scores: [mk('A', 'q', 0.9), mk('B', 'q', 0.91), mk('A', 'd', 0.8), mk('B', 'd', 0.79)],
      },
    ]
    const report = corpusInterRaterAgreementFromJudgeScores(itemsScores, { bootstrap: 0 })
    expect(report.dimensions).toEqual(['d', 'q'])
    expect(report.judgeIds).toEqual(['A', 'B'])
    for (const pd of report.perDimension) {
      expect(pd.icc).toBeGreaterThan(0.9)
      expect(pd.n).toBe(3)
      expect(pd.raters).toBe(2)
    }
  })

  it('corpusInterRaterAgreementFromJudgeScores: duplicate itemId throws', () => {
    expect(() =>
      corpusInterRaterAgreementFromJudgeScores(
        [
          { itemId: 's1', scores: [] },
          { itemId: 's1', scores: [] },
        ],
        { bootstrap: 0 },
      ),
    ).toThrow(/duplicate itemId 's1'/)
  })
})

describe('requiredSampleSize', () => {
  it('returns Infinity on non-positive effect', () => {
    expect(requiredSampleSize({ effect: 0 })).toBe(Infinity)
    expect(requiredSampleSize({ effect: -0.2 })).toBe(Infinity)
  })

  it("gives the expected N for Cohen's d=0.5 at 80% power, alpha=0.05, two-sided", () => {
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

describe('requiredPairedSampleSize', () => {
  it('uses the paired design formula', () => {
    const paired = requiredPairedSampleSize({ effect: 0.5 })
    const independent = requiredSampleSize({ effect: 0.5 })
    expect(paired).toBeGreaterThan(0)
    expect(paired).toBeLessThan(independent)
  })

  it('returns Infinity when no finite positive effect is available', () => {
    expect(requiredPairedSampleSize({ effect: 0 })).toBe(Infinity)
    expect(requiredPairedSampleSize({ effect: Number.NaN })).toBe(Infinity)
  })
})

describe('pairedMde', () => {
  it('returns Infinity on non-positive sample size', () => {
    expect(pairedMde({ nPaired: 0 })).toBe(Infinity)
    expect(pairedMde({ nPaired: -5 })).toBe(Infinity)
  })

  it('shrinks as paired N grows', () => {
    const small = pairedMde({ nPaired: 16 })
    const large = pairedMde({ nPaired: 100 })
    expect(large).toBeLessThan(small)
    expect(large).toBeGreaterThan(0)
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
    const sortedQ = ps.map((_, i) => qValues[i]).sort((a, b) => a - b)
    for (let i = 1; i < sortedQ.length; i++) {
      expect(sortedQ[i]).toBeGreaterThanOrEqual(sortedQ[i - 1])
    }
  })

  it('is less conservative than Bonferroni on mixed inputs', () => {
    const ps = [0.001, 0.008, 0.04, 0.2, 0.6]
    const bh = benjaminiHochberg(ps, 0.1).significant.filter((x) => x).length
    const bf = bonferroni(ps, 0.1).significant.filter((x) => x).length
    expect(bh).toBeGreaterThanOrEqual(bf)
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

describe('mcnemarRequiredN / mcnemarPower — paired-binary power', () => {
  it('matches the closed-form sample size for a known config', () => {
    // p10=0.25, p01=0.05, two-sided alpha=0.05, power=0.8 → 57 pairs (Lachin).
    expect(mcnemarRequiredN({ p10: 0.25, p01: 0.05, power: 0.8 })).toBe(57)
  })

  it('needs more pairs for a smaller effect, fewer for a larger one', () => {
    const big = mcnemarRequiredN({ p10: 0.4, p01: 0.05 })
    const small = mcnemarRequiredN({ p10: 0.2, p01: 0.15 })
    expect(small).toBeGreaterThan(big)
  })

  it('needs more pairs for higher target power', () => {
    const p80 = mcnemarRequiredN({ p10: 0.3, p01: 0.1, power: 0.8 })
    const p90 = mcnemarRequiredN({ p10: 0.3, p01: 0.1, power: 0.9 })
    expect(p90).toBeGreaterThan(p80)
  })

  it('no effect (p10 === p01) ⇒ Infinity pairs', () => {
    expect(mcnemarRequiredN({ p10: 0.1, p01: 0.1 })).toBe(Infinity)
  })

  it('power at the required N reaches the target (asymptotic, ceil ⇒ ≥)', () => {
    const n = mcnemarRequiredN({ p10: 0.25, p01: 0.05, power: 0.8 })
    expect(mcnemarPower({ p10: 0.25, p01: 0.05, nPairs: n })).toBeGreaterThanOrEqual(0.8)
  })

  it('required N is the MINIMAL n hitting the target, over a grid of configs', () => {
    // The two functions are inverses through different routes — required N via
    // the inverse normal, power via the forward normal CDF. Bounding the
    // round-trip on both sides is what ties those two routes together: a
    // one-sided ≥ target check is satisfied by any CDF that overstates power.
    const configs = [
      { p10: 0.25, p01: 0.05 },
      { p10: 0.2, p01: 0.1 },
      { p10: 0.3, p01: 0.1 },
      { p10: 0.15, p01: 0.05 },
    ]
    for (const cfg of configs) {
      for (const power of [0.7, 0.8, 0.9, 0.95]) {
        const n = mcnemarRequiredN({ ...cfg, power })
        const atN = mcnemarPower({ ...cfg, nPairs: n })
        expect(atN).toBeGreaterThanOrEqual(power)
        // One pair short must miss, so N cannot be inflated, and the overshoot
        // at N is bounded by a single pair's worth of power.
        expect(mcnemarPower({ ...cfg, nPairs: n - 1 })).toBeLessThan(power)
        expect(atN - power).toBeLessThan(0.01)
      }
    }
  })

  it('power rises monotonically with n and equals alpha at no effect', () => {
    const lo = mcnemarPower({ p10: 0.25, p01: 0.05, nPairs: 20 })
    const hi = mcnemarPower({ p10: 0.25, p01: 0.05, nPairs: 80 })
    expect(hi).toBeGreaterThan(lo)
    expect(mcnemarPower({ p10: 0.1, p01: 0.1, nPairs: 500 })).toBeCloseTo(0.05, 10)
  })

  it('throws on impossible discordant probabilities', () => {
    expect(() => mcnemarRequiredN({ p10: 0.7, p01: 0.7 })).toThrow(/p10\+p01/)
    expect(() => mcnemarPower({ p10: -0.1, p01: 0.2, nPairs: 50 })).toThrow(/p10,p01/)
  })
})

describe('pearsonR — consolidated correlation helper', () => {
  it('returns +1 for a perfectly increasing linear relationship', () => {
    expect(pearsonR([1, 2, 3, 4], [2, 4, 6, 8])).toBeCloseTo(1, 10)
  })

  it('returns -1 for a perfectly decreasing linear relationship', () => {
    expect(pearsonR([1, 2, 3, 4], [8, 6, 4, 2])).toBeCloseTo(-1, 10)
  })

  it('matches the known Pearson value on a worked example', () => {
    // r for ([1,2,3,4,5],[2,4,5,4,5]) ≈ 0.7745966692
    expect(pearsonR([1, 2, 3, 4, 5], [2, 4, 5, 4, 5])).toBeCloseTo(0.7745966692, 8)
  })

  it('is symmetric in its arguments', () => {
    const a = [3, 1, 4, 1, 5, 9]
    const b = [2, 7, 1, 8, 2, 8]
    expect(pearsonR(a, b)).toBeCloseTo(pearsonR(b, a), 12)
  })

  // Edge-case contract — the whole point of consolidating the divergent copies.
  it('returns NaN for fewer than two observations (insufficient data, not 0)', () => {
    expect(pearsonR([], [])).toBeNaN()
    expect(pearsonR([1], [2])).toBeNaN()
  })

  it('returns NaN on a length mismatch', () => {
    expect(pearsonR([1, 2, 3], [1, 2])).toBeNaN()
  })

  it('returns 1 when both series are constant (degenerate perfect agreement)', () => {
    expect(pearsonR([5, 5, 5], [3, 3, 3])).toBe(1)
  })

  it('returns 0 when exactly one series is constant (no covariation to detect)', () => {
    expect(pearsonR([5, 5, 5], [1, 2, 3])).toBe(0)
    expect(pearsonR([1, 2, 3], [4, 4, 4])).toBe(0)
  })
})

describe('ranks — average-rank-with-ties', () => {
  it('ranks distinct values 1..n in value order', () => {
    expect(ranks([10, 30, 20])).toEqual([1, 3, 2])
  })

  it('assigns the average rank to ties', () => {
    // values [5,5,9] occupy ranks 1,2,3 → the two 5s share (1+2)/2 = 1.5
    expect(ranks([5, 5, 9])).toEqual([1.5, 1.5, 3])
    // four equal values all share (1+2+3+4)/4 = 2.5
    expect(ranks([7, 7, 7, 7])).toEqual([2.5, 2.5, 2.5, 2.5])
  })
})

describe('spearmanR — rank correlation', () => {
  it('is +1 for any strictly increasing relationship, even non-linear', () => {
    // cubic is monotone but not linear: Pearson < 1, Spearman = 1
    const x = [1, 2, 3, 4, 5]
    const y = x.map((v) => v ** 3)
    expect(spearmanR(x, y)).toBeCloseTo(1, 10)
    expect(pearsonR(x, y)).toBeLessThan(1)
  })

  it('is -1 for a strictly decreasing relationship', () => {
    expect(spearmanR([1, 2, 3, 4], [40, 30, 20, 10])).toBeCloseTo(-1, 10)
  })

  it('handles ties via average ranks', () => {
    expect(spearmanR([1, 2, 2, 4], [1, 2, 2, 4])).toBeCloseTo(1, 10)
  })

  it('inherits the n<2 / length-mismatch NaN contract', () => {
    expect(spearmanR([1], [2])).toBeNaN()
    expect(spearmanR([1, 2, 3], [1, 2])).toBeNaN()
  })
})

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

describe('degenerate branches answer once, the same way', () => {
  it('pairedTTest returns null rather than absolute certainty from 3 pairs', () => {
    const r = pairedTTest([0, 0, 0.5], [0.5, 0.5, 1])
    expect(r.t).toBeNull()
    expect(r.p).toBeNull()
    expect(r.df).toBe(2)
  })

  it('pairedTTest still reports an all-zero delta as a measured null', () => {
    expect(pairedTTest([1, 2, 3], [1, 2, 3])).toEqual({ t: 0, df: 2, p: 1 })
  })

  it('pairedTTest returns null below two pairs', () => {
    expect(pairedTTest([1], [2])).toEqual({ t: null, df: 0, p: null })
  })

  it('cohensD returns null for a maximal zero-variance separation', () => {
    expect(cohensD([1, 1, 1], [2, 2, 2])).toBeNull()
  })

  it('cohensD returns 0 only when equal means meet zero spread', () => {
    expect(cohensD([1, 1, 1], [1, 1, 1])).toBe(0)
  })

  it('all three degenerate paths now agree with pairedCohensDz', () => {
    expect(pairedCohensDz([1, 1, 1], [2, 2, 2])).toBeNull()
    expect(cohensD([1, 1, 1], [2, 2, 2])).toBeNull()
    expect(pairedTTest([1, 1, 1], [2, 2, 2]).p).toBeNull()
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

describe('seeding is deterministic, including seed 0', () => {
  it('mulberry32(0) is its own stream, not the golden-ratio constant', () => {
    const zero = mulberry32(0)
    const golden = mulberry32(0x9e3779b9 | 0)
    const zeroDraws = [zero(), zero(), zero()]
    const goldenDraws = [golden(), golden(), golden()]
    expect(zeroDraws).not.toEqual(goldenDraws)
  })

  it('mulberry32(0) is reproducible across constructions', () => {
    const a = mulberry32(0)
    const b = mulberry32(0)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('mulberry32 rejects a non-finite seed', () => {
    expect(() => mulberry32(Number.NaN)).toThrow(/finite/)
  })

  it('an unseeded bootstrap is reproducible on identical input', () => {
    const scores = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7]
    const first = confidenceInterval(scores)
    const second = confidenceInterval(scores)
    expect(first).toEqual(second)
  })

  it('an unseeded paired bootstrap is reproducible on identical input', () => {
    const before = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
    const after = [0.2, 0.25, 0.45, 0.5, 0.62, 0.68]
    expect(pairedBootstrap(before, after)).toEqual(pairedBootstrap(before, after))
  })

  it('different data still gets a different stream', () => {
    const a = pairedBootstrap([0, 0, 0, 0, 0, 0], [1, 2, 3, 4, 5, 6])
    const b = pairedBootstrap([0, 0, 0, 0, 0, 0], [1, 2, 3, 4, 5, 7])
    expect(a.high).not.toBe(b.high)
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

describe('interRaterReliability measures BETWEEN-judge agreement', () => {
  const judge = (name: string, dimension: string, scores: number[]): JudgeScore[] =>
    scores.map((score) => ({ judgeName: name, dimension, score, reasoning: '' }))

  it('is +1 for two identical judges', () => {
    expect(
      interRaterReliability([judge('a', 'd', [0, 100]), judge('b', 'd', [0, 100])]),
    ).toBeCloseTo(1, 12)
  })

  it('is negative for two maximally disagreeing judges', () => {
    expect(
      interRaterReliability([judge('a', 'd', [0, 0]), judge('b', 'd', [100, 100])]),
    ).toBeCloseTo(-0.5, 12)
  })

  it('is +1 for perfect agreement whatever the item count', () => {
    for (const items of [
      [1, 5, 9],
      [1, 5, 9, 3],
      [2, 4, 6, 8, 10],
    ]) {
      expect(interRaterReliability([judge('a', 'd', items), judge('b', 'd', items)])).toBeCloseTo(
        1,
        12,
      )
    }
  })

  it('separates the dimensions rather than pooling them into one bucket', () => {
    const a = [...judge('a', 'clarity', [1, 2, 3]), ...judge('a', 'depth', [9, 8, 7])]
    const b = [...judge('b', 'clarity', [1, 2, 3]), ...judge('b', 'depth', [9, 8, 7])]
    expect(interRaterReliability([a, b])).toBeCloseTo(1, 12)
  })

  it('refuses ragged input rather than comparing mismatched items', () => {
    expect(() =>
      interRaterReliability([judge('a', 'd', [1, 2, 3]), judge('b', 'd', [1, 2])]),
    ).toThrow(/cannot be aligned/)
  })
})

describe('welchsTTest / compareToBaseline — the unguarded promotion path', () => {
  it('matches scipy.stats.ttest_ind(equal_var=False)', () => {
    const CASES: Array<{ a: number[]; b: number[]; t: number; df: number; p: number }> = [
      {
        a: [0.4, 0.5, 0.6, 0.55, 0.45, 0.5],
        b: [0.7, 0.8, 0.75, 0.72, 0.78, 0.74],
        t: 7.617523199624095,
        df: 7.559315598935626,
        p: 8.368400396856913e-5,
      },
      { a: [1, 2, 3, 4, 5], b: [2, 3, 4, 5, 6], t: 1.0, df: 8.0, p: 0.34659350708733416 },
      { a: [10, 12, 14, 16], b: [11, 11, 15, 15], t: 0.0, df: 5.926829268292685, p: 1.0 },
    ]
    for (const { a, b, t, df, p } of CASES) {
      const r = welchsTTest(a, b)
      expect(r.status).toBe('ok')
      expect(r.t).toBeCloseTo(t, 12)
      expect(r.df).toBeCloseTo(df, 12)
      expect(r.p).toBeCloseTo(p, 12)
    }
  })

  it('returns the complete Welch result with a Student-t 95% interval', () => {
    const r = welchsTTest([0.4, 0.5, 0.6, 0.55, 0.45, 0.5], [0.7, 0.8, 0.75, 0.72, 0.78, 0.74])
    expect(r).toMatchObject({
      status: 'ok',
      ci95: expect.any(Array),
    })
    expect(r.meanA).toBeCloseTo(0.5, 12)
    expect(r.meanB).toBeCloseTo(0.7483333333333334, 12)
    expect(r.delta).toBeCloseTo(0.2483333333333334, 12)
    expect(r.standardError).toBeCloseTo(0.03260027266416307, 12)
    expect(r.ci95![0]).toBeCloseTo(0.17238725256665494, 12)
    expect(r.ci95![1]).toBeCloseTo(0.3242794141000119, 12)
    expect(r.cohensD).toBeCloseTo(4.397979069861191, 12)
  })

  it('marks fewer than two observations per side as insufficient', () => {
    const r = welchsTTest([1], [2])
    expect(r.status).toBe('insufficient-sample')
    expect(r.meanA).toBe(1)
    expect(r.meanB).toBe(2)
    expect(r.delta).toBe(1)
    expect(r.standardError).toBeNaN()
    expect(r.t).toBeNaN()
    expect(r.df).toBeNaN()
    expect(r.p).toBeNaN()
    expect(r.ci95).toBeNull()
    expect(r.cohensD).toBeNull()
  })

  it('does not fabricate certainty for separated constant samples', () => {
    const r = welchsTTest(Array<number>(32).fill(0.25), Array<number>(32).fill(0.75))
    expect(r.status).toBe('zero-variance')
    expect(r.meanA).toBe(0.25)
    expect(r.meanB).toBe(0.75)
    expect(r.delta).toBe(0.5)
    expect(r.standardError).toBe(0)
    expect(r.t).toBe(Number.POSITIVE_INFINITY)
    expect(r.df).toBeNaN()
    expect(r.p).toBeNaN()
    expect(r.ci95).toBeNull()
    expect(r.cohensD).toBeNull()
  })

  it('drives improved / regressed / stable verdicts off those numbers', () => {
    const report = compareToBaseline([
      {
        metric: 'overallScore',
        higherIsBetter: true,
        baseline: [0.4, 0.5, 0.6, 0.55, 0.45, 0.5],
        candidate: [0.7, 0.8, 0.75, 0.72, 0.78, 0.74],
      },
      {
        metric: 'latencyMs',
        higherIsBetter: false,
        baseline: [100, 101, 102, 103, 100, 101],
        candidate: [100, 102, 101, 103, 101, 100],
      },
    ])
    expect(report.metrics[0]!.verdict).toBe('improved')
    expect(report.metrics[0]!.welchP).toBeCloseTo(8.368400396856913e-5, 12)
    expect(report.metrics[0]!.cohensD).toBeCloseTo(4.397979069861191, 12)
    expect(report.metrics[1]!.verdict).toBe('stable')
    expect(report.hasRegression).toBe(false)
  })

  it('reports a regression in the "worse" direction for a lower-is-better metric', () => {
    const report = compareToBaseline([
      {
        metric: 'latencyMs',
        higherIsBetter: false,
        baseline: [100, 101, 102, 103, 100, 101],
        candidate: [140, 141, 142, 143, 140, 141],
      },
    ])
    expect(report.metrics[0]!.verdict).toBe('regressed')
    expect(report.hasRegression).toBe(true)
  })

  it('does not promote a separated constant sample without defined inference', () => {
    const report = compareToBaseline([
      {
        metric: 'passRate',
        higherIsBetter: true,
        baseline: [0, 0, 0],
        candidate: [1, 1, 1],
      },
    ])
    expect(report.metrics[0]!.cohensD).toBeNull()
    expect(report.metrics[0]!.welchP).toBeNaN()
    expect(report.metrics[0]!.verdict).toBe('stable')
  })
})
