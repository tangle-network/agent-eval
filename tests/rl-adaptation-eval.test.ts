import { describe, expect, it } from 'vitest'
import {
  compareAdaptationCurves,
  firstPassK,
  runAdaptationCurve,
} from '../src/rl/adaptation-eval'
import type { AdaptationRunner } from '../src/rl/adaptation-eval'

interface Scen { scenarioId: string; difficulty: number }

const stockScenarios: Scen[] = [
  { scenarioId: 's-easy', difficulty: 0.2 },
  { scenarioId: 's-mid', difficulty: 0.5 },
  { scenarioId: 's-hard', difficulty: 0.8 },
]

function makeRunner(slope: number): AdaptationRunner<Scen> {
  // Saturating curve: score = (1 - difficulty) * slope-saturated-fn(k)
  return {
    run: async ({ scenario, k }) => {
      const efficiency = 1 - Math.exp(-k * slope / 4)
      return Math.min(1, (1 - scenario.difficulty) * (0.4 + 0.6 * efficiency))
    },
  }
}

describe('runAdaptationCurve', () => {
  it('produces a sorted curve with one point per requested k', async () => {
    const curve = await runAdaptationCurve({
      scenarios: stockScenarios,
      ks: [0, 1, 2, 4, 8],
      reps: 1,
      runner: makeRunner(1),
    })
    expect(curve.points.map((p) => p.k)).toEqual([0, 1, 2, 4, 8])
    expect(curve.points.every((p) => p.n === 3)).toBe(true)
  })

  it('mean score increases monotonically when adaptation helps', async () => {
    const curve = await runAdaptationCurve({
      scenarios: stockScenarios,
      ks: [0, 2, 8],
      reps: 1,
      runner: makeRunner(2),
    })
    const meanByK = curve.points.map((p) => p.meanScore)
    expect(meanByK[1]!).toBeGreaterThan(meanByK[0]!)
    expect(meanByK[2]!).toBeGreaterThan(meanByK[1]!)
  })

  it('reports adaptationArea normalized by max-k', async () => {
    const curve = await runAdaptationCurve({
      scenarios: stockScenarios,
      ks: [0, 4],
      reps: 1,
      runner: makeRunner(0.5),
    })
    expect(curve.adaptationArea).toBeGreaterThanOrEqual(0)
    expect(curve.adaptationArea).toBeLessThanOrEqual(1)
  })

  it('firstPassK reports the smallest k at which passRate ≥ threshold', async () => {
    // Runner that always passes — guarantees firstPassK = 0 regardless of difficulty.
    const alwaysPasses: AdaptationRunner<Scen> = { run: async () => 0.95 }
    const curve = await runAdaptationCurve({
      scenarios: stockScenarios,
      ks: [0, 1, 2, 4, 8, 16],
      reps: 1,
      runner: alwaysPasses,
      passThreshold: 0.5,
    })
    const k = firstPassK(curve, 0.5)
    expect(k).not.toBeNull()
    expect(k!).toBe(0)
  })

  it('firstPassK returns null when no k clears the threshold', async () => {
    const alwaysFails: AdaptationRunner<Scen> = { run: async () => 0.1 }
    const curve = await runAdaptationCurve({
      scenarios: stockScenarios,
      ks: [0, 1, 2],
      reps: 1,
      runner: alwaysFails,
      passThreshold: 0.5,
    })
    expect(firstPassK(curve, 0.5)).toBeNull()
  })
})

describe('compareAdaptationCurves', () => {
  it('flags a_better when curve A dominates', async () => {
    const fast = await runAdaptationCurve({ scenarios: stockScenarios, ks: [0, 4, 16], reps: 1, runner: makeRunner(2) })
    const slow = await runAdaptationCurve({ scenarios: stockScenarios, ks: [0, 4, 16], reps: 1, runner: makeRunner(0.3) })
    const out = compareAdaptationCurves(fast, slow, { seed: 1 })
    expect(out.verdict).toBe('a_better')
    expect(out.areaDelta).toBeGreaterThan(0)
  })

  it('flags similar when curves overlap', async () => {
    const a = await runAdaptationCurve({ scenarios: stockScenarios, ks: [0, 4, 16], reps: 1, runner: makeRunner(1) })
    const b = await runAdaptationCurve({ scenarios: stockScenarios, ks: [0, 4, 16], reps: 1, runner: makeRunner(1) })
    const out = compareAdaptationCurves(a, b, { seed: 1 })
    expect(out.verdict).toBe('similar')
  })

  it('returns one perK entry per matched k', async () => {
    const a = await runAdaptationCurve({ scenarios: stockScenarios, ks: [0, 1, 2], reps: 1, runner: makeRunner(1) })
    const b = await runAdaptationCurve({ scenarios: stockScenarios, ks: [0, 1, 2], reps: 1, runner: makeRunner(1) })
    const out = compareAdaptationCurves(a, b, { seed: 1 })
    expect(out.perK).toHaveLength(3)
  })
})
