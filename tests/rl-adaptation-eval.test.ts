import { describe, expect, it } from 'vitest'
import type { AdaptationRunner } from '../src/rl/adaptation-eval'
import { compareAdaptationCurves, firstPassK, runAdaptationCurve } from '../src/rl/adaptation-eval'
import { pairedBootstrap } from '../src/statistics'

interface Scen {
  scenarioId: string
  difficulty: number
}

const stockScenarios: Scen[] = [
  { scenarioId: 's-easy', difficulty: 0.2 },
  { scenarioId: 's-mid', difficulty: 0.5 },
  { scenarioId: 's-hard', difficulty: 0.8 },
]

function makeRunner(slope: number): AdaptationRunner<Scen> {
  // Saturating curve: score = (1 - difficulty) * slope-saturated-fn(k)
  return {
    run: async ({ scenario, k }) => {
      const efficiency = 1 - Math.exp((-k * slope) / 4)
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
  const pairedScenarios = Array.from({ length: 30 }, (_, i) => ({
    scenarioId: `scenario-${i}`,
    difficulty: 0.1 + (0.8 * i) / 29,
  }))

  it('flags a_better when curve A dominates', async () => {
    const fast = await runAdaptationCurve({
      scenarios: pairedScenarios,
      ks: [0, 4, 16],
      reps: 1,
      runner: makeRunner(2),
    })
    const slow = await runAdaptationCurve({
      scenarios: pairedScenarios,
      ks: [0, 4, 16],
      reps: 1,
      runner: makeRunner(0.3),
    })
    const out = compareAdaptationCurves(fast, slow, { seed: 1 })
    expect(out.verdict).toBe('a_better')
    expect(out.areaDelta.low).toBeGreaterThan(0)
    expect(out.areaDelta.n).toBe(pairedScenarios.length)
    expect(compareAdaptationCurves(slow, fast, { seed: 1 }).verdict).toBe('b_better')
  })

  it('reports inconclusive instead of claiming equivalence when curves overlap', async () => {
    const a = await runAdaptationCurve({
      scenarios: pairedScenarios,
      ks: [0, 4, 16],
      reps: 1,
      runner: makeRunner(1),
    })
    const b = await runAdaptationCurve({
      scenarios: pairedScenarios,
      ks: [0, 4, 16],
      reps: 1,
      runner: makeRunner(1),
    })
    const out = compareAdaptationCurves(a, b, { seed: 1 })
    expect(out.verdict).toBe('inconclusive')
  })

  it('returns one perK entry per matched k', async () => {
    const a = await runAdaptationCurve({
      scenarios: stockScenarios,
      ks: [0, 1, 2],
      reps: 1,
      runner: makeRunner(1),
    })
    const b = await runAdaptationCurve({
      scenarios: stockScenarios,
      ks: [0, 1, 2],
      reps: 1,
      runner: makeRunner(1),
    })
    const out = compareAdaptationCurves(a, b, { seed: 1 })
    expect(out.perK).toHaveLength(3)
  })

  it('joins IDs before bootstrapping and retains within-scenario covariance across k', async () => {
    const exactScores = pairedScenarios.map((scenario, i) => ({ ...scenario, difficulty: i / 32 }))
    const a = await runAdaptationCurve({
      scenarios: exactScores,
      ks: [0, 1],
      reps: 3,
      runner: { run: async ({ scenario }) => scenario.difficulty / 2 + 0.125 },
    })
    const b = await runAdaptationCurve({
      scenarios: [...exactScores].reverse(),
      ks: [1, 0],
      reps: 3,
      runner: { run: async ({ scenario }) => scenario.difficulty / 2 },
    })
    const out = compareAdaptationCurves(a, b, { seed: 17 })
    for (const point of out.perK) {
      expect(point.delta.n).toBe(30)
      expect(point.delta.low).toBe(0.125)
      expect(point.delta.high).toBe(0.125)
    }
    expect(out.areaDelta.low).toBe(0.125)
    expect(out.areaDelta.high).toBe(0.125)
    expect(out.aImprovement.indeterminate).toBe(true)
    expect(out.verdict).toBe('inconclusive')
    expect(compareAdaptationCurves(a, b, { minimumEffect: 0.2 }).verdict).toBe('inconclusive')
  })

  it('resamples per-scenario areas rather than independent k points', async () => {
    const scenarios = pairedScenarios.map((scenario, i) => ({
      ...scenario,
      gain: i < 15 ? 0.2 : -0.1,
    }))
    const a = await runAdaptationCurve({
      scenarios,
      ks: [0, 2, 4],
      runner: { run: async ({ scenario, k }) => 0.5 + (scenario.gain * k) / 4 },
    })
    const b = await runAdaptationCurve({
      scenarios,
      ks: [0, 2, 4],
      runner: { run: async () => 0.5 },
    })
    const out = compareAdaptationCurves(a, b, { seed: 19 })
    const sorted = [...scenarios].sort((left, right) =>
      left.scenarioId.localeCompare(right.scenarioId),
    )
    const reference = pairedBootstrap(
      sorted.map(() => 0.5),
      sorted.map((scenario) => 0.5 + scenario.gain / 2),
      { seed: 19, statistic: 'mean' },
    )
    expect(out.areaDelta.mean).toBeCloseTo(reference.mean, 10)
    expect(out.areaDelta.low).toBeCloseTo(reference.low, 10)
    expect(out.areaDelta.high).toBeCloseTo(reference.high, 10)
  })

  it('keeps repeated measurements of three scenarios descriptive', async () => {
    const a = await runAdaptationCurve({
      scenarios: stockScenarios,
      ks: [0, 2],
      reps: 30,
      runner: { run: async () => 0.9 },
    })
    const b = await runAdaptationCurve({
      scenarios: stockScenarios,
      ks: [0, 2],
      reps: 30,
      runner: { run: async () => 0.1 },
    })
    const out = compareAdaptationCurves(a, b)
    expect(out.verdict).toBe('insufficient_evidence')
    expect(out.areaDelta.n).toBe(3)
    expect(out.areaDelta.gateEligible).toBe(false)
  })

  it('can decide binary area outcomes below the continuous bootstrap minimum', async () => {
    const scenarios = pairedScenarios.slice(0, 6)
    const a = await runAdaptationCurve({
      scenarios,
      ks: [0, 1],
      reps: 1,
      runner: { run: async () => 1 },
    })
    const b = await runAdaptationCurve({
      scenarios,
      ks: [0, 1],
      reps: 1,
      runner: { run: async () => 0 },
    })
    const result = compareAdaptationCurves(a, b)
    expect(result.aImprovement.method).toBe('score-interval')
    expect(result.aImprovement.n).toBe(6)
    expect(result.aImprovement.sufficient).toBe(true)
    expect(result.verdict).toBe('a_better')
  })

  it('refuses disjoint cohorts, missing pairs, mismatched k grids, and repeated identities', async () => {
    const a = await runAdaptationCurve({
      scenarios: stockScenarios,
      ks: [0, 1],
      runner: makeRunner(1),
    })
    const disjoint = await runAdaptationCurve({
      scenarios: stockScenarios.map((scenario) => ({
        ...scenario,
        scenarioId: `other-${scenario.scenarioId}`,
      })),
      ks: [0, 1],
      runner: makeRunner(1),
    })
    expect(() => compareAdaptationCurves(a, disjoint)).toThrow(
      /scenario pairs differ.*missing=\[s-easy/,
    )
    const missing = structuredClone(a)
    missing.points[1]!.perScenario.pop()
    expect(() => compareAdaptationCurves(a, missing)).toThrow(/at k=1.*missing=\[s-hard\]/)
    const wrongGrid = { ...a, points: a.points.slice(1) }
    expect(() => compareAdaptationCurves(a, wrongGrid)).toThrow(/k grids differ/)
    const duplicate = structuredClone(a)
    duplicate.points[0]!.perScenario.push(duplicate.points[0]!.perScenario[0]!)
    expect(() => compareAdaptationCurves(a, duplicate)).toThrow(/duplicate scenarioId/)
  })

  it('refuses malformed designs and scoring failures instead of inventing measurements', async () => {
    const options = { scenarios: stockScenarios, ks: [0, 1], runner: makeRunner(1) }
    await expect(
      runAdaptationCurve({ ...options, scenarios: [{ scenarioId: '', difficulty: 0.1 }] }),
    ).rejects.toThrow(/explicit nonempty/)
    await expect(
      runAdaptationCurve({ ...options, scenarios: [stockScenarios[0]!, stockScenarios[0]!] }),
    ).rejects.toThrow(/duplicate scenarioId/)
    await expect(runAdaptationCurve({ ...options, reps: 0 })).rejects.toThrow(/positive integer/)
    await expect(runAdaptationCurve({ ...options, ks: [0, 0] })).rejects.toThrow(/duplicate k/)
    await expect(
      runAdaptationCurve({ ...options, runner: { run: async () => NaN } }),
    ).rejects.toThrow(/score must be finite/)
    const curve = await runAdaptationCurve(options)
    expect(() => compareAdaptationCurves(curve, curve, { bootstrapResamples: 0 })).toThrow(
      /positive integer/,
    )
    expect(() => compareAdaptationCurves(curve, curve, { confidence: NaN })).toThrow(/confidence/)
  })
})
