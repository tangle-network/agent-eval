import type { CostLedgerSummary } from '../cost-ledger'
import type { OpenAICompatibleOptimizerModel } from './optimizer-model'

export interface ExternalOptimizerTokenUsage {
  inputTokens: number
  outputTokens: number
  totalTokens: number
  calls: number
  /** Provider requests, including failed attempts before a successful call. */
  requestAttempts?: number
}

const TOKEN_USAGE_FIELDS = ['inputTokens', 'outputTokens', 'totalTokens', 'calls'] as const

export function assertPriorExternalOptimizerUsage(
  summary: CostLedgerSummary,
  budget: OpenAICompatibleOptimizerModel['budget'],
  name: string,
): void {
  if (!summary.accountingComplete || !summary.usageComplete) {
    throw new Error(
      `${name}: cannot resume optimizer-model work with incomplete prior cost or usage`,
    )
  }
  if (
    summary.totalCalls > budget.maxRequests ||
    summary.totalCostUsd > budget.maxCostUsd + Number.EPSILON
  ) {
    throw new Error(`${name}: prior optimizer-model usage exceeds the configured budget`)
  }
}

export function assertExternalOptimizerTokenUsage(
  usage: ExternalOptimizerTokenUsage | undefined,
  name: string,
  optimizer: string,
): void {
  if (usage === undefined) return
  for (const field of TOKEN_USAGE_FIELDS) {
    if (!Number.isSafeInteger(usage[field]) || usage[field] < 0) {
      throw new Error(`${name}: ${optimizer} bridge returned invalid tokenUsage.${field}`)
    }
  }
  if (usage.totalTokens !== usage.inputTokens + usage.outputTokens) {
    throw new Error(`${name}: ${optimizer} bridge returned inconsistent tokenUsage.totalTokens`)
  }
  if (
    usage.requestAttempts !== undefined &&
    (!Number.isSafeInteger(usage.requestAttempts) || usage.requestAttempts < usage.calls)
  ) {
    throw new Error(`${name}: ${optimizer} bridge returned invalid tokenUsage.requestAttempts`)
  }
}

export function assertExternalOptimizerCompletionCount(
  upstream: ExternalOptimizerTokenUsage | undefined,
  requestAttempts: number,
  successfulCompletions: number,
  name: string,
  optimizer: string,
): void {
  if (!upstream) {
    throw new Error(`${name}: ${optimizer} did not report optimizer token usage`)
  }
  if (
    !Number.isSafeInteger(requestAttempts) ||
    !Number.isSafeInteger(successfulCompletions) ||
    requestAttempts < 0 ||
    successfulCompletions < 0 ||
    successfulCompletions > requestAttempts
  ) {
    throw new Error(`${name}: optimizer model proxy returned invalid request counts`)
  }
  if (upstream.calls !== successfulCompletions) {
    throw new Error(
      `${name}: ${optimizer} reported ${upstream.calls} successful model calls but the proxy completed ${successfulCompletions} across ${requestAttempts} attempts`,
    )
  }
  if (upstream.requestAttempts !== undefined && upstream.requestAttempts !== requestAttempts) {
    throw new Error(
      `${name}: ${optimizer} reported ${upstream.requestAttempts} model attempts but the proxy received ${requestAttempts}`,
    )
  }
}
