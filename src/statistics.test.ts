import { describe, expect, it } from 'vitest'
import { pairedBootstrap } from './statistics'

/**
 * The load-bearing statistical core of the promotion gate: `pairedBootstrap`
 * returns a CI on the paired (after − before) delta, and the gate ships ONLY
 * when `low > threshold`. These pin the decisions the whole "trustworthy gate"
 * claim rests on — a clear gain is significant, noise is not, a regression is
 * caught, degenerate n is not laundered into false significance, and mismatched
 * data fails loud. Deterministic under a fixed seed (no bare Math.random()).
 */
describe('pairedBootstrap — promotion-gate CI core', () => {
  it('a clear, consistent paired gain has CI.low > 0 (gate would SHIP)', () => {
    const before = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    const after = [0.8, 0.8, 0.8, 0.8, 0.8, 0.8] // +0.3 every pair
    const r = pairedBootstrap(before, after, { seed: 1337 })
    expect(r.n).toBe(6)
    expect(r.median).toBeCloseTo(0.3, 6)
    expect(r.low).toBeGreaterThan(0) // CI lower bound positive ⇒ real gain
    expect(r.low).toBeCloseTo(0.3, 6) // identical deltas ⇒ CI collapses to 0.3
  })

  it('pure noise (mixed-sign deltas, median 0) has a CI spanning 0 (gate would HOLD)', () => {
    const before = [0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5, 0.5]
    const after = [0.6, 0.4, 0.6, 0.4, 0.6, 0.4, 0.6, 0.4] // deltas ±0.1
    const r = pairedBootstrap(before, after, { seed: 1337 })
    expect(r.low).toBeLessThanOrEqual(0)
    expect(r.high).toBeGreaterThanOrEqual(0) // brackets 0 ⇒ not significant
  })

  it('a consistent REGRESSION has CI.high < 0 (gate would HOLD / revert)', () => {
    const before = [0.8, 0.8, 0.8, 0.8, 0.8]
    const after = [0.5, 0.5, 0.5, 0.5, 0.5] // −0.3 every pair
    const r = pairedBootstrap(before, after, { seed: 1337 })
    expect(r.high).toBeLessThan(0)
  })

  it('n=1 is degenerate: low === high === the single delta (no laundered significance)', () => {
    const r = pairedBootstrap([0.5], [0.9], { seed: 1337 })
    expect(r.n).toBe(1)
    expect(r.low).toBeCloseTo(0.4, 6)
    expect(r.high).toBeCloseTo(0.4, 6)
  })

  it('throws on unequal sample sizes (fail-loud, never pairs mismatched data)', () => {
    expect(() => pairedBootstrap([1, 2, 3], [1, 2])).toThrow(/unequal sample sizes/)
  })

  it('throws on an out-of-range confidence (fail-loud)', () => {
    expect(() => pairedBootstrap([1, 2], [2, 3], { confidence: 1.5 })).toThrow(/confidence/)
  })

  it('is deterministic under a fixed seed (gate verdicts must be reproducible)', () => {
    const before = [0.5, 0.55, 0.6, 0.52, 0.58, 0.5]
    const after = [0.7, 0.72, 0.8, 0.71, 0.79, 0.7]
    expect(pairedBootstrap(before, after, { seed: 42 })).toEqual(
      pairedBootstrap(before, after, { seed: 42 }),
    )
  })
})
