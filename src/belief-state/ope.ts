import {
  type OffPolicyOptions,
  type OffPolicyTrajectory,
  offPolicyEstimateAll,
} from '../rl/off-policy'
import type {
  BeliefDecisionPoint,
  BeliefOpeReport,
  BeliefOpeSupportDiagnostics,
  BeliefOpeTargetPolicy,
} from './types'

export interface BeliefOpeOptions extends OffPolicyOptions {
  minEffectiveSampleSize?: number
  minEffectiveSampleRatio?: number
  maxDiagnostics?: number
}

export interface BeliefOffPolicyTrajectoryReport {
  targetPolicyId: string
  trajectories: OffPolicyTrajectory[]
  dropped: number
  diagnostics: string[]
}

export function embeddedBeliefOpeTargetPolicy(id = 'embedded-target-prob'): BeliefOpeTargetPolicy {
  return {
    id,
    targetProbOf(point) {
      return point.targetProb
    },
    qHatChosenOf(point) {
      return point.qHatChosen
    },
    vHatTargetOf(point) {
      return point.vHatTarget
    },
    qHatOf(point) {
      return point.qHat
    },
  }
}

export function beliefDecisionsToOffPolicyTrajectories(
  points: BeliefDecisionPoint[],
  targetPolicy: BeliefOpeTargetPolicy,
  options: Pick<BeliefOpeOptions, 'maxDiagnostics'> = {},
): BeliefOffPolicyTrajectoryReport {
  const trajectories: OffPolicyTrajectory[] = []
  const diagnostics: string[] = []
  for (const point of points) {
    if (!point.outcome) {
      diagnostics.push(`${point.id}: missing outcome`)
      continue
    }
    if (!isBehaviorProbability(point.behaviorProb)) {
      diagnostics.push(`${point.id}: invalid behaviorProb ${formatProbability(point.behaviorProb)}`)
      continue
    }

    let targetProb: number | null | undefined
    let qHatChosen: number | null | undefined
    let vHatTarget: number | null | undefined
    let qHat: number | null | undefined
    try {
      targetProb = targetPolicy.targetProbOf(point)
      qHatChosen = targetPolicy.qHatChosenOf?.(point)
      vHatTarget = targetPolicy.vHatTargetOf?.(point)
      qHat = targetPolicy.qHatOf?.(point)
    } catch (error) {
      diagnostics.push(
        `${point.id}: target policy ${targetPolicy.id} threw (${errorMessage(error)})`,
      )
      continue
    }
    if (!isTargetProbability(targetProb)) {
      diagnostics.push(`${point.id}: invalid targetProb ${formatProbability(targetProb)}`)
      continue
    }
    const hasQHatChosen = qHatChosen !== null && qHatChosen !== undefined
    const hasVHatTarget = vHatTarget !== null && vHatTarget !== undefined
    if (hasQHatChosen !== hasVHatTarget) {
      diagnostics.push(`${point.id}: qHatChosen and vHatTarget must be supplied together`)
      continue
    }
    if (
      hasQHatChosen &&
      hasVHatTarget &&
      (!isTargetProbability(qHatChosen) || !isTargetProbability(vHatTarget))
    ) {
      diagnostics.push(
        `${point.id}: invalid contextual Q pair qHatChosen=${formatProbability(qHatChosen)} vHatTarget=${formatProbability(vHatTarget)}`,
      )
      continue
    }
    if (
      !hasQHatChosen &&
      !hasVHatTarget &&
      qHat !== null &&
      qHat !== undefined &&
      !isTargetProbability(qHat)
    ) {
      diagnostics.push(`${point.id}: invalid qHat ${formatProbability(qHat)}; ignoring qHat`)
      qHat = null
    }

    trajectories.push({
      runId: point.id,
      reward: rewardOf(point),
      behaviorProb: point.behaviorProb,
      targetProb,
      ...(qHatChosen !== undefined ? { qHatChosen } : {}),
      ...(vHatTarget !== undefined ? { vHatTarget } : {}),
      qHat,
    })
  }
  return {
    targetPolicyId: targetPolicy.id,
    trajectories,
    dropped: points.length - trajectories.length,
    diagnostics: compactDiagnostics(diagnostics, options.maxDiagnostics ?? 20),
  }
}

export function evaluateBeliefOffPolicy(
  points: BeliefDecisionPoint[],
  targetPolicy: BeliefOpeTargetPolicy,
  options: BeliefOpeOptions = {},
): BeliefOpeReport {
  const trajectoryReport = beliefDecisionsToOffPolicyTrajectories(points, targetPolicy, options)
  const { trajectories } = trajectoryReport
  const estimates = offPolicyEstimateAll(trajectories, options)
  const support = supportDiagnostics(estimates.dr, {
    minEffectiveSampleSize: options.minEffectiveSampleSize ?? 30,
    minEffectiveSampleRatio: options.minEffectiveSampleRatio ?? 0.25,
    dropped: trajectoryReport.dropped,
    diagnostics: trajectoryReport.diagnostics,
    legacyScalarContributions: estimates.dr.contributionCounts?.legacyScalar ?? 0,
  })
  return { targetPolicyId: targetPolicy.id, ...estimates, support }
}

function supportDiagnostics(
  estimate: { n: number; effectiveSampleSize: number; maxImportanceWeight: number },
  options: {
    minEffectiveSampleSize: number
    minEffectiveSampleRatio: number
    dropped: number
    diagnostics: string[]
    legacyScalarContributions: number
  },
): BeliefOpeSupportDiagnostics {
  const ratio = estimate.n > 0 ? estimate.effectiveSampleSize / estimate.n : 0
  const reasons: string[] = [...options.diagnostics]
  if (estimate.n === 0) {
    reasons.push('no valid OPE trajectories')
  }
  if (options.dropped > 0) {
    reasons.push(`dropped ${options.dropped} unsupported decision(s)`)
  }
  if (options.legacyScalarContributions > 0) {
    reasons.push(
      `${options.legacyScalarContributions} decision(s) used deprecated scalar qHat; supply qHatChosen and vHatTarget for contextual doubly robust estimation`,
    )
  }
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
    dropped: options.dropped,
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

function isBehaviorProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 && value <= 1
}

function isTargetProbability(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 1
}

function formatProbability(value: unknown): string {
  return typeof value === 'number' ? String(value) : String(value ?? 'missing')
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function compactDiagnostics(diagnostics: string[], maxDiagnostics: number): string[] {
  if (diagnostics.length <= maxDiagnostics) return diagnostics
  return [
    ...diagnostics.slice(0, maxDiagnostics),
    `${diagnostics.length - maxDiagnostics} additional OPE diagnostic(s) omitted`,
  ]
}
