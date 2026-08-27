/**
 * Adapters: convert measurement outputs into the canonical `RunRecord[]`
 * artifact that `replayCache`, `pairedEvalueSequence`, and
 * `rubricPredictiveValidity` consume. Two sources:
 *   - `campaignToRunRecords` — the campaign substrate's per-cell results
 *     (the modern path: `runCampaign` / `runImprovementLoop` → records).
 *   - `verificationReportToRunRecord` — a `MultiLayerVerifier` report.
 *
 * Adapters are thin and explicit — every mandatory `RunRecord` field comes
 * from a caller-supplied context (`commitSha`, `model`, `promptHash`,
 * `configHash`) plus the cell's runtime data. The validator still rejects
 * bare-alias model strings — the caller snapshot-pins.
 */

import type { CampaignResult } from '../campaign'
import type { LayerResult, VerificationReport } from '../multi-layer-verifier'
import type { RunRecord, RunSplitTag } from '../run-record'

export interface AdapterContext {
  /** Logical experiment id — typically the campaign or sweep identifier. */
  experimentId: string
  /** Snapshot model id (e.g. `claude-sonnet-4-6@2025-04-15`). */
  model: string
  /** Git SHA the harness was run from. */
  commitSha: string
  /** Hash of the effective prompt sent to the model. */
  promptHash: string
  /** Hash of the effective config (model, temperature, tools, judges, splits). */
  configHash: string
  /** Default split tag. Default `'search'`. */
  splitTag?: RunSplitTag
  /** Default cost in USD when the source doesn't record one. Default `0`. */
  defaultCostUsd?: number
}

/**
 * Convert a `CampaignResult` into canonical `RunRecord[]` — one record per
 * scored cell. The cell's mean judge composite becomes the split score; every
 * judge dimension is carried through to `outcome.raw`. A cell that errored
 * becomes a record with `failureMode: 'cell_error'` (kept, not dropped — an
 * unscored cell is signal). `candidateId` identifies the measured surface
 * (defaults to the campaign manifest hash).
 */
export function campaignToRunRecords(
  campaign: CampaignResult,
  ctx: AdapterContext & { candidateId?: string },
): RunRecord[] {
  const splitTag = ctx.splitTag ?? 'search'
  const candidateId = ctx.candidateId ?? campaign.manifestHash
  return campaign.cells.map((cell) => {
    const composites = Object.values(cell.judgeScores).map((s) => s.composite)
    const score =
      composites.length > 0 ? composites.reduce((a, b) => a + b, 0) / composites.length : 0
    const raw: Record<string, number> = { rep: cell.rep, duration_ms: cell.durationMs }
    for (const judge of Object.values(cell.judgeScores)) {
      for (const [dim, value] of Object.entries(judge.dimensions)) {
        if (Number.isFinite(value)) raw[`dim.${dim}`] = value
      }
    }
    if (typeof cell.generation === 'number') raw.generation = cell.generation
    const outcome: RunRecord['outcome'] = { raw }
    if (splitTag === 'holdout') outcome.holdoutScore = score
    else outcome.searchScore = score
    return {
      runId: cell.cellId,
      experimentId: ctx.experimentId,
      candidateId,
      seed: cell.seed,
      model: ctx.model,
      promptHash: ctx.promptHash,
      configHash: ctx.configHash,
      commitSha: ctx.commitSha,
      wallMs: cell.durationMs,
      costUsd: Number.isFinite(cell.costUsd) ? cell.costUsd : (ctx.defaultCostUsd ?? 0),
      tokenUsage: { input: 0, output: 0 },
      outcome,
      failureMode: cell.error ? 'cell_error' : undefined,
      splitTag,
      scenarioId: cell.scenarioId,
    }
  })
}

/**
 * Convert a `MultiLayerVerifier` `VerificationReport` into a `RunRecord`.
 * `outcome.searchScore` (or `holdoutScore`) is `report.blendedScore`;
 * `outcome.raw` carries every layer's score + a pass indicator; `failureMode`
 * is the first failing layer's reason.
 */
export function verificationReportToRunRecord(
  report: VerificationReport,
  ctx: AdapterContext & { candidateId: string; scenarioId?: string },
  opts: { runId?: string } = {},
): RunRecord {
  const splitTag = ctx.splitTag ?? 'search'
  const runId = opts.runId ?? `run-${ctx.candidateId}-${ctx.experimentId}-${report.startedAt}`

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
    promptHash: ctx.promptHash,
    configHash: ctx.configHash,
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

function failureModeFromLayer(layer: LayerResult): string {
  if (layer.status === 'error') return `layer_${layer.layer}_error`
  if (layer.status === 'fail') return `layer_${layer.layer}_fail`
  if (layer.status === 'timeout') return `layer_${layer.layer}_timeout`
  return `layer_${layer.layer}_${layer.status}`
}
