/**
 * `otlpToRunRecords` — fold an OTLP traces.jsonl (one OTLP span per line;
 * the form AppWorld / HALO emit via their OpenInference OTLP exporter, the
 * same shape `flattenOtlpExportToNdjson` produces) into validated
 * `RunRecord[]` — one record per `trace_id` (one trace == one task).
 *
 * This is the offline ingestion primitive the AppWorld proposer bench and the
 * hosted Intelligence product both stand on: traces in, paper-grade rows
 * out, ready for `compareProposers` / `analyzeRuns` / the promotion gate.
 *
 * Aggregation per trace:
 *   - tokenUsage: reconcile input, output, cache-read, and cache-write across
 *     nested model-call wrappers without double-counting parent aggregates.
 *   - costUsd: reconcile complete observed model-call cost when present; else priced via
 *     `opts.priceUsdPerToken` from the aggregated tokens; else 0 with a
 *     loud `raw.cost_unpriced = 1` marker so a missing price is visible, not
 *     a silent zero folded into a gate.
 *   - failureMode: the first `STATUS_CODE_ERROR` span's normalized status
 *     message (carries the real failure signature, not a generic class).
 *   - model: the dominant LLM model in the trace (snapshot-padded to satisfy
 *     `validateRunRecord` when the trace's model is a bare alias).
 *   - outcome score: `opts.scoreForTrace` (AppWorld `world.evaluate()` →
 *     TGC/SGC) when supplied; else 1 when the trace had no error span, 0
 *     when it did — a defensible default the caller can override.
 *   - prompt / completion: carried into `raw` as token-count signals and,
 *     when the first/last LLM span exposes `input.value` / `output.value`,
 *     the verbatim text is preserved on the optional `promptText` /
 *     `completionText` of the returned `OtlpTraceRunRecord`.
 *
 * Fail-loud: an OTLP file with zero valid spans throws. A trace with no
 * spans is impossible (a trace exists only because a span referenced it).
 * `validateRunRecord` runs on every row — a malformed projection throws
 * rather than silently producing a half-record.
 */

import {
  type RunCostProvenance,
  type RunRecord,
  type RunSplitTag,
  type RunTokenUsage,
  validateRunRecord,
} from '../run-record'
import {
  type MeasurementCoverage,
  recordAggregateMeasurements,
  summarizeExecutionMeasurements,
} from '../trace/execution-measurements'
import { LLM_MODEL_ATTR_KEYS } from '../trace/otlp-attributes'
import {
  compareSpanTime,
  firstStringAttr,
  type ProjectedOtlpSpan,
  projectOtlpFlatLine,
  spanEpochMillis,
} from './otlp-span'

export interface OtlpToRunRecordsOptions {
  /** Logical experiment grouping for every produced record. */
  experimentId: string
  /** Candidate (variant) id — the surface these traces exercised. The
   *  bench passes the proposer label here so `compareProposers` can pair rows. */
  candidateId: string
  /** Split assignment for every produced record. Default `'holdout'` —
   *  ingested traces are evidence, not the optimizer's training pool. */
  splitTag?: RunSplitTag
  /** Git SHA the traces were produced from. Default `'unknown'`. */
  commitSha?: string
  /** sha256 of the effective prompt surface. Default `'unknown'`. */
  promptHash?: string
  /** sha256 of the effective config. Default `'unknown'`. */
  configHash?: string
  /** RNG seed recorded on every row. Default 0. */
  seed?: number
  /**
   * Fallback model snapshot when the trace exposes no LLM model attribute
   * OR exposes a bare alias `validateRunRecord` would reject. The trace's
   * own model wins when it already carries a snapshot. Default
   * `'unknown@otlp'` (opaque-snapshot form the validator accepts).
   */
  fallbackModel?: string
  /**
   * USD per total token (input+output) used to price a trace when no
   * per-span cost attribute is present. When unset, an unpriced trace
   * records `costUsd: 0` AND `raw.cost_unpriced = 1` — the zero is flagged,
   * never silent.
   */
  priceUsdPerToken?: number
  /**
   * Score for a trace's outcome (AppWorld `world.evaluate()` → TGC/SGC, or
   * any [0,1] task-success signal). Keyed by `trace_id`; falls through to
   * the error-derived default (1 = no error span, 0 = had one) when the map
   * has no entry or the function returns undefined.
   */
  scoreForTrace?: (traceId: string, span: TraceAggregate) => number | undefined
  /**
   * Per-record judge metadata when an external judge produced the score.
   * Keyed by `trace_id`.
   */
  judgeMetadataForTrace?: (traceId: string) => RunRecord['judgeMetadata'] | undefined
}

