import type { AgentCandidateFixedSpend } from '@tangle-network/agent-interface'
import type { CostReceiptInput } from '../cost-ledger'

export function addFixedSpend(
  left: AgentCandidateFixedSpend,
  right: AgentCandidateFixedSpend,
): AgentCandidateFixedSpend {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
    reasoningTokens: left.reasoningTokens + right.reasoningTokens,
    modelCalls: left.modelCalls + right.modelCalls,
    costUsdNanos: left.costUsdNanos + right.costUsdNanos,
    costProvenance:
      left.costProvenance === 'observed' && right.costProvenance === 'observed'
        ? 'observed'
        : 'estimated',
  }
}

/** Sum both arms in receipt order while retaining the observed/estimated provenance. */
export function pairedFixedSpendReceipt<TRun>(
  measurements: ReadonlyArray<{ baseline: TRun; candidate: TRun }>,
  model: string,
  usageOf: (run: TRun) => AgentCandidateFixedSpend,
): CostReceiptInput {
  const usage = measurements.reduce<AgentCandidateFixedSpend>(
    (sum, measurement) =>
      addFixedSpend(
        addFixedSpend(sum, usageOf(measurement.baseline)),
        usageOf(measurement.candidate),
      ),
    {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      reasoningTokens: 0,
      modelCalls: 0,
      costUsdNanos: 0,
      costProvenance: 'observed',
    },
  )
  const costUsd = usage.costUsdNanos / 1_000_000_000
  return {
    model,
    inputTokens: usage.inputTokens,
    outputTokens: usage.outputTokens,
    cachedTokens: usage.cachedInputTokens,
    reasoningTokens: usage.reasoningTokens,
    ...(usage.costProvenance === 'observed'
      ? { actualCostUsd: costUsd }
      : { estimatedCostUsd: costUsd }),
  }
}
