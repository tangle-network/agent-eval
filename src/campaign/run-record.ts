import type { AgentProfileCell } from '../agent-profile-cell'
import type {
  JudgeScoresRecord,
  RunOutcome,
  RunRecord,
  RunSplitTag,
  RunTerminalOutcome,
} from '../run-record'
import { validateRunRecord } from '../run-record'
import type { CampaignCellResult, JudgeScore } from './types'

export interface CampaignCellRunRecordOptions {
  runId: string
  experimentId: string
  candidateId: string
  model: string
  promptHash: string
  configHash: string
  commitSha: string
  splitTag: RunSplitTag
  seed?: number
  scenarioId?: string
  defaultCostUsd?: number
  agentProfile?: AgentProfileCell
  raw?: Record<string, number>
}

export interface CampaignCellQualityProjection {
  score?: number
  judgeScores?: JudgeScoresRecord
  successfulJudgeScores: Record<string, JudgeScore>
  failedJudges: string[]
  raw: Record<string, number>
}

export interface CampaignCellExecutionEvidence {
  terminalOutcome: RunTerminalOutcome
  executionErrorCount?: number
  judgeErrorCount?: number
  unclassifiedErrorCount?: number
  terminalFailureReason?: string
}

/**
 * Project one campaign cell into the canonical run format.
 *
 * A dispatch error establishes terminal execution failure. A judge error only
 * establishes that quality measurement failed after dispatch completed.
 * Failures without a stage remain unknown. No failure becomes a zero-quality
 * label.
 */
export function campaignCellToRunRecord<TArtifact>(
  cell: CampaignCellResult<TArtifact>,
  options: CampaignCellRunRecordOptions,
): RunRecord {
  const quality = projectCampaignCellQuality(cell)
  const execution = campaignCellExecutionEvidence(cell)
  const judgeErrorCount = Math.max(
    quality.raw.judge_error_count ?? 0,
    execution.judgeErrorCount ?? 0,
  )
  const cellCostCaptured = Number.isFinite(cell.costUsd) && cell.costUsd >= 0
  const costUsd = cellCostCaptured ? cell.costUsd : (options.defaultCostUsd ?? null)
  const costProvenance =
    costUsd === null
      ? ({ kind: 'uncaptured', usd: null } as const)
      : cellCostCaptured && !cell.costEstimated
        ? ({ kind: 'observed', usd: costUsd } as const)
        : ({ kind: 'estimated', usd: costUsd } as const)
  const raw: Record<string, number> = {
    ...finiteMetrics(options.raw),
    ...quality.raw,
    rep: cell.rep,
    duration_ms: cell.durationMs,
    ...(costUsd === null ? {} : { cost_usd: costUsd }),
    cost_estimated: cell.costEstimated ? 1 : 0,
    tokens_input: cell.tokenUsage.input,
    tokens_output: cell.tokenUsage.output,
    latency_ms: cell.durationMs,
    ...(execution.executionErrorCount === undefined
      ? {}
      : { execution_error_count: execution.executionErrorCount }),
    ...(judgeErrorCount > 0 ? { judge_error_count: judgeErrorCount } : {}),
    ...(execution.unclassifiedErrorCount === undefined
      ? {}
      : { unclassified_error_count: execution.unclassifiedErrorCount }),
  }
  if (typeof cell.generation === 'number') raw.generation = cell.generation
  if (cell.tokenUsage.reasoning !== undefined) {
    raw.tokens_reasoning = cell.tokenUsage.reasoning
  }
  if (cell.tokenUsage.cached !== undefined) raw.tokens_cached = cell.tokenUsage.cached
  if (cell.tokenUsage.cacheWrite !== undefined) {
    raw.tokens_cache_write = cell.tokenUsage.cacheWrite
  }
  if (costUsd !== null && costUsd > 0) {
    raw.tokens_per_dollar = (cell.tokenUsage.input + cell.tokenUsage.output) / costUsd
  }
  if (costUsd !== null && quality.score !== undefined && quality.score > 0.01) {
    raw.cost_per_quality = costUsd / quality.score
  }

  const outcome: RunOutcome = {
    raw,
    ...(quality.judgeScores ? { judgeScores: quality.judgeScores } : {}),
  }
  if (quality.score !== undefined) {
    if (options.splitTag === 'holdout') outcome.holdoutScore = quality.score
    else outcome.searchScore = quality.score
  }

  return validateRunRecord({
    runId: options.runId,
    experimentId: options.experimentId,
    candidateId: options.candidateId,
    seed: options.seed ?? cell.seed,
    model: options.model,
    promptHash: options.promptHash,
    configHash: options.configHash,
    commitSha: options.commitSha,
    wallMs: cell.durationMs,
    costUsd,
    costProvenance,
    tokenUsage: { ...cell.tokenUsage },
    terminalOutcome: execution.terminalOutcome,
    ...(execution.terminalFailureReason
      ? { terminalFailureReason: execution.terminalFailureReason }
      : {}),
    outcome,
    splitTag: options.splitTag,
    scenarioId: options.scenarioId ?? cell.scenarioId,
    ...(options.agentProfile ? { agentProfile: options.agentProfile } : {}),
  })
}