/** A `RunRecord` plus the verbatim prompt/completion text when the trace's
 *  LLM spans exposed it. The text is NOT on the validated `RunRecord`
 *  (`outcome.raw` is numeric-only) but consumers ingesting full traces want
 *  it — so it rides alongside. */
export interface OtlpTraceRunRecord {
  record: RunRecord
  /** Verbatim first-LLM-span `input.value`, when present. */
  promptText?: string
  /** Verbatim last-LLM-span `output.value`, when present. */
  completionText?: string
}

/** Per-trace rollup the score callback can inspect. */
export interface TraceAggregate {
  traceId: string
  spanCount: number
  llmSpanCount: number
  toolSpanCount: number
  agentSpanCount: number
  errorSpanCount: number
  tokenUsage: RunTokenUsage
  /** First error span's normalized status message, if any. */
  firstErrorMessage?: string
  model: string
  startTime: string
  endTime: string
  wallMs: number
}

interface AggregatedTrace extends TraceAggregate {
  callSpanIds: string[]
  costMeasurement: MeasurementCoverage
  aggregateMeasurement?: ReturnType<typeof summarizeExecutionMeasurements>['aggregate']
}

/**
 * Parse + aggregate an OTLP traces.jsonl string into validated
 * `RunRecord[]` (one per trace). Use {@link otlpToTraceRunRecords} when you
 * also want the verbatim prompt/completion text alongside each record.
 */
export function otlpToRunRecords(otlpJsonl: string, opts: OtlpToRunRecordsOptions): RunRecord[] {
  return otlpToTraceRunRecords(otlpJsonl, opts).map((r) => r.record)
}

/**
 * Aggregate already-parsed OTLP flat rows without serializing them back to
 * JSONL. This is the in-memory counterpart to {@link otlpToRunRecords}; both
 * paths share projection, reconciliation, validation, and ordering.
 */
export function otlpRowsToRunRecords(
  rows: Iterable<object>,
  opts: OtlpToRunRecordsOptions,
): RunRecord[] {
  return otlpRowsToTraceRunRecords(rows, opts).map((row) => row.record)
}

/** As {@link otlpToRunRecords} but returns the prompt/completion text too. */
export function otlpToTraceRunRecords(
  otlpJsonl: string,
  opts: OtlpToRunRecordsOptions,
): OtlpTraceRunRecord[] {
  return traceRunRecordsFromSpans(groupJsonlSpansByTrace(otlpJsonl), opts)
}

/** Parsed-row counterpart to {@link otlpToTraceRunRecords}. */
export function otlpRowsToTraceRunRecords(
  rows: Iterable<object>,
  opts: OtlpToRunRecordsOptions,
): OtlpTraceRunRecord[] {
  return traceRunRecordsFromSpans(groupRowsByTrace(rows), opts)
}

