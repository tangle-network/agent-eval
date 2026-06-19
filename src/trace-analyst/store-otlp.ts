/**
 * `OtlpFileTraceStore` — read-only OTLP-JSONL trace store for the
 * trace-analyst.
 *
 * Wire shape. Each line of the input file is one OTLP-shaped span. The
 * store understands flattened OTLP JSONL plus the OpenInference vocab.
 * We project upstream's full
 * span shape down to `TraceAnalystSpan` lazily — full materialisation
 * only happens for the spans the agent actually requests.
 *
 * Indexing. On first read the store builds an in-memory index keyed
 * by `trace_id` carrying:
 *   - byte offsets + lengths for each span line (for surgical reads
 *     without re-parsing the whole file)
 *   - a `TraceAnalystTraceSummary` rollup
 *   - sets of services / agents / models / tools / has_errors
 *   - byte size of the trace's JSONL slab
 *
 * Memory bound. The index keeps span metadata only — names, kinds,
 * offsets, status. Attribute payloads stay on disk until requested.
 * For a 50MB JSONL with 50k spans, the index is ~5MB.
 *
 * Concurrency. The store builds the index once on first read and
 * caches it. Subsequent reads reuse the index. The file is opened on
 * each read; we never hold a long-lived FD.
 */

import { readFile, stat } from 'node:fs/promises'
import { NotFoundError } from '../errors'
import { extractOtlpAttributes, projectOtlpFlatLine } from './otlp-span'
import { compileSearchRegex, type TraceAnalysisStore, truncateForBudget } from './store'
import {
  type DatasetOverview,
  DEFAULT_TRACE_ANALYST_BUDGETS,
  type ErrorCluster,
  type QueryTracesPage,
  type SearchSpanResult,
  type SearchTraceResult,
  type SpanMatchRecord,
  type TraceAnalystFilters,
  type TraceAnalystSpan,
  type TraceAnalystSpanKind,
  type TraceAnalystSpanStatus,
  type TraceAnalystTraceSummary,
  type ViewSpansResult,
  type ViewTraceOversized,
  type ViewTraceResult,
} from './types'

/**
 * Parse a span timestamp to epoch millis, or null when empty/unparseable. The
 * OTLP readers accept BOTH ISO-8601 and epoch-millis-string dialects, so raw
 * string comparison (`<`, localeCompare) is wrong across dialects, and
 * `new Date(str)` is NaN for an epoch-millis string.
 */
function epochOrNull(ts: string): number | null {
  if (!ts) return null
  if (/^\d+$/.test(ts)) return Number(ts)
  const n = Date.parse(ts)
  return Number.isNaN(n) ? null : n
}

/** Ordering key: unparseable timestamps sort as epoch 0 (earliest), never NaN. */
function epochMs(ts: string): number {
  return epochOrNull(ts) ?? 0
}

interface SpanIndexEntry {
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

interface TraceIndexEntry {
  trace_id: string
  service_name: string | null
  agent_name: string | null
  span_count: number
  has_errors: boolean
  start_time: string
  end_time: string
  duration_ms: number
  raw_jsonl_bytes: number
  models: Set<string>
  tools: Set<string>
  spans: SpanIndexEntry[]
  /** Sorted by line offset for stable iteration. */
}

interface DatasetIndex {
  byTrace: Map<string, TraceIndexEntry>
  totalRawBytes: number
  // Pre-computed sorted trace_ids for sample/query stability.
  sortedTraceIds: string[]
}

export interface OtlpFileTraceStoreOptions {
  /** Path to the OTLP-JSONL file. */
  path: string
  /** Override the discovery (`viewTrace`) per-attribute byte cap. */
  perAttributeViewBudget?: number
  /** Override the surgical (`viewSpans`) per-attribute byte cap. */
  perAttributeSpanBudget?: number
  /** Override the per-call ceiling that triggers oversized summaries. */
  perCallByteCeiling?: number
  /** Override the per-match text budget. */
  perMatchTextBudget?: number
}

export class OtlpFileTraceStore implements TraceAnalysisStore {
  private readonly path: string
  private readonly perAttributeViewBudget: number
  private readonly perAttributeSpanBudget: number
  private readonly perCallByteCeiling: number
  private readonly perMatchTextBudget: number
  private indexPromise?: Promise<DatasetIndex>
  /** Cached UTF-8 buffer of the file. We pin it once because every
   *  read needs slice access and re-reading on each call balloons the
   *  syscall count. */
  private bufferPromise?: Promise<Buffer>

