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

import { campaignCellToRunRecord } from '../campaign/run-record'
import type { CampaignResult } from '../campaign/types'
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
  /** Estimated cost in USD when the source doesn't record one. */
  defaultCostUsd?: number
}

/**
 * Convert a `CampaignResult` into canonical `RunRecord[]`, one per cell.
 * Successful judged cells carry their mean judge composite and dimensions.
 * Errored or unjudged cells remain unlabeled while retaining explicit terminal
 * outcome, execution-error count, token usage, cost, and failure detail.
 * `candidateId` identifies the measured surface and defaults to the campaign
 * manifest hash.
 */
export function campaignToRunRecords(
  campaign: CampaignResult,
  ctx: AdapterContext & { candidateId?: string },
): RunRecord[] {
  const splitTag = ctx.splitTag ?? 'search'
  const candidateId = ctx.candidateId ?? campaign.manifestHash
  return campaign.cells.map((cell) =>
    campaignCellToRunRecord(cell, {
      runId: cell.cellId,
      experimentId: ctx.experimentId,
      candidateId,
      model: ctx.model,
      promptHash: ctx.promptHash,
      configHash: ctx.configHash,
      commitSha: ctx.commitSha,
      splitTag,
      defaultCostUsd: ctx.defaultCostUsd,
    }),
  )
}

/**
 * Convert a `MultiLayerVerifier` `VerificationReport` into a `RunRecord`.
 * A split score is emitted only when `report.taskScore` proves the configured
 * scoring panel completed. Partial scores remain in `outcome.raw` for
 * diagnosis. Layer errors and timeouts become judge or execution telemetry;
 * only a scored `fail` layer may produce task-failure detail.
 */
export function verificationReportToRunRecord(
  report: VerificationReport,
  ctx: AdapterContext & { candidateId: string; scenarioId: string },
  opts: { runId?: string } = {},
): RunRecord {
  const splitTag = ctx.splitTag ?? 'search'
  const runId = opts.runId ?? `run-${ctx.candidateId}-${ctx.experimentId}-${report.startedAt}`
  const hasValidLayerMeasurement = report.layers.some(hasValidTaskMeasurement)
  const taskScore =
    hasValidLayerMeasurement && isValidScore(report.taskScore) ? report.taskScore : undefined
  let executionErrorCount = 0
  let judgeErrorCount = 0
  let layerErrorCount = 0
  let layerTimeoutCount = 0
  let unscoredLayerCount = 0

  const raw: Record<string, number> = {
    pass_count: report.passCount,
    fail_count: report.failCount,
    error_count: report.errorCount,
    skipped_count: report.skippedCount,
    duration_ms: report.durationMs,
    execution_error_count: 0,
  }
  for (const layer of report.layers) {
    if (hasValidTaskMeasurement(layer)) raw[`layer.${layer.layer}`] = layer.score
    else unscoredLayerCount++
    raw[`layer_${layer.layer}_pass`] = layer.status === 'pass' ? 1 : 0
    if (layer.status === 'error' || layer.status === 'timeout') {
      if (layer.errorSource === 'judge') judgeErrorCount++
      else executionErrorCount++
      if (layer.status === 'error') layerErrorCount++
      else layerTimeoutCount++
    }
    if (layer.diagnostics) {
      for (const [k, v] of Object.entries(layer.diagnostics)) {
        if (typeof v === 'number' && Number.isFinite(v)) raw[`layer.${layer.layer}.${k}`] = v
      }
    }
  }

  raw.execution_error_count = executionErrorCount
  if (judgeErrorCount > 0) raw.judge_error_count = judgeErrorCount
  if (layerErrorCount > 0) raw.layer_error_count = layerErrorCount
  if (layerTimeoutCount > 0) raw.layer_timeout_count = layerTimeoutCount
  if (unscoredLayerCount > 0) raw.unscored_layer_count = unscoredLayerCount
  if (taskScore !== undefined) raw.blended_score = taskScore

  const firstScoredFailure = report.layers.find(
    (layer) => layer.status === 'fail' && hasValidTaskMeasurement(layer),
  )
  const outcome: RunRecord['outcome'] = { raw }
  if (taskScore !== undefined) {
    if (splitTag === 'holdout') outcome.holdoutScore = taskScore
    else outcome.searchScore = taskScore
  }

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
    costUsd: ctx.defaultCostUsd ?? null,
    costProvenance:
      ctx.defaultCostUsd === undefined
        ? { kind: 'uncaptured', usd: null }
        : { kind: 'estimated', usd: ctx.defaultCostUsd },
    tokenUsage: { input: 0, output: 0 },
    terminalOutcome: 'succeeded',
    outcome,
    failureMode: firstScoredFailure ? `layer_${firstScoredFailure.layer}_fail` : undefined,
    splitTag,
    scenarioId: ctx.scenarioId,
  }
}

function hasValidTaskMeasurement(
  layer: LayerResult,
): layer is LayerResult & { status: 'pass' | 'fail'; score: number } {
  return (layer.status === 'pass' || layer.status === 'fail') && isValidScore(layer.score)
}

function isValidScore(score: unknown): score is number {
  return typeof score === 'number' && Number.isFinite(score) && score >= 0 && score <= 1
}
