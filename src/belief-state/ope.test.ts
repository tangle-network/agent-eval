import { describe, expect, it } from 'vitest'
import { beliefDecisionsToOffPolicyTrajectories, evaluateBeliefOffPolicy } from './ope'
import type { BeliefDecisionPoint } from './types'

describe('belief-state off-policy evaluation', () => {
  it('converts supported decision points to OPE trajectories', () => {
    const points: BeliefDecisionPoint[] = [
      {
        id: 'd-1',
        runId: 'r-1',
        stepIndex: 0,
        kind: 'continue',
        chosenAction: 'continue',
        behaviorProb: 0.5,
        targetProb: 0.5,
        qHat: 0.8,
        evidence: [{ source: 'event', id: 'e-1' }],
        outcome: { score: 0.8 },
      },
      {
        id: 'd-2',
        runId: 'r-2',
        stepIndex: 0,
        kind: 'continue',
        chosenAction: 'continue',
        evidence: [{ source: 'event', id: 'e-2' }],
        outcome: { score: 0.2 },
      },
    ]

    expect(beliefDecisionsToOffPolicyTrajectories(points)).toEqual([
      {
        runId: 'd-1',
        reward: 0.8,
        behaviorProb: 0.5,
        targetProb: 0.5,
        qHat: 0.8,
      },
    ])
  })

  it('surfaces support mismatch when effective sample size is too low', () => {
    const points: BeliefDecisionPoint[] = Array.from({ length: 4 }, (_, index) => ({
      id: `d-${index}`,
      runId: `r-${index}`,
      stepIndex: index,
      kind: 'continue',
      chosenAction: 'continue',
      behaviorProb: index === 0 ? 0.01 : 0.9,
      targetProb: 0.9,
      evidence: [{ source: 'event', id: `e-${index}` }],
      outcome: { score: 0.5 },
    }))

    const report = evaluateBeliefOffPolicy(points, { minEffectiveSampleSize: 30 })

    expect(report).not.toBeNull()
    expect(report!.support.supported).toBe(false)
    expect(report!.support.reasons.join('\n')).toMatch(/effective sample size/)
  })
})
