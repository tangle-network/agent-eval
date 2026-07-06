import { describe, expect, it } from 'vitest'
import type { JudgeScore } from '../types'
import { defaultProductionGate } from './default-production-gate'

/**
 * Reproduction of supervisor-lab run 6: a +0.18 mean holdout lift (8 scenarios
 * improved ~+0.5, 2 regressed) that the median-based gate reported as median
 * 0.000 → hold, because ~50% of the 40 paired cells were exact ties (problems
 * both baseline and winner solve optimally). This rebuilds run-6-shaped cells
 * and asserts the tie-robust (mean) gate now SHIPS the real lift while still
 * reporting the tie-dominated median as a diagnostic.
 */

const S = (composite: number): Record<string, JudgeScore> => ({
  j: { dimensions: { q: composite }, composite, notes: '' },
})

// Run 6's measured per-scenario baseline→winner (8 up ~+0.5, 2 down, rest flat).
const PER_SCENARIO: Array<[string, number, number]> = [
  ['assign-10', 1, 1],
  ['assign-10b', 1, 1],
  ['flow-8x3b', 0.5, 1],
  ['flow-8x4', 0, 0.5],
  ['flow-9x4', 1, 0.832],
  ['fsetup-8x3', 0, 0.5],
  ['fsetup-8x3b', 0, 0.5],
  ['kconf-19', 1, 1],
  ['kconf-20', 1, 1],
  ['knap-21', 1, 1],
  ['knap-22', 1, 1],
  ['tsp-11', 0.5, 1],
  ['tsp-11b', 0.5, 1],
  ['tsp-12', 0.5, 1],
  ['tsp-12b', 1, 1],
  ['tsptw-10', 0.285, 0],
  ['tsptw-10b', 0, 0],
  ['wtar-13b', 0.5, 1],
  ['wtar-14', 1, 1],
  ['wtlate-13', 1, 1],
]

describe('run-6 tie-domination regression guard (mean ships what median wrongly held)', () => {
  it('a +0.18 lift with ~50% tied scenarios now SHIPS (median would hold)', async () => {
    const scenarios = PER_SCENARIO.map(([id]) => ({ id, kind: 'or' }))
    const judgeScores = new Map<string, Record<string, JudgeScore>>()
    const baselineJudgeScores = new Map<string, Record<string, JudgeScore>>()
    // reps=2 → cellId scenario:rep, both reps carry the scenario's composite.
    for (const [id, base, win] of PER_SCENARIO) {
      for (const rep of [0, 1]) {
        judgeScores.set(`${id}:${rep}`, S(win))
        baselineJudgeScores.set(`${id}:${rep}`, S(base))
      }
    }

    const gate = defaultProductionGate({ holdoutScenarios: scenarios, deltaThreshold: 0.05 })
    const result = await gate.decide({
      candidateArtifacts: new Map(),
      baselineArtifacts: new Map(),
      judgeScores,
      baselineJudgeScores,
      scenarios,
      cost: { candidate: 1, baseline: 1 },
      signal: new AbortController().signal,
    } as never)

    const sig = result.contributingGates?.find((g) => g.name === 'heldout-significance')
    const detail = sig?.detail as
      | { deltaMean?: number; deltaMedianDiagnostic?: number; tieFraction?: number; ciLow?: number }
      | undefined
    expect(detail).toBeDefined()
    // The tie fraction is high (~0.5) — this is the case that pinned the MEDIAN at
    // 0 and produced run 6's false hold. The gate now reports it.
    expect(detail?.tieFraction ?? 0).toBeGreaterThan(0.4)
    // The diagnostic median is still ~0 (tie-dominated) — proving the flaw is real.
    expect(Math.abs(detail?.deltaMedianDiagnostic ?? 1)).toBeLessThan(0.05)
    // But the SHIP statistic (mean paired delta) now reflects the true +0.18 lift...
    expect(detail?.deltaMean ?? 0).toBeGreaterThan(0.1)
    // ...and the gate SHIPS the real improvement the median-based gate wrongly held.
    expect(result.decision).toBe('ship')
    expect(result.delta ?? 0).toBeGreaterThan(0.1)
  })
})
