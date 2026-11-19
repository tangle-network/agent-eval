/**
 * Campaign measurements as search-ledger facts.
 *
 * A search executor that measures a node with a one-cell `runCampaign` gets
 * back a `CampaignCellResult`; `cell-settled` records its outcome, accounting
 * and identity. A proposer that makes paid calls leaves cost receipts;
 * `operation-recorded` records their accounting and what ran. These are the
 * one mapping between the two, shared by `runOptimization` and by executors
 * and proposers outside this package.
 */

import type { CostReceipt } from '../cost-ledger'
import { modelHasSnapshot } from '../run-record'
import { projectCampaignCellQuality } from './run-record'
import type { SearchCellResult } from './search-kernel'
import type {
  SearchAttemptAccounting,
  SearchExecutionIdentity,
  SearchModelIdentity,
  SearchOperationRecordedEvent,
  SearchTaskOutcome,
} from './search-ledger-types'
import type { CampaignCellResult } from './types'

/**
 * The facts `cell-settled` records about one campaign cell, without its
 * artifact. JSON-safe, so a producer that measures cells out of process (the
 * external-optimizer evaluation callback) can keep them in its observation log
 * and record them later through the same mapping as an in-process executor.
 */
export interface CampaignCellMeasurement {
  /** The campaign's cell id, `<scenarioId>:<rep>`; unique within one campaign only. */
  cellId: string
  scenarioId: string
  rep: number
  /** The attempt that produced the result; null on a historical cached record without one. */
  attempt: { runAttemptId: string; number: number } | null
  /** runCampaign read this result from its cache instead of dispatching it. */
  cached: boolean
  outcome: SearchTaskOutcome
  accounting: SearchAttemptAccounting
  /** The model every agent receipt in the cell reported; absent for none or several. */
  resolvedModel?: string
  durationMs: number
}

/**
 * Project a campaign cell onto what `cell-settled` records: `passed` with the
 * composite, each judge's composite and each judge dimension when every judge
 * scored it, else `errored`, never retryable, because `runCampaign` already
 * applied its own retry policy; its tokens and cost, with an uncaptured cost
 * kept as a lower bound; the attempt that produced it.
 */
export function campaignCellMeasurement<TArtifact>(
  cell: CampaignCellResult<TArtifact>,
): CampaignCellMeasurement {
  return {
    cellId: cell.cellId,
    scenarioId: cell.scenarioId,
    rep: cell.rep,
    attempt: cell.attempt
      ? { runAttemptId: cell.attempt.runAttemptId, number: cell.attempt.number }
      : null,
    cached: cell.cached,
    outcome: campaignCellOutcome(cell),
    accounting: campaignCellAccounting(cell),
    ...(cell.resolvedModel === undefined ? {} : { resolvedModel: cell.resolvedModel }),
    durationMs: cell.durationMs,
  }
}

/**
 * What `cell-settled` records for one campaign cell, or for its measurement:
 * the outcome and accounting of `campaignCellMeasurement`, the model the cell
 * resolved, else the declared one, and its duration. `runCampaign` assigns no
 * trace id, so the trace reference stays unknown and names the attempt whose
 * trace writer received the cell's spans.
 */
export function campaignCellSearchResult<TArtifact>(
  cell: CampaignCellResult<TArtifact> | CampaignCellMeasurement,
  input: { execution: SearchExecutionIdentity; lane: string },
): SearchCellResult {
  const measurement = 'outcome' in cell ? cell : campaignCellMeasurement(cell)
  return {
    outcome: measurement.outcome,
    accounting: measurement.accounting,
    identity: {
      ...input.execution,
      model:
        measurement.resolvedModel === undefined
          ? input.execution.model
          : searchModelIdentity(measurement.resolvedModel, input.execution.model.provider),
    },
    wallMs: measurement.durationMs,
    placement: { lane: input.lane, boxId: null },
    traceRef: { unknown: campaignCellTraceReason(measurement) },
  }
}

function campaignCellTraceReason(measurement: CampaignCellMeasurement): string {
  const cell = `campaign cell ${measurement.cellId}`
  if (measurement.attempt === null) {
    return `runCampaign assigns no trace id, and ${cell} records no attempt`
  }
  const { runAttemptId, number } = measurement.attempt
  return `runCampaign assigns no trace id; ${cell} wrote its spans through the trace writer of attempt ${runAttemptId}/attempt-${number}`
}

