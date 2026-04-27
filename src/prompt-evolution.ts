/**
 * PromptEvolutionLoop — population-based reflective-mutation evolution.
 *
 * Above the existing `AxGepaSteeringOptimizer` (which RANKS variants),
 * this loop GENERATES variants. Each generation:
 *   1. Score the population across (variant × scenario × rep).
 *   2. Pick survivors from the Pareto frontier (with crowding-distance tie-break).
 *   3. Ask the mutator for replacements until population size is restored.
 *   4. Repeat for N generations OR until convergence.
 *
 * Domain-agnostic. Consumers supply:
 *   - A seed population of `PromptVariant`s.
 *   - A `ScoreAdapter` that runs (variant, scenario, rep) → `TrialResult`.
 *   - A `MutateAdapter` that produces children given trace evidence.
 *   - Pareto `Objective<TrialAggregate>[]` defining the multi-objective vector.
 *
 * The loop owns: population management, parallel scheduling (concurrency-
 * limited), Pareto selection with crowding distance, generation reporting.
 *
 * It does NOT own: rendering trials to a model, executing prompts, choosing
 * mutation primitives, persisting to disk. Those are the consumer's call.
 */

import { paretoFrontierWithCrowding, scalarScore, type Objective } from './pareto'

export interface PromptVariant<P = unknown> {
  /** Stable id for the variant — surfaces in reports and trial results. */
  id: string
  /** Variant payload — interpretation is the consumer's responsibility. */
  payload: P
  /** Generation index (0 = seed, then 1, 2, ...). */
  generation: number
  /** Parent variant id when produced via mutation; absent for seeds. */
  parentId?: string
  /** Human label for reports. */
  label: string
  /** What the mutator was trying to fix. */
  rationale?: string
}

export interface TrialResult {
  variantId: string
  scenarioId: string
  rep: number
  ok: boolean
  /** Primary scalar score the consumer cares about (e.g., recall, accuracy). */
  score: number
  /** Token cost (or any cost-like dimension). */
  cost?: number
  /** Wall time in ms. */
  durationMs?: number
  /** Free-form metric bag for objective accessors. */
  metrics?: Record<string, number>
  error?: string
}

/** Aggregated trial summary for one (variant, scenario) pair across reps. */
export interface ScenarioAggregate {
  variantId: string
  scenarioId: string
  meanScore: number
  meanCost: number
  meanDurationMs: number
  okRate: number
  trials: number
  /** Mean of every numeric metric across reps. */
  metrics: Record<string, number>
}

/** Aggregated trial summary for one variant across all scenarios. */
export interface VariantAggregate {
  variantId: string
  meanScore: number
  meanCost: number
  meanDurationMs: number
  okRate: number
  scenarios: ScenarioAggregate[]
  /** Mean of every numeric metric, averaged across scenarios. */
  metrics: Record<string, number>
}

export interface ScoreAdapter<P = unknown> {
  score(args: {
    variant: PromptVariant<P>
    scenarioId: string
    rep: number
  }): Promise<TrialResult>
}

export interface MutateAdapter<P = unknown> {
  mutate(args: {
    parent: PromptVariant<P>
    parentAggregate: VariantAggregate
    topTrials: TrialResult[]
    bottomTrials: TrialResult[]
    childCount: number
    generation: number
  }): Promise<PromptVariant<P>[]>
}

export interface PromptEvolutionConfig<P = unknown> {
  runId: string
  /** What component is being mutated — surfaces in reports + reflection prompts. */
  target: string
  seedVariants: PromptVariant<P>[]
  scenarioIds: string[]
  reps: number
  generations: number
  populationSize: number
  /** Maximum concurrent score() calls. */
  scoreConcurrency: number
  scoreAdapter: ScoreAdapter<P>
  mutateAdapter: MutateAdapter<P>
  /** Pareto objectives over `VariantAggregate`. Ordered by importance. */
  objectives: Objective<VariantAggregate>[]
  /** Optional weights for the scalar tie-break selector (by objective name). */
  scalarWeights?: Record<string, number>
  /** Stop early if a generation produces no Pareto improvement. Default true. */
  earlyStopOnNoImprovement?: boolean
  onProgress?: (event: PromptEvolutionEvent) => void
  /**
   * Optional cache key for memoising scored (variantId, scenarioId, rep)
   * tuples. When provided AND a cache instance is passed, repeated trials
   * skip re-scoring. Cache keys are stable across runs.
   */
  cache?: TrialCache
}

export interface TrialCache {
  get(key: string): TrialResult | undefined
  set(key: string, value: TrialResult): void
}

export class InMemoryTrialCache implements TrialCache {
  private store = new Map<string, TrialResult>()
  get(key: string): TrialResult | undefined { return this.store.get(key) }
  set(key: string, value: TrialResult): void { this.store.set(key, value) }
  size(): number { return this.store.size }
  clear(): void { this.store.clear() }
}

