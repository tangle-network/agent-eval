/**
 * clusteredPower: the week's own burns as regression. The {6,3,3,2} structure
 * (14 rows, 4 task clusters) and any 3-cluster structure must be refused at
 * conventional targets — before a dollar is spent — because the exact
 * whole-cluster sign-flip test can never certify at alpha 0.05 below 6
 * clusters, whatever the effect size.
 */

import { describe, expect, it } from 'vitest'
import {
  assertDesignAdequate,
  clusteredPower,
  DesignRefusalError,
  mcnemarPower,
} from '../../src/experiment/index'

describe('clusteredPower refusals (the recorded burns)', () => {
  it('refuses the {6,3,3,2} killtest structure at any effect, including 1.0', () => {
    const result = clusteredPower({
      clusterSizes: [6, 3, 3, 2],
      effects: [0, 0.3, 0.9, 1],
      seed: 20260810,
      trials: 300,
      resamples: 500,
      // largest-eigenval carried outcome noise, not signal (recorded flip 0.30)
      noisyClusters: [{ index: 3, flipRate: 0.3 }],
    })
    expect(result.adequate).toBe(false)
    expect(result.refusal).not.toBeNull()
    expect(result.refusal!.verdict).toBe('underpowered')
    expect(result.refusal!.reasons.join(' ')).toContain(
      '4 clusters cannot certify any effect size, including 1.0',
    )
    expect(result.signFlipFloor.twoSidedP).toBe(0.125)
    expect(result.signFlipFloor.certifiableAtAlpha).toBe(false)
    expect(() => assertDesignAdequate(result)).toThrow(DesignRefusalError)
  })

  it('refuses a 3-cluster design: sign-flip floor 0.25 > alpha 0.05', () => {
    const result = clusteredPower({
      clusterSizes: [5, 5, 5],
      effects: [1],
      seed: 7,
      trials: 200,
      resamples: 400,
    })
    expect(result.signFlipFloor.twoSidedP).toBe(0.25)
    expect(result.adequate).toBe(false)
    expect(() => assertDesignAdequate(result)).toThrow(DesignRefusalError)
  })

  it('reports the smallest certifiable cluster count for alpha 0.05 (six)', () => {
    const result = clusteredPower({
      clusterSizes: [4, 4, 4, 4],
      effects: [1],
      seed: 7,
      trials: 100,
      resamples: 300,
    })
    expect(result.signFlipFloor.minClustersForAlpha).toBe(6)
  })

  it('accepts a 12-cluster design with a large simulated effect', () => {
    const result = clusteredPower({
      clusterSizes: Array.from({ length: 12 }, () => 4),
      effects: [0.5],
      seed: 11,
      trials: 300,
      resamples: 400,
    })
    expect(result.signFlipFloor.certifiableAtAlpha).toBe(true)
    expect(result.maxPower).toBeGreaterThanOrEqual(0.8)
    expect(result.adequate).toBe(true)
    expect(result.refusal).toBeNull()
    expect(() => assertDesignAdequate(result)).not.toThrow()
  })

  it('refuses an adequate cluster count whose simulated power stays under target', () => {
    const result = clusteredPower({
      clusterSizes: Array.from({ length: 8 }, () => 2),
      effects: [0.05],
      seed: 13,
      trials: 300,
      resamples: 400,
    })
    expect(result.signFlipFloor.certifiableAtAlpha).toBe(true)
    expect(result.maxPower).toBeLessThan(0.8)
    expect(result.adequate).toBe(false)
    expect(result.refusal!.reasons.join(' ')).toContain('simulated power tops out')
  })
})

describe('clusteredPower simulation sanity', () => {
  it('is deterministic under the seed', () => {
    const run = () =>
      clusteredPower({
        clusterSizes: [6, 3, 3, 2],
        effects: [0.5],
        seed: 42,
        trials: 200,
        resamples: 300,
      })
    expect(run().curve).toEqual(run().curve)
  })

  it('power is monotone in effect on a fixed structure', () => {
    const result = clusteredPower({
      clusterSizes: Array.from({ length: 10 }, () => 4),
      effects: [0.1, 0.5],
      seed: 21,
      trials: 300,
      resamples: 400,
    })
    expect(result.curve[1]!.power).toBeGreaterThan(result.curve[0]!.power)
  })

  it('approaches the closed-form McNemar power on singleton clusters', () => {
    // 40 one-row clusters, effect 0.3: pw 0.4 / pl 0.1 corresponds to
    // McNemar p10 0.4, p01 0.1 at 40 pairs.
    const simulated = clusteredPower({
      clusterSizes: Array.from({ length: 40 }, () => 1),
      effects: [0.3],
      seed: 99,
      trials: 400,
      resamples: 500,
    })
    const closedForm = mcnemarPower({ p10: 0.4, p01: 0.1, nPairs: 40 })
    expect(Math.abs(simulated.curve[0]!.power - closedForm)).toBeLessThanOrEqual(0.15)
  })

  it('rejects invalid structures loudly', () => {
    expect(() => clusteredPower({ clusterSizes: [], effects: [0.5], seed: 1 })).toThrow(
      /positive integers/,
    )
    expect(() => clusteredPower({ clusterSizes: [3, 0], effects: [0.5], seed: 1 })).toThrow(
      /positive integers/,
    )
    expect(() => clusteredPower({ clusterSizes: [3, 3], effects: [], seed: 1 })).toThrow(
      /grid is empty/,
    )
    expect(() =>
      clusteredPower({
        clusterSizes: [3, 3],
        effects: [0.5],
        seed: 1,
        noisyClusters: [{ index: 5, flipRate: 0.3 }],
      }),
    ).toThrow(/outside/)
  })
})
