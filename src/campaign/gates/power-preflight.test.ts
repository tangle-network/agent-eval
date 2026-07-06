import { describe, expect, it } from 'vitest'
import { powerPreflight } from './power-preflight'

describe('powerPreflight (minimum-detectable-lift calculator)', () => {
  it('computes the MDE from baseline variance and paired n (hand-checked normal approx)', () => {
    // sd = 0.5 exactly (alternating 0/1), n = 16, z(95%) = 1.96:
    // mde = 0.05 + 1.96 * sqrt(2) * 0.5 / 4 = 0.05 + 0.34648...
    const composites = [0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1, 0, 1]
    const p = powerPreflight({ baselineComposites: composites, pairedN: 16 })
    expect(p.sd).toBeCloseTo(0.5164, 3) // sample SD with n-1
    expect(p.mde).toBeCloseTo(0.05 + (1.96 * Math.SQRT2 * p.sd) / 4, 10)
    expect(p.n).toBe(16)
    expect(p.scaleAssumed).toBe(true)
  })

  it('reports the run-5 regime honestly: practically hopeless MDE, but not structurally underpowered', () => {
    // The measured regime that motivated this module: baseline ~0.57 with cells
    // flipping between 0 and 1 on a 20-cell holdout. The MDE (~0.32) dwarfs any
    // plausible prompt effect (~0.1) — but a TRUE +0.35 effect could still ship,
    // so the structural flag stays off; the reported MDE is the decision input.
    const composites = [1, 0, 1, 1, 0, 0.5, 1, 0, 1, 0.3, 1, 0, 1, 1, 0, 0.166, 1, 0, 1, 0.5]
    const p = powerPreflight({ baselineComposites: composites })
    expect(p.underpowered).toBe(false)
    expect(p.mde).toBeGreaterThan(0.25)
    expect(p.recommendation).toMatch(/cannot clear the gate/)
  })

  it('flags a structurally underpowered run: high baseline leaves less headroom than the MDE', () => {
    // Baseline ~0.85 with heavy variance on a small holdout: headroom 0.15,
    // MDE ~0.3 — NO achievable effect can ship, regardless of proposal quality.
    const composites = [1, 0.5, 1, 1, 0.3, 1, 1, 0.5, 1, 0.2]
    const p = powerPreflight({ baselineComposites: composites })
    expect(p.headroom).toBeLessThan(p.mde)
    expect(p.underpowered).toBe(true)
    expect(p.recommendation).toMatch(/UNDERPOWERED/)
    expect(p.recommendation).toMatch(/Raise paired n/)
  })

  it('a low-variance regime is NOT underpowered and reports a small MDE', () => {
    const composites = Array.from({ length: 40 }, (_, i) => 0.6 + (i % 2 === 0 ? 0.02 : -0.02))
    const p = powerPreflight({ baselineComposites: composites })
    expect(p.underpowered).toBe(false)
    expect(p.mde).toBeLessThan(0.07)
  })

  it('more reps (pairedN) shrink the MDE toward the gate threshold', () => {
    const composites = [1, 0, 1, 0, 1, 0, 1, 0, 1, 0]
    const at10 = powerPreflight({ baselineComposites: composites, pairedN: 10 })
    const at40 = powerPreflight({ baselineComposites: composites, pairedN: 40 })
    expect(at40.mde).toBeLessThan(at10.mde)
    expect(at40.mde).toBeGreaterThan(at40.deltaThreshold)
  })

  it('withholds the underpowered verdict off the [0,1] scale but still reports MDE', () => {
    const composites = [80, 92, 75, 88, 95, 70, 85, 90]
    const p = powerPreflight({ baselineComposites: composites })
    expect(p.scaleAssumed).toBe(false)
    expect(p.underpowered).toBe(false)
    expect(p.mde).toBeGreaterThan(0)
  })

  it('fails loud on insufficient evidence', () => {
    expect(() => powerPreflight({ baselineComposites: [1, 0] })).toThrow(/>= 3 finite/)
    expect(() => powerPreflight({ baselineComposites: [1, 0, 1], pairedN: 1 })).toThrow(/pairedN/)
  })
})
