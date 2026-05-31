/**
 * Tool-use metrics — derived purely from trace data.
 *
 * No scoring assumptions: consumers supply optional ground-truth tool
 * selections per turn + optional "information used downstream" signals.
 * Without those, we still compute descriptive metrics (error rate,
 * retry rate, duplicate-call rate) that are useful on their own.
 */

import { argHash, groupBy, toolSpans } from './trace/query'
import type { Span } from './trace/schema'
import type { TraceStore } from './trace/store'

export interface ToolUseMetrics {
  runId: string
  totalCalls: number
  byTool: Record<string, ToolStats>
  errorRate: number
  /** Ratio of calls with identical (toolName, argHash) already seen earlier in the same run. */
  duplicateRate: number
  /** Ratio of error calls followed by ≥1 retry on same tool. */
  retryRate: number
  /** Optional: of the calls agent made, fraction the evaluator marked as "correct selection". */
  selectionAccuracy?: number
}

export interface ToolStats {
  calls: number
  errors: number
  avgLatencyMs: number
  duplicates: number
}

export interface ToolUseOptions {
  /** Map of spanId → whether the evaluator judged the tool selection correct. Optional. */
  selectionLabels?: Record<string, boolean>
}

export async function computeToolUseMetrics(
  store: TraceStore,
  runId: string,
  options: ToolUseOptions = {},
): Promise<ToolUseMetrics> {
  const tools = await toolSpans(store, runId)
  if (tools.length === 0) {
    return { runId, totalCalls: 0, byTool: {}, errorRate: 0, duplicateRate: 0, retryRate: 0 }
  }

  const byTool: Record<string, ToolStats> = {}
  let totalErrors = 0
  let totalDuplicates = 0
  const sortedTools = [...tools].sort((a, b) => a.startedAt - b.startedAt)
  const seenSignatures = new Set<string>()

  // duplicate detection + per-tool aggregation
  for (const t of sortedTools) {
    byTool[t.toolName] ??= { calls: 0, errors: 0, avgLatencyMs: 0, duplicates: 0 }
    const stat = byTool[t.toolName]!
    stat.calls += 1
    if (t.status === 'error') {
      stat.errors += 1
      totalErrors += 1
    }
    if (typeof t.latencyMs === 'number') stat.avgLatencyMs += t.latencyMs
    const sig = `${t.toolName}|${argHash(t.args)}`
    if (seenSignatures.has(sig)) {
      stat.duplicates += 1
      totalDuplicates += 1
    }
    seenSignatures.add(sig)
  }

  for (const stat of Object.values(byTool)) {
    stat.avgLatencyMs = stat.calls > 0 ? stat.avgLatencyMs / stat.calls : 0
  }

  // retry detection: per-tool chronological adjacency where error → next same-tool call
  let retryOpportunities = 0
  let retriesFollowed = 0
  for (const [, arr] of groupBy(sortedTools, (t) => t.toolName)) {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i]!.status !== 'error') continue
      retryOpportunities += 1
      if (arr[i + 1]) retriesFollowed += 1
    }
  }
  const retryRate = retryOpportunities > 0 ? retriesFollowed / retryOpportunities : 0

  let selectionAccuracy: number | undefined
  if (options.selectionLabels) {
    const labeled = sortedTools.filter((t) => t.spanId in options.selectionLabels!)
    if (labeled.length > 0) {
      selectionAccuracy =
        labeled.filter((t) => options.selectionLabels![t.spanId]).length / labeled.length
    }
  }

  return {
    runId,
    totalCalls: sortedTools.length,
    byTool,
    errorRate: totalErrors / sortedTools.length,
    duplicateRate: totalDuplicates / sortedTools.length,
    retryRate,
    selectionAccuracy,
  }
}

export type { Span }
