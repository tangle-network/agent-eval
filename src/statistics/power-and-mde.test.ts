import { describe, expect, it } from 'vitest'
import {
  mcnemarPower,
  mcnemarRequiredN,
  pairedMde,
  requiredPairedSampleSize,
  requiredSampleSize,
} from './index'

describe('requiredSampleSize', () => {
  it('returns Infinity on non-positive effect', () => {
    expect(requiredSampleSize({ effect: 0 })).toBe(Infinity)
    expect(requiredSampleSize({ effect: -0.2 })).toBe(Infinity)
  })

  it("gives the expected N for Cohen's d=0.5 at 80% power, alpha=0.05, two-sided", () => {
    const n = requiredSampleSize({ effect: 0.5 })
    // Classical answer: ~63 per arm. Allow ±3 for approximation.
    expect(n).toBeGreaterThanOrEqual(60)
    expect(n).toBeLessThanOrEqual(66)
  })

  it('larger effect → smaller N', () => {
    const small = requiredSampleSize({ effect: 0.2 })
    const large = requiredSampleSize({ effect: 0.8 })
    expect(large).toBeLessThan(small)
  })
})

describe('requiredPairedSampleSize', () => {
  it('uses the paired design formula', () => {
    const paired = requiredPairedSampleSize({ effect: 0.5 })
    const independent = requiredSampleSize({ effect: 0.5 })
    expect(paired).toBeGreaterThan(0)
    expect(paired).toBeLessThan(independent)
  })

  it('returns Infinity when no finite positive effect is available', () => {
    expect(requiredPairedSampleSize({ effect: 0 })).toBe(Infinity)
    expect(requiredPairedSampleSize({ effect: Number.NaN })).toBe(Infinity)
  })
})

describe('pairedMde', () => {
  it('returns Infinity on non-positive sample size', () => {
    expect(pairedMde({ nPaired: 0 })).toBe(Infinity)
    expect(pairedMde({ nPaired: -5 })).toBe(Infinity)
  })

  it('shrinks as paired N grows', () => {
    const small = pairedMde({ nPaired: 16 })
    const large = pairedMde({ nPaired: 100 })
    expect(large).toBeLessThan(small)
    expect(large).toBeGreaterThan(0)
  })
})

describe('mcnemarRequiredN / mcnemarPower — paired-binary power', () => {
  it('matches the closed-form sample size for a known config', () => {
    // p10=0.25, p01=0.05, two-sided alpha=0.05, power=0.8 → 57 pairs (Lachin).
    expect(mcnemarRequiredN({ p10: 0.25, p01: 0.05, power: 0.8 })).toBe(57)
  })

  it('needs more pairs for a smaller effect, fewer for a larger one', () => {
    const big = mcnemarRequiredN({ p10: 0.4, p01: 0.05 })
    const small = mcnemarRequiredN({ p10: 0.2, p01: 0.15 })
    expect(small).toBeGreaterThan(big)
  })

  it('needs more pairs for higher target power', () => {
    const p80 = mcnemarRequiredN({ p10: 0.3, p01: 0.1, power: 0.8 })
    const p90 = mcnemarRequiredN({ p10: 0.3, p01: 0.1, power: 0.9 })
    expect(p90).toBeGreaterThan(p80)
  })

  it('no effect (p10 === p01) ⇒ Infinity pairs', () => {
    expect(mcnemarRequiredN({ p10: 0.1, p01: 0.1 })).toBe(Infinity)
  })

  it('power at the required N reaches the target (asymptotic, ceil ⇒ ≥)', () => {
    const n = mcnemarRequiredN({ p10: 0.25, p01: 0.05, power: 0.8 })
    expect(mcnemarPower({ p10: 0.25, p01: 0.05, nPairs: n })).toBeGreaterThanOrEqual(0.8)
  })

  it('required N is the MINIMAL n hitting the target, over a grid of configs', () => {
    // The two functions are inverses through different routes — required N via
    // the inverse normal, power via the forward normal CDF. Bounding the
    // round-trip on both sides is what ties those two routes together: a
    // one-sided ≥ target check is satisfied by any CDF that overstates power.
    const configs = [
      { p10: 0.25, p01: 0.05 },
      { p10: 0.2, p01: 0.1 },
      { p10: 0.3, p01: 0.1 },
      { p10: 0.15, p01: 0.05 },
    ]
    for (const cfg of configs) {
      for (const power of [0.7, 0.8, 0.9, 0.95]) {
        const n = mcnemarRequiredN({ ...cfg, power })
        const atN = mcnemarPower({ ...cfg, nPairs: n })
        expect(atN).toBeGreaterThanOrEqual(power)
        // One pair short must miss, so N cannot be inflated, and the overshoot
        // at N is bounded by a single pair's worth of power.
        expect(mcnemarPower({ ...cfg, nPairs: n - 1 })).toBeLessThan(power)
        expect(atN - power).toBeLessThan(0.01)
      }
    }
  })

  it('power rises monotonically with n and equals alpha at no effect', () => {
    const lo = mcnemarPower({ p10: 0.25, p01: 0.05, nPairs: 20 })
    const hi = mcnemarPower({ p10: 0.25, p01: 0.05, nPairs: 80 })
    expect(hi).toBeGreaterThan(lo)
    expect(mcnemarPower({ p10: 0.1, p01: 0.1, nPairs: 500 })).toBeCloseTo(0.05, 10)
  })

  it('throws on impossible discordant probabilities', () => {
    expect(() => mcnemarRequiredN({ p10: 0.7, p01: 0.7 })).toThrow(/p10\+p01/)
    expect(() => mcnemarPower({ p10: -0.1, p01: 0.2, nPairs: 50 })).toThrow(/p10,p01/)
  })
})
