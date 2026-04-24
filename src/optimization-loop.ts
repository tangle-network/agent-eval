import { PromptOptimizer, type PromptVariant } from './prompt-optimizer'
import { aggregateRunScore, type RunScore, type RunScoreWeights } from './run-score'
import type { SteeringBundle } from './steering'
import { renderSteeringText } from './steering'

export interface OptimizationExample {
  scenarioId: string
  metadata?: Record<string, unknown>
}

export interface SteeringEvaluation {
  variant: SteeringBundle
  example: OptimizationExample
  trialIndex: number
}

export interface SteeringVariantReport {
  variantId: string
  bundle: SteeringBundle
  mean: number
  ci95: { lower: number; upper: number }
  scenarioScores: Record<string, { mean: number; n: number; samples: number[] }>
}

export interface OptimizationLoopResult {
  winner: SteeringBundle
  significant: boolean
  reports: SteeringVariantReport[]
  pairwise: Array<{
    variantA: string
    variantB: string
    pValue: number
    qValue: number
    significant: boolean
    meanDelta: number
  }>
}

export interface OptimizationLoopConfig {
  variants: SteeringBundle[]
  examples: OptimizationExample[]
  evaluate: (args: SteeringEvaluation) => Promise<RunScore>
  scoreWeights?: Partial<RunScoreWeights>
  trialsPerScenario?: number
}

export class OptimizationLoop {
  private readonly optimizer: PromptOptimizer

  constructor(optimizer = new PromptOptimizer()) {
    this.optimizer = optimizer
  }

  async run(config: OptimizationLoopConfig): Promise<OptimizationLoopResult> {
    const byId = new Map(config.variants.map((variant) => [variant.id, variant]))
    const result = await this.optimizer.run({
      variants: config.variants.map<PromptVariant>((variant) => ({
        id: variant.id,
        prompt: renderSteeringText(variant),
        metadata: { bundle: variant },
      })),
      scenarioIds: config.examples.map((example) => example.scenarioId),
      trialsPerScenario: config.trialsPerScenario,
      scoreVariant: async ({ variant, scenarioId, trialIndex }) => {
        const bundle = byId.get(variant.id)
        if (!bundle) throw new Error(`unknown steering bundle ${variant.id}`)
        const example = config.examples.find((item) => item.scenarioId === scenarioId)
        if (!example) throw new Error(`unknown optimization example ${scenarioId}`)
        const score = await config.evaluate({ variant: bundle, example, trialIndex })
        return aggregateRunScore(score, config.scoreWeights)
      },
    })

    return {
      winner: byId.get(result.winner.variantId)!,
      significant: result.winner.significant,
      reports: result.scores.map((score) => ({
        variantId: score.variantId,
        bundle: byId.get(score.variantId)!,
        mean: score.mean,
        ci95: score.ci95,
        scenarioScores: score.perScenario,
      })),
      pairwise: result.pairwise,
    }
  }
}