function traceRunRecordsFromSpans(
  byTrace: Map<string, ProjectedOtlpSpan[]>,
  opts: OtlpToRunRecordsOptions,
): OtlpTraceRunRecord[] {
  const splitTag = opts.splitTag ?? 'holdout'
  const commitSha = opts.commitSha ?? 'unknown'
  const promptHash = opts.promptHash ?? 'unknown'
  const configHash = opts.configHash ?? 'unknown'
  const seed = opts.seed ?? 0
  const fallbackModel = opts.fallbackModel ?? 'unknown@otlp'

  if (byTrace.size === 0) {
    throw new Error(
      'otlpToRunRecords: OTLP input produced zero valid spans — every row was empty, malformed, or missing trace_id/span_id',
    )
  }

  // Stable trace order (insertion order of first appearance is preserved by
  // Map; sort by trace_id for determinism across producers).
  const traceIds = [...byTrace.keys()].sort()
  const out: OtlpTraceRunRecord[] = []

  for (const traceId of traceIds) {
    const spans = byTrace.get(traceId)!
    const agg = aggregateTrace(traceId, spans, fallbackModel)

    const score = resolveScore(opts, traceId, agg)
    const { costUsd, costProvenance } = resolveCost(opts, agg)

    const raw: Record<string, number> = {
      span_count: agg.spanCount,
      llm_span_count: agg.llmSpanCount,
      tool_span_count: agg.toolSpanCount,
      agent_span_count: agg.agentSpanCount,
      error_span_count: agg.errorSpanCount,
      prompt_tokens: agg.tokenUsage.input,
      completion_tokens: agg.tokenUsage.output,
    }
    if (agg.tokenUsage.reasoning !== undefined) raw.reasoning_tokens = agg.tokenUsage.reasoning
    if (agg.tokenUsage.cached !== undefined) raw.cached_tokens = agg.tokenUsage.cached
    if (agg.tokenUsage.cacheWrite !== undefined) {
      raw.cache_write_tokens = agg.tokenUsage.cacheWrite
    }
    if (agg.costMeasurement.value !== undefined && !agg.costMeasurement.complete) {
      raw.partial_observed_cost_usd = agg.costMeasurement.value
    }
    recordAggregateMeasurements(raw, agg.aggregateMeasurement)
    if (costProvenance.kind === 'uncaptured') raw.cost_unpriced = 1

    const outcome =
      splitTag === 'holdout' ? { holdoutScore: score, raw } : { searchScore: score, raw }

    const { promptText, completionText } = extractPromptCompletion(spans, agg.callSpanIds)
    const judgeMetadata = opts.judgeMetadataForTrace?.(traceId)

    const record = validateRunRecord({
      runId: `otlp:${opts.experimentId}:${opts.candidateId}:${traceId}`,
      experimentId: opts.experimentId,
      candidateId: opts.candidateId,
      seed,
      model: ensureSnapshot(agg.model, fallbackModel),
      promptHash,
      configHash,
      commitSha,
      wallMs: agg.wallMs,
      costUsd,
      costProvenance,
      tokenUsage: agg.tokenUsage,
      ...(judgeMetadata ? { judgeMetadata } : {}),
      outcome,
      ...(agg.firstErrorMessage ? { failureMode: agg.firstErrorMessage } : {}),
      splitTag,
      scenarioId: traceId,
    })

    out.push({
      record,
      ...(promptText !== undefined ? { promptText } : {}),
      ...(completionText !== undefined ? { completionText } : {}),
    })
  }

  return out
}

// ── Internals ──────────────────────────────────────────────────────────

function* yieldJsonlRows(otlpJsonl: string): Iterable<Record<string, unknown>> {
  for (const line of otlpJsonl.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.length === 0) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch {
      // Tolerate a stray malformed line — mirrors the store's index, which
      // skips unparseable lines rather than nuking a whole dataset. A file
      // that is ENTIRELY malformed still throws (zero valid spans).
      continue
    }
    if (parsed && typeof parsed === 'object') yield parsed as Record<string, unknown>
  }
}

function groupJsonlSpansByTrace(otlpJsonl: string): Map<string, ProjectedOtlpSpan[]> {
  return groupRowsByTrace(yieldJsonlRows(otlpJsonl))
}

function groupRowsByTrace(rows: Iterable<object>): Map<string, ProjectedOtlpSpan[]> {
  const byTrace = new Map<string, ProjectedOtlpSpan[]>()
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    const span = projectOtlpFlatLine(row as Record<string, unknown>)
    if (!span) continue
    const arr = byTrace.get(span.trace_id)
    if (arr) arr.push(span)
    else byTrace.set(span.trace_id, [span])
  }
  return byTrace
}

