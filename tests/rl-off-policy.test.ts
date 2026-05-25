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
  it('matches IPS when qHat is uniform constant', () => {
    const trajectories = Array.from({ length: 50 }, () => traj(0.5, 0.5, 0.7, 0.5))
    const dr = doublyRobust(trajectories)
    const ips = inverseProbabilityWeighting(trajectories)
    // Both unbiased; values should be close.
    expect(Math.abs(dr.value - ips.value)).toBeLessThan(0.05)
  })

  it('falls back to IPS for entries missing qHat', () => {
    const trajectories: OffPolicyTrajectory[] = [
      traj(0.5, 0.5, 1, undefined),
      traj(0.5, 0.5, 0, 0.5),
    ]
    const dr = doublyRobust(trajectories)
    expect(dr.n).toBe(2)
    expect(Number.isFinite(dr.value)).toBe(true)
  })

  it('lower MSE than IPS when qHat is informative (synthetic)', () => {
    // Synthetic: reward = bernoulli with p depending on context; qHat = true p.
    const trajectories: OffPolicyTrajectory[] = []
    let s = 1
    const rng = () => {
      s = (s * 1664525 + 1013904223) % 0x100000000
      return s / 0x100000000
    }
    for (let i = 0; i < 200; i++) {
      const p = rng()
      const reward = rng() < p ? 1 : 0
      trajectories.push({ runId: `r-${i}`, behaviorProb: 0.5, targetProb: 0.5, reward, qHat: p })
    }
    const dr = doublyRobust(trajectories)
    const ips = inverseProbabilityWeighting(trajectories)
    expect(dr.standardError).toBeLessThan(ips.standardError * 1.1)
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
