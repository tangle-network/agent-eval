/**
 * Typed query helpers over TraceStore.
 *
 * Not a full SQL engine — a minimal, composable set of operators that
 * cover the canned-pipeline use cases. For ad-hoc analytics, persist to
 * NDJSON and point DuckDB at it; the schema is stable so external SQL
 * tooling works out of the box.
 */

import type {
  FailureClass,
  JudgeSpan,
  LlmSpan,
  Run,
  ToolSpan,
} from './schema'
import { isJudgeSpan, isLlmSpan, isToolSpan } from './schema'
import type { TraceStore } from './store'

export async function runsForScenario(store: TraceStore, scenarioId: string): Promise<Run[]> {
  return store.listRuns({ scenarioId })
}

export async function llmSpans(store: TraceStore, runId?: string): Promise<LlmSpan[]> {
  const spans = await store.spans({ runId, kind: 'llm' })
  return spans.filter(isLlmSpan)
}

export async function toolSpans(store: TraceStore, runId?: string, toolName?: string): Promise<ToolSpan[]> {
  const spans = await store.spans({ runId, kind: 'tool', toolName })
  return spans.filter(isToolSpan)
}

export async function judgeSpans(store: TraceStore, runId?: string): Promise<JudgeSpan[]> {
  const spans = await store.spans({ runId, kind: 'judge' })
  return spans.filter(isJudgeSpan)
}

/** Group spans by any key selector. */
export function groupBy<T, K extends string | number>(items: T[], key: (t: T) => K): Map<K, T[]> {
  const map = new Map<K, T[]>()
  for (const item of items) {
    const k = key(item)
    let bucket = map.get(k)
    if (!bucket) { bucket = []; map.set(k, bucket) }
    bucket.push(item)
  }
  return map
}

/** Hash tool arguments to an orderless-key-stable string for de-duplication. */
export function argHash(args: unknown): string {
  return stableStringify(args)
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value as Record<string, unknown>).sort()
  const parts = keys.map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`)
  return `{${parts.join(',')}}`
}

/** Sum an LLM-span array into aggregate token + cost. */
export function aggregateLlm(spans: LlmSpan[]): { inputTokens: number; outputTokens: number; cachedTokens: number; costUsd: number } {
  return spans.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + (s.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (s.outputTokens ?? 0),
      cachedTokens: acc.cachedTokens + (s.cachedTokens ?? 0),
      costUsd: acc.costUsd + (s.costUsd ?? 0),
    }),
    { inputTokens: 0, outputTokens: 0, cachedTokens: 0, costUsd: 0 },
  )
}

/** Pick the outcome's failure class when present, else derive 'success' from run status. */
export function runFailureClass(run: Run): FailureClass {
  if (run.outcome?.failureClass) return run.outcome.failureClass
  if (run.status === 'completed' && run.outcome?.pass !== false) return 'success'
  if (run.status === 'aborted') return 'budget_exceeded'
  return 'unknown'
}