  constructor(opts: OtlpFileTraceStoreOptions) {
    this.path = opts.path
    this.perAttributeViewBudget =
      opts.perAttributeViewBudget ?? DEFAULT_TRACE_ANALYST_BUDGETS.perAttributeViewBudget
    this.perAttributeSpanBudget =
      opts.perAttributeSpanBudget ?? DEFAULT_TRACE_ANALYST_BUDGETS.perAttributeSpanBudget
    this.perCallByteCeiling =
      opts.perCallByteCeiling ?? DEFAULT_TRACE_ANALYST_BUDGETS.perCallByteCeiling
    this.perMatchTextBudget =
      opts.perMatchTextBudget ?? DEFAULT_TRACE_ANALYST_BUDGETS.perMatchTextBudget
  }

  // ─── Public API ────────────────────────────────────────────────────

  async getOverview(filters?: TraceAnalystFilters): Promise<DatasetOverview> {
    const idx = await this.index()
    const matched = await this.matchedTraces(idx, filters)

    const services = new Set<string>()
    const agents = new Set<string>()
    const models = new Set<string>()
    const tools = new Set<string>()
    let rawBytes = 0
    let earliest: string | null = null
    let latest: string | null = null
    let errorTraceCount = 0
    let errorSpanCount = 0
    const clusters = new Map<string, ErrorClusterAccumulator>()

    for (const t of matched) {
      if (t.service_name) services.add(t.service_name)
      if (t.agent_name) agents.add(t.agent_name)
      for (const m of t.models) models.add(m)
      for (const tn of t.tools) tools.add(tn)
      rawBytes += t.raw_jsonl_bytes
      if (!earliest || epochMs(t.start_time) < epochMs(earliest)) earliest = t.start_time
      if (!latest || epochMs(t.end_time) > epochMs(latest)) latest = t.end_time
      if (t.has_errors) {
        errorTraceCount += 1
        for (const s of t.spans) {
          if (s.status !== 'ERROR') continue
          errorSpanCount += 1
          accumulateErrorCluster(clusters, t.trace_id, s)
        }
      }
    }

    const sample_trace_ids = matched.slice(0, 20).map((t) => t.trace_id)
    return {
      total_traces: matched.length,
      raw_jsonl_bytes: rawBytes,
      services: [...services].sort(),
      agents: [...agents].sort(),
      models: [...models].sort(),
      tool_names: [...tools].sort(),
      sample_trace_ids,
      errors: { trace_count: errorTraceCount, span_count: errorSpanCount },
      error_clusters: finalizeErrorClusters(clusters, errorTraceCount),
      time_range: earliest && latest ? { earliest, latest } : null,
    }
  }

  async queryTraces(opts: {
    filters?: TraceAnalystFilters
    limit: number
    offset?: number
  }): Promise<QueryTracesPage> {
    if (!Number.isInteger(opts.limit) || opts.limit < 1 || opts.limit > 200) {
      throw new RangeError(`queryTraces.limit must be 1..200, got ${opts.limit}`)
    }
    const offset = opts.offset ?? 0
    if (!Number.isInteger(offset) || offset < 0) {
      throw new RangeError(`queryTraces.offset must be >=0, got ${offset}`)
    }

    const idx = await this.index()
    const matched = await this.matchedTraces(idx, opts.filters)
    const slice = matched.slice(offset, offset + opts.limit)
    return {
      traces: slice.map((t) => this.toSummary(t)),
      total: matched.length,
      has_more: offset + slice.length < matched.length,
    }
  }

