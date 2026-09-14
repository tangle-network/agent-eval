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
      minimumEffect: 0.3,
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
      minimumEffect: 1,
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
      minimumEffect: 1,
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
      minimumEffect: 0.5,
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
      minimumEffect: 0.05,
      seed: 13,
      trials: 300,
      resamples: 400,
    })
    expect(result.signFlipFloor.certifiableAtAlpha).toBe(true)
    expect(result.maxPower).toBeLessThan(0.8)
    expect(result.adequate).toBe(false)
    expect(result.refusal!.reasons.join(' ')).toContain('at minimum worthwhile effect 0.05')
  })
})

describe('clusteredPower simulation sanity', () => {
  it('is deterministic under the seed', () => {
    const run = () =>
      clusteredPower({
        clusterSizes: [6, 3, 3, 2],
        effects: [0.5],
        minimumEffect: 0.5,
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
      minimumEffect: 0.1,
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
      minimumEffect: 0.3,
      seed: 99,
      trials: 400,
      resamples: 500,
    })
    const closedForm = mcnemarPower({ p10: 0.4, p01: 0.1, nPairs: 40 })
    expect(Math.abs(simulated.curve[0]!.power - closedForm)).toBeLessThanOrEqual(0.15)
  })

  it('rejects invalid structures loudly', () => {
    expect(() =>
      clusteredPower({ clusterSizes: [], effects: [0.5], minimumEffect: 0.5, seed: 1 }),
    ).toThrow(/positive integers/)
    expect(() =>
      clusteredPower({ clusterSizes: [3, 0], effects: [0.5], minimumEffect: 0.5, seed: 1 }),
    ).toThrow(/positive integers/)
    expect(() =>
      clusteredPower({ clusterSizes: [3, 3], effects: [], minimumEffect: 0.5, seed: 1 }),
    ).toThrow(/grid is empty/)
    expect(() =>
      clusteredPower({
        clusterSizes: [3, 3],
        effects: [0.5],
        minimumEffect: 0.5,
        seed: 1,
        noisyClusters: [{ index: 5, flipRate: 0.3 }],
      }),
    ).toThrow(/outside/)
  })

  it('refuses a design powerful only at effects larger than the worthwhile effect', () => {
    const result = clusteredPower({
      clusterSizes: Array.from({ length: 12 }, () => 4),
      effects: [0.01, 1],
      minimumEffect: 0.01,
      seed: 31,
      trials: 200,
      resamples: 300,
    })
    expect(result.maxPower).toBe(1)
    expect(result.powerAtMinimumEffect).toBeLessThan(0.8)
    expect(result.adequate).toBe(false)
    expect(() => assertDesignAdequate(result)).toThrow(/minimum worthwhile effect 0.01/)
  })

  it('requires the worthwhile effect and finite probability parameters before simulation', () => {
    const options = {
      clusterSizes: [4, 4, 4, 4, 4, 4],
      effects: [0.5],
      minimumEffect: 0.5,
      seed: 1,
    }
    expect(() => clusteredPower({ ...options, minimumEffect: 0.1 })).toThrow(
      /contain minimumEffect/,
    )
    expect(() => clusteredPower({ ...options, minimumEffect: NaN })).toThrow(/minimumEffect/)
    expect(() => clusteredPower({ ...options, effects: [0.5, 0.5] })).toThrow(/unique/)
    expect(() => clusteredPower({ ...options, alpha: 0 })).toThrow(/alpha/)
    expect(() => clusteredPower({ ...options, confidence: NaN })).toThrow(/confidence/)
    expect(() => clusteredPower({ ...options, targetPower: 2 })).toThrow(/targetPower/)
    expect(() => clusteredPower({ ...options, baseWinRate: 0.9, baseLossRate: 0.9 })).toThrow(
      /sum to at most/,
    )
    expect(() => clusteredPower({ ...options, baseWinRate: 0.2, baseLossRate: 0.1 })).toThrow(
      /zero-effect model/,
    )
    expect(() =>
      clusteredPower({ ...options, noisyClusters: [{ index: 1, flipRate: -0.1 }] }),
    ).toThrow(/flipRate/)
  })

  it('does not replace a large non-deterministic effect with perfect wins by clipping probabilities', () => {
    const result = clusteredPower({
      clusterSizes: Array.from({ length: 40 }, () => 1),
      effects: [0.9],
      minimumEffect: 0.9,
      seed: 39,
      trials: 200,
      resamples: 300,
    })
    expect(result.curve[0]!.medianCiWidth).toBeGreaterThan(0.05)
  })
})
