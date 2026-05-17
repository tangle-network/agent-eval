/**
 * Adapters: convert `TrialResult[]` (from `runMultiShotOptimization`,
 * `runPromptEvolution`) into the canonical `RunRecord[]` artifact that
 * `replayCache`, `pairedEvalueSequence`, and `rubricPredictiveValidity`
 * consume.
 *
 * Adapters are thin and explicit — every mandatory `RunRecord` field
 * comes from a caller-supplied context (`commitSha`, `model`,
 * `promptHash`, `configHash`) plus the trial's runtime data. Defaults
 * exist for fields the trial doesn't carry (`tokenUsage`, `costUsd`),
 * but the validator still rejects records with bare-alias model strings
 * — the caller is responsible for snapshot-pinning.
 */

import type { LayerResult, VerificationReport } from '../multi-layer-verifier'
import type { TrialResult, VariantAggregate } from '../prompt-evolution'
import type { RunRecord, RunSplitTag } from '../run-record'

export interface AdapterContext {
  /** Logical experiment id — typically the campaign or sweep identifier. */
  experimentId: string
  /** Snapshot model id (e.g. `claude-sonnet-4-6@2025-04-15`). */
  model: string
  /** Git SHA the harness was run from. */
  commitSha: string
  /** Hash of the effective prompt sent to the model. */
  promptHash: string | ((t: TrialResult) => string)
  /** Hash of the effective config (model, temperature, tools, judges, splits). */
  configHash: string | ((t: TrialResult) => string)
  /** Default split tag. Default `'search'` — optimization sweeps run on the search split. */
  splitTag?: RunSplitTag
  /** Default cost in USD when the trial doesn't record one. Default `0`. */
  defaultCostUsd?: number
}

/**
 * Convert one `TrialResult` (from `runPromptEvolution` or
 * `runMultiShotOptimization`) into a canonical `RunRecord`.
 *
 * The conversion is **not lossy** — every `TrialResult.metrics` field is
 * carried through to `outcome.raw`, plus a synthetic
 * `raw.cost_unknown = 1` flag when the trial omits cost (so downstream
 * filters can distinguish "free" from "untracked"). This preserves the
 * paper-grade contract: a record without a cost number is unbounded by
 * definition, but we don't drop the record.
 */
export function trialToRunRecord(
  trial: TrialResult,
  ctx: AdapterContext,
  opts: { runId?: string; experimentIdPerTrial?: (t: TrialResult) => string } = {},
): RunRecord {
  const splitTag = ctx.splitTag ?? 'search'
  const promptHash = typeof ctx.promptHash === 'function' ? ctx.promptHash(trial) : ctx.promptHash
  const configHash = typeof ctx.configHash === 'function' ? ctx.configHash(trial) : ctx.configHash
  const runId = opts.runId ?? defaultRunId(ctx, trial)
  const experimentId = opts.experimentIdPerTrial?.(trial) ?? ctx.experimentId
  const costRecorded = typeof trial.cost === 'number' && Number.isFinite(trial.cost)
  const costUsd = costRecorded ? (trial.cost as number) : (ctx.defaultCostUsd ?? 0)

  // Carry every numeric metric through; synthesize a cost-unknown flag when
  // the trial omitted cost so downstream tooling can distinguish honest
  // zero ("free") from missing.
  const raw: Record<string, number> = { ...(trial.metrics ?? {}) }
  if (!costRecorded) raw.cost_unknown = 1
  if (typeof trial.durationMs === 'number') raw.duration_ms = trial.durationMs
  raw.rep = trial.rep

  const score = Number.isFinite(trial.score) ? trial.score : 0
  const outcome: RunRecord['outcome'] = { raw }
  if (splitTag === 'holdout') outcome.holdoutScore = score
  else outcome.searchScore = score

  return {
    runId,
    experimentId,
    candidateId: trial.variantId,
    seed: trial.rep,
    model: ctx.model,
    promptHash,
    configHash,
    commitSha: ctx.commitSha,
    wallMs: trial.durationMs ?? 0,
    costUsd,
    tokenUsage: { input: 0, output: 0 },
    outcome,
    failureMode: trial.ok
      ? undefined
      : trial.error
        ? 'optimizer_trial_error'
        : 'optimizer_trial_failed',
    splitTag,
    scenarioId: trial.scenarioId,
  }
}

/** Convenience: convert an array of `TrialResult` in one go. */
export function trialsToRunRecords(trials: TrialResult[], ctx: AdapterContext): RunRecord[] {
  return trials.map((t) => trialToRunRecord(t, ctx))
}

