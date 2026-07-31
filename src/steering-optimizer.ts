import { aggregateRunScore, type RunScore, type RunScoreWeights } from './run-score'
import type { SteeringBundle } from './steering'

export type SteeringOptimizerBackend = 'pairwise'

export interface SteeringOptimizationRow {
  variantId: string
  scenarioId: string
  bundle: SteeringBundle
  score: RunScore
  metadata?: Record<string, unknown>
}

export interface SteeringOptimizationSelector {
  backend: SteeringOptimizerBackend
  signature?: string
  labels?: string[]
  rationale?: string
}

export interface SteeringOptimizationResult {
  backend: SteeringOptimizerBackend
  recommendedVariantId: string
  rationale: string
  rankings: Array<{ variantId: string; mean: number; runs: number }>
  selector?: SteeringOptimizationSelector
  skipped?: boolean
}

export interface SteeringOptimizerConfig {
  weights?: Partial<RunScoreWeights>
}

/**
 * Rank already-evaluated steering variants.
 *
 * Model-backed candidate generation belongs to the official GEPA campaign
 * integration. This class only performs the deterministic selection it owns.
 */
export class PairwiseSteeringOptimizer {
  optimize(
    rows: SteeringOptimizationRow[],
    config: SteeringOptimizerConfig = {},
  ): SteeringOptimizationResult {
    const rankings = rankRows(rows, config.weights)
    if (rankings.length === 0) throw new Error('no steering optimization rows')
    return {
      backend: 'pairwise',
      recommendedVariantId: rankings[0]!.variantId,
      rationale: `Highest observed mean aggregate across ${rows.length} scored run(s).`,
      rankings,
    }
  }
}

function rankRows(
  rows: readonly SteeringOptimizationRow[],
  weights?: Partial<RunScoreWeights>,
): Array<{ variantId: string; mean: number; runs: number }> {
  const buckets = new Map<string, number[]>()
  for (const row of rows) {
    const values = buckets.get(row.variantId) ?? []
    values.push(aggregateRunScore(row.score, weights))
    buckets.set(row.variantId, values)
  }
  return [...buckets.entries()]
    .map(([variantId, values]) => ({
      variantId,
      mean: values.reduce((sum, value) => sum + value, 0) / values.length,
      runs: values.length,
    }))
    .sort((a, b) => b.mean - a.mean)
}
