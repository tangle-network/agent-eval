/**
 * Multi-shot optimization adapter.
 *
 * This is the canonical bridge between variable-length agent trajectories
 * and `runPromptEvolution`. Apps provide four things:
 *
 *   - variants: prompt/config/tool-policy candidates
 *   - runner: executes one full task trajectory for a variant
 *   - scorer: turns that trajectory into score + actionable side information
 *   - mutator: proposes new variants from top/bottom scored trials
 *
 * The adapter owns the boring but easy-to-get-wrong glue: stable seeds,
 * score/cost objectives, error-to-trial conversion, ASI metric projection,
 * and optional paired holdout gating via `HeldOutGate`.
 */

import { type GateDecision, HeldOutGate, type HeldOutGateConfig } from './held-out-gate'
import type { Objective } from './pareto'
import {
  type EvolvableVariant,
  type PromptEvolutionEvent,
  type PromptEvolutionResult,
  runPromptEvolution,
  type ScoreAdapter,
  type TrialCache,
  type TrialResult,
  type VariantAggregate,
} from './prompt-evolution'
import type { TrialTrace } from './reflective-mutation'
import { type RunRecord, type RunSplitTag, validateRunRecord } from './run-record'

export type MultiShotSplit = 'search' | 'dev' | 'holdout'

export type AsiSeverity = 'info' | 'warning' | 'error' | 'critical'

export type MultiShotVariant<P = unknown> = EvolvableVariant<P>

export interface ActionableSideInfo {
  /** Stable expectation/check id when available. */
  expectationId?: string
  /** Human-readable diagnosis of what happened. */
  message: string
  severity?: AsiSeverity
  /** Concrete trace excerpt, file path, tool call, screenshot id, etc. */
  evidence?: string
  /** Prompt/tool/context surface likely responsible. */
  responsibleSurface?: string
  /** Suggested fix in natural language. */
  suggestion?: string
  /** Whether this expectation was satisfied. Defaults to false for ASI rows. */
  matched?: boolean
  metadata?: Record<string, unknown>
}

export interface MultiShotTrace {
  scenarioId: string
  /** Full turn/tool trace. Shape is intentionally app-owned. */
  turns?: unknown[]
  toolCalls?: unknown[]
  artifacts?: unknown[]
  /** Compact final output or summary used by reflection prompts. */
  transcript?: string
  output?: unknown
  metadata?: Record<string, unknown>
}

export interface MultiShotRun {
  trace: MultiShotTrace
  costUsd?: number
  durationMs?: number
  tokenUsage?: { input?: number; output?: number; cached?: number }
  metadata?: Record<string, unknown>
}

export interface MultiShotRunInput<P = unknown> {
  variant: EvolvableVariant<P>
  scenarioId: string
  rep: number
  split: MultiShotSplit
  /** Stable paired seed for baseline/candidate comparisons. */
  seed: number
}

export interface MultiShotRunner<P = unknown> {
  run(input: MultiShotRunInput<P>): Promise<MultiShotRun> | MultiShotRun
}

export interface MultiShotScore {
  /** Primary score in [0,1]. The adapter clamps for safety. */
  score: number
  /** Pass/fail for top/bottom trial selection. Defaults to true. */
  ok?: boolean
  costUsd?: number
  durationMs?: number
  metrics?: Record<string, number>
  asi?: ActionableSideInfo[]
  /** Optional rich output shown to reflection mutators. */
  emitted?: string
  metadata?: Record<string, unknown>
}

export interface MultiShotScorer<P = unknown> {
  score(
    input: MultiShotRunInput<P> & { run: MultiShotRun },
  ): Promise<MultiShotScore> | MultiShotScore
}

export interface MultiShotTrialResult extends TrialResult {
  split: MultiShotSplit
  seed: number
  trace?: MultiShotTrace
  asi?: ActionableSideInfo[]
  emitted?: string
  metadata?: Record<string, unknown>
}

export interface MultiShotMutateAdapter<P = unknown> {
  mutate(args: {
    parent: EvolvableVariant<P>
    parentAggregate: VariantAggregate
    topTrials: MultiShotTrialResult[]
    bottomTrials: MultiShotTrialResult[]
    childCount: number
    generation: number
  }): Promise<EvolvableVariant<P>[]>
}

export interface MultiShotGateConfig<P = unknown> {
  /** Search rows are optional, but enable HeldOutGate's overfit-gap check. */
  searchScenarioIds?: string[]
  holdoutScenarioIds: string[]
  reps?: number
  gate: HeldOutGateConfig
  /** Convert scored trajectory runs into paper-grade RunRecords. */
  toRunRecord(input: {
    variant: EvolvableVariant<P>
    scenarioId: string
    rep: number
    split: RunSplitTag
    seed: number
    trial: MultiShotTrialResult
  }): RunRecord
}

