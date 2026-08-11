/**
 * Judge scoring for one cell, with the paid-call accounting guard: a judge
 * that reports an LLM call without a CostLedger receipt fails the cell.
 */

import { CostAccountingIncompleteError } from '../cost-ledger'
import type { JudgeConfig, JudgeScore, Scenario } from './types'

export async function runJudgeCell<TArtifact, TScenario extends Scenario>(
  judge: JudgeConfig<TArtifact, TScenario>,
  input: Parameters<JudgeConfig<TArtifact, TScenario>['score']>[0],
): Promise<JudgeScore> {
  const previousJudgeCalls = new Set(
    input.costLedger
      ?.list({ channel: 'judge', tags: input.costTags })
      .map((receipt) => receipt.callId) ?? [],
  )
  try {
    const score = await judge.score(input)
    assertReportedJudgeCallRecorded(judge.name, score, input, previousJudgeCalls)
    return score
  } catch (error) {
    assertReportedJudgeCallRecorded(judge.name, error, input, previousJudgeCalls, error)
    throw error
  }
}

function assertReportedJudgeCallRecorded(
  judgeName: string,
  value: unknown,
  input: Parameters<JudgeConfig<unknown>['score']>[0],
  previousCallIds: ReadonlySet<string>,
  cause?: unknown,
): void {
  if (!hasLlmCall(value)) return
  const recorded = input.costLedger
    ?.list({ channel: 'judge', tags: input.costTags })
    .some((receipt) => !previousCallIds.has(receipt.callId))
  if (recorded) return
  throw new CostAccountingIncompleteError(
    `runCampaign: judge '${judgeName}' reported a paid LLM call without a CostLedger receipt`,
    cause === undefined ? undefined : { cause },
  )
}

function hasLlmCall(value: unknown): value is { llmCall: unknown } {
  return (
    typeof value === 'object' &&
    value !== null &&
    'llmCall' in value &&
    (value as { llmCall?: unknown }).llmCall !== undefined
  )
}
