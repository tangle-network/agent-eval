import { describe, expect, it } from 'vitest'
import { randomizedCanaryPower } from './index'

// Sixty repositories, three tasks each: the structure a fleet with a per-repository cap produces.
const sixtyRepositories = Array.from({ length: 60 }, () => 3)

describe('randomized canary power', () => {
  it('holds the false-positive rate under no lift and finds a large lift', () => {
    const result = randomizedCanaryPower({
      clusterSizes: sixtyRepositories,
      controlRate: 0.5,
      intraclusterCorrelation: 0.1,
      lifts: [0, 0.3],
      trials: 600,
      seed: 7,
    })
    const [none, large] = result.curve
    // The decision passes on a 95% interval's low end above zero: about 2.5% under no lift.
    expect(none!.power).toBeLessThan(0.05)
    expect(large!.power).toBeGreaterThan(0.9)
    expect(result.detectableLift).toBe(0.3)
    expect(result.assignments).toBe(180)
  })

  it('counts the refusals the decision makes for too few or dominant repositories', () => {
    const few = randomizedCanaryPower({
      clusterSizes: Array.from({ length: 30 }, () => 4),
      controlRate: 0.5,
      intraclusterCorrelation: 0,
      lifts: [0.3],
      trials: 50,
      seed: 1,
    })
    expect(few.curve[0]!.refusals['insufficient-clusters']).toBe(1)
    expect(few.curve[0]!.power).toBe(0)
    expect(few.detectableLift).toBeNull()

    // One repository with a third of the tasks dominates every arm.
    const dominant = randomizedCanaryPower({
      clusterSizes: [90, ...Array.from({ length: 45 }, () => 4)],
      controlRate: 0.5,
      intraclusterCorrelation: 0,
      lifts: [0.3],
      trials: 50,
      seed: 1,
    })
    expect(dominant.curve[0]!.refusals['dominant-cluster']).toBe(1)
    expect(dominant.curve[0]!.power).toBe(0)
  })
})
