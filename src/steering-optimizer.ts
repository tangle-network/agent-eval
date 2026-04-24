import { aggregateRunScore, type RunScore, type RunScoreWeights } from './run-score'
import type { SteeringBundle } from './steering'

export type SteeringOptimizerBackend = 'pairwise' | 'ax-gepa'

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

export interface AxSteeringOptimizerConfig extends SteeringOptimizerConfig {
  provider: 'openai' | 'anthropic'
  apiKey: string
  model: string
  teacherModel?: string
  minRows?: number
}

export class PairwiseSteeringOptimizer {
  optimize(rows: SteeringOptimizationRow[], config: SteeringOptimizerConfig = {}): SteeringOptimizationResult {
    const ranked = rankRows(rows, config.weights)
    if (!ranked.length) throw new Error('no steering optimization rows')
    return {
      backend: 'pairwise',
      recommendedVariantId: ranked[0]!.variantId,
      rationale: `Highest observed mean aggregate across ${rows.length} scored run(s).`,
      rankings: ranked,
    }
  }
}

export class AxGepaSteeringOptimizer {
  constructor(private readonly config: AxSteeringOptimizerConfig) {}

  async optimize(rows: SteeringOptimizationRow[]): Promise<SteeringOptimizationResult> {
    const fallback = new PairwiseSteeringOptimizer().optimize(rows, this.config)
    const minRows = this.config.minRows ?? 6
    const variantIds = [...new Set(rows.map((row) => row.variantId))]
    const byScenario = collapseScenarioWinners(rows, this.config.weights)
    if (variantIds.length < 2 || byScenario.length < minRows) {
      return {
        ...fallback,
        backend: 'ax-gepa',
        skipped: true,
        rationale: `AxGEPA skipped: need >=2 variants and >=${minRows} scenario winners, got ${variantIds.length} variant(s) and ${byScenario.length} scenario winner(s).`,
      }
    }

    let axLib: any
    try {
      axLib = await import('@ax-llm/ax')
    } catch {
      return {
        ...fallback,
        backend: 'ax-gepa',
        skipped: true,
        rationale: 'AxGEPA unavailable: install @ax-llm/ax to enable selector optimization.',
      }
    }

    const { ai, ax, AxGEPA } = axLib
    const signature = `task:string, split:string, seedPreview:string -> variantId:class "${variantIds.join(', ')}", rationale:string`
    const selector = ax(signature, {
      description: 'Choose the best steering bundle variant for an autopilot task.',
    })
    const splitIndex = Math.max(1, Math.floor(byScenario.length * 0.8))
    const train = byScenario.slice(0, splitIndex)
    const validation = byScenario.slice(splitIndex)
    if (!validation.length) {
      return {
        ...fallback,
        backend: 'ax-gepa',
        skipped: true,
        rationale: 'AxGEPA skipped: no validation examples after split.',
      }
    }

    const optimizer = new AxGEPA({
      studentAI: createAxService(ai, this.config.provider, this.config.apiKey, this.config.model),
      teacherAI: createAxService(ai, this.config.provider, this.config.apiKey, this.config.teacherModel ?? this.config.model),
      numTrials: 8,
      minibatch: true,
      minibatchSize: 4,
      earlyStoppingTrials: 3,
      sampleCount: 1,
    })

    const compiled = await optimizer.compile(
      selector,
      train,
      (({ prediction, example }: any) => prediction?.variantId === example?.variantId ? 1 : 0) as any,
      {
        validationExamples: validation,
        maxMetricCalls: 64,
      },
    )
    selector.applyOptimization(compiled.optimizedProgram!)

    return {
      ...fallback,
      backend: 'ax-gepa',
      rationale: `AxGEPA trained a variant selector from ${byScenario.length} scored scenario winner(s); default winner remains ${fallback.recommendedVariantId}.`,
      selector: {
        backend: 'ax-gepa',
        signature,
        labels: variantIds,
        rationale: compiled.bestScore !== undefined ? `bestScore=${compiled.bestScore}` : undefined,
      },
    }
  }
}

function rankRows(rows: SteeringOptimizationRow[], weights?: Partial<RunScoreWeights>) {
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

function collapseScenarioWinners(rows: SteeringOptimizationRow[], weights?: Partial<RunScoreWeights>) {
  const byScenario = new Map<string, SteeringOptimizationRow[]>()
  for (const row of rows) {
    const bucket = byScenario.get(row.scenarioId) ?? []
    bucket.push(row)
    byScenario.set(row.scenarioId, bucket)
  }
  return [...byScenario.entries()].map(([scenarioId, scenarioRows]) => {
    const best = scenarioRows
      .map((row) => ({ row, aggregate: aggregateRunScore(row.score, weights) }))
      .sort((a, b) => b.aggregate - a.aggregate)[0]!
    return {
      task: String(best.row.metadata?.task ?? best.row.metadata?.seed_preview ?? scenarioId),
      split: String(best.row.metadata?.split ?? 'train'),
      seedPreview: String(best.row.metadata?.seed_preview ?? ''),
      variantId: best.row.variantId,
    }
  })
}

function createAxService(aiFactory: any, provider: 'openai' | 'anthropic', apiKey: string, model: string) {
  return aiFactory({
    name: provider,
    apiKey,
    config: { model },
  })
}
