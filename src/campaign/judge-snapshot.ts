import { judgeVersionFor } from './campaign-manifest'
import type { JudgeConfig, Scenario } from './types'

/** Capture configuration and callbacks; receiver and closed-over state remain caller-owned. */
export function captureJudge<TArtifact, TScenario extends Scenario>(
  judge: JudgeConfig<TArtifact, TScenario>,
): JudgeConfig<TArtifact, TScenario> {
  const dimensions = judge.dimensions.map((dimension) =>
    Object.freeze({ key: dimension.key, description: dimension.description }),
  )
  Object.freeze(dimensions)
  const captured = {
    name: judge.name,
    judgeVersion: judge.judgeVersion,
    dimensions,
    score: judge.score,
    appliesTo: judge.appliesTo,
  }
  return Object.freeze({
    ...captured,
    // Derive identity before binding; bound callbacks hide their original source text.
    judgeVersion: judgeVersionFor(captured),
    score: captured.score.bind(judge),
    appliesTo: captured.appliesTo?.bind(judge),
  })
}
