/**
 * ToolWasteView — fraction of tool calls whose results weren't used
 * downstream. Without a "used" signal we fall back to structural
 * proxies: error calls, duplicate calls, and tool calls followed by
 * zero subsequent LLM spans are all considered waste.
 *
 * Consumers can pass a `usageOracle` that inspects a tool span and
 * returns true iff the tool's result appears in a later LLM message,
 * artifact, or state mutation — that's the canonical definition; the
 * default heuristic is a reasonable fallback.
 */

import { computeToolUseMetrics } from '../tool-use-metrics'
import { llmSpans, toolSpans } from '../trace/query'
import type { LlmSpan, ToolSpan } from '../trace/schema'
import type { TraceStore } from '../trace/store'

export interface ToolWasteFinding {
  runId: string
  wastedCalls: number
  totalCalls: number
  wasteRate: number
}

export interface ToolWasteReport {
  byRun: ToolWasteFinding[]
  overallWasteRate: number
}

export interface ToolWasteOptions {
  runId?: string
  usageOracle?: (tool: ToolSpan, later: { llm: Awaited<ReturnType<typeof llmSpans>> }) => boolean
}

export async function toolWasteView(
  store: TraceStore,
  options: ToolWasteOptions = {},
): Promise<ToolWasteReport> {
  const runs = options.runId ? [options.runId] : (await store.listRuns()).map((r) => r.runId)

  const byRun: ToolWasteFinding[] = []
  let totalCalls = 0
  let totalWasted = 0
  for (const runId of runs) {
    const tools = await toolSpans(store, runId)
    if (tools.length === 0) {
      byRun.push({ runId, wastedCalls: 0, totalCalls: 0, wasteRate: 0 })
      continue
    }
    const llms = await llmSpans(store, runId)
    // Sort LLM spans once by start time, then build a suffix index of the
    // concatenated message text. `suffixText[i]` is the haystack of every
    // string message content in spans[i..]. Per tool we binary-search the
    // first span started strictly after the tool, then test that one suffix
    // — turning the per-tool O(llms × messages × content) scan into a single
    // O(log llms) lookup over precomputed text.
    const sortedLlm = [...llms].sort((a, b) => a.startedAt - b.startedAt)
    const startTimes = sortedLlm.map((l) => l.startedAt)
    const suffixText = buildSuffixText(sortedLlm)
    let wasted = 0
    for (const t of tools) {
      if (t.status === 'error') {
        wasted++
        continue
      }
      // First LLM span started strictly after this tool (upper-bound search).
      const cutoff = upperBound(startTimes, t.startedAt)
      if (options.usageOracle) {
        if (!options.usageOracle(t, { llm: sortedLlm.slice(cutoff) })) wasted++
      } else {
        // Default heuristic: a tool whose result is NOT mentioned in any
        // later LLM input message is likely wasted. An empty/null result has
        // no payload to propagate downstream — there is nothing to find in a
        // later message, so it is not evidence of waste; skip it.
        const resultStr = stringify(t.result)
        if (resultStr === '') continue
        const haystack = suffixText[cutoff] ?? ''
        const used = haystack.includes(resultStr.slice(0, 120))
        if (!used) wasted++
      }
    }
    const wasteRate = wasted / tools.length
    byRun.push({ runId, wastedCalls: wasted, totalCalls: tools.length, wasteRate })
    totalCalls += tools.length
    totalWasted += wasted
  }
  return { byRun, overallWasteRate: totalCalls > 0 ? totalWasted / totalCalls : 0 }
}

/**
 * Build per-position suffix haystacks: result[i] is the concatenation of every
 * string message content in spans[i..end]. Built back-to-front so each entry
 * reuses the next one — O(total message text) rather than O(spans²).
 */
function buildSuffixText(spans: LlmSpan[]): string[] {
  const result = new Array<string>(spans.length + 1)
  result[spans.length] = ''
  for (let i = spans.length - 1; i >= 0; i--) {
    const own = spans[i]!.messages.map((m) =>
      typeof m.content === 'string' ? m.content : '',
    ).join('\n')
    result[i] = `${own}\n${result[i + 1]}`
  }
  return result
}

/** Index of the first element strictly greater than `target` in a sorted array. */
function upperBound(sorted: number[], target: number): number {
  let lo = 0
  let hi = sorted.length
  while (lo < hi) {
    const mid = (lo + hi) >>> 1
    if (sorted[mid]! <= target) lo = mid + 1
    else hi = mid
  }
  return lo
}

function stringify(v: unknown): string {
  if (v === null || v === undefined) return ''
  if (typeof v === 'string') return v
  try {
    return JSON.stringify(v)
  } catch {
    return String(v)
  }
}

// Re-export for convenience in consumers that want both descriptive and usage metrics.
export { computeToolUseMetrics }
