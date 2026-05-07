import type {
  ControlEvalResult,
  ControlRunResult,
} from './control-runtime'
import {
  validateRunRecord,
  type RunRecord,
  type RunSplitTag,
  type RunTokenUsage,
} from './run-record'
import type { FailureClass } from './trace/schema'

export interface RunEvidenceMetadata {
  experimentId: string
  candidateId: string
  seed: number
  model: string
  promptHash: string
  configHash: string
  commitSha: string
  splitTag: RunSplitTag
  tokenUsage: RunTokenUsage
  queueMs?: number
  judgeMetadata?: RunRecord['judgeMetadata']
  raw?: Record<string, number>
}

export interface ControlRunToRunRecordOptions extends RunEvidenceMetadata {
  runId?: string
  score?: number
  failureMode?: string
}

/**
 * Project a completed control-loop run into the strict RunRecord shape used by
 * release gates, optimizer tables, and research reports.
 *
 * The control loop owns live execution evidence. The caller still supplies the
 * experimental cell metadata because prompt/config hashes, split assignment,
 * model snapshot, and commit SHA are product/harness concerns.
 */
export function controlRunToRunRecord<TState, TAction, TActionResult, TEval extends ControlEvalResult = ControlEvalResult>(
  run: ControlRunResult<TState, TAction, TActionResult, TEval>,
  options: ControlRunToRunRecordOptions,
): RunRecord {
  const score = clampScore(options.score ?? run.score ?? scoreFromEvals(run.finalEvals) ?? (run.pass ? 1 : 0))
  const outcome = options.splitTag === 'holdout'
    ? { holdoutScore: score, raw: normalizeRawMetrics(options.raw, run, score) }
    : { searchScore: score, raw: normalizeRawMetrics(options.raw, run, score) }

  return validateRunRecord({
    runId: options.runId ?? run.runId ?? `control:${options.experimentId}:${options.candidateId}:${options.seed}:${options.splitTag}`,
    experimentId: options.experimentId,
    candidateId: options.candidateId,
    seed: options.seed,
    model: options.model,
    promptHash: options.promptHash,
    configHash: options.configHash,
    commitSha: options.commitSha,
    wallMs: run.wallMs,
    ...(options.queueMs !== undefined ? { queueMs: options.queueMs } : {}),
    costUsd: run.spentCostUsd,
    tokenUsage: options.tokenUsage,
    ...(options.judgeMetadata ? { judgeMetadata: options.judgeMetadata } : {}),
    outcome,
    failureMode: options.failureMode ?? failureModeFromRun(run),
    splitTag: options.splitTag,
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
  score: number,
): Record<string, number> {
  return {
    score,
    pass: run.pass ? 1 : 0,
    completed: run.completed ? 1 : 0,
    steps: run.steps.length,
    runtimeErrors: run.runtimeErrors.length,
    ...finiteOnly(raw ?? {}),
  }
}

function finiteOnly(values: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(values)) {
    if (Number.isFinite(value)) out[key] = value
  }
  return out
}

function failureModeFromRun<TState, TAction, TActionResult, TEval extends ControlEvalResult>(
  run: ControlRunResult<TState, TAction, TActionResult, TEval>,
): FailureClass | undefined {
  if (run.pass) return undefined
  return run.failureClass ?? 'unknown'
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
