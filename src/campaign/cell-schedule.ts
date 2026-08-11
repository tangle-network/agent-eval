/**
 * The campaign cell schedule: the (scenario × rep) fan-out with seed-group
 * aware per-cell seeds, plus the cell directory / cache-path / cost-tag
 * naming every phase shares.
 */

import { join } from 'node:path'
import type { RunCampaignOptions } from './run-campaign'
import type { Scenario } from './types'

export function buildCellSchedule<TScenario extends Scenario>(
  scenarios: TScenario[],
  seed: number,
  reps: number,
): Array<{ scenario: TScenario; rep: number; cellId: string; cellSeed: number }> {
  const schedule: Array<{ scenario: TScenario; rep: number; cellId: string; cellSeed: number }> = []
  const groupIndexes = new Map<string, number>()
  let nextGroupIndex = 0
  for (const scenario of scenarios) {
    let groupIndex: number
    if (scenario.seedGroup === undefined) {
      groupIndex = nextGroupIndex
      nextGroupIndex += 1
    } else {
      const existing = groupIndexes.get(scenario.seedGroup)
      if (existing !== undefined) {
        groupIndex = existing
      } else {
        groupIndex = nextGroupIndex
        nextGroupIndex += 1
        groupIndexes.set(scenario.seedGroup, groupIndex)
      }
    }
    for (let rep = 0; rep < reps; rep++) {
      const cellId = `${scenario.id}:${rep}`
      const cellSeed = seed + groupIndex * reps + rep
      schedule.push({ scenario, rep, cellId, cellSeed })
    }
  }
  return schedule
}

export type CellScheduleSlot<TScenario extends Scenario> = ReturnType<
  typeof buildCellSchedule<TScenario>
>[number]

export function cellDirectory(runDir: string, cellId: string): string {
  return join(runDir, cellId.replace(/[^a-zA-Z0-9_-]/g, '_'))
}

export function cellCachePath(runDir: string, cellId: string): string {
  return join(cellDirectory(runDir, cellId), 'cached-result.json')
}

export function stableCostTagsFor<TScenario extends Scenario>(
  opts: Pick<RunCampaignOptions<TScenario, unknown>, 'runDir' | 'costTags'>,
  slot: CellScheduleSlot<TScenario>,
): Record<string, string> {
  return {
    ...(opts.costTags ?? {}),
    runDir: opts.runDir,
    cellId: slot.cellId,
    scenarioId: slot.scenario.id,
    rep: String(slot.rep),
  }
}
