import { describe, expect, it } from 'vitest'
import {
  beliefDecisionsToOffPolicyTrajectories,
  embeddedBeliefOpeTargetPolicy,
  evaluateBeliefOffPolicy,
} from './ope'
import type { BeliefDecisionPoint } from './types'

describe('belief-state off-policy evaluation', () => {
  it('converts supported decision points through an explicit target policy', () => {
    const points: BeliefDecisionPoint[] = [
      {
        id: 'd-1',
        runId: 'r-1',
        stepIndex: 0,
        kind: 'continue',
        chosenAction: 'continue',
        behaviorProb: 0.5,
        targetProb: 0.5,
        qHatChosen: 0.7,
        vHatTarget: 0.8,
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

    const report = beliefDecisionsToOffPolicyTrajectories(
      points,
      embeddedBeliefOpeTargetPolicy('logged-threshold-policy'),
    )

    expect(report.targetPolicyId).toBe('logged-threshold-policy')
    expect(report.trajectories).toEqual([
      {
        runId: 'd-1',
        reward: 0.8,
        behaviorProb: 0.5,
        targetProb: 0.5,
        qHatChosen: 0.7,
        vHatTarget: 0.8,
        qHat: undefined,
      },
    ])
    expect(report.dropped).toBe(1)
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

    const report = evaluateBeliefOffPolicy(points, embeddedBeliefOpeTargetPolicy(), {
      minEffectiveSampleSize: 30,
    })

    expect(report.support.supported).toBe(false)
    expect(report.support.reasons.join('\n')).toMatch(/effective sample size/)
  })

  it('turns invalid propensities into unsupported diagnostics instead of throwing', () => {
    const points: BeliefDecisionPoint[] = [
      {
        id: 'zero-behavior',
        runId: 'r-1',
        stepIndex: 0,
        kind: 'continue',
        chosenAction: 'continue',
        behaviorProb: 0,
        targetProb: 0.5,
        evidence: [{ source: 'event', id: 'e-1' }],
        outcome: { score: 1 },
      },
      {
        id: 'negative-behavior',
        runId: 'r-2',
        stepIndex: 0,
        kind: 'continue',
        chosenAction: 'continue',
        behaviorProb: -0.1,
        targetProb: 0.5,
        evidence: [{ source: 'event', id: 'e-2' }],
        outcome: { score: 1 },
      },
      {
        id: 'too-high-target',
        runId: 'r-3',
        stepIndex: 0,
        kind: 'continue',
        chosenAction: 'continue',
        behaviorProb: 0.5,
        targetProb: 1.2,
        evidence: [{ source: 'event', id: 'e-3' }],
        outcome: { score: 1 },
      },
    ]

    const report = evaluateBeliefOffPolicy(points, embeddedBeliefOpeTargetPolicy(), {
      minEffectiveSampleSize: 1,
    })

    expect(report.support.supported).toBe(false)
    expect(report.support.n).toBe(0)
    expect(report.support.dropped).toBe(3)
    expect(report.support.reasons.join('\n')).toMatch(/zero-behavior: invalid behaviorProb 0/)
    expect(report.support.reasons.join('\n')).toMatch(/too-high-target: invalid targetProb 1.2/)
  })

  it('uses the named target policy rather than implicitly trusting embedded target probabilities', () => {
    const points: BeliefDecisionPoint[] = [
      {
        id: 'd-1',
        runId: 'r-1',
        stepIndex: 0,
        kind: 'continue',
        chosenAction: 'continue',
        behaviorProb: 0.5,
        targetProb: 0,
        evidence: [{ source: 'event', id: 'e-1' }],
        outcome: { score: 1 },
      },
    ]

    const report = evaluateBeliefOffPolicy(
      points,
      {
        id: 'explicit-policy',
        targetProbOf: () => 0.5,
      },
      { minEffectiveSampleSize: 1 },
    )

    expect(report.targetPolicyId).toBe('explicit-policy')
    expect(report.ips.value).toBe(1)
  })

  it('plumbs contextual Q callbacks into the doubly-robust estimate', () => {
    const points: BeliefDecisionPoint[] = [
      {
        id: 'action-a',
        runId: 'r-1',
        stepIndex: 0,
        kind: 'continue',
        chosenAction: 'a',
        behaviorProb: 0.5,
        evidence: [{ source: 'event', id: 'e-1' }],
        outcome: { reward: 1 },
      },
      {
        id: 'action-b',
        runId: 'r-2',
        stepIndex: 0,
        kind: 'continue',
        chosenAction: 'b',
        behaviorProb: 0.5,
        evidence: [{ source: 'event', id: 'e-2' }],
        outcome: { reward: 0.2 },
      },
    ]

    const report = evaluateBeliefOffPolicy(
      points,
      {
        id: 'stochastic-policy',
        targetProbOf: (point) => (point.chosenAction === 'a' ? 0.75 : 0.25),
        qHatChosenOf: (point) => (point.chosenAction === 'a' ? 1 : 0.2),
        vHatTargetOf: () => 0.8,
      },
      { minEffectiveSampleSize: 1 },
    )

    expect(report.dr.value).toBeCloseTo(0.8, 12)
    expect(report.dr.contributionCounts).toEqual({ dr: 2, ipsFallback: 0, legacyScalar: 0 })
  })

  it('drops an incomplete contextual Q pair with a diagnostic', () => {
    const points: BeliefDecisionPoint[] = [
      {
        id: 'partial-pair',
        runId: 'r-1',
        stepIndex: 0,
        kind: 'continue',
        chosenAction: 'continue',
        behaviorProb: 0.5,
        evidence: [{ source: 'event', id: 'e-1' }],
        outcome: { reward: 1 },
      },
    ]

    const report = beliefDecisionsToOffPolicyTrajectories(points, {
      id: 'invalid-target-policy',
      targetProbOf: () => 0.5,
      qHatChosenOf: () => 0.6,
    })

    expect(report.trajectories).toEqual([])
    expect(report.dropped).toBe(1)
    expect(report.diagnostics).toEqual([
      'partial-pair: qHatChosen and vHatTarget must be supplied together',
    ])
  })
})
