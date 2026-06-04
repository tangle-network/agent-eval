import {
  type OffPolicyOptions,
  type OffPolicyTrajectory,
  offPolicyEstimateAll,
} from '../rl/off-policy'
import type { BeliefDecisionPoint, BeliefOpeReport, BeliefOpeSupportDiagnostics } from './types'

export interface BeliefOpeOptions extends OffPolicyOptions {
  minEffectiveSampleSize?: number
  minEffectiveSampleRatio?: number
}

export function beliefDecisionsToOffPolicyTrajectories(
  points: BeliefDecisionPoint[],
): OffPolicyTrajectory[] {
  const trajectories: OffPolicyTrajectory[] = []
  for (const point of points) {
    if (
      typeof point.behaviorProb !== 'number' ||
      typeof point.targetProb !== 'number' ||
      !point.outcome
    ) {
      continue
    }
    trajectories.push({
      runId: point.id,
      reward: rewardOf(point),
      behaviorProb: point.behaviorProb,
      targetProb: point.targetProb,
      qHat: point.qHat,
    })
  }
  return trajectories
}

export function evaluateBeliefOffPolicy(
  points: BeliefDecisionPoint[],
  options: BeliefOpeOptions = {},
): BeliefOpeReport | null {
  const trajectories = beliefDecisionsToOffPolicyTrajectories(points)
  if (trajectories.length === 0) return null
  const estimates = offPolicyEstimateAll(trajectories, options)
  const support = supportDiagnostics(estimates.dr, {
    minEffectiveSampleSize: options.minEffectiveSampleSize ?? 30,
    minEffectiveSampleRatio: options.minEffectiveSampleRatio ?? 0.25,
  })
  return { ...estimates, support }
}

function supportDiagnostics(
  estimate: { n: number; effectiveSampleSize: number; maxImportanceWeight: number },
  options: { minEffectiveSampleSize: number; minEffectiveSampleRatio: number },
): BeliefOpeSupportDiagnostics {
  const ratio = estimate.n > 0 ? estimate.effectiveSampleSize / estimate.n : 0
  const reasons: string[] = []
  if (estimate.effectiveSampleSize < options.minEffectiveSampleSize) {
    reasons.push(
      `effective sample size ${estimate.effectiveSampleSize.toFixed(2)} below ${options.minEffectiveSampleSize}`,
    )
  }
  if (ratio < options.minEffectiveSampleRatio) {
    reasons.push(
      `effective sample ratio ${ratio.toFixed(2)} below ${options.minEffectiveSampleRatio}`,
    )
  }
  if (estimate.maxImportanceWeight > 10) {
    reasons.push(`max importance weight ${estimate.maxImportanceWeight.toFixed(2)} is high`)
  }
  return {
    supported: reasons.length === 0,
    n: estimate.n,
    effectiveSampleSize: estimate.effectiveSampleSize,
    effectiveSampleRatio: ratio,
    maxImportanceWeight: estimate.maxImportanceWeight,
    reasons,
  }
}

function rewardOf(point: BeliefDecisionPoint): number {
  if (typeof point.outcome?.reward === 'number') return point.outcome.reward
  if (typeof point.outcome?.score === 'number') return point.outcome.score
  if (point.outcome?.success === true) return 1
  return 0
}
