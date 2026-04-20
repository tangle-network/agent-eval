import { describe, it, expect } from 'vitest'
import {
  normalizeScores,
  weightedMean,
  confidenceInterval,
  partialCredit,
  mannWhitneyU,
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