export type PromptEvolutionEvent =
  | { type: 'generation-start'; generation: number; populationSize: number }
  | { type: 'trial-complete'; generation: number; variantId: string; scenarioId: string; rep: number; ok: boolean; score: number; cached: boolean }
  | { type: 'generation-complete'; report: GenerationReport<unknown> }
  | { type: 'converged'; generation: number; reason: string }

export interface GenerationReport<P = unknown> {
  runId: string
  target: string
  generation: number
  variants: PromptVariant<P>[]
  aggregates: VariantAggregate[]
  /** Frontier candidates, sorted by descending crowding distance. */
  paretoFrontIds: string[]
  /** Scalar-best variant id — used for the single "winner" if callers want one. */
  winnerId: string
  /** Trials that fed this generation (kept for downstream reporting). */
  trials: TrialResult[]
}

export interface PromptEvolutionResult<P = unknown> {
  runId: string
  target: string
  generations: GenerationReport<P>[]
  /** Best variant by scalar score in the final generation. */
  bestVariant: PromptVariant<P>
  /** Best aggregate (matches bestVariant). */
  bestAggregate: VariantAggregate
}

export async function runPromptEvolution<P>(
  config: PromptEvolutionConfig<P>,
): Promise<PromptEvolutionResult<P>> {
  const generations: GenerationReport<P>[] = []
  let population = [...config.seedVariants]
  let bestVariant: PromptVariant<P> = population[0]!
  let bestAggregate: VariantAggregate | null = null

  for (let generation = 0; generation < config.generations; generation++) {
    config.onProgress?.({ type: 'generation-start', generation, populationSize: population.length })

    const trials = await scorePopulation(population, config, generation)
    const aggregates = aggregateTrials(population, config.scenarioIds, trials)

    const front = paretoFrontierWithCrowding(aggregates, config.objectives)
    const frontIds = new Set(front.map((c) => c.candidate.variantId))

    const scored = scalarScore(aggregates, config.objectives, { weights: config.scalarWeights })
    scored.sort((a, b) => b.score - a.score)
    const winnerId = scored[0]?.candidate.variantId ?? aggregates[0]?.variantId ?? population[0]!.id

    const report: GenerationReport<P> = {
      runId: config.runId,
      target: config.target,
      generation,
      variants: population,
      aggregates,
      paretoFrontIds: front.map((c) => c.candidate.variantId),
      winnerId,
      trials,
    }
    generations.push(report)
    config.onProgress?.({ type: 'generation-complete', report })

    const winnerAgg = aggregates.find((a) => a.variantId === winnerId)
    if (winnerAgg) {
      const winner = population.find((v) => v.id === winnerId)
      if (winner) bestVariant = winner
      bestAggregate = winnerAgg
    }

    // Convergence: no Pareto-or-scalar improvement vs previous generation.
    if (config.earlyStopOnNoImprovement !== false && generations.length >= 2) {
      const prev = generations[generations.length - 2]!
      const noChange = prev.winnerId === winnerId && samePopulation(prev.paretoFrontIds, [...frontIds])
      if (noChange) {
        config.onProgress?.({ type: 'converged', generation, reason: 'no improvement vs previous generation' })
        break
      }
    }

    if (generation === config.generations - 1) break

    population = await nextPopulation(population, aggregates, trials, front, config, generation + 1)
  }

  return {
    runId: config.runId,
    target: config.target,
    generations,
    bestVariant,
    bestAggregate: bestAggregate ?? aggregateTrials(population, config.scenarioIds, []).find((a) => a.variantId === bestVariant.id)!,
  }
}

async function scorePopulation<P>(
  population: PromptVariant<P>[],
  config: PromptEvolutionConfig<P>,
  generation: number,
): Promise<TrialResult[]> {
  const jobs: Array<() => Promise<TrialResult>> = []
  for (const variant of population) {
    for (const scenarioId of config.scenarioIds) {
      for (let rep = 0; rep < config.reps; rep++) {
        jobs.push(async () => {
          const cacheKey = `${variant.id}|${scenarioId}|${rep}`
          const cached = config.cache?.get(cacheKey)
          if (cached) {
            config.onProgress?.({
              type: 'trial-complete',
              generation,
              variantId: variant.id,
              scenarioId,
              rep,
              ok: cached.ok,
              score: cached.score,
              cached: true,
            })
            return cached
          }
          const result = await config.scoreAdapter.score({ variant, scenarioId, rep })
          config.cache?.set(cacheKey, result)
          config.onProgress?.({
            type: 'trial-complete',
            generation,
            variantId: variant.id,
            scenarioId,
            rep,
            ok: result.ok,
            score: result.score,
            cached: false,
          })
          return result
        })
      }
    }
  }
  return runWithConcurrency(jobs, config.scoreConcurrency)
}