function aggregateTrace(
  traceId: string,
  spans: ProjectedOtlpSpan[],
  fallbackModel: string,
): AggregatedTrace {
  // Span order within a trace is by start time (epoch-aware across ISO/epoch
  // dialects), then a stable tiebreak.
  const ordered = [...spans].sort(
    (a, b) => compareSpanTime(a.start_time, b.start_time) || a.span_id.localeCompare(b.span_id),
  )

  const measurements = summarizeExecutionMeasurements(
    ordered.map((span) => ({
      id: span.span_id,
      ...(span.parent_span_id ? { parentId: span.parent_span_id } : {}),
      attributes: span.attributes,
      modelCall:
        span.kind === 'LLM' ||
        (span.kind === 'UNKNOWN' &&
          (span.model_name !== null ||
            typeof span.attributes['gen_ai.operation.name'] === 'string')),
      aggregate: span.kind !== 'LLM' && span.kind !== 'UNKNOWN',
    })),
  )
  let toolSpanCount = 0
  let agentSpanCount = 0
  let errorSpanCount = 0
  let firstErrorMessage: string | undefined
  const modelVotes = new Map<string, number>()
  let earliest = ordered[0]?.start_time ?? ''
  let latest = ordered[0]?.end_time ?? ''

  for (const s of ordered) {
    if (s.start_time && (!earliest || compareSpanTime(s.start_time, earliest) < 0))
      earliest = s.start_time
    if (s.end_time && (!latest || compareSpanTime(s.end_time, latest) > 0)) latest = s.end_time

    if (s.kind === 'TOOL') {
      toolSpanCount += 1
    } else if (s.kind === 'AGENT') {
      agentSpanCount += 1
    }

    if (s.status === 'ERROR') {
      errorSpanCount += 1
      if (firstErrorMessage === undefined) {
        firstErrorMessage = (s.status_message ?? `${s.name} — STATUS_CODE_ERROR`).slice(0, 500)
      }
    }
  }

  const callSpanIds = new Set(measurements.callSpanIds)
  for (const span of ordered) {
    if (!callSpanIds.has(span.span_id)) continue
    const model = firstStringAttr(span.attributes, LLM_MODEL_ATTR_KEYS) ?? span.model_name
    if (model) modelVotes.set(model, (modelVotes.get(model) ?? 0) + 1)
  }

  // Dominant model across LLM spans; falls back to any model attribute on a
  // non-LLM span, then the supplied fallback snapshot.
  const model = topVote(modelVotes) ?? firstModelAttr(ordered) ?? fallbackModel

  let wallMs = 0
  // epoch-aware: Date.parse returns NaN for a bare epoch-millis string, which
  // silently zeroed wallMs for traces emitted with epoch timestamps.
  const a = spanEpochMillis(earliest)
  const b = spanEpochMillis(latest)
  if (a !== null && b !== null) wallMs = Math.max(0, b - a)

  return {
    traceId,
    spanCount: spans.length,
    llmSpanCount: measurements.modelCallCount,
    toolSpanCount,
    agentSpanCount,
    errorSpanCount,
    tokenUsage: measurements.tokenUsage,
    firstErrorMessage,
    model,
    startTime: earliest,
    endTime: latest,
    wallMs,
    callSpanIds: measurements.callSpanIds,
    costMeasurement: measurements.cost,
    ...(measurements.aggregate ? { aggregateMeasurement: measurements.aggregate } : {}),
  }
}

function resolveScore(opts: OtlpToRunRecordsOptions, traceId: string, agg: TraceAggregate): number {
  const supplied = opts.scoreForTrace?.(traceId, agg)
  if (supplied !== undefined) {
    if (!Number.isFinite(supplied)) {
      throw new Error(
        `otlpToRunRecords: scoreForTrace('${traceId}') returned non-finite ${supplied}`,
      )
    }
    return supplied
  }
  // Default: error-derived. A trace with any error span scores 0; otherwise 1.
  return agg.errorSpanCount > 0 ? 0 : 1
}

