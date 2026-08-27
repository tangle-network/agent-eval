/**
 * # `intake/otel-spans` — OTel `TraceSpanEvent[]` → `RunRecord[]`.
 *
 * Turns an existing observability stream into the substrate-canonical
 * `RunRecord` shape so consumers with logs but no eval discipline can
 * call `analyzeRuns()` against their production traffic immediately.
 *
 * Pivot rule: spans are grouped by `tangle.runId` (the same attribute the
 * hosted-tier wire format uses) or, when absent, by `traceId`. One group
 * becomes one `RunRecord`. The root span (no `parentSpanId`) supplies:
 *
 *   - `runId` (the group key)
 *   - `wallMs` from `endTimeUnixNano - startTimeUnixNano`
 *   - `model` from `gen_ai.request.model` / `llm.model` / `tangle.model`
 *   - cost from `cost.usd` / `gen_ai.usage.cost_usd` / `tangle.cost.usd`
 *   - token usage from model-call input, output, cache-read, and cache-write
 *     attributes without double-counting aggregate parent spans
 *   - `outcome.searchScore` from `tangle.score` / `eval.score` when
 *     present; `outcome.raw` collects every numeric attribute.
 *
 * Spans that ERRORed (`status.code === 'ERROR'`) populate `failureMode`
 * with their `name` so `analyzeRuns()`'s failure clustering sees them.
 */

import type { TraceSpanEvent } from '../../hosted/types'
import type { JudgeScoresRecord, RunOutcome, RunRecord, RunSplitTag } from '../../run-record'
import {
  recordAggregateMeasurements,
  summarizeExecutionMeasurements,
} from '../../trace/execution-measurements'
import { LLM_MODEL_ATTR_KEYS } from '../../trace/otlp-attributes'

const SCORE_KEYS = ['tangle.score', 'eval.score', 'score']
const MODEL_KEYS = ['tangle.model', ...LLM_MODEL_ATTR_KEYS, 'model']
const PROMPT_HASH_KEYS = ['tangle.prompt_hash', 'prompt.hash']
const CONFIG_HASH_KEYS = ['tangle.config_hash', 'config.hash']

export interface FromOtelSpansOptions {
  spans: TraceSpanEvent[]
  /** Default split tag for synthesized records. Defaults to `'holdout'`. */
  defaultSplit?: RunSplitTag
  /** Default `experimentId` when not present on any span. */
  experimentId?: string
}