  async countTraces(filters?: TraceAnalystFilters): Promise<number> {
    const idx = await this.index()
    const matched = await this.matchedTraces(idx, filters)
    return matched.length
  }

  async viewTrace(opts: {
    trace_id: string
    per_attribute_byte_cap?: number
  }): Promise<ViewTraceResult> {
    const idx = await this.index()
    const trace = idx.byTrace.get(opts.trace_id)
    if (!trace) {
      throw new TraceNotFoundError(opts.trace_id)
    }
    const cap = opts.per_attribute_byte_cap ?? this.perAttributeViewBudget

    // Probe size first — if the materialised payload would exceed
    // the per-call ceiling we return an oversized summary rather than
    // blowing the agent's context.
    const buf = await this.buffer()
    const spans: TraceAnalystSpan[] = []
    let runningBytes = 0
    let span_response_bytes_max = 0
    for (const s of trace.spans) {
      const projected = await this.projectSpan(buf, trace.trace_id, s, cap)
      const bytes = Buffer.byteLength(JSON.stringify(projected), 'utf8')
      span_response_bytes_max = Math.max(span_response_bytes_max, bytes)
      runningBytes += bytes
      if (runningBytes > this.perCallByteCeiling) {
        return {
          trace_id: trace.trace_id,
          oversized: this.buildOversizedSummary(trace, span_response_bytes_max),
        }
      }
      spans.push(projected)
    }
    return { trace_id: trace.trace_id, spans }
  }

  async viewSpans(opts: {
    trace_id: string
    span_ids: readonly string[]
    per_attribute_byte_cap?: number
  }): Promise<ViewSpansResult> {
    const idx = await this.index()
    const trace = idx.byTrace.get(opts.trace_id)
    if (!trace) throw new TraceNotFoundError(opts.trace_id)
    if (opts.span_ids.length === 0) {
      return {
        trace_id: trace.trace_id,
        spans: [],
        missing_span_ids: [],
        truncated_attribute_count: 0,
      }
    }
    if (opts.span_ids.length > 100) {
      throw new RangeError(`viewSpans.span_ids cap is 100, got ${opts.span_ids.length}`)
    }
    const cap = opts.per_attribute_byte_cap ?? this.perAttributeSpanBudget

    const wantSet = new Set(opts.span_ids)
    const found = trace.spans.filter((s) => wantSet.has(s.span_id))
    const missing = opts.span_ids.filter((id) => !found.some((f) => f.span_id === id))

    const buf = await this.buffer()
    const spans: TraceAnalystSpan[] = []
    let truncated = 0
    let runningBytes = 0
    for (const s of found) {
      const before = truncationCounter(this)
      const projected = await this.projectSpan(buf, trace.trace_id, s, cap)
      truncated += before.delta()
      const bytes = Buffer.byteLength(JSON.stringify(projected), 'utf8')
      runningBytes += bytes
      if (runningBytes > this.perCallByteCeiling) {
        // Stop adding further spans rather than truncate mid-list.
        // Callers can refetch the rest with a smaller `span_ids`.
        break
      }
      spans.push(projected)
    }
    return {
      trace_id: trace.trace_id,
      spans,
      missing_span_ids: missing,
      truncated_attribute_count: truncated,
    }
  }

  async searchTrace(opts: {
    trace_id: string
    regex_pattern: string
    max_matches?: number
  }): Promise<SearchTraceResult> {
    const max_matches = opts.max_matches ?? 50
    if (!Number.isInteger(max_matches) || max_matches < 1 || max_matches > 500) {
      throw new RangeError(`searchTrace.max_matches must be 1..500, got ${max_matches}`)
    }
    const idx = await this.index()
    const trace = idx.byTrace.get(opts.trace_id)
    if (!trace) throw new TraceNotFoundError(opts.trace_id)
    const re = compileSearchRegex(opts.regex_pattern)

    const buf = await this.buffer()
    const hits: SpanMatchRecord[] = []
    let total = 0
    let capped = false
    for (const s of trace.spans) {
      const remaining = max_matches - hits.length
      const localHits = await this.scanSpanForMatches(
        buf,
        trace.trace_id,
        s,
        re,
        this.perMatchTextBudget,
        remaining,
      )
      total += localHits.total
      for (const h of localHits.records) {
        if (hits.length >= max_matches) break
        hits.push(h)
      }
      if (hits.length >= max_matches) {
        capped = true
        total = Math.max(total, hits.length + 1)
        break
      }
    }
    return {
      trace_id: trace.trace_id,
      hits,
      total_matches: total,
      has_more: capped || total > hits.length,
    }
  }

