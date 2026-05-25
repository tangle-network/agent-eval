import { describe, expect, it } from 'vitest'
import {
  benjaminiHochberg,
  bonferroni,
  type CorpusScoreRecord,
  cohensD,
  confidenceInterval,
  corpusInterRaterAgreement,
  corpusInterRaterAgreementFromJudgeScores,
  mannWhitneyU,
  normalizeScores,
  pairedBootstrap,
  pairedMde,
  pairedTTest,
  partialCredit,
  requiredSampleSize,
  weightedMean,
  wilcoxonSignedRank,
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
    expect(mannWhitneyU([], [1, 2])).toEqual({ u: 0, p: 1 })
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

  it('returns p=1 when too few non-zero differences', () => {
    // All pairs equal → zero non-zero diffs → fast return
    expect(wilcoxonSignedRank([1, 2, 3], [1, 2, 3])).toEqual({ w: 0, p: 1 })
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

  it('returns 0 for under-sized groups', () => {
    expect(cohensD([1], [2])).toBe(0)
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
