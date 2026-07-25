import type { ControlEvalResult, ControlRunResult } from './control-runtime'
import {
  type RunRecord,
  type RunSplitTag,
  type RunTaskFailure,
  type RunTokenUsage,
  validateRunRecord,
} from './run-record'

export interface RunEvidenceMetadata {
  experimentId: string
  scenarioId: string
  candidateId: string
  seed: number
  model: string
  promptHash: string
  configHash: string
  commitSha: string
  splitTag: RunSplitTag
  tokenUsage: RunTokenUsage
  costProvenance: RunRecord['costProvenance']
  queueMs?: number
  judgeMetadata?: RunRecord['judgeMetadata']
  raw?: Record<string, number>
}

export type ControlRunToRunRecordOptions = RunEvidenceMetadata &
  RunTaskFailure & {
    runId?: string
    score?: number
  }

/**
 * Project a completed control-loop run into the strict RunRecord shape used by
 * release gates, optimizer tables, and research reports.
 *
 * The control loop owns live execution evidence. The caller still supplies the
 * experiment-cell metadata because prompt/config hashes, split assignment,
 * model snapshot, and commit SHA are product/harness concerns.
 */
export function controlRunToRunRecord<
  TState,
  TAction,
  TActionResult,
  TEval extends ControlEvalResult = ControlEvalResult,
>(
  run: ControlRunResult<TState, TAction, TActionResult, TEval>,
  options: ControlRunToRunRecordOptions,
): RunRecord {
  const score =
    finiteScore(options.score) ?? finiteScore(run.score) ?? scoreFromEvals(run.finalEvals)
  const outcome =
    options.splitTag === 'holdout'
      ? {
          ...(score !== undefined ? { holdoutScore: score } : {}),
          raw: normalizeRawMetrics(options.raw, run, score),
        }
      : {
          ...(score !== undefined ? { searchScore: score } : {}),
          raw: normalizeRawMetrics(options.raw, run, score),
        }
  const terminalOutcome =
    run.stoppedBy === 'abort'
      ? 'cancelled'
      : run.stoppedBy === 'runtime-error'
        ? 'failed'
        : run.completed
          ? 'succeeded'
          : 'incomplete'
  const costUsd = options.costProvenance.kind === 'uncaptured' ? null : options.costProvenance.usd
  if (costUsd !== null && costUsd !== run.spentCostUsd) {
    throw new Error(
      `cost provenance amount ${costUsd} does not match control run spend ${run.spentCostUsd}`,
    )
  }

  return validateRunRecord({
    runId:
      options.runId ??
      run.runId ??
      `control:${options.experimentId}:${options.candidateId}:${options.seed}:${options.splitTag}`,
    experimentId: options.experimentId,
    candidateId: options.candidateId,
    seed: options.seed,
    model: options.model,
    promptHash: options.promptHash,
    configHash: options.configHash,
    commitSha: options.commitSha,
    wallMs: run.wallMs,
    ...(options.queueMs !== undefined ? { queueMs: options.queueMs } : {}),
    costUsd,
    costProvenance: options.costProvenance,
    tokenUsage: options.tokenUsage,
    terminalOutcome,
    ...(terminalOutcome !== 'succeeded' ? { terminalFailureReason: run.reason } : {}),
    ...(options.judgeMetadata ? { judgeMetadata: options.judgeMetadata } : {}),
    outcome,
    ...(options.failureClass !== undefined ? { failureClass: options.failureClass } : {}),
    ...(options.failureMode !== undefined ? { failureMode: options.failureMode } : {}),
    splitTag: options.splitTag,
    scenarioId: options.scenarioId,
  })
}

export function scoreFromEvals(evals: readonly ControlEvalResult[]): number | undefined {
  const scores = evals
    .map((e) => e.score)
    .filter((score): score is number => typeof score === 'number' && Number.isFinite(score))
  if (scores.length === 0) return undefined
  return clampScore(scores.reduce((sum, score) => sum + score, 0) / scores.length)
}

function normalizeRawMetrics<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  raw: Record<string, number> | undefined,
  run: ControlRunResult<TState, TAction, TActionResult, TEval>,
  score: number | undefined,
): Record<string, number> {
  const normalizedRaw = finiteOnly(raw ?? {})
  delete normalizedRaw.score
  return {
    ...normalizedRaw,
    ...(score !== undefined ? { score } : {}),
    pass: run.pass ? 1 : 0,
    completed: run.completed ? 1 : 0,
    steps: run.steps.length,
    runtimeErrors: run.runtimeErrors.length,
    execution_error_count: executionErrorCount(run),
  }
}

function executionErrorCount<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRunResult<TState, TAction, TActionResult, TEval>,
): number {
  const thrownActionSteps = new Set(
    run.runtimeErrors.filter((error) => error.phase === 'act').map((error) => error.stepIndex),
  )
  const failedActionsWithoutRuntimeError = run.steps.filter(
    (step) => step.actionOutcome?.ok === false && !thrownActionSteps.has(step.index),
  ).length
  return run.runtimeErrors.length + failedActionsWithoutRuntimeError
}

function finiteOnly(values: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(values)) {
    if (Number.isFinite(value)) out[key] = value
  }
  return out
}

function finiteScore(value: number | undefined): number | undefined {
  return value !== undefined && Number.isFinite(value) ? clampScore(value) : undefined
}

function clampScore(value: number): number {
  return Math.max(0, Math.min(1, value))
}