  async searchSpan(opts: {
    trace_id: string
    span_id: string
    regex_pattern: string
    max_matches?: number
  }): Promise<SearchSpanResult> {
    const max_matches = opts.max_matches ?? 50
    if (!Number.isInteger(max_matches) || max_matches < 1 || max_matches > 500) {
      throw new RangeError(`searchSpan.max_matches must be 1..500, got ${max_matches}`)
    }
    const idx = await this.index()
    const trace = idx.byTrace.get(opts.trace_id)
    if (!trace) throw new TraceNotFoundError(opts.trace_id)
    const span = trace.spans.find((s) => s.span_id === opts.span_id)
    if (!span) {
      throw new SpanNotFoundError(opts.trace_id, opts.span_id)
    }
    const re = compileSearchRegex(opts.regex_pattern)
    const buf = await this.buffer()
    const localHits = await this.scanSpanForMatches(
      buf,
      trace.trace_id,
      span,
      re,
      this.perMatchTextBudget,
      max_matches,
    )
    return {
      trace_id: trace.trace_id,
      span_id: span.span_id,
      hits: localHits.records,
      total_matches: localHits.total,
      has_more: localHits.total > localHits.records.length,
    }
  }

  // ─── Index building ────────────────────────────────────────────────

  /** Force the index to materialise. Useful to amortise startup cost
   *  before the first agent call. */
  async ensureIndexed(): Promise<void> {
    await this.index()
  }

  private async buffer(): Promise<Buffer> {
    if (!this.bufferPromise) {
      this.bufferPromise = readFile(this.path)
    }
    return this.bufferPromise
  }

  private async index(): Promise<DatasetIndex> {
    if (!this.indexPromise) {
      this.indexPromise = this.buildIndex()
    }
    return this.indexPromise
  }