async function runWithConcurrency<T>(jobs: Array<() => Promise<T>>, concurrency: number): Promise<T[]> {
  const results: T[] = new Array(jobs.length)
  const limit = Math.max(1, concurrency)
  let next = 0
  async function worker(): Promise<void> {
    while (true) {
      const i = next++
      if (i >= jobs.length) return
      results[i] = await jobs[i]!()
    }
  }
  await Promise.all(Array.from({ length: limit }, () => worker()))
  return results
}

function aggregateTrials<P>(
  population: PromptVariant<P>[],
  scenarioIds: string[],
  trials: TrialResult[],
): VariantAggregate[] {
  return population.map((variant) => {
    const variantTrials = trials.filter((t) => t.variantId === variant.id)
    const scenarios = scenarioIds.map<ScenarioAggregate>((sid) => {
      const scenarioTrials = variantTrials.filter((t) => t.scenarioId === sid)
      const okTrials = scenarioTrials.filter((t) => t.ok)
      // Mean score must include every successfully-graded trial — a trial
      // with score=0.6 and ok=false (below quality_bar) is real signal, not
      // noise. Only `error` trials (agent crash, judge crash) carry a
      // synthetic score and are excluded. okRate continues to reflect the
      // pass/fail rate against the configured quality_bar.
      const gradedTrials = scenarioTrials.filter((t) => !t.error)
      const metrics = aggregateMetrics(gradedTrials.map((t) => t.metrics ?? {}))
      return {
        variantId: variant.id,
        scenarioId: sid,
        meanScore: mean(gradedTrials.map((t) => t.score)),
        meanCost: mean(gradedTrials.map((t) => t.cost ?? 0)),
        meanDurationMs: mean(gradedTrials.map((t) => t.durationMs ?? 0)),
        okRate: scenarioTrials.length === 0 ? 0 : okTrials.length / scenarioTrials.length,
        trials: scenarioTrials.length,
        metrics,
      }
    })
    return {
      variantId: variant.id,
      meanScore: mean(scenarios.map((s) => s.meanScore)),
      meanCost: mean(scenarios.map((s) => s.meanCost)),
      meanDurationMs: mean(scenarios.map((s) => s.meanDurationMs)),
      okRate: mean(scenarios.map((s) => s.okRate)),
      scenarios,
      metrics: aggregateMetrics(scenarios.map((s) => s.metrics)),
    }
  })
}

function aggregateMetrics(rows: Array<Record<string, number>>): Record<string, number> {
  const buckets = new Map<string, number[]>()
  for (const row of rows) {
    for (const [k, v] of Object.entries(row)) {
      if (!Number.isFinite(v)) continue
      const list = buckets.get(k) ?? []
      list.push(v)
      buckets.set(k, list)
    }
  }
  const out: Record<string, number> = {}
  for (const [k, list] of buckets) out[k] = mean(list)
  return out
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

async function nextPopulation<P>(
  current: PromptVariant<P>[],
  aggregates: VariantAggregate[],
  trials: TrialResult[],
  front: Array<{ candidate: VariantAggregate; distance: number }>,
  config: PromptEvolutionConfig<P>,
  nextGeneration: number,
): Promise<PromptVariant<P>[]> {
  const survivorIds = new Set(front.map((c) => c.candidate.variantId))
  const survivors = current.filter((v) => survivorIds.has(v.id))

  // Pick the best survivor (by scalar) as the mutation parent.
  const ranked = scalarScore(aggregates, config.objectives, { weights: config.scalarWeights })
    .sort((a, b) => b.score - a.score)
  const parentId = ranked[0]?.candidate.variantId ?? current[0]!.id
  const parent = current.find((v) => v.id === parentId) ?? current[0]!
  const parentAggregate = aggregates.find((a) => a.variantId === parent.id) ?? aggregates[0]!

  const topTrials = topKTrialsByScore(trials, parent.id, 3)
  const bottomTrials = bottomKTrialsByScore(trials, parent.id, 3)
  const childCount = Math.max(0, config.populationSize - survivors.length)
  let children: PromptVariant<P>[] = []
  if (childCount > 0) {
    children = await config.mutateAdapter.mutate({
      parent,
      parentAggregate,
      topTrials,
      bottomTrials,
      childCount,
      generation: nextGeneration,
    })
    children = children.slice(0, childCount).map((c) => ({ ...c, generation: nextGeneration, parentId: parent.id }))
  }
  return [...survivors, ...children]
}

function topKTrialsByScore(trials: TrialResult[], variantId: string, k: number): TrialResult[] {
  return trials.filter((t) => t.variantId === variantId && t.ok).sort((a, b) => b.score - a.score).slice(0, k)
}

function bottomKTrialsByScore(trials: TrialResult[], variantId: string, k: number): TrialResult[] {
  return trials.filter((t) => t.variantId === variantId && t.ok).sort((a, b) => a.score - b.score).slice(0, k)
}

function samePopulation(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false
  const setA = new Set(a)
  return b.every((id) => setA.has(id))
}
