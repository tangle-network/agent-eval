import { describe, expect, it } from 'vitest'
import type { OffPolicyTrajectory } from '../src/rl/off-policy'
import {
  doublyRobust,
  inverseProbabilityWeighting,
  offPolicyEstimateAll,
  selfNormalizedImportanceWeighting,
} from '../src/rl/off-policy'

function traj(
  behavior: number,
  target: number,
  reward: number,
  qHat?: number,
): OffPolicyTrajectory {
  return {
    runId: `t-${Math.random()}`,
    behaviorProb: behavior,
    targetProb: target,
    reward,
    qHat,
  }
}

describe('IPS', () => {
  it('recovers the behavior policy value when behavior == target', () => {
    const trajectories = Array.from({ length: 200 }, (_, i) => traj(0.5, 0.5, i % 2 === 0 ? 1 : 0))
    const out = inverseProbabilityWeighting(trajectories)
    expect(out.value).toBeCloseTo(0.5, 1)
    expect(out.maxImportanceWeight).toBe(1)
  })

  it('upweights matched actions and downweights the rest', () => {
    // Behavior assigns 0.1 to a high-reward action; target assigns 0.9.
    // IPS should report a value close to 0.9 (importance ratio = 9).
    const trajectories: OffPolicyTrajectory[] = []
    for (let i = 0; i < 100; i++) {
      const isHigh = i % 10 === 0
      trajectories.push({
        runId: `r-${i}`,
        behaviorProb: isHigh ? 0.1 : 0.1,
        targetProb: isHigh ? 0.9 : 0.1,
        reward: isHigh ? 1 : 0,
      })
    }
    const out = inverseProbabilityWeighting(trajectories)
    expect(out.value).toBeGreaterThan(0.7)
    expect(out.maxImportanceWeight).toBe(9)
  })

  it('throws when behaviorProb is 0', () => {
    expect(() => inverseProbabilityWeighting([traj(0, 0.5, 1)])).toThrow(/behaviorProb must be > 0/)
  })

  it('weight cap reduces variance at the cost of bias', () => {
    const trajectories: OffPolicyTrajectory[] = []
    for (let i = 0; i < 50; i++) trajectories.push(traj(0.01, 0.5, 1))
    const uncapped = inverseProbabilityWeighting(trajectories)
    const capped = inverseProbabilityWeighting(trajectories, { weightCap: 5 })
    expect(uncapped.maxImportanceWeight).toBe(50)
    expect(capped.maxImportanceWeight).toBe(5)
    expect(capped.value).toBeLessThan(uncapped.value)
  })
})

describe('SNIPS', () => {
  it('returns a value bounded by min/max realized rewards', () => {
    const trajectories = Array.from({ length: 50 }, (_, i) => traj(0.3, 0.7, i / 50))
    const out = selfNormalizedImportanceWeighting(trajectories)
    expect(out.value).toBeGreaterThanOrEqual(0)
    expect(out.value).toBeLessThanOrEqual(1)
  })

  it('lower variance than vanilla IPS on the same data', () => {
    const trajectories: OffPolicyTrajectory[] = []
    for (let i = 0; i < 100; i++) {
      trajectories.push(traj(0.05, 0.5, i % 2))
    }
    const ips = inverseProbabilityWeighting(trajectories)
    const snips = selfNormalizedImportanceWeighting(trajectories)
    expect(snips.standardError).toBeLessThanOrEqual(ips.standardError)
  })
})

