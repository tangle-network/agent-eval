// Policies compared on the same seeds. One seed gives every policy the same
// luck, so a contrast is read on per-seed differences, and "beats" has to
// clear the spread seeds alone produce.

import { ValidationError } from '../errors'
import { meanConfidenceInterval } from '../statistics/descriptive'
import { pairedSignTest } from '../statistics/paired-tests'
import { runWorldEpisode } from './episode'
import type { WorldAgent, WorldEpisode, WorldScenario } from './types'

export interface WorldPolicyRow {
  policy: string
  /** End value per seed, in seed order. */
  values: number[]
  mean: number
  /** Sample standard deviation across seeds. */
  stddev: number
  min: number
  max: number
  /** Mean end value minus the starting budget. */
  meanGain: number
  /** Refused spends with no recorded approval, summed over seeds. */
  unapprovedSpendAttempts: number
  /** Deep cuts and scale-ups made before the evidence rule was met, summed over seeds. */
  prematureDecisions: number
  /** Sessions in which the policy threw, summed over seeds. */
  failedSessions: number
}

export interface WorldPolicyContrast {
  better: string
  worse: string
  /** `better - worse` end value per seed. */
  differences: number[]
  meanDifference: number
  minDifference: number
  /** Seeds on which `better` ended higher. */
  wins: number
  /** The larger of the two policies' standard deviations across seeds. */
  seedNoise: number
  /** Exact one-sided sign test on the per-seed differences. */
  signTestP: number
  /** `better` ended higher on every seed, by more than twice the seed noise on
   *  average, and neither policy had a failed session. */
  beyondNoise: boolean
}

export interface CompareWorldPoliciesOptions {
  scenario: WorldScenario
  /** At least two distinct seeds; every policy runs every seed. */
  seeds: readonly number[]
  /** Policy name to a factory called once per episode with its seed. */
  policies: Readonly<Record<string, (seed: number) => WorldAgent>>
  /** `[better, worse]` pairs to test. */
  contrasts?: ReadonlyArray<readonly [string, string]>
}

export interface WorldPolicyComparison {
  scenarioId: string
  scenarioDigest: string
  seeds: number[]
  rows: WorldPolicyRow[]
  contrasts: WorldPolicyContrast[]
  episodes: Record<string, WorldEpisode[]>
}

/** Run every policy on every seed and report each row and each contrast. */
export async function compareWorldPolicies(
  opts: CompareWorldPoliciesOptions,
): Promise<WorldPolicyComparison> {
  const seeds = [...opts.seeds]
  if (seeds.length < 2 || new Set(seeds).size !== seeds.length) {
    throw new ValidationError('compareWorldPolicies: at least two distinct seeds are required')
  }
  // Checked before anything runs: a typo must not discard paid episodes.
  const names = Object.keys(opts.policies)
  if (names.length === 0) {
    throw new ValidationError('compareWorldPolicies: at least one policy is required')
  }
  for (const name of (opts.contrasts ?? []).flat()) {
    if (!names.includes(name)) {
      throw new ValidationError(`compareWorldPolicies: no policy '${name}'`)
    }
  }
  const episodes: Record<string, WorldEpisode[]> = {}
  for (const [policy, make] of Object.entries(opts.policies)) {
    const runs: WorldEpisode[] = []
    for (const seed of seeds) {
      runs.push(await runWorldEpisode({ scenario: opts.scenario, seed, agent: make(seed) }))
    }
    episodes[policy] = runs
  }

  const rows = Object.entries(episodes).map(([policy, runs]): WorldPolicyRow => {
    const values = runs.map((run) => run.end.value)
    const summary = meanConfidenceInterval(values)
    return {
      policy,
      values,
      mean: summary.mean!,
      stddev: summary.stdev!,
      min: Math.min(...values),
      max: Math.max(...values),
      meanGain: summary.mean! - opts.scenario.budget,
      unapprovedSpendAttempts: runs.reduce(
        (sum, run) => sum + (run.score.refused.approval_missing ?? 0),
        0,
      ),
      prematureDecisions: runs.reduce((sum, run) => sum + run.score.prematureDecisions.length, 0),
      failedSessions: runs.reduce((sum, run) => sum + run.score.failedSessions, 0),
    }
  })

  const contrasts = (opts.contrasts ?? []).map(([better, worse]): WorldPolicyContrast => {
    const high = rows.find((row) => row.policy === better)!
    const low = rows.find((row) => row.policy === worse)!
    const differences = high.values.map((value, index) => value - low.values[index]!)
    const meanDifference = differences.reduce((sum, d) => sum + d, 0) / differences.length
    const minDifference = Math.min(...differences)
    const seedNoise = Math.max(high.stddev, low.stddev)
    return {
      better,
      worse,
      differences,
      meanDifference,
      minDifference,
      wins: differences.filter((d) => d > 0).length,
      seedNoise,
      signTestP: pairedSignTest(differences, 'greater').pValue,
      beyondNoise:
        minDifference > 0 &&
        meanDifference > 2 * seedNoise &&
        high.failedSessions + low.failedSessions === 0,
    }
  })

  return {
    scenarioId: opts.scenario.id,
    scenarioDigest: episodes[names[0]!]![0]!.scenarioDigest,
    seeds,
    rows,
    contrasts,
    episodes,
  }
}