export interface MultiShotOptimizationConfig<P = unknown> {
  runId: string
  target: string
  seedVariants: EvolvableVariant<P>[]
  searchScenarioIds: string[]
  reps: number
  generations: number
  populationSize: number
  scoreConcurrency?: number
  runner: MultiShotRunner<P>
  scorer: MultiShotScorer<P>
  mutateAdapter: MultiShotMutateAdapter<P>
  objectives?: Objective<VariantAggregate>[]
  scalarWeights?: Record<string, number>
  cache?: TrialCache
  earlyStopOnNoImprovement?: boolean
  seedBase?: number
  onProgress?: (event: PromptEvolutionEvent) => void
  gate?: MultiShotGateConfig<P>
}

export interface MultiShotGateResult {
  decision: GateDecision
  candidateRuns: RunRecord[]
  baselineRuns: RunRecord[]
}

export interface MultiShotOptimizationResult<P = unknown> {
  evolution: PromptEvolutionResult<P>
  /** Best candidate on the optimizer-visible search split. */
  searchBestVariant: EvolvableVariant<P>
  searchBestAggregate: VariantAggregate
  /** Variant callers should actually ship after optional holdout gating. */
  promotedVariant: EvolvableVariant<P>
  promotedAggregate: VariantAggregate
  /** Null when no gate was configured or the search-best candidate was the baseline. */
  gate: MultiShotGateResult | null
}

export async function runMultiShotOptimization<P>(
  config: MultiShotOptimizationConfig<P>,
): Promise<MultiShotOptimizationResult<P>> {
  validateConfig(config)

  const scoreAdapter: ScoreAdapter<P> = {
    score: (args) => scoreOne(config, args.variant, args.scenarioId, args.rep, 'search'),
  }

  const evolution = await runPromptEvolution<P>({
    runId: config.runId,
    target: config.target,
    seedVariants: config.seedVariants,
    scenarioIds: config.searchScenarioIds,
    reps: config.reps,
    generations: config.generations,
    populationSize: config.populationSize,
    scoreConcurrency: config.scoreConcurrency ?? 1,
    scoreAdapter,
    mutateAdapter: {
      mutate: (args) =>
        config.mutateAdapter.mutate({
          ...args,
          topTrials: args.topTrials as MultiShotTrialResult[],
          bottomTrials: args.bottomTrials as MultiShotTrialResult[],
        }),
    },
    objectives: config.objectives ?? defaultMultiShotObjectives(),
    scalarWeights: config.scalarWeights,
    earlyStopOnNoImprovement: config.earlyStopOnNoImprovement,
    cache: config.cache,
    onProgress: config.onProgress,
  })

  let gate: MultiShotGateResult | null = null
  const baseline = config.seedVariants[0]!
  let promotedVariant = evolution.bestVariant
  let promotedAggregate = evolution.bestAggregate
  if (config.gate && evolution.bestVariant.id !== baseline.id) {
    gate = await evaluateMultiShotGate(config, baseline, evolution.bestVariant)
    if (!gate.decision.promote) {
      promotedVariant = baseline
      promotedAggregate = aggregateFor(evolution, baseline.id)
    }
  }

  return {
    evolution,
    searchBestVariant: evolution.bestVariant,
    searchBestAggregate: evolution.bestAggregate,
    promotedVariant,
    promotedAggregate,
    gate,
  }
}

export function defaultMultiShotObjectives(): Objective<VariantAggregate>[] {
  return [
    { name: 'score', direction: 'maximize', value: (a) => a.meanScore },
    { name: 'cost', direction: 'minimize', value: (a) => a.meanCost },
  ]
}

export function trialTraceFromMultiShotTrial(trial: MultiShotTrialResult): TrialTrace {
  return {
    id: `${trial.variantId}/${trial.scenarioId}/r${trial.rep}`,
    score: trial.score,
    inputName: trial.scenarioId,
    expectations: (trial.asi ?? []).map((item, i) => ({
      id: item.expectationId ?? `asi-${i}`,
      phrase: item.message,
      matched: item.matched ?? false,
    })),
    emitted: trial.emitted ?? traceExcerpt(trial.trace),
    metrics: trial.metrics,
  }
}