/** A provider-reported model: a snapshot when its name pins one, else a moving alias. */
export function searchModelIdentity(model: string, provider: string): SearchModelIdentity {
  return modelHasSnapshot(model)
    ? { provider, snapshot: model }
    : { provider, alias: model, unknown: 'the provider reported a moving alias, not a snapshot' }
}

function campaignCellOutcome<TArtifact>(cell: CampaignCellResult<TArtifact>): SearchTaskOutcome {
  const quality = projectCampaignCellQuality(cell)
  if (quality.score === undefined) {
    return {
      status: 'errored',
      metrics: {},
      error: {
        code: cell.errorStage ?? 'unscored',
        message: cell.error ?? 'the cell produced no complete judge score',
        retryable: false,
      },
    }
  }
  const metrics: Record<string, number> = { composite: quality.score }
  const addMetric = (key: string, value: number): void => {
    if (Object.hasOwn(metrics, key)) {
      throw new Error(
        `campaign cell ${cell.cellId}: metric '${key}' names two measurements; rename the judge or dimension`,
      )
    }
    metrics[key] = value
  }
  for (const [judge, score] of Object.entries(quality.successfulJudgeScores)) {
    addMetric(`judge.${judge}`, score.composite)
    for (const [dimension, value] of Object.entries(score.dimensions)) {
      addMetric(`dimension.${judge}.${dimension}`, value)
    }
  }
  return { status: 'passed', score: quality.score, metrics }
}

function campaignCellAccounting<TArtifact>(
  cell: CampaignCellResult<TArtifact>,
): SearchAttemptAccounting {
  const usage = cell.tokenUsage
  return {
    tokens:
      usage.tokensKnown === false
        ? { status: 'unknown', reason: 'a paid call in this cell reported no token usage' }
        : {
            status: 'known',
            inputTokens: usage.input,
            outputTokens: usage.output,
            cachedTokens: usage.cached ?? 0,
          },
    cost:
      cell.costProvenance.kind === 'uncaptured'
        ? {
            status: 'unknown',
            knownLowerBoundUsd: cell.costUsd,
            reason: 'the cell recorded spend without a provider receipt',
          }
        : {
            status: 'known',
            usd: cell.costUsd,
            source: cell.costProvenance.kind === 'observed' ? 'provider' : 'pricing-table',
          },
  }
}

/** The accounting of a proposal's cost receipts: token and dollar sums, each
 * unknown (with the known dollars as a lower bound) when a receipt lacks it. */
export function searchReceiptAccounting(
  receipts: ReadonlyArray<CostReceipt>,
): SearchAttemptAccounting {
  let inputTokens = 0
  let outputTokens = 0
  let cachedTokens = 0
  let usd = 0
  let tokensKnown = true
  let costKnown = true
  for (const receipt of receipts) {
    if (receipt.usageUnknown === true) tokensKnown = false
    inputTokens += receipt.inputTokens
    outputTokens += receipt.outputTokens
    cachedTokens += receipt.cachedTokens ?? 0
    if (receipt.costUnknown) costKnown = false
    else usd += receipt.costUsd
  }
  return {
    tokens: tokensKnown
      ? { status: 'known', inputTokens, outputTokens, cachedTokens }
      : { status: 'unknown', reason: 'a candidate-generation call reported no token usage' },
    cost: costKnown
      ? { status: 'known', usd, source: usd === 0 ? 'free' : 'provider' }
      : {
          status: 'unknown',
          knownLowerBoundUsd: usd,
          reason: 'a candidate-generation call recorded no provider cost',
        },
  }
}

/** What ran a proposal: a model when it made a paid call other than a judge's,
 * else deterministic code. */
export function searchProposalExecution(
  receipts: ReadonlyArray<CostReceipt>,
  provider: string,
  source: SearchOperationRecordedEvent['execution']['source'],
): SearchOperationRecordedEvent['execution'] {
  const model = receipts.find((receipt) => receipt.channel !== 'judge')?.model
  if (model === undefined) return { kind: 'deterministic', source }
  return { kind: 'model', model: searchModelIdentity(model, provider), source }
}