export function campaignCellExecutionEvidence<TArtifact>(
  cell: CampaignCellResult<TArtifact>,
): CampaignCellExecutionEvidence {
  if (cell.errorStage === 'dispatch') {
    return {
      terminalOutcome: 'failed',
      executionErrorCount: 1,
      ...(cell.error ? { terminalFailureReason: cell.error } : {}),
    }
  }
  if (cell.errorStage === 'judge') {
    return {
      terminalOutcome: 'succeeded',
      executionErrorCount: 0,
      judgeErrorCount: 1,
    }
  }
  if (!cell.error) {
    return { terminalOutcome: 'succeeded', executionErrorCount: 0 }
  }
  return {
    terminalOutcome: 'unknown',
    unclassifiedErrorCount: 1,
  }
}

/**
 * Produce the only task-quality view used by campaign aggregates and exports.
 *
 * Successful judge results remain available for diagnosis after another judge
 * fails, but a task score exists only for an error-free cell whose reported
 * judge values are all finite.
 */
export function projectCampaignCellQuality<TArtifact>(
  cell: CampaignCellResult<TArtifact>,
): CampaignCellQualityProjection {
  if (cell.errorStage === 'dispatch') {
    return { successfulJudgeScores: {}, failedJudges: [], raw: {} }
  }

  const perJudge: Record<string, Record<string, number>> = {}
  const successfulJudgeScores: Record<string, JudgeScore> = {}
  const dimensionValues = new Map<string, number[]>()
  const composites: number[] = []
  const notes: string[] = []
  const failedJudges = new Set<string>(
    cell.errorStage === 'judge' ? [cell.errorJudge ?? 'unknown-judge'] : [],
  )
  const raw: Record<string, number> = {}

  for (const [judgeName, score] of Object.entries(cell.judgeScores)) {
    const finiteDimensions = Object.values(score.dimensions).every(Number.isFinite)
    if (score.failed || !Number.isFinite(score.composite) || !finiteDimensions) {
      failedJudges.add(judgeName)
      continue
    }

    composites.push(score.composite)
    successfulJudgeScores[judgeName] = score
    const dimensions = { ...score.dimensions }
    perJudge[judgeName] = dimensions
    for (const [dimension, value] of Object.entries(dimensions)) {
      raw[`${judgeName}.${dimension}`] = value
      const values = dimensionValues.get(dimension) ?? []
      values.push(value)
      dimensionValues.set(dimension, values)
    }
    if (score.notes) notes.push(`${judgeName}: ${score.notes}`)
    for (const failedJudge of score.failedJudges ?? []) {
      failedJudges.add(`${judgeName}/${failedJudge}`)
    }
  }

  if (failedJudges.size > 0) raw.judge_error_count = failedJudges.size
  const sortedFailedJudges = [...failedJudges].sort()
  if (composites.length === 0) {
    return {
      successfulJudgeScores,
      failedJudges: sortedFailedJudges,
      raw,
    }
  }

  const composite = mean(composites)
  const perDimMean = Object.fromEntries(
    [...dimensionValues.entries()].map(([dimension, values]) => [dimension, mean(values)]),
  )
  const complete =
    cell.error === undefined && cell.errorStage === undefined && failedJudges.size === 0
  if (complete) raw.composite = composite

  return {
    ...(complete ? { score: composite } : {}),
    raw,
    successfulJudgeScores,
    failedJudges: sortedFailedJudges,
    judgeScores: {
      perJudge,
      perDimMean,
      composite,
      ...(sortedFailedJudges.length > 0 ? { failedJudges: sortedFailedJudges } : {}),
      ...(notes.length > 0 ? { notes: notes.join(' | ') } : {}),
    },
  }
}

/** Read the canonical task score without recomputing cell quality. */
export function campaignCellTaskScore<TArtifact>(
  cell: CampaignCellResult<TArtifact>,
): number | undefined {
  return projectCampaignCellQuality(cell).score
}

/** Read canonical successful judge dimensions without recomputing cell quality. */
export function campaignCellJudgeDimensions<TArtifact>(
  cell: CampaignCellResult<TArtifact>,
): Record<string, Record<string, number>> {
  return projectCampaignCellQuality(cell).judgeScores?.perJudge ?? {}
}

function finiteMetrics(metrics: Record<string, number> | undefined): Record<string, number> {
  const finite: Record<string, number> = {}
  for (const [key, value] of Object.entries(metrics ?? {})) {
    if (Number.isFinite(value)) finite[key] = value
  }
  return finite
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}