  private async buildIndex(): Promise<DatasetIndex> {
    let buf: Buffer
    try {
      buf = await this.buffer()
    } catch (err) {
      const stats = await stat(this.path).catch(() => null)
      if (!stats) {
        throw new TraceFileMissingError(this.path)
      }
      throw err
    }

    const byTrace = new Map<string, TraceIndexEntry>()
    let cursor = 0
    while (cursor < buf.length) {
      const newlineIndex = buf.indexOf(0x0a, cursor) // \n
      const lineEnd = newlineIndex === -1 ? buf.length : newlineIndex
      const lineLength = lineEnd - cursor
      if (lineLength === 0) {
        cursor = lineEnd + 1
        continue
      }
      const lineSlice = buf.subarray(cursor, lineEnd).toString('utf8')
      const lineOffset = cursor
      cursor = lineEnd + 1

      let parsed: unknown
      try {
        parsed = JSON.parse(lineSlice)
      } catch {
        // Skip malformed lines silently. The agent shouldn't see them
        // but we don't want one bad line to nuke an entire dataset.
        continue
      }
      if (!parsed || typeof parsed !== 'object') continue
      const span = projectOtlpFlatLine(parsed as Record<string, unknown>)
      if (!span) continue

      let entry = byTrace.get(span.trace_id)
      if (!entry) {
        entry = {
          trace_id: span.trace_id,
          service_name: span.service_name,
          agent_name: span.agent_name,
          span_count: 0,
          has_errors: false,
          start_time: span.start_time,
          end_time: span.end_time,
          duration_ms: 0,
          raw_jsonl_bytes: 0,
          models: new Set(),
          tools: new Set(),
          spans: [],
        }
        byTrace.set(span.trace_id, entry)
      } else {
        // Pin the trace's service/agent to the first AGENT span we
        // Prefer the first agent/service fields that appear in the trace.
        if (!entry.service_name && span.service_name) entry.service_name = span.service_name
        if (!entry.agent_name && span.agent_name) entry.agent_name = span.agent_name
      }

      const indexEntry: SpanIndexEntry = {
        span_id: span.span_id,
        parent_span_id: span.parent_span_id,
        name: span.name,
        kind: span.kind,
        start_time: span.start_time,
        end_time: span.end_time,
        duration_ms: span.duration_ms,
        status: span.status,
        status_message: span.status_message,
        service_name: span.service_name,
        agent_name: span.agent_name,
        model_name: span.model_name,
        tool_name: span.tool_name,
        line_byte_offset: lineOffset,
        line_byte_length: lineLength,
      }
      entry.spans.push(indexEntry)
      entry.span_count += 1
      entry.raw_jsonl_bytes += lineLength + 1 // +1 newline byte
      if (span.status === 'ERROR') entry.has_errors = true
      if (epochMs(span.start_time) < epochMs(entry.start_time)) entry.start_time = span.start_time
      if (epochMs(span.end_time) > epochMs(entry.end_time)) entry.end_time = span.end_time
      if (span.model_name) entry.models.add(span.model_name)
      if (span.tool_name) entry.tools.add(span.tool_name)
    }

    // Compute trace duration once, sort spans by start time for
    // stable iteration.
    let totalRawBytes = 0
    for (const t of byTrace.values()) {
      totalRawBytes += t.raw_jsonl_bytes
      t.spans.sort(
        (a, b) => epochMs(a.start_time) - epochMs(b.start_time) || a.line_byte_offset - b.line_byte_offset,
      )
      // Duration is 0 unless BOTH bounds parse — a missing/garbage timestamp
      // yields 0, never a NaN (→ null in JSON) or a bogus epoch-from-zero span.
      const startMs = epochOrNull(t.start_time)
      const endMs = epochOrNull(t.end_time)
      t.duration_ms = startMs === null || endMs === null ? 0 : Math.max(0, endMs - startMs)
    }
    const sortedTraceIds = [...byTrace.keys()].sort()

    return { byTrace, totalRawBytes, sortedTraceIds }
  }

  // ─── Filter pipeline ───────────────────────────────────────────────

  private async matchedTraces(
    idx: DatasetIndex,
    filters: TraceAnalystFilters | undefined,
  ): Promise<TraceIndexEntry[]> {
    const traces = idx.sortedTraceIds.map((id) => idx.byTrace.get(id)).filter(isPresent)
    if (!filters) return traces

    const indexedFiltered = traces.filter((t) => {
      if (filters.has_errors !== undefined && t.has_errors !== filters.has_errors) return false
      if (filters.service_names && filters.service_names.length > 0) {
        if (!t.service_name || !filters.service_names.includes(t.service_name)) return false
      }
      if (filters.agent_names && filters.agent_names.length > 0) {
        if (!t.agent_name || !filters.agent_names.includes(t.agent_name)) return false
      }
      if (filters.model_names && filters.model_names.length > 0) {
        if (![...t.models].some((m) => filters.model_names!.includes(m))) return false
      }
      if (filters.tool_names && filters.tool_names.length > 0) {
        if (![...t.tools].some((tn) => filters.tool_names!.includes(tn))) return false
      }
      if (filters.start_time_after && t.start_time < filters.start_time_after) return false
      if (filters.start_time_before && t.start_time > filters.start_time_before) return false
      return true
    })

    if (!filters.regex_pattern) return indexedFiltered

    // Opt-in raw-bytes scan — only over the already-narrowed set.
    const re = compileSearchRegex(filters.regex_pattern)
    const buf = await this.buffer()
    const out: TraceIndexEntry[] = []
    for (const t of indexedFiltered) {
      let matched = false
      for (const s of t.spans) {
        const slice = buf.subarray(s.line_byte_offset, s.line_byte_offset + s.line_byte_length)
        // Buffer.toString allocates; tolerate it because regex_pattern
        // is opt-in. Future optimisation: byte-level fast-path for
        // ASCII-only patterns.
        if (re.test(slice.toString('utf8'))) {
          matched = true
          break
        }
      }
      if (matched) out.push(t)
    }
    return out
  }

