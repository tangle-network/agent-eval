import type { SpanSourceReader } from './store-contract'
import type { TraceAnalystSpanKind, TraceAnalystSpanStatus } from './types'

export interface SpanIndexEntry {
  span_id: string
  parent_span_id: string | null
  name: string
  kind: TraceAnalystSpanKind
  start_time: string
  end_time: string
  duration_ms: number
  status: TraceAnalystSpanStatus
  status_message: string | undefined
  service_name: string | null
  agent_name: string | null
  model_name: string | null
  tool_name: string | null
  /** Byte offset in the raw JSONL file to the start of this span's line. */
  line_byte_offset: number
  /** Length of this line in bytes (excluding the trailing newline). */
  line_byte_length: number
}

export interface TraceIndexEntry {
  trace_id: string
  service_name: string | null
  agent_name: string | null
  span_count: number
  has_errors: boolean
  start_time: string
  end_time: string
  duration_ms: number
  raw_jsonl_bytes: number
  agents: Set<string>
  models: Set<string>
  tools: Set<string>
  spans: SpanIndexEntry[]
  /** Sorted by line offset for stable iteration. */
}

export interface DatasetIndex {
  byTrace: Map<string, TraceIndexEntry>
  totalRawBytes: number
  // Pre-computed sorted trace_ids for sample/query stability.
  sortedTraceIds: string[]
}

export interface ToolSpansToTraceAnalysisStoreOptions {
  /** Authorized original-record lookup, exposed only when supplied. */
  sourceReader?: SpanSourceReader
  /** Override the discovery (`viewTrace`) per-attribute byte cap. */
  perAttributeViewBudget?: number
  /** Override the surgical (`viewSpans`) per-attribute byte cap. */
  perAttributeSpanBudget?: number
  /** Override the per-call ceiling that triggers oversized summaries. */
  perCallByteCeiling?: number
  /** Override the per-match text budget. */
  perMatchTextBudget?: number
}

/** Budgets and authorized source access shared by canonical span-record stores. */
export type SpanRecordsToTraceAnalysisStoreOptions = ToolSpansToTraceAnalysisStoreOptions

export type BufferedTraceStoreOptions = ToolSpansToTraceAnalysisStoreOptions

export interface OtlpFileTraceStoreOptions extends BufferedTraceStoreOptions {
  /** Path to the OTLP-JSONL file. */
  path: string
  /**
   * Hard ceiling on the trace file size in bytes. The store reads the
   * whole file into one Buffer and indexes it in memory, so an
   * unbounded file OOMs the process. Above this size the store fails
   * loud with `TraceFileTooLargeError` instead of degrading silently.
   * Default 256 MiB.
   */
  maxFileBytes?: number
}
