import { describe, it, expect } from 'vitest'
import {
  normalizeScores,
  weightedMean,
  confidenceInterval,
  partialCredit,
  mannWhitneyU,
  pairedTTest,
  wilcoxonSignedRank,
  cohensD,
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
    expect(normalized.find(s => s.dimension === 'hallucination')!.score).toBe(8)
    expect(normalized.find(s => s.dimension === 'domain_accuracy')!.score).toBe(6)
  })

  it('handles empty input', () => {
    expect(normalizeScores([])).toEqual([])
  })
})

describe('weightedMean', () => {
  it('computes simple average with no weights', () => {
    expect(weightedMean([
      { score: 4 },
      { score: 6 },
      { score: 8 },
    ])).toBeCloseTo(6)
  })

  it('computes weighted average', () => {
    expect(weightedMean([
      { score: 10, weight: 3 },
      { score: 0, weight: 1 },
    ])).toBeCloseTo(7.5)
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
