import { describe, expect, it } from 'vitest'
import {
  decideReferenceReplayPromotion,
  scoreReferenceReplay,
  type ReferenceReplayScenario,
} from '../src/reference-replay'

describe('reference replay', () => {
  it('scores hidden references after execution and keeps unmatched candidates as false positives', () => {
    const score = scoreReferenceReplay([
      {
        id: 'case-1',
        split: 'dev',
        references: [
          { id: 'r1', title: 'missing authorization on withdrawal', tags: ['auth'], severity: 'high' },
          { id: 'r2', title: 'stale oracle price accepted', tags: ['oracle'], severity: 'medium' },
        ],
        candidates: [
          { id: 'c1', title: 'withdrawal authorization bypass', tags: ['auth'], severity: 'high' },
          { id: 'c2', title: 'unrelated gas optimization', tags: ['gas'], severity: 'low' },
        ],
      },
    ])

    expect(score.aggregate.matched).toBe(1)
    expect(score.aggregate.total).toBe(2)
    expect(score.aggregate.falsePositives).toBe(1)
    expect(score.aggregate.precision).toBeCloseTo(0.5)
    expect(score.aggregate.recall).toBeCloseTo(0.5)
  })

  it('excludes holdout by default and includes it only when explicitly requested', () => {
    const scenarios = [
      scenario('train-case', 'train', true),
      scenario('holdout-case', 'holdout', true),
    ]

    expect(scoreReferenceReplay(scenarios).scenarios.map((s) => s.scenarioId)).toEqual(['train-case'])
    expect(scoreReferenceReplay(scenarios, { includeHoldout: true }).scenarios.map((s) => s.scenarioId)).toEqual([
      'train-case',
      'holdout-case',
    ])
  })

  it('uses greedy one-to-one matching so duplicate candidates do not inflate recall', () => {
    const score = scoreReferenceReplay([
      {
        id: 'case-1',
        split: 'dev',
        references: [
          { id: 'r1', title: 'unsafe callback reentrancy' },
          { id: 'r2', title: 'precision loss in fee accounting' },
        ],
        candidates: [
          { id: 'c1', title: 'unsafe callback reentrancy' },
          { id: 'c2', title: 'unsafe callback reentrancy duplicate' },
        ],
      },
    ])

    expect(score.scenarios[0].matched).toBe(1)
    expect(score.scenarios[0].falsePositives).toBe(1)
  })

  it('promotes only when required splits improve and holdout does not regress', () => {
    const baseline = scoreReferenceReplay([
      scenario('dev-1', 'dev', false),
      scenario('test-1', 'test', false),
      scenario('holdout-1', 'holdout', true),
    ], { includeHoldout: true })
    const candidate = scoreReferenceReplay([
      scenario('dev-1', 'dev', true),
      scenario('test-1', 'test', true),
      scenario('holdout-1', 'holdout', true),
    ], { includeHoldout: true })

    const decision = decideReferenceReplayPromotion(baseline, candidate, { minF1Delta: 0.1 })
    expect(decision.promote).toBe(true)
    expect(decision.regressions).toHaveLength(0)
  })

  it('rejects candidate variants that improve dev but regress holdout', () => {
    const baseline = scoreReferenceReplay([
      scenario('dev-1', 'dev', false),
      scenario('holdout-1', 'holdout', true),
    ], { includeHoldout: true })
    const candidate = scoreReferenceReplay([
      scenario('dev-1', 'dev', true),
      scenario('holdout-1', 'holdout', false),
    ], { includeHoldout: true })

    const decision = decideReferenceReplayPromotion(baseline, candidate, {
      requiredSplits: ['dev'],
      requireHoldoutNonRegression: true,
    })
    expect(decision.promote).toBe(false)
    expect(decision.reason).toMatch(/Regression in holdout/)
  })
})

function scenario(id: string, split: ReferenceReplayScenario['split'], matched: boolean): ReferenceReplayScenario {
  return {
    id,
    split,
    references: [{ id: 'r1', title: 'admin can drain funds through unchecked transfer', tags: ['auth'] }],
    candidates: matched
      ? [{ id: 'c1', title: 'unchecked transfer lets admin drain funds', tags: ['auth'] }]
      : [{ id: 'c1', title: 'button label alignment issue', tags: ['ui'] }],
  }
}