function resolveCost(
  opts: OtlpToRunRecordsOptions,
  agg: AggregatedTrace,
): { costUsd: number; costProvenance: RunCostProvenance } {
  const observedCost = agg.costMeasurement
  if (observedCost.complete && observedCost.value !== undefined) {
    return {
      costUsd: observedCost.value,
      costProvenance: { kind: 'observed', usd: observedCost.value },
    }
  }
  if (agg.aggregateMeasurement?.costUsd !== undefined) {
    return {
      costUsd: agg.aggregateMeasurement.costUsd,
      costProvenance: { kind: 'observed', usd: agg.aggregateMeasurement.costUsd },
    }
  }

  if (opts.priceUsdPerToken !== undefined) {
    const totalTokens = agg.tokenUsage.input + agg.tokenUsage.output
    const costUsd = totalTokens * opts.priceUsdPerToken
    return { costUsd, costProvenance: { kind: 'estimated', usd: costUsd } }
  }

  // No per-span cost, no price table — record 0 but flag it loudly so a
  // missing price never silently flatters a cost axis.
  return { costUsd: 0, costProvenance: { kind: 'uncaptured', usd: null } }
}

function extractPromptCompletion(
  spans: ProjectedOtlpSpan[],
  callSpanIds: string[],
): {
  promptText?: string
  completionText?: string
} {
  const callIds = new Set(callSpanIds)
  const measuredCalls = spans.filter((span) => callIds.has(span.span_id))
  const llm = (
    measuredCalls.length > 0 ? measuredCalls : spans.filter((s) => s.kind === 'LLM')
  ).sort(
    (a, b) => compareSpanTime(a.start_time, b.start_time) || a.span_id.localeCompare(b.span_id),
  )
  if (llm.length === 0) return {}
  const promptText =
    firstStringAttr(llm[0]!.attributes, ['input.value', 'llm.input_messages', 'gen_ai.prompt']) ??
    undefined
  const last = llm[llm.length - 1]!
  const completionText =
    firstStringAttr(last.attributes, [
      'output.value',
      'llm.output_messages',
      'gen_ai.completion',
    ]) ?? undefined
  return {
    ...(promptText !== undefined ? { promptText } : {}),
    ...(completionText !== undefined ? { completionText } : {}),
  }
}

function topVote(votes: Map<string, number>): string | null {
  let best: string | null = null
  let bestN = 0
  for (const [k, n] of votes) {
    // Strict > keeps the higher count; lexicographic tie-break makes the winner
    // independent of Map insertion order (reproducible across producers).
    if (n > bestN || (n === bestN && best !== null && k < best)) {
      best = k
      bestN = n
    }
  }
  return best
}

function firstModelAttr(spans: ProjectedOtlpSpan[]): string | null {
  for (const s of spans) {
    const m = firstStringAttr(s.attributes, LLM_MODEL_ATTR_KEYS) ?? s.model_name
    if (m) return m
  }
  return null
}

/**
 * `validateRunRecord` rejects bare model aliases (`gpt-4o`) that remap
 * silently. AppWorld/HALO traces frequently carry such bare ids (or a null
 * model). When the model already encodes a snapshot we keep it; otherwise we
 * append the fallback snapshot token so the row is admissible without lying
 * about the model — the bare base name is preserved verbatim before `@`.
 */
function ensureSnapshot(model: string, fallbackModel: string): string {
  if (modelHasSnapshot(model)) return model
  const fallbackTag = fallbackModel.includes('@')
    ? fallbackModel.slice(fallbackModel.indexOf('@'))
    : '@otlp'
  return `${model}${fallbackTag}`
}

function modelHasSnapshot(model: string): boolean {
  if (model.includes('@')) return true
  if (/-\d{8}$/.test(model)) return true
  if (/-\d{4}-\d{2}-\d{2}$/.test(model)) return true
  if (/:date-/.test(model)) return true
  return false
}
