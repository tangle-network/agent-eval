/**
 * Prompt optimizer — A/B test prompt variants with statistical rigor.
 *
 * Runs N prompt variants against a fixed scenario set, collects per-scenario
 * scores via the user-provided `scoreVariant` callback, and returns:
 *   - per-variant mean + bootstrap CI
 *   - pairwise significance (Mann-Whitney, non-parametric — works on any
 *     score distribution, not just normal)
 *   - a winner (highest mean, flagged if the lead is not significant)
 *
 * Deliberately generic — the `scoreVariant` callback does whatever domain
 * work the consumer needs (invoke the agent, judge the output, whatever),
 * and returns a number per scenario. This lets the optimizer stay small +
 * testable.
 */

import { confidenceInterval, mannWhitneyU } from './statistics'
import { benjaminiHochberg } from './power-analysis'

export interface PromptVariant {
  id: string
  prompt: string
  metadata?: Record<string, unknown>
}

export interface OptimizationConfig {
  variants: PromptVariant[]
  /** How many trials per (variant, scenario) — controls CI tightness. Default 3. */
  trialsPerScenario?: number
  /** Significance threshold for pairwise comparison (default 0.05). */
  significanceLevel?: number
  /**
   * The scoring callback. For each (variant, scenarioId, trialIndex), produce
   * a score in 0..1 (or any numeric range — the optimizer only cares about
   * monotonicity).
   */
  scoreVariant: (args: {
    variant: PromptVariant
    scenarioId: string
    trialIndex: number
  }) => Promise<number>
  /** Scenario ids to run against. */
  scenarioIds: string[]
  /** Optional hook — fires after each (variant, scenario) fully scored. */
  onScenarioComplete?: (info: {
    variantId: string
    scenarioId: string
    scores: number[]
  }) => void
}

export interface VariantScore {
  variantId: string
  mean: number
  ci95: { lower: number; upper: number }
  n: number
  perScenario: Record<string, { mean: number; n: number; samples: number[] }>
}

export interface PairwiseComparison {
  variantA: string
  variantB: string
  pValue: number
  /** BH-FDR-corrected q-value across all n*(n-1)/2 pairwise tests. */
  qValue: number
  /** True when q-value passes the FDR threshold. Prefer over raw p-value when variants > 2. */
  significant: boolean
  meanDelta: number
}

export interface OptimizationResult {
  winner: {
    variantId: string
    /** True when the winner's lead vs every other variant is statistically significant. */
    significant: boolean
    ciLowerBoundExceedsSecondMean: boolean
  }
  scores: VariantScore[]
  pairwise: PairwiseComparison[]
  config: {
    trialsPerScenario: number
    significanceLevel: number
    variants: string[]
    scenarios: string[]
  }
}

export class PromptOptimizer {
  async run(config: OptimizationConfig): Promise<OptimizationResult> {
    const trials = config.trialsPerScenario ?? 3
    const alpha = config.significanceLevel ?? 0.05

    if (config.variants.length < 2) {
      throw new Error('PromptOptimizer requires at least 2 variants')
    }
    if (config.scenarioIds.length === 0) {
      throw new Error('PromptOptimizer requires at least 1 scenario')
    }

    // Collect scores for every (variant, scenario, trial).
    const rawScores = new Map<string, Map<string, number[]>>() // variantId → scenarioId → samples

    for (const variant of config.variants) {
      const scenarioMap = new Map<string, number[]>()
      rawScores.set(variant.id, scenarioMap)

      for (const scenarioId of config.scenarioIds) {
        const samples: number[] = []
        for (let t = 0; t < trials; t++) {
          const score = await config.scoreVariant({
            variant,
            scenarioId,
            trialIndex: t,
          })
          if (!Number.isFinite(score)) {
            throw new Error(`scoreVariant returned non-finite: variant=${variant.id} scenario=${scenarioId} trial=${t}`)
          }
          samples.push(score)
        }
        scenarioMap.set(scenarioId, samples)
        config.onScenarioComplete?.({
          variantId: variant.id,
          scenarioId,
          scores: samples,
        })
      }
    }

    // Build per-variant VariantScore.
    const scores: VariantScore[] = config.variants.map((variant) => {
      const scenarioMap = rawScores.get(variant.id)!
      const allSamples: number[] = []
      const perScenario: VariantScore['perScenario'] = {}
      for (const scenarioId of config.scenarioIds) {
        const samples = scenarioMap.get(scenarioId) ?? []
        allSamples.push(...samples)
        perScenario[scenarioId] = {
          mean: samples.length ? samples.reduce((a, b) => a + b, 0) / samples.length : 0,
          n: samples.length,
          samples,
        }
      }
      const ci = confidenceInterval(allSamples, 0.95)
      return {
        variantId: variant.id,
        mean: ci.mean,
        ci95: { lower: ci.lower, upper: ci.upper },
        n: allSamples.length,
        perScenario,
      }
    })

    // Pairwise comparisons — raw p-values first, then BH-FDR correction
    // across the full n*(n-1)/2 matrix. Without correction, 3+ variants
    // pump false-positive rate way past alpha.
    const rawPairs: Array<{ a: VariantScore; b: VariantScore; p: number }> = []
    for (let i = 0; i < scores.length; i++) {
      for (let j = i + 1; j < scores.length; j++) {
        const a = scores[i]
        const b = scores[j]
        const { p } = mannWhitneyU(flatSamples(a), flatSamples(b))
        rawPairs.push({ a, b, p })
      }
    }
    const { qValues } = benjaminiHochberg(rawPairs.map((r) => r.p), alpha)
    const pairwise: PairwiseComparison[] = rawPairs.map((r, idx) => ({
      variantA: r.a.variantId,
      variantB: r.b.variantId,
      pValue: r.p,
      qValue: qValues[idx],
      significant: qValues[idx] < alpha,
      meanDelta: r.b.mean - r.a.mean,
    }))

    // Winner: highest mean. Flag significance if the winner beats every other
    // variant at the alpha threshold in its pairwise comparison.
    const sorted = scores.slice().sort((x, y) => y.mean - x.mean)
    const winner = sorted[0]
    const second = sorted[1]
    const winnerComparisons = pairwise.filter(
      (c) => c.variantA === winner.variantId || c.variantB === winner.variantId,
    )
    const significantOverAll = winnerComparisons.every((c) => c.significant)
    const ciLowerBoundExceedsSecondMean = winner.ci95.lower > second.mean

    return {
      winner: {
        variantId: winner.variantId,
        significant: significantOverAll,
        ciLowerBoundExceedsSecondMean,
      },
      scores,
      pairwise,
      config: {
        trialsPerScenario: trials,
        significanceLevel: alpha,
        variants: config.variants.map((v) => v.id),
        scenarios: config.scenarioIds,
      },
    }
  }
}

function flatSamples(score: VariantScore): number[] {
  const out: number[] = []
  for (const s of Object.values(score.perScenario)) out.push(...s.samples)
  return out
}