async function evaluateMultiShotGate<P>(
  config: MultiShotOptimizationConfig<P>,
  baseline: EvolvableVariant<P>,
  candidate: EvolvableVariant<P>,
): Promise<MultiShotGateResult> {
  const gateConfig = config.gate!
  const reps = gateConfig.reps ?? config.reps
  const candidateRuns: RunRecord[] = []
  const baselineRuns: RunRecord[] = []

  const searchIds = gateConfig.searchScenarioIds ?? config.searchScenarioIds
  for (const scenarioId of searchIds) {
    for (let rep = 0; rep < reps; rep++) {
      const seed = seedFor(config, scenarioId, rep)
      const baseTrial = await scoreOne(config, baseline, scenarioId, rep, 'search')
      const candTrial = await scoreOne(config, candidate, scenarioId, rep, 'search')
      baselineRuns.push(
        toValidatedRecord(config, baseline, scenarioId, rep, 'search', seed, baseTrial),
      )
      candidateRuns.push(
        toValidatedRecord(config, candidate, scenarioId, rep, 'search', seed, candTrial),
      )
    }
  }

  for (const scenarioId of gateConfig.holdoutScenarioIds) {
    for (let rep = 0; rep < reps; rep++) {
      const seed = seedFor(config, scenarioId, rep)
      const baseTrial = await scoreOne(config, baseline, scenarioId, rep, 'holdout')
      const candTrial = await scoreOne(config, candidate, scenarioId, rep, 'holdout')
      baselineRuns.push(
        toValidatedRecord(config, baseline, scenarioId, rep, 'holdout', seed, baseTrial),
      )
      candidateRuns.push(
        toValidatedRecord(config, candidate, scenarioId, rep, 'holdout', seed, candTrial),
      )
    }
  }

  const decision = new HeldOutGate(gateConfig.gate).evaluate(candidateRuns, baselineRuns)
  return { decision, candidateRuns, baselineRuns }
}

async function scoreOne<P>(
  config: MultiShotOptimizationConfig<P>,
  variant: EvolvableVariant<P>,
  scenarioId: string,
  rep: number,
  split: MultiShotSplit,
): Promise<MultiShotTrialResult> {
  const seed = seedFor(config, scenarioId, rep)
  const input: MultiShotRunInput<P> = { variant, scenarioId, rep, split, seed }
  try {
    const run = await config.runner.run(input)
    const scored = await config.scorer.score({ ...input, run })
    const asi = scored.asi ?? []
    return {
      variantId: variant.id,
      scenarioId,
      rep,
      ok: scored.ok ?? true,
      score: clamp01(scored.score),
      cost: scored.costUsd ?? run.costUsd ?? 0,
      durationMs: scored.durationMs ?? run.durationMs ?? 0,
      metrics: {
        ...numericMetrics(scored.metrics),
        ...asiMetrics(asi),
      },
      split,
      seed,
      trace: run.trace,
      asi,
      emitted: scored.emitted ?? traceExcerpt(run.trace),
      metadata: scored.metadata,
    }
  } catch (err) {
    return {
      variantId: variant.id,
      scenarioId,
      rep,
      ok: false,
      score: 0,
      cost: 0,
      durationMs: 0,
      metrics: { error: 1 },
      error: err instanceof Error ? err.message : String(err),
      split,
      seed,
      asi: [
        {
          severity: 'critical',
          message: err instanceof Error ? err.message : String(err),
          responsibleSurface: config.target,
        },
      ],
      emitted: '',
    }
  }
}

function toValidatedRecord<P>(
  config: MultiShotOptimizationConfig<P>,
  variant: EvolvableVariant<P>,
  scenarioId: string,
  rep: number,
  split: RunSplitTag,
  seed: number,
  trial: MultiShotTrialResult,
): RunRecord {
  const record = config.gate!.toRunRecord({ variant, scenarioId, rep, split, seed, trial })
  return validateRunRecord(record)
}

