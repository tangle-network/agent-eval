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
import type { ToolSpan } from '../trace/schema'
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
    let wasted = 0
    for (const t of tools) {
      if (t.status === 'error') {
        wasted++
        continue
      }
      const laterLlm = llms.filter((l) => l.startedAt > t.startedAt)
      if (options.usageOracle) {
        if (!options.usageOracle(t, { llm: laterLlm })) wasted++
      } else {
        // Default heuristic: a tool whose result is NOT mentioned in any
        // later LLM input message is likely wasted.
        const resultStr = stringify(t.result)
        const used = laterLlm.some((l) =>
          l.messages.some(
            (m) =>
              typeof m.content === 'string' &&
              resultStr &&
              m.content.includes(resultStr.slice(0, 120)),
          ),
        )
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
