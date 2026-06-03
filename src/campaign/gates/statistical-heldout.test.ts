import { describe, expect, it } from 'vitest'
import type { JudgeScore } from '../types'
import { heldoutSignificance, pairHoldout } from './statistical-heldout'

/**
 * The promotion gate's decision core: pair candidate-vs-baseline holdout cells,
 * then ship ONLY when the paired-bootstrap CI lower bound clears the threshold.
 * These pin the "trustworthy gate" behaviors the audit flagged as untested:
 * a clear gain is significant, noise/regression is not, thin n is refused
 * (not laundered into significance), and a candidate/baseline cell mismatch
 * fails loud rather than silently mispairing.
 */

const score = (composite: number, dimensions: Record<string, number> = {}): JudgeScore => ({
  composite,
  dimensions,
  notes: '',
})
/** One judge ('quality') per cell; cellId = `scN:0`. */
const cells = (vals: number[]): Map<string, Record<string, JudgeScore>> =>
  new Map(vals.map((v, i) => [`sc${i}:0`, { quality: score(v) }]))
const scenarioIds = (n: number): Set<string> => new Set(Array.from({ length: n }, (_, i) => `sc${i}`))
const composite = (s: JudgeScore) => s.composite

describe('pairHoldout + heldoutSignificance — promotion gate decision core', () => {
  it('a clear held-out gain is SIGNIFICANT (gate ships)', () => {
    const paired = pairHoldout(cells([0.8, 0.8, 0.8, 0.8, 0.8]), cells([0.5, 0.5, 0.5, 0.5, 0.5]), scenarioIds(5), composite)
    expect(paired.before).toEqual([0.5, 0.5, 0.5, 0.5, 0.5])
    expect(paired.after).toEqual([0.8, 0.8, 0.8, 0.8, 0.8])
    const sig = heldoutSignificance(paired)
    expect(sig.n).toBe(5)
    expect(sig.fewRuns).toBe(false)
    expect(sig.bootstrap.low).toBeGreaterThan(0)
    expect(sig.significant).toBe(true)
  })

  it('pure noise is NOT significant (gate holds)', () => {
    const paired = pairHoldout(
      cells([0.6, 0.4, 0.6, 0.4, 0.6, 0.4]),
      cells([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      scenarioIds(6),
      composite,
    )
    const sig = heldoutSignificance(paired)
    expect(sig.significant).toBe(false)
  })

  it('a regression is NOT significant (gate holds; CI high < 0)', () => {
    const paired = pairHoldout(cells([0.5, 0.5, 0.5, 0.5]), cells([0.8, 0.8, 0.8, 0.8]), scenarioIds(4), composite)
    const sig = heldoutSignificance(paired)
    expect(sig.significant).toBe(false)
    expect(sig.bootstrap.high).toBeLessThan(0)
  })

  it('thin n (< minProductiveRuns) is REFUSED even with a huge delta (fewRuns, not significant)', () => {
    const paired = pairHoldout(cells([0.95, 0.95]), cells([0.1, 0.1]), scenarioIds(2), composite)
    const sig = heldoutSignificance(paired) // default minProductiveRuns = 3
    expect(sig.n).toBe(2)
    expect(sig.fewRuns).toBe(true)
    expect(sig.significant).toBe(false) // 2 runs is not evidence, however large the gap
  })

  it('a positive-but-sub-threshold gain does NOT ship (deltaThreshold respected)', () => {
    const paired = pairHoldout(cells([0.55, 0.55, 0.55, 0.55, 0.55]), cells([0.5, 0.5, 0.5, 0.5, 0.5]), scenarioIds(5), composite)
    const sig = heldoutSignificance(paired, { deltaThreshold: 0.2 }) // needs > +0.2; only +0.05 here
    expect(sig.significant).toBe(false)
  })

  it('fails loud when candidate/baseline holdout cells do not align (no silent mispairing)', () => {
    const candidate = cells([0.8, 0.8, 0.8]) // sc0, sc1, sc2
    const baseline = new Map([
      ['sc0:0', { quality: score(0.5) }],
      ['sc1:0', { quality: score(0.5) }],
      ['sc9:0', { quality: score(0.5) }], // sc9 instead of sc2
    ])
    expect(() => pairHoldout(candidate, baseline, new Set(['sc0', 'sc1', 'sc2', 'sc9']), composite)).toThrow(/do not align/)
  })

  it('is deterministic — the same holdout yields the same verdict (reproducible gate)', () => {
    const mk = () => heldoutSignificance(pairHoldout(cells([0.7, 0.72, 0.8, 0.71, 0.79]), cells([0.5, 0.52, 0.6, 0.51, 0.59]), scenarioIds(5), composite))
    expect(mk()).toEqual(mk())
  })
})