describe('Doubly-robust', () => {
  it('recovers a stochastic target value of 0.8 with a perfect Q-function', () => {
    const trajectories: OffPolicyTrajectory[] = [
      {
        runId: 'action-a',
        behaviorProb: 0.5,
        targetProb: 0.75,
        reward: 1,
        qHatChosen: 1,
        vHatTarget: 0.8,
      },
      {
        runId: 'action-b',
        behaviorProb: 0.5,
        targetProb: 0.25,
        reward: 0.2,
        qHatChosen: 0.2,
        vHatTarget: 0.8,
      },
    ]

    const dr = doublyRobust(trajectories)

    expect(dr.value).toBeCloseTo(0.8, 12)
    expect(dr.contributionCounts).toEqual({ dr: 2, ipsFallback: 0, legacyScalar: 0 })
  })

  it('is unbiased with correct propensities even when the Q-function is wrong', () => {
    const trajectories: OffPolicyTrajectory[] = [
      {
        runId: 'action-a',
        behaviorProb: 0.5,
        targetProb: 0.8,
        reward: 1,
        qHatChosen: 0.4,
        vHatTarget: 0.4,
      },
      {
        runId: 'action-b',
        behaviorProb: 0.5,
        targetProb: 0.2,
        reward: 0,
        qHatChosen: 0.4,
        vHatTarget: 0.4,
      },
    ]

    const dr = doublyRobust(trajectories)

    expect(dr.value).toBeCloseTo(0.8, 12)
  })

  it('handles a deterministic target policy', () => {
    const trajectories: OffPolicyTrajectory[] = [
      {
        runId: 'selected-action',
        behaviorProb: 0.5,
        targetProb: 1,
        reward: 1,
        qHatChosen: 0.7,
        vHatTarget: 0.7,
      },
      {
        runId: 'rejected-action',
        behaviorProb: 0.5,
        targetProb: 0,
        reward: 0,
        qHatChosen: 0.3,
        vHatTarget: 0.7,
      },
    ]

    const dr = doublyRobust(trajectories)

    expect(dr.value).toBeCloseTo(1, 12)
  })

  it.each([
    { qHatChosen: 0.4 },
    { vHatTarget: 0.4 },
  ])('rejects an incomplete contextual Q pair: %o', (estimates) => {
    expect(() =>
      doublyRobust([
        {
          runId: 'partial-pair',
          behaviorProb: 0.5,
          targetProb: 0.5,
          reward: 1,
          ...estimates,
        },
      ]),
    ).toThrow(/qHatChosen and vHatTarget must be supplied together/)
  })

  it('uses exact IPS and reports it when no reward-model estimate is supplied', () => {
    const trajectories: OffPolicyTrajectory[] = [traj(0.5, 0.75, 1), traj(0.5, 0.25, 0)]

    const dr = doublyRobust(trajectories)
    const ips = inverseProbabilityWeighting(trajectories)

    expect(dr.value).toBe(ips.value)
    expect(dr.contributionCounts).toEqual({ dr: 0, ipsFallback: 2, legacyScalar: 0 })
  })

  it('preserves the deprecated scalar formula', () => {
    const dr = doublyRobust([
      {
        runId: 'legacy-scalar',
        behaviorProb: 0.5,
        targetProb: 0.75,
        reward: 1,
        qHat: 0.4,
      },
    ])

    expect(dr.value).toBeCloseTo(1.3, 12)
    expect(dr.contributionCounts).toEqual({ dr: 0, ipsFallback: 0, legacyScalar: 1 })
  })

  it('prefers the contextual pair when the deprecated scalar is also present', () => {
    const dr = doublyRobust([
      {
        runId: 'gradual-migration',
        behaviorProb: 0.5,
        targetProb: 0.5,
        reward: 1,
        qHatChosen: 0.6,
        vHatTarget: 0.8,
        qHat: 0,
      },
    ])

    expect(dr.value).toBeCloseTo(1.2, 12)
    expect(dr.contributionCounts).toEqual({ dr: 1, ipsFallback: 0, legacyScalar: 0 })
  })
})

describe('offPolicyEstimateAll', () => {
  it('runs all three estimators side-by-side', () => {
    const trajectories = Array.from({ length: 30 }, () => traj(0.5, 0.5, 0.5, 0.5))
    const out = offPolicyEstimateAll(trajectories)
    expect(out.ips.n).toBe(30)
    expect(out.snips.n).toBe(30)
    expect(out.dr.n).toBe(30)
  })
})
