/**
 * The ensemble reducer's job is to fold N judge verdicts into one trustworthy
 * number. These tests pin the invariants a silent zero would break: a failed
 * judge never counts as zero, all-failed throws, cost includes failures, and
 * the composite/disagreement signals match the per-dimension survivors.
 */

import { describe, expect, it } from 'vitest'

import { aggregateJudgeVerdicts, type JudgeVerdict } from './judge-ensemble'

type Dim = 'accuracy' | 'tone'
const DIMS: readonly Dim[] = ['accuracy', 'tone']

function verdict(model: string, accuracy: number, tone: number, costUsd = 0): JudgeVerdict<Dim> {
  return { model, perDimension: { accuracy, tone }, rationale: `${model} ok`, costUsd }
}

describe('aggregateJudgeVerdicts', () => {
  it('means each dimension over surviving judges', () => {
    const agg = aggregateJudgeVerdicts([verdict('a', 0.8, 0.6), verdict('b', 0.6, 0.4)], DIMS)
    expect(agg.perDimension.accuracy).toBeCloseTo(0.7, 5)
    expect(agg.perDimension.tone).toBeCloseTo(0.5, 5)
    expect(agg.failedJudges).toEqual([])
  })

  it('uniform composite by default = mean of dimension means', () => {
    const agg = aggregateJudgeVerdicts([verdict('a', 0.8, 0.6), verdict('b', 0.6, 0.4)], DIMS)
    // ((0.7)+(0.5))/2 = 0.6
    expect(agg.composite).toBeCloseTo(0.6, 5)
  })

  it('weights select-and-weight named dimensions', () => {
    const agg = aggregateJudgeVerdicts([verdict('a', 1, 0)], DIMS, { accuracy: 1 })
    // only accuracy weighted → composite = accuracy mean = 1
    expect(agg.composite).toBeCloseTo(1, 5)
  })

  it('records a failed judge without folding it into a zero', () => {
    const agg = aggregateJudgeVerdicts(
      [verdict('a', 0.9, 0.9), { model: 'b', perDimension: null }],
      DIMS,
    )
    expect(agg.failedJudges).toEqual(['b'])
    // mean over the ONE survivor, not (0.9 + 0)/2
    expect(agg.perDimension.accuracy).toBeCloseTo(0.9, 5)
  })

  it('throws fail-loud when every judge failed', () => {
    expect(() =>
      aggregateJudgeVerdicts(
        [
          { model: 'a', perDimension: null },
          { model: 'b', perDimension: null },
        ],
        DIMS,
      ),
    ).toThrow(/all 2 judges failed/)
  })

  it('sums cost across ALL verdicts including failed ones', () => {
    const agg = aggregateJudgeVerdicts(
      [verdict('a', 0.5, 0.5, 0.01), { model: 'b', perDimension: null, costUsd: 0.02 }],
      DIMS,
    )
    expect(agg.costUsd).toBeCloseTo(0.03, 5)
  })

  it('reports max per-dimension disagreement spread across survivors', () => {
    const agg = aggregateJudgeVerdicts([verdict('a', 0.9, 0.5), verdict('b', 0.3, 0.5)], DIMS)
    // accuracy spread 0.6, tone spread 0 → max 0.6
    expect(agg.maxDisagreement).toBeCloseTo(0.6, 5)
  })

  it('clamps out-of-range judge scores into [0,1]', () => {
    const agg = aggregateJudgeVerdicts(
      [{ model: 'a', perDimension: { accuracy: 1.5, tone: -0.5 } }],
      DIMS,
    )
    expect(agg.perDimension.accuracy).toBe(1)
    expect(agg.perDimension.tone).toBe(0)
  })

  it('throws on empty inputs', () => {
    expect(() => aggregateJudgeVerdicts([], DIMS)).toThrow(/no verdicts/)
    expect(() => aggregateJudgeVerdicts([verdict('a', 1, 1)], [])).toThrow(/dimensionKeys is empty/)
  })

  it('carries the first non-empty survivor rationale', () => {
    const agg = aggregateJudgeVerdicts(
      [
        { model: 'a', perDimension: null, rationale: 'failed' },
        { model: 'b', perDimension: { accuracy: 1, tone: 1 }, rationale: 'looks right' },
      ],
      DIMS,
    )
    expect(agg.rationale).toBe('looks right')
  })

  it('suffixes model-id collisions so repeat votes are not overwritten', () => {
    const agg = aggregateJudgeVerdicts(
      [verdict('a', 0.2, 0.2), verdict('a', 0.4, 0.4), verdict('a', 0.6, 0.6)],
      DIMS,
    )
    expect(Object.keys(agg.perJudge).sort()).toEqual(['a', 'a#2', 'a#3'])
    expect(agg.perJudge['a#2']!.accuracy).toBeCloseTo(0.4, 5)
    // All three votes count in the mean — not just the last one.
    expect(agg.perDimension.accuracy).toBeCloseTo(0.4, 5)
  })

  it('suffixes collisions in failedJudges too', () => {
    const agg = aggregateJudgeVerdicts(
      [
        verdict('a', 0.5, 0.5),
        { model: 'a', perDimension: null },
        { model: 'a', perDimension: null },
      ],
      DIMS,
    )
    expect(agg.failedJudges).toEqual(['a#2', 'a#3'])
    expect(Object.keys(agg.perJudge)).toEqual(['a'])
  })

  it('detail is carried through verbatim and ignored by the math', () => {
    const withDetail: JudgeVerdict<Dim> = {
      model: 'a',
      perDimension: { accuracy: 0.8, tone: 0.6 },
      detail: { accuracy: { reasoning: 'cites the source', evidence: 'line 3' } },
    }
    const agg = aggregateJudgeVerdicts([withDetail, verdict('b', 0.6, 0.4)], DIMS)
    expect(agg.perDimension.accuracy).toBeCloseTo(0.7, 5)
    expect(agg.verdicts[0]!.detail).toEqual({
      accuracy: { reasoning: 'cites the source', evidence: 'line 3' },
    })
  })

  it('exposes the input verdicts verbatim on the aggregate', () => {
    const inputs = [verdict('a', 0.9, 0.9), { model: 'b', perDimension: null }]
    const agg = aggregateJudgeVerdicts(inputs, DIMS)
    expect(agg.verdicts).toEqual(inputs)
  })
})