function validateConfig<P>(config: MultiShotOptimizationConfig<P>): void {
  if (!config.runId.trim()) throw new Error('runMultiShotOptimization: runId must not be empty')
  if (!config.target.trim()) throw new Error('runMultiShotOptimization: target must not be empty')
  if (config.seedVariants.length === 0) {
    throw new Error('runMultiShotOptimization: seedVariants must not be empty')
  }
  if (config.searchScenarioIds.length === 0) {
    throw new Error('runMultiShotOptimization: searchScenarioIds must not be empty')
  }
  requirePositiveInteger(config.reps, 'reps')
  requirePositiveInteger(config.generations, 'generations')
  requirePositiveInteger(config.populationSize, 'populationSize')
  if (config.scoreConcurrency !== undefined)
    requirePositiveInteger(config.scoreConcurrency, 'scoreConcurrency')
  if (config.populationSize < config.seedVariants.length) {
    throw new Error('runMultiShotOptimization: populationSize must be >= seedVariants.length')
  }
  assertUnique(
    config.seedVariants.map((v) => v.id),
    'seedVariants.id',
  )
  assertUnique(config.searchScenarioIds, 'searchScenarioIds')

  if (config.gate) {
    if (config.gate.holdoutScenarioIds.length === 0) {
      throw new Error('runMultiShotOptimization: gate.holdoutScenarioIds must not be empty')
    }
    if (config.gate.reps !== undefined) requirePositiveInteger(config.gate.reps, 'gate.reps')
    assertUnique(config.gate.holdoutScenarioIds, 'gate.holdoutScenarioIds')
    if (config.gate.searchScenarioIds)
      assertUnique(config.gate.searchScenarioIds, 'gate.searchScenarioIds')
    const searchIds = new Set(config.searchScenarioIds)
    for (const id of config.gate.holdoutScenarioIds) {
      if (searchIds.has(id)) {
        throw new Error(
          `runMultiShotOptimization: holdout scenario "${id}" also appears in searchScenarioIds`,
        )
      }
    }
    const baselineId = config.seedVariants[0]!.id
    if (config.gate.gate.baselineKey !== baselineId) {
      throw new Error(
        `runMultiShotOptimization: gate.gate.baselineKey must match first seed variant id "${baselineId}"`,
      )
    }
  }
}

function requirePositiveInteger(value: number, name: string): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`runMultiShotOptimization: ${name} must be a positive integer`)
  }
}

function assertUnique(values: string[], name: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (!value.trim())
      throw new Error(`runMultiShotOptimization: ${name} must not contain empty values`)
    if (seen.has(value)) throw new Error(`runMultiShotOptimization: duplicate ${name} "${value}"`)
    seen.add(value)
  }
}

function aggregateFor<P>(evolution: PromptEvolutionResult<P>, variantId: string): VariantAggregate {
  const final = evolution.generations[evolution.generations.length - 1]
  const aggregate = final?.aggregates.find((a) => a.variantId === variantId)
  if (!aggregate) {
    throw new Error(`runMultiShotOptimization: missing aggregate for variant "${variantId}"`)
  }
  return aggregate
}

function seedFor<P>(
  config: MultiShotOptimizationConfig<P>,
  scenarioId: string,
  rep: number,
): number {
  const base = config.seedBase ?? 0
  return (base + stableHash(`${scenarioId}\x1f${rep}`)) % Number.MAX_SAFE_INTEGER
}

function stableHash(input: string): number {
  let h = 2166136261
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return h >>> 0
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0
  return Math.max(0, Math.min(1, n))
}

function numericMetrics(metrics: Record<string, number> | undefined): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [k, v] of Object.entries(metrics ?? {})) {
    if (Number.isFinite(v)) out[k] = v
  }
  return out
}

function asiMetrics(asi: ActionableSideInfo[]): Record<string, number> {
  const out: Record<string, number> = { asi: asi.length }
  for (const item of asi.slice(0, 1000)) {
    const sev = normalizeSeverity(item.severity)
    out[`asi.${sev}`] = (out[`asi.${sev}`] ?? 0) + 1
    if (item.responsibleSurface) {
      const key = `surface.${metricKeySegment(item.responsibleSurface)}`
      out[key] = (out[key] ?? 0) + 1
    }
  }
  return out
}

function normalizeSeverity(severity: AsiSeverity | undefined): AsiSeverity {
  if (
    severity === 'info' ||
    severity === 'warning' ||
    severity === 'error' ||
    severity === 'critical'
  ) {
    return severity
  }
  return 'error'
}

function metricKeySegment(raw: string): string {
  return (
    raw
      .trim()
      .replace(/[^a-zA-Z0-9._-]+/g, '_')
      .slice(0, 80) || 'unknown'
  )
}

function traceExcerpt(trace: MultiShotTrace | undefined): string | undefined {
  if (!trace) return undefined
  if (typeof trace.output === 'string') return trace.output
  if (trace.transcript) return trace.transcript
  if (trace.turns) {
    try {
      const clipped = trace.turns.slice(0, 20)
      const suffix =
        trace.turns.length > clipped.length
          ? ` ... ${trace.turns.length - clipped.length} more turn(s)`
          : ''
      return `${JSON.stringify(clipped).slice(0, 2000)}${suffix}`
    } catch {
      return '[unserializable trace turns]'
    }
  }
  return undefined
}
