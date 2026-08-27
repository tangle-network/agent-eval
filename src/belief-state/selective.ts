import { ValidationError } from '../errors'
import { confidenceInterval } from '../statistics'
import type {
  BeliefDecisionPoint,
  BeliefPolicyAction,
  BeliefSelectivePolicy,
  BeliefSelectivePolicyMetrics,
  BeliefUtilityOptions,
} from './types'

export interface EvaluateBeliefSelectivePolicyOptions {
  utility?: BeliefUtilityOptions
  minN?: number
  minAccepted?: number
  minUtilityDelta?: number
  seed?: number
}

const DEFAULT_UTILITY: Required<BeliefUtilityOptions> = {
  successUtility: 1,
  failureUtility: -1,
  deferUtility: 0,
  verifyCost: 0.05,
  askCost: 0.05,
  retryCost: 0.1,
  stopUtility: 0,
  costWeight: 1,
}

export function thresholdSelectivePolicy(options: {
  id?: string
  confidenceThreshold: number
  belowThresholdAction?: Exclude<BeliefPolicyAction, 'accept'>
}): BeliefSelectivePolicy {
  const threshold = options.confidenceThreshold
  if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) {
    throw new ValidationError(
      `thresholdSelectivePolicy: confidenceThreshold must be in [0, 1], got ${threshold}`,
    )
  }
  const belowThresholdAction = options.belowThresholdAction ?? 'verify'
  return {
    id: options.id ?? `confidence>=${threshold}`,
    decide(point) {
      const confidence = point.confidence ?? 0
      return {
        action: confidence >= threshold ? 'accept' : belowThresholdAction,
        confidence,
        targetProb: point.targetProb,
        qHatChosen: point.qHatChosen,
        vHatTarget: point.vHatTarget,
        qHat: point.qHat,
        reason:
          confidence >= threshold ? 'confidence threshold passed' : 'confidence threshold failed',
      }
    },
  }
}

export function evaluateBeliefSelectivePolicy(
  points: BeliefDecisionPoint[],
  policy: BeliefSelectivePolicy,
  options: EvaluateBeliefSelectivePolicyOptions = {},
): BeliefSelectivePolicyMetrics {
  const utility = { ...DEFAULT_UTILITY, ...(options.utility ?? {}) }
  const scored = points.filter((point) => point.outcome)
  const minN = options.minN ?? 30
  const minAccepted = options.minAccepted ?? 5
  const minUtilityDelta = options.minUtilityDelta ?? 0
  const deltas: number[] = []
  const acceptedRewards: number[] = []
  const rejectedRewards: number[] = []
  let baselineUtility = 0
  let policyUtility = 0
  let accepted = 0
  let acceptedErrors = 0

  for (const point of scored) {
    const baseline = acceptUtility(point, utility)
    const decision = policy.decide(point)
    const candidate = policyDecisionUtility(point, decision.action, utility)
    const reward = rewardOf(point, utility)
    baselineUtility += baseline
    policyUtility += candidate
    deltas.push(candidate - baseline)
    if (decision.action === 'accept') {
      accepted++
      acceptedRewards.push(reward)
      if (reward < 0) acceptedErrors++
    } else {
      rejectedRewards.push(reward)
    }
  }

  const n = scored.length
  const rejected = Math.max(0, n - accepted)
  const ci = confidenceInterval(deltas, 0.95, { seed: options.seed ?? 17 })
  const reasons: string[] = []
  if (n < minN) reasons.push(`need at least ${minN} scored decisions, got ${n}`)
  if (accepted < minAccepted)
    reasons.push(`need at least ${minAccepted} accepted decisions, got ${accepted}`)
  if (ci.lower <= minUtilityDelta) {
    reasons.push(`utility CI lower bound ${ci.lower.toFixed(4)} does not clear ${minUtilityDelta}`)
  }
  const recommendation =
    n < minN || accepted < minAccepted
      ? 'need_more_data'
      : ci.lower > minUtilityDelta
        ? 'ship'
        : 'hold'

  return {
    policyId: policy.id,
    n,
    accepted,
    rejected,
    coverage: n > 0 ? accepted / n : 0,
    acceptedErrorRate: accepted > 0 ? acceptedErrors / accepted : 0,
    baselineUtility,
    policyUtility,
    utilityDelta: policyUtility - baselineUtility,
    utilityCi95: ci,
    rejectedMeanReward: rejectedRewards.length > 0 ? mean(rejectedRewards) : null,
    recommendation,
    reasons,
  }
}

function acceptUtility(
  point: BeliefDecisionPoint,
  utility: Required<BeliefUtilityOptions>,
): number {
  return (
    rewardOf(point, utility) - utility.costWeight * (point.costUsd ?? point.outcome?.costUsd ?? 0)
  )
}

function policyDecisionUtility(
  point: BeliefDecisionPoint,
  action: BeliefPolicyAction,
  utility: Required<BeliefUtilityOptions>,
): number {
  if (action === 'accept') return acceptUtility(point, utility)
  if (action === 'verify') return utility.deferUtility - utility.verifyCost
  if (action === 'ask') return utility.deferUtility - utility.askCost
  if (action === 'retry') return utility.deferUtility - utility.retryCost
  if (action === 'stop') return utility.stopUtility
  return utility.deferUtility
}

function rewardOf(point: BeliefDecisionPoint, utility: Required<BeliefUtilityOptions>): number {
  const outcome = point.outcome
  if (!outcome) return utility.failureUtility
  if (typeof outcome.reward === 'number') return 2 * outcome.reward - 1
  if (typeof outcome.score === 'number') return 2 * outcome.score - 1
  if (outcome.success === true) return utility.successUtility
  if (outcome.success === false) return utility.failureUtility
  return utility.failureUtility
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