export function fromOtelSpans(opts: FromOtelSpansOptions): RunRecord[] {
  const { spans, defaultSplit = 'holdout', experimentId = 'otel-corpus' } = opts
  const grouped = groupSpans(spans)

  const runs: RunRecord[] = []
  for (const [groupKey, groupSpans] of grouped) {
    const root = findRoot(groupSpans)
    if (!root) continue
    const measurements = summarizeExecutionMeasurements(
      groupSpans.map((span) => ({
        id: span.spanId,
        ...(span.parentSpanId ? { parentId: span.parentSpanId } : {}),
        attributes: span.attributes,
        modelCall: isExplicitModelCall(span),
        aggregate: isExplicitAggregate(span),
      })),
    )
    const callSpanIds = new Set(measurements.callSpanIds)
    const callSpans = groupSpans.filter((span) => callSpanIds.has(span.spanId))

    const wallMs = Math.max(0, (root.endTimeUnixNano - root.startTimeUnixNano) / 1_000_000)
    const model =
      readAttrString(callSpans, MODEL_KEYS) ??
      readAttrString(groupSpans, MODEL_KEYS) ??
      'unknown@unknown'
    const capturedCost =
      (measurements.cost.complete ? measurements.cost.value : undefined) ??
      measurements.aggregate?.costUsd
    const costUsd = capturedCost ?? 0
    const promptHash = readAttrString(groupSpans, PROMPT_HASH_KEYS) ?? 'sha256:unknown'
    const configHash = readAttrString(groupSpans, CONFIG_HASH_KEYS) ?? 'sha256:unknown'
    const score = readAttrNumber(groupSpans, SCORE_KEYS)

    const rawNumeric = collectNumericAttrs(groupSpans)
    rawNumeric.error_span_count = groupSpans.filter((span) => span.status?.code === 'ERROR').length
    rawNumeric.llm_span_count = measurements.modelCallCount
    if (measurements.cost.value !== undefined && !measurements.cost.complete) {
      rawNumeric.partial_observed_cost_usd = measurements.cost.value
    }
    recordAggregateMeasurements(rawNumeric, measurements.aggregate)

    const judgeScores: JudgeScoresRecord | undefined =
      score !== undefined
        ? {
            perJudge: { 'otel-derived': { score } },
            perDimMean: { score },
            composite: score,
          }
        : undefined

    const errorSpan = groupSpans.find((s) => s.status?.code === 'ERROR')
    const outcome: RunOutcome = {
      ...(opts.defaultSplit === 'search' ? { searchScore: score } : { holdoutScore: score }),
      raw: rawNumeric,
      ...(judgeScores ? { judgeScores } : {}),
    }

    runs.push({
      runId: groupKey,
      experimentId,
      candidateId: (root.attributes['tangle.candidateId'] as string | undefined) ?? 'otel-default',
      seed: 0,
      model,
      promptHash,
      configHash,
      commitSha: (root.attributes['tangle.commit_sha'] as string | undefined) ?? 'unknown',
      wallMs,
      costUsd,
      costProvenance:
        capturedCost === undefined
          ? { kind: 'uncaptured', usd: null }
          : { kind: 'observed', usd: capturedCost },
      tokenUsage: measurements.tokenUsage,
      outcome,
      splitTag: defaultSplit,
      ...(errorSpan ? { failureMode: errorSpan.name } : {}),
    } as RunRecord)
  }
  return runs
}

function isExplicitModelCall(span: TraceSpanEvent): boolean {
  const kind = span.attributes['openinference.span.kind']
  if (typeof kind === 'string') return kind.toUpperCase() === 'LLM'
  const spanType = span.attributes['span.type']
  return (
    (typeof spanType === 'string' && spanType.toLowerCase() === 'llm_request') ||
    span.name.toLowerCase().includes('llm') ||
    readAttrString([span], MODEL_KEYS) !== undefined ||
    typeof span.attributes['gen_ai.operation.name'] === 'string'
  )
}

function isExplicitAggregate(span: TraceSpanEvent): boolean {
  const kind = span.attributes['openinference.span.kind']
  return typeof kind === 'string' && kind.toUpperCase() !== 'LLM'
}

// ── Internal helpers ────────────────────────────────────────────────

function groupSpans(spans: TraceSpanEvent[]): Map<string, TraceSpanEvent[]> {
  const m = new Map<string, TraceSpanEvent[]>()
  for (const span of spans) {
    const key = (span['tangle.runId'] as string | undefined) ?? span.traceId
    const list = m.get(key) ?? []
    list.push(span)
    m.set(key, list)
  }
  return m
}

function findRoot(group: TraceSpanEvent[]): TraceSpanEvent | undefined {
  return group.find((s) => !s.parentSpanId) ?? group[0]
}

function readAttrString(spans: TraceSpanEvent[], keys: string[]): string | undefined {
  for (const span of spans) {
    for (const key of keys) {
      const v = span.attributes[key]
      if (typeof v === 'string' && v.length > 0) return v
    }
  }
  return undefined
}

function readAttrNumber(spans: TraceSpanEvent[], keys: string[]): number | undefined {
  for (const span of spans) {
    for (const key of keys) {
      const v = span.attributes[key]
      if (typeof v === 'number' && Number.isFinite(v)) return v
      if (typeof v === 'string') {
        const parsed = Number(v)
        if (Number.isFinite(parsed)) return parsed
      }
    }
  }
  return undefined
}

function collectNumericAttrs(spans: TraceSpanEvent[]): Record<string, number> {
  const raw: Record<string, number> = {}
  for (const span of spans) {
    for (const [k, v] of Object.entries(span.attributes)) {
      if (typeof v === 'number' && Number.isFinite(v)) raw[k] = v
    }
  }
  return raw
}
