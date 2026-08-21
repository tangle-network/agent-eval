/**
 * Typed query helpers over TraceStore.
 *
 * Not a full SQL engine — a minimal, composable set of operators that
 * cover the canned-pipeline use cases. For ad-hoc analytics, persist to
 * NDJSON and point DuckDB at it; the schema is stable so external SQL
 * tooling works out of the box.
 */

import { ValidationError } from '../errors'
import { canonicalString } from '../ledger-core/canonical'
import type { FailureClass, JudgeSpan, LlmSpan, Run, ToolSpan } from './schema'
import { isJudgeSpan, isLlmSpan, isToolSpan } from './schema'
import type { TraceStore } from './store'

export async function runsForScenario(store: TraceStore, scenarioId: string): Promise<Run[]> {
  return store.listRuns({ scenarioId })
}

export async function llmSpans(store: TraceStore, runId?: string): Promise<LlmSpan[]> {
  const spans = await store.spans({ runId, kind: 'llm' })
  return spans.filter(isLlmSpan)
}

export async function toolSpans(
  store: TraceStore,
  runId?: string,
  toolName?: string,
): Promise<ToolSpan[]> {
  const spans = await store.spans({ runId, kind: 'tool', toolName })
  return spans.filter(isToolSpan)
}

/** Query judge-kind spans from the trace store, optionally scoped to a single run. */
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
    if (!bucket) {
      bucket = []
      map.set(k, bucket)
    }
    bucket.push(item)
  }
  return map
}

/**
 * Key tool arguments for de-duplication: RFC 8785 canonical JSON, so key
 * order cannot split one call into two keys. Uncaptured args (`undefined`)
 * key to the string `'undefined'` so every call still keys to a string; an
 * args value with no canonical JSON form (a nested `undefined`, a function, a
 * non-finite number) throws `LedgerCanonicalizationError`.
 */
export function argHash(args: unknown): string {
  if (args === undefined) return 'undefined'
  return canonicalString(args)
}

/** Whether argument-based comparisons are valid for this tool call. */
export function hasCapturedToolArgs(span: ToolSpan): boolean {
  return span.argsCaptured !== false
}

/** Sum an LLM-span array into aggregate token + cost. */
export function aggregateLlm(spans: LlmSpan[]): {
  inputTokens: number
  outputTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  costUsd: number
} {
  return spans.reduce(
    (acc, s) => ({
      inputTokens: acc.inputTokens + (s.inputTokens ?? 0),
      outputTokens: acc.outputTokens + (s.outputTokens ?? 0),
      cachedTokens: acc.cachedTokens + (s.cachedTokens ?? 0),
      cacheWriteTokens: acc.cacheWriteTokens + (s.cacheWriteTokens ?? 0),
      reasoningTokens: acc.reasoningTokens + (s.reasoningTokens ?? 0),
      costUsd: acc.costUsd + (s.costUsd ?? 0),
    }),
    {
      inputTokens: 0,
      outputTokens: 0,
      cachedTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      costUsd: 0,
    },
  )
}

/** Pick the outcome's failure class when present, else derive 'success' from run status. */
export function runFailureClass(run: Run): FailureClass {
  if (run.outcome?.failureClass) return run.outcome.failureClass
  if (run.status === 'completed' && run.outcome?.pass !== false) return 'success'
  if (run.status === 'aborted') return 'budget_exceeded'
  return 'unknown'
}

/**
 * Metrics `regressionView`, `correlationStudy`, and `calibrationCurve` can
 * read from a run without a caller-supplied extractor. The type derives from
 * this array, so a new metric cannot be declared without an extractor arm.
 */
export const RUN_METRICS = [
  'score',
  'overallScore',
  'pass',
  'durationMs',
  'costUsd',
  'inputTokens',
  'outputTokens',
  'failureClass',
] as const

export type RunMetric = (typeof RUN_METRICS)[number]

export function isRunMetric(metric: string): metric is RunMetric {
  return (RUN_METRICS as readonly string[]).includes(metric)
}

/**
 * The extractor for one built-in metric. `null` means this run carries no
 * value for the metric — the caller drops that run from the sample.
 *
 * Throws `ValidationError` on a metric name this package does not define:
 * an unrecognized name would otherwise read as "every run is missing this
 * value" and produce an empty study instead of a refusal.
 */
export function runMetricExtractor(
  metric: string,
): (run: Run, store: TraceStore) => Promise<number | null> {
  if (!isRunMetric(metric)) {
    throw new ValidationError(
      `unknown run metric '${metric}' — pass an \`extract\` function or use one of: ${RUN_METRICS.join(', ')}`,
    )
  }
  return async (run, store) => {
    switch (metric) {
      case 'score':
      case 'overallScore':
        return run.outcome?.score ?? null
      case 'pass':
        return run.outcome?.pass === true ? 1 : 0
      case 'durationMs':
        return run.endedAt && run.startedAt ? run.endedAt - run.startedAt : null
      case 'costUsd':
        return aggregateLlm(await llmSpans(store, run.runId)).costUsd
      case 'inputTokens':
        return aggregateLlm(await llmSpans(store, run.runId)).inputTokens
      case 'outputTokens':
        return aggregateLlm(await llmSpans(store, run.runId)).outputTokens
      case 'failureClass':
        return runFailureClass(run) === 'success' ? 1 : 0
    }
  }
}