/**
 * Convert a `MultiLayerVerifier` `VerificationReport` into a `RunRecord`.
 *
 * The verifier produces per-layer results; we synthesize one canonical
 * record where:
 *   - `outcome.searchScore` (or `holdoutScore`) is `report.blendedScore`
 *   - `outcome.raw` carries every layer's score keyed `layer.<name>`
 *     plus a `layer_<name>_pass` 1/0 indicator
 *   - `failureMode` is taken from the first failing layer's `reason`
 *   - `wallMs` is `report.durationMs`
 */
export function verificationReportToRunRecord(
  report: VerificationReport,
  ctx: AdapterContext & { candidateId: string; scenarioId?: string },
  opts: { runId?: string } = {},
): RunRecord {
  const splitTag = ctx.splitTag ?? 'search'
  const runId = opts.runId ?? `run-${ctx.candidateId}-${ctx.experimentId}-${report.startedAt}`
  const promptHash = typeof ctx.promptHash === 'function' ? 'p'.repeat(64) : ctx.promptHash
  const configHash = typeof ctx.configHash === 'function' ? 'c'.repeat(64) : ctx.configHash

  const raw: Record<string, number> = {
    pass_count: report.passCount,
    fail_count: report.failCount,
    error_count: report.errorCount,
    skipped_count: report.skippedCount,
    duration_ms: report.durationMs,
    blended_score: report.blendedScore,
  }
  for (const layer of report.layers) {
    if (typeof layer.score === 'number') raw[`layer.${layer.layer}`] = layer.score
    raw[`layer_${layer.layer}_pass`] = layer.status === 'pass' ? 1 : 0
    if (layer.diagnostics) {
      for (const [k, v] of Object.entries(layer.diagnostics)) {
        if (typeof v === 'number' && Number.isFinite(v)) raw[`layer.${layer.layer}.${k}`] = v
      }
    }
  }

  const firstFail = report.layers.find((l) => l.status === 'fail' || l.status === 'error')
  const outcome: RunRecord['outcome'] = { raw }
  if (splitTag === 'holdout') outcome.holdoutScore = report.blendedScore
  else outcome.searchScore = report.blendedScore

  return {
    runId,
    experimentId: ctx.experimentId,
    candidateId: ctx.candidateId,
    seed: 0,
    model: ctx.model,
    promptHash,
    configHash,
    commitSha: ctx.commitSha,
    wallMs: report.durationMs,
    costUsd: ctx.defaultCostUsd ?? 0,
    tokenUsage: { input: 0, output: 0 },
    outcome,
    failureMode: firstFail ? failureModeFromLayer(firstFail) : undefined,
    splitTag,
    scenarioId: ctx.scenarioId,
  }
}

/**
 * Convert a `VariantAggregate` (per-variant rollup from `prompt-evolution`)
 * into a synthetic `RunRecord` representing the aggregate. Useful when the
 * downstream consumer wants per-variant entries for a `researchReport`
 * rather than per-(variant, scenario, rep) trial entries.
 */
export function variantAggregateToRunRecord(
  agg: VariantAggregate,
  ctx: AdapterContext,
  opts: { runId?: string } = {},
): RunRecord {
  const splitTag = ctx.splitTag ?? 'search'
  const runId = opts.runId ?? `agg-${agg.variantId}-${ctx.experimentId}`
  const promptHash = typeof ctx.promptHash === 'function' ? 'p'.repeat(64) : ctx.promptHash
  const configHash = typeof ctx.configHash === 'function' ? 'c'.repeat(64) : ctx.configHash

  const raw: Record<string, number> = {
    ...agg.metrics,
    ok_rate: agg.okRate,
    duration_ms: agg.meanDurationMs,
    n_scenarios: agg.scenarios.length,
  }

  const outcome: RunRecord['outcome'] = { raw }
  if (splitTag === 'holdout') outcome.holdoutScore = agg.meanScore
  else outcome.searchScore = agg.meanScore

  return {
    runId,
    experimentId: ctx.experimentId,
    candidateId: agg.variantId,
    seed: 0,
    model: ctx.model,
    promptHash,
    configHash,
    commitSha: ctx.commitSha,
    wallMs: agg.meanDurationMs,
    costUsd: agg.meanCost,
    tokenUsage: { input: 0, output: 0 },
    outcome,
    splitTag,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

function defaultRunId(ctx: AdapterContext, t: TrialResult): string {
  return `run-${ctx.experimentId}-${t.variantId}-${t.scenarioId}-${t.rep}`
}

function failureModeFromLayer(layer: LayerResult): string {
  if (layer.status === 'error') return `layer_${layer.layer}_error`
  if (layer.status === 'fail') return `layer_${layer.layer}_fail`
  if (layer.status === 'timeout') return `layer_${layer.layer}_timeout`
  return `layer_${layer.layer}_${layer.status}`
}
