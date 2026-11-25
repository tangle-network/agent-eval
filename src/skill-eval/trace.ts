/**
 * A recorded run as the process measures the skill eval compares. A caller
 * whose agent records into a {@link TraceStore} returns this from `run` instead
 * of counting tool calls and cost itself.
 */

import { costForUsage } from '../cost-ledger/pricing'
import { ValidationError } from '../errors'
import { computeToolUseMetrics } from '../tool-use-metrics'
import { llmSpans, runMetricExtractor } from '../trace/query'
import type { LlmSpan } from '../trace/schema'
import type { TraceStore } from '../trace/store'
import type { SkillEvalTrace } from './recipe'

/** What one response cost: the recorded cost, else the ledger's price for its tokens, else unknown. */
function llmSpanCost(span: LlmSpan): number | null {
  if (span.costUsd !== undefined) return span.costUsd
  if (span.inputTokens === undefined || span.outputTokens === undefined) return null
  const priced = costForUsage(span.model, {
    inputTokens: span.inputTokens,
    outputTokens: span.outputTokens,
    ...(span.cachedTokens === undefined ? {} : { cachedTokens: span.cachedTokens }),
    ...(span.cacheWriteTokens === undefined ? {} : { cacheWriteTokens: span.cacheWriteTokens }),
  })
  return priced.costUnknown ? null : priced.costUsd
}

/**
 * Read one run's tool calls, tool errors, wall time and cost from a trace store.
 *
 * Wall time is null while the run has no end. Cost is null when the run
 * recorded no model call or any of its model calls cannot be priced: a partial
 * sum would read as a cheaper run. Throws when the store has no such run.
 */
export async function skillEvalTraceFromRun(
  store: TraceStore,
  runId: string,
): Promise<SkillEvalTrace> {
  const run = await store.getRun(runId)
  if (run === undefined) {
    throw new ValidationError(`skillEvalTraceFromRun: the store has no run '${runId}'`)
  }
  const tools = await computeToolUseMetrics(store, runId)
  const costs = (await llmSpans(store, runId)).map(llmSpanCost)
  let costUsd: number | null = costs.length === 0 ? null : 0
  for (const cost of costs) {
    costUsd = costUsd === null || cost === null ? null : costUsd + cost
  }
  return {
    toolCalls: tools.totalCalls,
    toolErrors: Object.values(tools.byTool).reduce((errors, tool) => errors + tool.errors, 0),
    wallMs: await runMetricExtractor('durationMs')(run, store),
    costUsd,
  }
}
