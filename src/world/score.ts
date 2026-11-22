// Scoring reads two things: the end state, and the decision log. The end
// state says how the episode came out. The log says which calls the world
// refused, which kills and scale-ups came before the evidence could support
// them. `worldDecisionCosts` then prices each accepted action by replaying the
// episode without it.

import { ValidationError } from '../errors'
import { seedFromData } from '../statistics/internal'
import type {
  WorldAction,
  WorldDecisionCost,
  WorldEndState,
  WorldEpisode,
  WorldLogEntry,
  WorldPrematureDecision,
  WorldRefusal,
  WorldScenario,
  WorldScore,
} from './types'
import { World } from './world'

/** The accepted actions of a log, in the order they were taken. */
export function worldActions(log: readonly WorldLogEntry[]): WorldAction[] {
  return log.flatMap((entry) => (entry.action ? [entry.action] : []))
}

/** Re-run a scenario and seed under a list of actions. An action the world
 *  refuses on replay is skipped, as it would have been live. */
export function replayWorld(
  scenario: WorldScenario,
  seed: number,
  actions: readonly WorldAction[],
): WorldEndState {
  const world = new World(scenario, seed)
  for (const action of actions) {
    if (action.day > world.day) world.advance(action.day - world.day)
    world.apply(action)
  }
  world.advance(world.daysLeft)
  return world.end()
}

function prematureDecisions(
  scenario: WorldScenario,
  log: readonly WorldLogEntry[],
): WorldPrematureDecision[] {
  const rule = scenario.key.evidence
  const found: WorldPrematureDecision[] = []
  for (const entry of log) {
    if (entry.action?.kind !== 'set_rate' || !entry.evidence) continue
    const { previousRate, landed, maturedSpend } = entry.evidence
    if (previousRate <= 0) continue
    const next = entry.action.dailyRate
    const kind = next === 0 ? 'kill' : next >= previousRate * rule.scaleFactor ? 'scale' : null
    if (!kind) continue
    const exposure = maturedSpend / scenario.outcome.value
    if (landed >= rule.minOutcomes || exposure >= rule.minOutcomes) continue
    found.push({
      seq: entry.seq,
      day: entry.day,
      lever: entry.action.lever,
      kind,
      landed,
      maturedSpend,
    })
  }
  return found
}

export interface WorldDecisionCostOptions {
  /** Fresh noise seeds the expected cost is averaged over. Default 20. */
  noiseSeeds?: number
}

/** Price every accepted action of an episode by replaying the episode without
 *  it, costliest in expectation first. The other actions stay as recorded, so
 *  a removed rate change leaves the lever at its previous rate until the next
 *  recorded change. */
export function worldDecisionCosts(
  scenario: WorldScenario,
  episode: Pick<WorldEpisode, 'seed' | 'log'>,
  opts: WorldDecisionCostOptions = {},
): WorldDecisionCost[] {
  const noiseSeeds = opts.noiseSeeds ?? 20
  if (!Number.isSafeInteger(noiseSeeds) || noiseSeeds < 1) {
    throw new ValidationError('worldDecisionCosts: noiseSeeds must be a positive integer')
  }
  const taken = episode.log.filter((entry) => entry.action !== undefined)
  const all = taken.map((entry) => entry.action!)
  const fresh = Array.from({ length: noiseSeeds }, (_, index) =>
    seedFromData([[episode.seed, index + 1]]),
  )
  const realizedBase = replayWorld(scenario, episode.seed, all).value
  const freshBase = fresh.map((seed) => replayWorld(scenario, seed, all).value)
  const costs = taken.map((entry, index): WorldDecisionCost => {
    const without = all.filter((_, at) => at !== index)
    const expected = fresh.map(
      (seed, at) => replayWorld(scenario, seed, without).value - freshBase[at]!,
    )
    return {
      seq: entry.seq,
      day: entry.day,
      action: entry.action!,
      realizedCost: replayWorld(scenario, episode.seed, without).value - realizedBase,
      expectedCost: expected.reduce((sum, cost) => sum + cost, 0) / expected.length,
    }
  })
  return costs.sort((x, y) => y.expectedCost - x.expectedCost || x.seq - y.seq)
}

/** Score an episode from its end state and its decision log. */
export function scoreWorldEpisode(
  scenario: WorldScenario,
  log: readonly WorldLogEntry[],
  end: WorldEndState,
): WorldScore {
  const refused: Partial<Record<WorldRefusal, number>> = {}
  for (const entry of log) {
    const reason = entry.result.refused
    if (reason) refused[reason] = (refused[reason] ?? 0) + 1
  }
  let overdriveDays = 0
  let inFlight = 0
  for (const lever of Object.values(end.levers)) {
    overdriveDays += lever.overdriveDays
    inFlight += lever.inFlight
  }
  return {
    value: end.value,
    gain: end.value - scenario.budget,
    refused,
    prematureDecisions: prematureDecisions(scenario, log),
    overdriveDays,
    lateValue: inFlight * scenario.outcome.value,
  }
}
