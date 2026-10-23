import { CostLedger } from '../cost-ledger'
import type { EvaluationContext } from '../evaluation'
import type { AnalystContext } from './types'

/** One deadline, spending authority and usage bridge for every evaluation-backed analyst. */
export function analystEvaluationContext(
  context: AnalystContext,
  actor: string,
): {
  evaluation: EvaluationContext
  analystContext: AnalystContext & { signal: AbortSignal }
} {
  const signals = context.signal ? [context.signal] : []
  if (context.deadlineMs !== undefined) {
    const remaining = context.deadlineMs - Date.now()
    if (!Number.isFinite(remaining)) throw new TypeError('Analyst deadline must be finite')
    if (remaining <= 0) throw new DOMException('Analyst deadline exceeded', 'TimeoutError')
    signals.push(AbortSignal.timeout(Math.ceil(remaining)))
  }
  const signal = AbortSignal.any(signals)
  signal.throwIfAborted()
  return {
    analystContext: { ...context, signal },
    evaluation: {
      signal,
      // No implicit account overrides an evaluator's configured spending authority.
      costLedger:
        context.costLedger ??
        (context.budgetUsd === undefined
          ? undefined
          : new CostLedger({ costCeilingUsd: context.budgetUsd })),
      actor,
      channel: 'analyst',
      costPhase: context.costPhase,
      costTags: { ...context.tags, runId: context.runId, correlationId: context.correlationId },
      onReceipt: (receipt) =>
        context.recordUsage?.({
          calls: 1,
          tokens: receipt.usageUnknown
            ? null
            : { input: receipt.inputTokens, output: receipt.outputTokens },
          cost: receipt.costUnknown
            ? { kind: 'uncaptured', usd: null }
            : {
                kind: receipt.actualCostUsd === undefined ? 'estimated' : 'observed',
                usd: receipt.costUsd,
              },
        }),
    },
  }
}
