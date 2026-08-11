import { describe, expect, it } from 'vitest'
import type { JudgeScore } from '../types'
import {
  type CorpusScoreRecord,
  corpusInterRaterAgreement,
  corpusInterRaterAgreementFromJudgeScores,
  interRaterReliability,
} from './index'

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
