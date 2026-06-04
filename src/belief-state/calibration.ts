import { ValidationError } from '../errors'
import { calibrationFromPairs } from '../meta-eval/calibration'
import type { BeliefDecisionPoint, BeliefSelectivePolicy } from './types'

export type BeliefCalibrationRegion = 'all' | 'accepted' | 'rejected'

export interface BeliefCalibrationOptions {
  bins?: number
  minPairs?: number
  policy?: BeliefSelectivePolicy
  region?: BeliefCalibrationRegion
}

export function calibrateBeliefDecisions(
  points: BeliefDecisionPoint[],
  options: BeliefCalibrationOptions = {},
) {
  const filtered = filterCalibrationRegion(points, options)
  const pairs = filtered
    .filter((point) => typeof point.confidence === 'number' && point.outcome)
    .map((point) => ({
      evalScore: point.confidence!,
      outcome: outcomeScore(point),
    }))
    .filter((pair) => Number.isFinite(pair.outcome))
  const minPairs = options.minPairs ?? 10
  if (pairs.length < minPairs) return null
  return calibrationFromPairs(pairs, 'belief-confidence', 'decision-outcome', {
    bins: options.bins ?? 5,
    range: { lo: 0, hi: 1 },
  })
}

function filterCalibrationRegion(
  points: BeliefDecisionPoint[],
  options: BeliefCalibrationOptions,
): BeliefDecisionPoint[] {
  const region = options.region ?? 'all'
  if (region === 'all') return points
  const policy = options.policy
  if (!policy) {
    throw new ValidationError(
      `calibrateBeliefDecisions: policy is required when region is "${region}"`,
    )
  }
  return points.filter((point) => {
    const accepted = policy.decide(point).action === 'accept'
    return region === 'accepted' ? accepted : !accepted
  })
}

function outcomeScore(point: BeliefDecisionPoint): number {
  if (typeof point.outcome?.reward === 'number') return point.outcome.reward
  if (typeof point.outcome?.score === 'number') return point.outcome.score
  if (point.outcome?.success === true) return 1
  if (point.outcome?.success === false) return 0
  return Number.NaN
}
