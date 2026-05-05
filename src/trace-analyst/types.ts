/**
 * Shared types for the trace-analyst module.
 *
 * Wire format. The store interface speaks `OtlpSpanLike` rows — one JSONL
 * line per span, OTLP-shaped. We do NOT depend on a specific tracing
 * vendor at the type level. Adapter
 * layers map upstream shapes onto this interface.
 *
 * Design constraint. Every read operation that can return arbitrary
 * payload must carry a byte budget so the agent's tool result stays
 * bounded regardless of input trace size. Oversized responses
 * substitute a deterministic summary instead of bytes — see
 * `ViewTraceOversized`.
 */

/** OTLP span kind (subset we actually use). */
export type TraceAnalystSpanKind =
  | 'AGENT'
  | 'LLM'
  | 'TOOL'
  | 'CHAIN'
  | 'GUARDRAIL'
  | 'SPAN'
  | 'UNKNOWN'

export type TraceAnalystSpanStatus = 'OK' | 'ERROR' | 'UNSET'

/** Subset of OTLP span fields the analyst exposes to the agent. The
 *  store's job is to project upstream's full span shape down to this
 *  view — the analyst never sees vendor extensions directly. */
export interface TraceAnalystSpan {
  trace_id: string
  span_id: string
  parent_span_id: string | null
  name: string
  kind: TraceAnalystSpanKind
  start_time: string
  end_time: string
  duration_ms: number
  status: TraceAnalystSpanStatus
  status_message?: string
  service_name: string | null
  agent_name: string | null
  model_name: string | null
  tool_name: string | null
  /** Raw JSON-serialisable attribute map. May contain large strings;
   *  callers must respect the per-attribute byte cap. */
  attributes: Record<string, unknown>
}

export interface TraceAnalystTraceSummary {
  trace_id: string
  service_name: string | null
  agent_name: string | null
  span_count: number
  has_errors: boolean
  start_time: string
  end_time: string
  duration_ms: number
  raw_jsonl_bytes: number
  models: string[]
  tools: string[]
}

export interface TraceAnalystFilters {
  /** Restrict to traces that contain at least one error span. */
  has_errors?: boolean
  /** Match if any span's `service.name` is in this list. */
  service_names?: string[]
  /** Match if any span's `agent.name` is in this list. */
  agent_names?: string[]
  /** Match if any LLM span's `llm.model_name` is in this list. */
  model_names?: string[]
  /** Match if any tool span's `tool.name` is in this list. */
  tool_names?: string[]
  /** ISO-8601 lower bound on the trace's earliest start time. */
  start_time_after?: string
  /** ISO-8601 upper bound on the trace's earliest start time. */
  start_time_before?: string
  /** Single regex applied to raw JSONL bytes for the trace. Opt-in;
   *  expensive on large datasets. Use the indexed filters above first. */
  regex_pattern?: string
}

export interface DatasetOverview {
  total_traces: number
  raw_jsonl_bytes: number
  services: string[]
  agents: string[]
  models: string[]
  tool_names: string[]
  /** Up to 20 real trace ids the agent may pass to view/search tools. */
  sample_trace_ids: string[]
  errors: { trace_count: number; span_count: number }
  time_range: { earliest: string; latest: string } | null
}

export interface QueryTracesPage {
  traces: TraceAnalystTraceSummary[]
  total: number
  has_more: boolean
}

/** Full-trace view. When the response would exceed the per-call byte
 *  budget, `oversized` is populated INSTEAD of `spans` so the agent
 *  knows to switch to `searchTrace` / `viewSpans`. */
export interface ViewTraceResult {
  trace_id: string
  spans?: TraceAnalystSpan[]
  oversized?: ViewTraceOversized
}

export interface ViewTraceOversized {
  span_count: number
  /** Names with their counts, sorted desc. Capped at 20 entries. */
  top_span_names: Array<[string, number]>
  /** Largest single span body (bytes after attribute-cap projection). */
  span_response_bytes_max: number
  error_span_count: number
}

export interface ViewSpansResult {
  trace_id: string
  spans: TraceAnalystSpan[]
  /** Number of requested span ids that were not found in the trace. */
  missing_span_ids: string[]
  /** Number of attribute fields truncated to fit the per-attribute cap. */
  truncated_attribute_count: number
}

export interface SpanMatchRecord {
  trace_id: string
  span_id: string
  span_name: string
  span_kind: TraceAnalystSpanKind
  /** JSON pointer-style path to the matched value, e.g.
   *  `attributes."llm.input_messages"[2].content`. */
  attribute_path: string
  matched_text: string
  context_before: string
  context_after: string
  match_offset: number
}

export interface SearchTraceResult {
  trace_id: string
  hits: SpanMatchRecord[]
  total_matches: number
  has_more: boolean
}

export interface SearchSpanResult {
  trace_id: string
  span_id: string
  hits: SpanMatchRecord[]
  total_matches: number
  has_more: boolean
}

/** Tunable byte budgets for bounded RLM tool output. */
export interface TraceAnalystByteBudgets {
  /** Max bytes any single tool response may emit. Hard ceiling enforced
   *  by the store; oversized → summary. Default 150_000. */
  perCallByteCeiling: number
  /** Per-attribute string truncation cap on `viewTrace` (discovery scan).
   *  Default 4096. */
  perAttributeViewBudget: number
  /** Per-attribute string truncation cap on `viewSpans` (surgical reads).
   *  Default 16384. */
  perAttributeSpanBudget: number
  /** Per-attribute cap on a single match record's `matched_text` and
   *  context window. Default 1024. */
  perMatchTextBudget: number
}

export const DEFAULT_TRACE_ANALYST_BUDGETS: TraceAnalystByteBudgets = {
  perCallByteCeiling: 150_000,
  perAttributeViewBudget: 4_096,
  perAttributeSpanBudget: 16_384,
  perMatchTextBudget: 1_024,
}

/** Marker substituted in place of truncated string payloads. Callers
 *  parsing tool output can detect it deterministically. */
export const TRACE_ANALYST_TRUNCATION_MARKER_PREFIX = '[trace-analyst truncated:'
