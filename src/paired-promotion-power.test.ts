import { describe, expect, it } from 'vitest'
import {
  type PairedPromotionAlternative,
  type PairedPromotionPowerCall,
  pairedPromotionPower,
  requiredPairsForPairedPromotion,
} from './paired-promotion-power'

/**
 * Discovery's registered E1 alternative (tangle-network/discovery, E1
 * preregistration section 1): the pass/fail cell is drawn first, the delta on
 * contributions per million tokens given the cell. Non-tie win probability
 * (0.70 * 0.879 + 0.15) / 0.90 = 0.85, tie rate 0.10.
 */
const e1: PairedPromotionAlternative = {
  cells: [
    {
      probability: 0.7,
      pass: { control: true, treatment: true },
      delta: {
        kind: 'atoms',
        atoms: [
          { value: 1.0, probability: 0.879 },
          { value: -0.5, probability: 0.121 },
        ],
      },
    },
    {
      probability: 0.15,
      pass: { control: false, treatment: true },
      delta: { kind: 'point', value: 1.0 },
    },
    {
      probability: 0.05,
      pass: { control: true, treatment: false },
      delta: { kind: 'point', value: -0.5 },
    },
    {
      probability: 0.1,
      pass: { control: false, treatment: false },
      delta: { kind: 'point', value: 0 },
    },
  ],
}

/** The two sealed E1 calls, minus the n they are sealed with. */
const primary: PairedPromotionPowerCall = {
  outcome: 'delta',
  options: {
    threshold: 0.5,
    confidence: 0.95,
    statistic: 'mean',
    resamples: 400,
    seed: 20260923,
    continuous: true,
  },
}
const veto: PairedPromotionPowerCall = {
  outcome: 'pass',
  options: { threshold: -0.1, confidence: 0.95, binaryScale: 1, seed: 20260923 },
}

describe('pairedPromotionPower validation', () => {
  it('refuses cells that do not sum to one', () => {
    expect(() =>
      pairedPromotionPower({
        n: 20,
        alternative: { cells: [{ probability: 0.5, delta: { kind: 'point', value: 1 } }] },
        calls: [primary],
        simulations: 10,
      }),
    ).toThrow(/must sum to 1/)
  })

  it("refuses a 'pass' call when a cell carries no pass outcome", () => {
    expect(() =>
      pairedPromotionPower({
        n: 20,
        alternative: { cells: [{ probability: 1, delta: { kind: 'point', value: 1 } }] },
        calls: [veto],
        simulations: 10,
      }),
    ).toThrow(/pass must give control and treatment booleans/)
  })

  it('refuses an empty call list and a bad n', () => {
    expect(() =>
      pairedPromotionPower({ n: 20, alternative: e1, calls: [], simulations: 10 }),
    ).toThrow(/at least one call/)
    expect(() =>
      pairedPromotionPower({ n: 0, alternative: e1, calls: [primary], simulations: 10 }),
    ).toThrow(/positive integer/)
  })
})

describe('pairedPromotionPower under the E1 alternative', () => {
  it('is deterministic for a seed and reports its Monte Carlo error', () => {
    const a = pairedPromotionPower({
      n: 24,
      alternative: e1,
      calls: [primary, veto],
      simulations: 200,
      seed: 7,
    })
    const b = pairedPromotionPower({
      n: 24,
      alternative: e1,
      calls: [primary, veto],
      simulations: 200,
      seed: 7,
    })
    expect(a).toEqual(b)
    expect(a.standardError).toBeCloseTo(Math.sqrt((a.power * (1 - a.power)) / 200), 12)
    expect(a.low).toBeLessThanOrEqual(a.power)
    expect(a.high).toBeGreaterThanOrEqual(a.power)
    expect(a.power + a.refuse + a.hold).toBeCloseTo(1, 12)
  })

  it('joint power is at most the weakest call and rises with n', () => {
    const at20 = pairedPromotionPower({
      n: 20,
      alternative: e1,
      calls: [primary, veto],
      simulations: 300,
      seed: 3,
    })
    const at40 = pairedPromotionPower({
      n: 40,
      alternative: e1,
      calls: [primary, veto],
      simulations: 300,
      seed: 3,
    })
    for (const r of [at20, at40]) {
      expect(r.power).toBeLessThanOrEqual(Math.min(...r.calls.map((c) => c.promote)) + 1e-12)
    }
    expect(at40.power).toBeGreaterThan(at20.power)
  })

  it('below the bootstrap floor every simulation refuses on sufficiency', () => {
    const r = pairedPromotionPower({
      n: 12,
      alternative: e1,
      calls: [primary],
      simulations: 50,
      seed: 1,
    })
    expect(r.power).toBe(0)
    expect(r.calls[0]!.insufficient).toBe(1)
    expect(r.calls[0]!.methods['exact-sign']).toBe(1)
  })
})

