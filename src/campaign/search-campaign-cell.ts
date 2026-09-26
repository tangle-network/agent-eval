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
 * What `cell-settled` records for one campaign cell: `passed` with the
 * composite (and each judge's) when every judge scored it, else `errored`,
 * never retryable, because `runCampaign` already applied its own retry policy;
 * its tokens and cost, with an uncaptured cost kept as a lower bound; the
 * model the cell resolved, else the declared one.
 */
export function campaignCellSearchResult<TArtifact>(
  cell: CampaignCellResult<TArtifact>,
  input: { execution: SearchExecutionIdentity; lane: string },
): SearchCellResult {
  return {
    outcome: campaignCellOutcome(cell),
    accounting: campaignCellAccounting(cell),
    identity: {
      ...input.execution,
      model:
        cell.resolvedModel === undefined
          ? input.execution.model
          : searchModelIdentity(cell.resolvedModel, input.execution.model.provider),
    },
    wallMs: cell.durationMs,
    placement: { lane: input.lane, boxId: null },
    traceRef: { unknown: 'runCampaign reports no trace id per cell' },
  }
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
  for (const [judge, score] of Object.entries(quality.successfulJudgeScores)) {
    metrics[`judge.${judge}`] = score.composite
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
            cachedTokens: 0,
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