  private toSummary(t: TraceIndexEntry): TraceAnalystTraceSummary {
    return {
      trace_id: t.trace_id,
      service_name: t.service_name,
      agent_name: t.agent_name,
      span_count: t.span_count,
      has_errors: t.has_errors,
      start_time: t.start_time,
      end_time: t.end_time,
      duration_ms: t.duration_ms,
      raw_jsonl_bytes: t.raw_jsonl_bytes,
      models: [...t.models].sort(),
      tools: [...t.tools].sort(),
    }
  }

  // ─── Span projection (lazy attribute reads) ────────────────────────

  private async projectSpan(
    buf: Buffer,
    trace_id: string,
    s: SpanIndexEntry,
    perAttrCap: number,
  ): Promise<TraceAnalystSpan> {
    const slice = buf
      .subarray(s.line_byte_offset, s.line_byte_offset + s.line_byte_length)
      .toString('utf8')
    let raw: Record<string, unknown> = {}
    try {
      const parsed = JSON.parse(slice)
      if (parsed && typeof parsed === 'object') raw = parsed as Record<string, unknown>
    } catch {
      // Should not happen — index pre-validated.
    }
    const attrs = extractOtlpAttributes(raw)
    const projected: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(attrs)) {
      if (typeof v === 'string') {
        const trunc = truncateForBudget(v, perAttrCap)
        if (trunc !== v) trackTruncation(this)
        projected[k] = trunc
      } else if (Array.isArray(v) || (v && typeof v === 'object')) {
        const json = JSON.stringify(v)
        const trunc = truncateForBudget(json, perAttrCap)
        if (trunc !== json) {
          trackTruncation(this)
          projected[k] = trunc
        } else {
          projected[k] = v
        }
      } else {
        projected[k] = v
      }
    }
    return {
      trace_id,
      span_id: s.span_id,
      parent_span_id: s.parent_span_id,
      name: s.name,
      kind: s.kind,
      start_time: s.start_time,
      end_time: s.end_time,
      duration_ms: s.duration_ms,
      status: s.status,
      status_message: s.status_message,
      service_name: s.service_name,
      agent_name: s.agent_name,
      model_name: s.model_name,
      tool_name: s.tool_name,
      attributes: projected,
    }
  }

  private buildOversizedSummary(
    t: TraceIndexEntry,
    span_response_bytes_max: number,
  ): ViewTraceOversized {
    const counts = new Map<string, number>()
    let errorCount = 0
    for (const s of t.spans) {
      counts.set(s.name, (counts.get(s.name) ?? 0) + 1)
      if (s.status === 'ERROR') errorCount += 1
    }
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)
    return {
      span_count: t.span_count,
      top_span_names: top,
      span_response_bytes_max,
      error_span_count: errorCount,
    }
  }

  private async scanSpanForMatches(
    buf: Buffer,
    trace_id: string,
    s: SpanIndexEntry,
    re: RegExp,
    textBudget: number,
    recordCap: number,
  ): Promise<{ records: SpanMatchRecord[]; total: number; hasMore: boolean }> {
    // We scan against the original raw JSONL slice for each span and
    // record byte positions; the matched_text + context window is
    // truncated to `textBudget` bytes per record so total tool output
    // stays bounded even if hits cluster.
    const slice = buf
      .subarray(s.line_byte_offset, s.line_byte_offset + s.line_byte_length)
      .toString('utf8')
    const records: SpanMatchRecord[] = []
    const globalRe = new RegExp(re.source, re.flags.includes('g') ? re.flags : `${re.flags}g`)
    let total = 0
    let hasMore = false
    let m: RegExpExecArray | null = globalRe.exec(slice)
    while (m !== null) {
      total += 1
      if (m.index === globalRe.lastIndex) globalRe.lastIndex += 1 // zero-width guard
      if (records.length >= recordCap) {
        hasMore = true
        break
      }
      const before = slice.slice(Math.max(0, m.index - textBudget / 2), m.index)
      const after = slice.slice(
        m.index + m[0].length,
        m.index + m[0].length + Math.floor(textBudget / 2),
      )
      records.push({
        trace_id,
        span_id: s.span_id,
        span_name: s.name,
        span_kind: s.kind,
        attribute_path: bestAttributePathForOffset(slice, m.index) ?? 'span.raw',
        matched_text: truncateForBudget(m[0], textBudget),
        context_before: truncateForBudget(before, textBudget),
        context_after: truncateForBudget(after, textBudget),
        match_offset: m.index,
      })
      m = globalRe.exec(slice)
    }
    return { records, total, hasMore }
  }
}