describe('the sealed route', () => {
  // The measured motive for `continuous`: on a zero baseline the E1 deltas
  // {+1, -0.5, 0} give a sample on {0, 1} whenever no -0.5 is drawn, and the
  // inferred shape then decides it on the score interval instead of the sealed
  // bootstrap.
  it('without continuous, an all-{0,1} sample re-routes to the score interval; with it, never', () => {
    const inferred: PairedPromotionPowerCall = {
      outcome: 'delta',
      options: { ...primary.options, continuous: undefined },
    }
    const loose = pairedPromotionPower({
      n: 20,
      alternative: e1,
      calls: [inferred],
      simulations: 400,
      seed: 11,
    })
    const sealed = pairedPromotionPower({
      n: 20,
      alternative: e1,
      calls: [primary],
      simulations: 400,
      seed: 11,
    })
    expect(loose.calls[0]!.methods['score-interval'] ?? 0).toBeGreaterThan(0)
    expect(sealed.calls[0]!.methods['score-interval'] ?? 0).toBe(0)
    expect(sealed.calls[0]!.methods['bootstrap-ci']).toBe(1)
  })
})

describe('under a null the promotion rate stays at the nominal level', () => {
  it('symmetric deltas around a zero threshold promote in about 2.5 % of samples', () => {
    const nullLaw: PairedPromotionAlternative = {
      cells: [{ probability: 1, delta: { kind: 'normal', mean: 0, sd: 1 } }],
    }
    const r = pairedPromotionPower({
      n: 30,
      alternative: nullLaw,
      calls: [
        {
          outcome: 'delta',
          options: {
            threshold: 0,
            confidence: 0.95,
            statistic: 'mean',
            resamples: 400,
            seed: 5,
            continuous: true,
          },
        },
      ],
      simulations: 600,
      seed: 9,
    })
    // One-sided 2.5 % by construction of the 95 % interval; the percentile
    // bootstrap runs a little liberal at n = 30, so allow up to 7 %.
    expect(r.power).toBeLessThan(0.07)
  })
})

describe('requiredPairsForPairedPromotion', () => {
  it('returns the first n at the target and the first n whose lower bound reaches it', () => {
    const r = requiredPairsForPairedPromotion({
      target: 0.5,
      alternative: e1,
      calls: [primary, veto],
      minPairs: 20,
      maxPairs: 40,
      simulations: 120,
      seed: 2,
    })
    expect(r.n).not.toBeNull()
    expect(r.curve[0]!.n).toBe(20)
    const first = r.curve.find((p) => p.power >= 0.5)
    expect(first?.n).toBe(r.n)
    if (r.nAtLowerBound !== null) {
      expect(r.nAtLowerBound).toBeGreaterThanOrEqual(r.n!)
      expect(r.curve[r.curve.length - 1]!.n).toBe(r.nAtLowerBound)
    }
  })

  it('reports null when maxPairs is exhausted', () => {
    const r = requiredPairsForPairedPromotion({
      target: 0.99,
      alternative: e1,
      calls: [primary, veto],
      minPairs: 20,
      maxPairs: 21,
      simulations: 40,
      seed: 2,
    })
    expect(r.n).toBeNull()
    expect(r.nAtLowerBound).toBeNull()
    expect(r.curve.map((p) => p.n)).toEqual([20, 21])
  })
})
