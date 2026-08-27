import { type AxAIService, AxGEPA, type AxMetricFn, AxSignature, ax } from '@ax-llm/ax'
import { createAnalystAi } from './analyst/ax-service'
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
  /** Runnable handle on the trained classifier. Present only when the
   *  ax-gepa backend completed training; calls the optimized selector
   *  program via ax's `forward`. */
  selectVariant?: (row: {
    task: string
    split: string
    seedPreview: string
  }) => Promise<{ variantId: string; rationale: string }>
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
  minScenarioWinners?: number
}

export class PairwiseSteeringOptimizer {
  optimize(
    rows: SteeringOptimizationRow[],
    config: SteeringOptimizerConfig = {},
  ): SteeringOptimizationResult {
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
    const minScenarioWinners = this.config.minScenarioWinners ?? 6
    const variantIds = [...new Set(rows.map((row) => row.variantId))]
    const byScenario = collapseScenarioWinners(rows, this.config.weights)
    if (variantIds.length < 2 || byScenario.length < minScenarioWinners) {
      return {
        ...fallback,
        backend: 'ax-gepa',
        skipped: true,
        rationale: `AxGEPA skipped: need >=2 variants and >=${minScenarioWinners} scenario winners, got ${variantIds.length} variant(s) and ${byScenario.length} scenario winner(s).`,
      }
    }

    const signature = `task:string, split:string, seedPreview:string -> variantId:class "${variantIds.join(', ')}", rationale:string`
    const selectorSignature = AxSignature.from<
      { task: string; split: string; seedPreview: string },
      { variantId: string; rationale?: string }
    >(signature)
    const selector = ax(selectorSignature, {
      description: 'Choose the best steering bundle variant for an autopilot task.',
    })
    const shuffled = seededShuffle(byScenario, signature)
    const splitIndex = Math.max(1, Math.floor(shuffled.length * 0.8))
    const train = shuffled.slice(0, splitIndex)
    const validation = shuffled.slice(splitIndex)
    if (!validation.length) {
      return {
        ...fallback,
        backend: 'ax-gepa',
        skipped: true,
        rationale: 'AxGEPA skipped: no validation examples after split.',
      }
    }

    const studentAI = createAxService(this.config.provider, this.config.apiKey, this.config.model)
    const optimizer = new AxGEPA({
      studentAI,
      teacherAI: createAxService(
        this.config.provider,
        this.config.apiKey,
        this.config.teacherModel ?? this.config.model,
      ),
      numTrials: 8,
      minibatch: true,
      minibatchSize: 4,
      earlyStoppingTrials: 3,
      sampleCount: 1,
    })

    const metric: AxMetricFn = ({ prediction, example }) =>
      stringField(prediction, 'variantId') === stringField(example, 'variantId') ? 1 : 0
    const compiled = await optimizer.compile(selector, train, metric, {
      validationExamples: validation,
      maxMetricCalls: 64,
    })
    if (compiled.optimizedProgram !== undefined) {
      selector.applyOptimization(compiled.optimizedProgram)
    }

    // After applyOptimization the `selector` program carries the trained
    // weights; the closure runs it through ax's `forward` so the caller can
    // classify unseen tasks rather than only read a description string.
    const selectVariant = async (row: { task: string; split: string; seedPreview: string }) => {
      const prediction = await selector.forward(studentAI, row)
      return {
        variantId: String(prediction.variantId),
        rationale: String(prediction.rationale ?? ''),
      }
    }

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
      selectVariant,
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

function collapseScenarioWinners(
  rows: SteeringOptimizationRow[],
  weights?: Partial<RunScoreWeights>,
) {
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

function createAxService(
  provider: 'openai' | 'anthropic',
  apiKey: string,
  model: string,
): AxAIService {
  return createAnalystAi({
    provider,
    apiKey,
    model,
  })
}

function stringField(value: unknown, field: string): string | undefined {
  if (!value || typeof value !== 'object') return undefined
  const candidate = (value as Record<string, unknown>)[field]
  return typeof candidate === 'string' ? candidate : undefined
}

// Deterministic Fisher-Yates driven by a seeded mulberry32 PRNG. Seeding from
// a stable value (the signature) keeps train/validation splits reproducible
// across runs while removing positional skew when rows arrive grouped.
function seededShuffle<T>(items: readonly T[], seed: string): T[] {
  const rng = mulberry32(hashString(seed))
  const out = [...items]
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[out[i], out[j]] = [out[j]!, out[i]!]
  }
  return out
}

function hashString(value: string): number {
  let h = 2166136261
  for (let i = 0; i < value.length; i++) {
    h ^= value.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