// ─── Errors ──────────────────────────────────────────────────────────

export class TraceFileMissingError extends NotFoundError {
  constructor(path: string) {
    super(`trace file not found: ${path}`)
  }
}
export class TraceNotFoundError extends NotFoundError {
  readonly trace_id: string
  constructor(trace_id: string) {
    super(`trace not found: ${trace_id}`)
    this.trace_id = trace_id
  }
}
export class SpanNotFoundError extends NotFoundError {
  readonly trace_id: string
  readonly span_id: string
  constructor(trace_id: string, span_id: string) {
    super(`span ${span_id} not found in trace ${trace_id}`)
    this.trace_id = trace_id
    this.span_id = span_id
  }
}

// ─── OTLP shape readers ──────────────────────────────────────────────
//
// The per-line projection lives in `./otlp-span` so the index here and
// `otlpToRunRecords` read the same vocabulary off the same parser.

function isPresent<T>(v: T | undefined): v is T {
  return v !== undefined
}

// Truncation counter — module-private, lets viewSpans report the
// number of attribute fields it had to truncate without threading
// a counter through every call.
const truncationCounters = new WeakMap<OtlpFileTraceStore, { value: number }>()

function trackTruncation(store: OtlpFileTraceStore): void {
  let c = truncationCounters.get(store)
  if (!c) {
    c = { value: 0 }
    truncationCounters.set(store, c)
  }
  c.value += 1
}

function truncationCounter(store: OtlpFileTraceStore): { delta(): number } {
  const before = truncationCounters.get(store)?.value ?? 0
  return {
    delta() {
      const after = truncationCounters.get(store)?.value ?? 0
      return after - before
    },
  }
}

/**
 * Best-effort: locate the JSON path for the substring at `offset` in
 * a single span's JSONL slice. We walk the parsed JSON structurally
 * and return the dotted path when we find a string field whose
 * serialised form contains `offset`. Returns `null` if the offset
 * doesn't fall inside a recognisable string field.
 */
function bestAttributePathForOffset(slice: string, offset: number): string | null {
  // The slice contains '"key":"value..."' — find the nearest '"'
  // wrapping `offset` and walk back to a key. This is heuristic but
  // bounded by the span line length, not the whole file.
  let i = offset
  while (i > 0 && slice[i] !== '"') i -= 1
  if (i <= 0) return null
  // Scan backwards for the preceding '"': pattern is "key":"value"
  let j = i - 1
  while (j > 0 && slice[j] !== ':') j -= 1
  if (j <= 0) return null
  // Find the key: walk back from `:` to the matching closing '"' then to opening '"'.
  let k = j - 1
  while (k > 0 && slice[k] !== '"') k -= 1
  let l = k - 1
  while (l > 0 && slice[l] !== '"') l -= 1
  if (l <= 0) return null
  return slice.slice(l + 1, k)
}

