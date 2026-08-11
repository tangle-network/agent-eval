/**
 * Campaign identity: the manifest hash over (scenarios, judges, dispatch,
 * seed, reps) that keys resumability, and the dispatch-ref rules feeding it.
 */

import { contentHash } from '../verdict-cache'
import type { DispatchFn, JudgeConfig, Scenario } from './types'

export function computeManifestHash(input: {
  scenarios: Scenario[]
  judges: JudgeConfig<unknown>[]
  dispatchRef: string
  seed: number
  reps: number
}): string {
  return contentHash({
    scenarios: input.scenarios,
    judges: input.judges.map((judge) => ({
      name: judge.name,
      dims: judge.dimensions,
      version: judgeVersionFor(judge),
    })),
    dispatch: input.dispatchRef,
    seed: input.seed,
    reps: input.reps,
  })
}

function judgeVersionFor(judge: JudgeConfig<unknown>): string {
  if (judge.judgeVersion !== undefined) {
    const version = judge.judgeVersion.trim()
    if (version.length === 0) {
      throw new Error(`runCampaign: judge '${judge.name}' has an empty judgeVersion`)
    }
    return version
  }
  return contentHash({
    score: judge.score.toString(),
    appliesTo: judge.appliesTo?.toString() ?? null,
  })
}

export function dispatchRefFor<TScenario extends Scenario, TArtifact>(
  dispatch: DispatchFn<TScenario, TArtifact> | undefined,
  override: string | undefined,
): string {
  const ref = override ?? dispatch?.name ?? 'anonymous'
  if (typeof ref !== 'string' || ref.trim().length === 0) {
    throw new Error('runCampaign: dispatchRef must be a non-empty string when provided')
  }
  return ref
}
