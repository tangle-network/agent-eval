/**
 * @experimental
 *
 * `runEval` — the simplest preset over `runShot`. No optimizer, no
 * gate, no auto-PR. Just: run scenarios through dispatch, score with
 * judges, return ShotResult.
 *
 * The 80% case for consumers who want a scorecard, not an improvement loop.
 */

import { type RunShotOptions, runShot } from '../run-shot'
import type { Scenario, ShotResult } from '../types'

export interface RunEvalOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunShotOptions<TScenario, TArtifact>, 'runDir'> {
  runDir: string
}

export async function runEval<TScenario extends Scenario, TArtifact>(
  opts: RunEvalOptions<TScenario, TArtifact>,
): Promise<ShotResult<TArtifact, TScenario>> {
  return runShot(opts)
}