// ─── Error-cluster extraction ────────────────────────────────────────
//
// Deterministic failure-coverage population. The error-span loop in
// getOverview already visits every ERROR span; bucketing them by a
// normalized status_message signature turns "N error spans" into "K
// distinct failure modes" — the checklist an analyst must close. No LLM.

const ERROR_CLUSTER_MAX = 50
const ERROR_CLUSTER_EXEMPLARS = 5
const SIGNATURE_MAX_CHARS = 160

interface ErrorClusterAccumulator {
  signature: string
  sample: string
  traceIds: Set<string>
  spanIds: string[]
  spanCount: number
  spanNames: Map<string, number>
  toolNames: Map<string, number>
}

/** Collapse volatile tokens so semantically identical failures share a key:
 *  hex/uuid ids → <id>, numbers → #, quoted/abs paths → <path>, durations →
 *  <dur>, whitespace collapsed. Empty/absent messages fall back to the span
 *  name so a no-message error still forms a real cluster. */
function normalizeErrorSignature(message: string | undefined, spanName: string): string {
  const raw = (message ?? '').trim()
  const base = raw.length > 0 ? raw : `(${spanName || 'error'} — no message)`
  const norm = base
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '<id>')
    .replace(/\b[0-9a-f]{12,}\b/gi, '<id>')
    .replace(/(?:\/[\w.\-@]+){2,}/g, '<path>')
    .replace(/\b\d+(?:\.\d+)?(ms|s|m|h|kb|mb|gb)?\b/gi, (_m, u) => (u ? `#${u}` : '#'))
    .replace(/\s+/g, ' ')
    .trim()
  return norm.length > SIGNATURE_MAX_CHARS ? `${norm.slice(0, SIGNATURE_MAX_CHARS)}…` : norm
}

function bump(map: Map<string, number>, key: string | null): void {
  if (!key) return
  map.set(key, (map.get(key) ?? 0) + 1)
}

function topKey(map: Map<string, number>): string | null {
  let best: string | null = null
  let bestN = 0
  for (const [k, n] of map)
    if (n > bestN) {
      best = k
      bestN = n
    }
  return best
}

function accumulateErrorCluster(
  clusters: Map<string, ErrorClusterAccumulator>,
  traceId: string,
  span: SpanIndexEntry,
): void {
  const signature = normalizeErrorSignature(span.status_message, span.name)
  let acc = clusters.get(signature)
  if (!acc) {
    acc = {
      signature,
      sample: (span.status_message ?? span.name ?? '').slice(0, 500),
      traceIds: new Set(),
      spanIds: [],
      spanCount: 0,
      spanNames: new Map(),
      toolNames: new Map(),
    }
    clusters.set(signature, acc)
  }
  acc.traceIds.add(traceId)
  acc.spanCount += 1
  if (acc.spanIds.length < ERROR_CLUSTER_EXEMPLARS && !acc.spanIds.includes(span.span_id)) {
    acc.spanIds.push(span.span_id)
  }
  bump(acc.spanNames, span.name)
  bump(acc.toolNames, span.tool_name)
}

function finalizeErrorClusters(
  clusters: Map<string, ErrorClusterAccumulator>,
  errorTraceCount: number,
): ErrorCluster[] {
  const out = [...clusters.values()].map(
    (acc): ErrorCluster => ({
      signature: acc.signature,
      status_message_sample: acc.sample,
      span_name: topKey(acc.spanNames),
      tool_name: topKey(acc.toolNames),
      trace_count: acc.traceIds.size,
      span_count: acc.spanCount,
      prevalence: errorTraceCount > 0 ? acc.traceIds.size / errorTraceCount : 0,
      exemplar_trace_ids: [...acc.traceIds].slice(0, ERROR_CLUSTER_EXEMPLARS),
      exemplar_span_ids: acc.spanIds.slice(0, ERROR_CLUSTER_EXEMPLARS),
    }),
  )
  out.sort((a, b) => b.trace_count - a.trace_count || b.span_count - a.span_count)
  return out.slice(0, ERROR_CLUSTER_MAX)
}
