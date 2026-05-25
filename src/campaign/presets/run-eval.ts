/**
 * @experimental
 *
 * `runEval` — the simplest preset over `runCampaign`. No optimizer, no
 * gate, no auto-PR. Just: run scenarios through dispatch, score with
 * judges, return CampaignResult.
 *
 * The 80% case for consumers who want a scorecard, not an improvement loop.
 */

import { runCampaign, type RunCampaignOptions } from '../run-campaign'
import type { CampaignResult, Scenario } from '../types'

export interface RunEvalOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'runDir'> {
  runDir: string
}

export async function runEval<TScenario extends Scenario, TArtifact>(
  opts: RunEvalOptions<TScenario, TArtifact>,
): Promise<CampaignResult<TArtifact, TScenario>> {
  return runCampaign(opts)
}
