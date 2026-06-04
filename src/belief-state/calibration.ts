import { calibrationFromPairs } from '../meta-eval/calibration'
import type { BeliefDecisionPoint } from './types'

export interface BeliefCalibrationOptions {
  bins?: number
  minPairs?: number
}

export function calibrateBeliefDecisions(
  points: BeliefDecisionPoint[],
  options: BeliefCalibrationOptions = {},
) {
  const pairs = points
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

function outcomeScore(point: BeliefDecisionPoint): number {
  if (typeof point.outcome?.reward === 'number') return point.outcome.reward
  if (typeof point.outcome?.score === 'number') return point.outcome.score
  if (point.outcome?.success === true) return 1
  if (point.outcome?.success === false) return 0
  return Number.NaN
}
