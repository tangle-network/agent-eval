// Reliability across seeded repeats: how often a scenario succeeds in every one
// of k repeats, reported beside its mean success and counted per independent
// unit. A conversation that resolves the user's problem on two seeds out of
// four has a mean success of 0.5 and a pass^4 of 0; an agent a user can rely
// on needs the second number, which a mean never shows.

import { passHatK } from '../statistics/paired-binary'
import type { CampaignCellResult } from './types'

export interface RepeatReliabilityOptions<TArtifact> {
  /** Repeats every success must hold over: pass^k. A scenario with fewer scored
   *  repeats than `k` reports no pass^k and is listed as incomplete. */
  k: number
  /** Objective success of one repeat, decided by code from the artifact. */
  success: (artifact: TArtifact) => boolean
  /** Independent sampling unit for each scenario; scenarios sharing a unit are
   *  averaged before units are weighted equally. Default: each scenario is its
   *  own unit. */
  independentUnitByScenarioId?: ReadonlyMap<string, string>
}

export interface ScenarioRepeatReliability {
  scenarioId: string
  unit: string
  /** Scored repeats: cells that produced an artifact without an error. */
  repeats: number
  successes: number
  meanSuccess: number
  /** Unbiased pass^k over the scored repeats; null below `k` repeats. */
  passAllK: number | null
}

export interface RepeatReliability {
  k: number
  /** Scenarios in first-seen cell order. */
  scenarios: ScenarioRepeatReliability[]
  /** Independent units with at least one scored repeat. */
  units: number
  /** Mean success, each unit weighted equally; null with no scored repeat. */
  meanSuccess: number | null
  /** pass^k, each unit weighted equally over its complete scenarios; null when
   *  no scenario has `k` scored repeats. */
  passAllK: number | null
  /** Scenarios with fewer than `k` scored repeats. */
  incompleteScenarios: string[]
  /** Cells that failed in dispatch or judging. They are a service or
   *  measurement failure, never a counted agent failure. */
  failedCells: number
}

/** pass^k beside mean success over a campaign's seeded repeats. */
export function repeatReliability<TArtifact>(
  cells: ReadonlyArray<CampaignCellResult<TArtifact>>,
  opts: RepeatReliabilityOptions<TArtifact>,
): RepeatReliability {
  if (!Number.isSafeInteger(opts.k) || opts.k < 1) {
    throw new RangeError(`repeatReliability: k must be a positive integer, got ${opts.k}`)
  }
  const byScenario = new Map<string, { repeats: number; successes: number }>()
  let failedCells = 0
  for (const cell of cells) {
    if (cell.error !== undefined) {
      failedCells += 1
      continue
    }
    const row = byScenario.get(cell.scenarioId) ?? { repeats: 0, successes: 0 }
    const passed = opts.success(cell.artifact)
    if (typeof passed !== 'boolean') {
      throw new TypeError(
        `repeatReliability: success must return a boolean for '${cell.scenarioId}'`,
      )
    }
    row.repeats += 1
    if (passed) row.successes += 1
    byScenario.set(cell.scenarioId, row)
  }

  const scenarios: ScenarioRepeatReliability[] = [...byScenario].map(([scenarioId, row]) => ({
    scenarioId,
    unit: opts.independentUnitByScenarioId?.get(scenarioId) ?? scenarioId,
    repeats: row.repeats,
    successes: row.successes,
    meanSuccess: row.successes / row.repeats,
    passAllK: row.repeats >= opts.k ? passHatK(row.repeats, row.successes, opts.k) : null,
  }))
  const unitMean = (values: (row: ScenarioRepeatReliability) => number | null) => {
    const units = new Map<string, number[]>()
    for (const row of scenarios) {
      const value = values(row)
      if (value === null) continue
      units.set(row.unit, [...(units.get(row.unit) ?? []), value])
    }
    if (units.size === 0) return null
    const means = [...units.values()].map((list) => list.reduce((a, b) => a + b, 0) / list.length)
    return means.reduce((a, b) => a + b, 0) / means.length
  }
  return {
    k: opts.k,
    scenarios,
    units: new Set(scenarios.map((row) => row.unit)).size,
    meanSuccess: unitMean((row) => row.meanSuccess),
    passAllK: unitMean((row) => row.passAllK),
    incompleteScenarios: scenarios.filter((row) => row.passAllK === null).map((r) => r.scenarioId),
    failedCells,
  }
}
