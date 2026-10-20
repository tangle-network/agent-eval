import type { RE2JS } from 're2js'
import {
  SpanNotFoundError,
  TraceAnalysisLimitError,
  TraceAnalysisValidationError,
  TraceFileMalformedError,
  TraceNotFoundError,
} from './errors'
import {
  compareSpanTime,
  extractOtlpAttributes,
  projectOtlpFlatLine,
  spanEpochMillis,
} from './otlp-span'
import {
  createSharedAbortableTask,
  type SharedAbortableTask,
  waitForSharedTask,
} from './shared-abortable-task'
import {
  compileSearchRegex,
  TRACE_ANALYSIS_LIMITS,
  type TraceAnalysisStore,
  type TraceAnalysisStoreContext,
  truncateForBudget,
  validateInteger,
} from './store'
import { bindSpanSourceReader } from './store-boundary'
import type { SpanSourceReader } from './store-contract'
import type {
  BufferedTraceStoreOptions,
  DatasetIndex,
  SpanIndexEntry,
  TraceIndexEntry,
} from './store-otlp-contract'
import {
  accumulateErrorCluster,
  type ErrorClusterAccumulator,
  finalizeErrorClusters,
} from './store-otlp-error-clusters'
import { bestAttributePathForOffset } from './store-otlp-search-offset'
import {
  type DatasetOverview,
  DEFAULT_TRACE_ANALYST_BUDGETS,
  type QueryTracesPage,
  type SearchSpanResult,
  type SearchTraceResult,
  type SpanMatchRecord,
  type TraceAnalystFilters,
  type TraceAnalystSpan,
  type TraceAnalystTraceSummary,
  type ViewSpansResult,
  type ViewTraceOversized,
  type ViewTraceResult,
} from './types'

/** Lines indexed between event-loop yields. Bounded synchronous work per
 *  tick keeps the index build from starving other tasks on large files
 *  while staying coarse enough that the yields are cheap. */
const INDEX_YIELD_LINES = 5000

const SCAN_YIELD_ITEMS = 500

/** Hand control back to the event loop without busy-waiting. */
function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve))
}

async function scanCheckpoint(signal: AbortSignal | undefined, item: number): Promise<void> {
  signal?.throwIfAborted()
  if (item > 0 && item % SCAN_YIELD_ITEMS === 0) {
    await yieldToEventLoop()
    signal?.throwIfAborted()
  }
}

export abstract class BufferedTraceStore implements TraceAnalysisStore {
  readonly readSpanSource?: SpanSourceReader
  private readonly perAttributeViewBudget: number
  private readonly perAttributeSpanBudget: number
  private readonly perCallByteCeiling: number
  private readonly perMatchTextBudget: number
  private indexValue?: DatasetIndex
  private indexTask?: SharedAbortableTask<DatasetIndex>
  private bufferValue?: Buffer
  private bufferTask?: SharedAbortableTask<Buffer>

  constructor(opts: BufferedTraceStoreOptions) {
    this.perAttributeViewBudget = validateInteger(
      opts.perAttributeViewBudget ?? DEFAULT_TRACE_ANALYST_BUDGETS.perAttributeViewBudget,
      'perAttributeViewBudget',
      TRACE_ANALYSIS_LIMITS.minimumTextBudget,
    )
    this.perAttributeSpanBudget = validateInteger(
      opts.perAttributeSpanBudget ?? DEFAULT_TRACE_ANALYST_BUDGETS.perAttributeSpanBudget,
      'perAttributeSpanBudget',
      TRACE_ANALYSIS_LIMITS.minimumTextBudget,
    )
    this.perCallByteCeiling = validateInteger(
      opts.perCallByteCeiling ?? DEFAULT_TRACE_ANALYST_BUDGETS.perCallByteCeiling,
      'perCallByteCeiling',
      1,
    )
    this.perMatchTextBudget = validateInteger(
      opts.perMatchTextBudget ?? DEFAULT_TRACE_ANALYST_BUDGETS.perMatchTextBudget,
      'perMatchTextBudget',
      TRACE_ANALYSIS_LIMITS.minimumTextBudget,
    )
    if (opts.sourceReader !== undefined) {
      this.readSpanSource = bindSpanSourceReader(this, opts.sourceReader, {
        perAttributeSpanBudget: this.perAttributeSpanBudget,
        perCallByteCeiling: this.perCallByteCeiling,
      })
    }
  }

  // ─── Public API ────────────────────────────────────────────────────

  async hasTrace(trace_id: string, context?: TraceAnalysisStoreContext): Promise<boolean> {
    context?.signal?.throwIfAborted()
    const idx = await this.index(context)
    context?.signal?.throwIfAborted()
    return idx.byTrace.has(trace_id)
  }

  async hasSpans(
    opts: { trace_id: string; span_ids: readonly string[] },
    context?: TraceAnalysisStoreContext,
  ): Promise<string[]> {
    context?.signal?.throwIfAborted()
    const idx = await this.index(context)
    const trace = idx.byTrace.get(opts.trace_id)
    if (!trace) return []
    const requested = new Set(opts.span_ids)
    const found: string[] = []
    for (let index = 0; index < trace.spans.length; index += 1) {
      await scanCheckpoint(context?.signal, index)
      const spanId = trace.spans[index]!.span_id
      if (requested.has(spanId)) found.push(spanId)
    }
    return found
  }

  async getOverview(
    filters?: TraceAnalystFilters,
    context?: TraceAnalysisStoreContext,
  ): Promise<DatasetOverview> {
    const idx = await this.index(context)
    const matched = await this.matchedTraces(idx, filters, context)

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

    let traceIndex = 0
    for (const t of matched) {
      await scanCheckpoint(context?.signal, traceIndex++)
      if (t.service_name) services.add(t.service_name)
      for (const agent of t.agents) agents.add(agent)
      for (const m of t.models) models.add(m)
      for (const tn of t.tools) tools.add(tn)
      rawBytes += t.raw_jsonl_bytes
      if (!earliest || compareSpanTime(t.start_time, earliest) < 0) earliest = t.start_time
      if (!latest || compareSpanTime(t.end_time, latest) > 0) latest = t.end_time
      if (t.has_errors) {
        errorTraceCount += 1
        let spanIndex = 0
        for (const s of t.spans) {
          await scanCheckpoint(context?.signal, spanIndex++)
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

  async queryTraces(
    opts: { filters?: TraceAnalystFilters; limit: number; offset?: number },
    context?: TraceAnalysisStoreContext,
  ): Promise<QueryTracesPage> {
    const limit = validateInteger(
      opts.limit,
      'queryTraces.limit',
      1,
      TRACE_ANALYSIS_LIMITS.queryTraces,
    )
    const offset = validateInteger(opts.offset ?? 0, 'queryTraces.offset', 0)

    const idx = await this.index(context)
    const matched = await this.matchedTraces(idx, opts.filters, context)
    const slice = matched.slice(offset, offset + limit)
    return {
      traces: slice.map((t) => this.toSummary(t)),
      total: matched.length,
      has_more: offset + slice.length < matched.length,
    }
  }

  async countTraces(
    filters?: TraceAnalystFilters,
    context?: TraceAnalysisStoreContext,
  ): Promise<number> {
    const idx = await this.index(context)
    const matched = await this.matchedTraces(idx, filters, context)
    return matched.length
  }

  async viewTrace(
    opts: { trace_id: string; per_attribute_byte_cap?: number },
    context?: TraceAnalysisStoreContext,
  ): Promise<ViewTraceResult> {
    context?.signal?.throwIfAborted()
    const idx = await this.index(context)
    const trace = idx.byTrace.get(opts.trace_id)
    if (!trace) {
      throw new TraceNotFoundError(opts.trace_id)
    }
    const cap = validateInteger(
      opts.per_attribute_byte_cap ?? this.perAttributeViewBudget,
      'viewTrace.per_attribute_byte_cap',
      1,
    )

    // Probe size first — if the materialised payload would exceed
    // the per-call ceiling we return an oversized summary rather than
    // blowing the agent's context.
    const buf = await this.buffer(context)
    const spans: TraceAnalystSpan[] = []
    let runningBytes = 0
    let span_response_bytes_max = 0
    const counter: TruncationCounter = { value: 0 }
    let spanIndex = 0
    for (const s of trace.spans) {
      await scanCheckpoint(context?.signal, spanIndex++)
      const projected = this.projectSpan(buf, trace.trace_id, s, cap, counter)
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

  async viewSpans(
    opts: { trace_id: string; span_ids: readonly string[]; per_attribute_byte_cap?: number },
    context?: TraceAnalysisStoreContext,
  ): Promise<ViewSpansResult> {
    context?.signal?.throwIfAborted()
    const idx = await this.index(context)
    const trace = idx.byTrace.get(opts.trace_id)
    if (!trace) throw new TraceNotFoundError(opts.trace_id)
    if (opts.span_ids.length < 1 || opts.span_ids.length > TRACE_ANALYSIS_LIMITS.viewSpans) {
      throw new TraceAnalysisValidationError(
        `viewSpans.span_ids must contain 1..${TRACE_ANALYSIS_LIMITS.viewSpans} ids, got ${opts.span_ids.length}`,
      )
    }
    const cap = validateInteger(
      opts.per_attribute_byte_cap ?? this.perAttributeSpanBudget,
      'viewSpans.per_attribute_byte_cap',
      1,
    )

    const requested = [...new Set(opts.span_ids)]
    const wantSet = new Set(requested)
    const foundById = new Map<string, SpanIndexEntry>()
    for (let index = 0; index < trace.spans.length; index += 1) {
      await scanCheckpoint(context?.signal, index)
      const span = trace.spans[index]!
      if (wantSet.has(span.span_id)) foundById.set(span.span_id, span)
    }
    const missing = requested.filter((id) => !foundById.has(id))

    const buf = await this.buffer(context)
    const spans: TraceAnalystSpan[] = []
    let truncatedAttributeCount = 0
    const omitted = new Set(requested.filter((id) => foundById.has(id)))
    const buildResult = (): ViewSpansResult => ({
      trace_id: trace.trace_id,
      spans,
      missing_span_ids: missing,
      omitted_span_ids: requested.filter((id) => omitted.has(id)),
      has_more: omitted.size > 0,
      truncated_attribute_count: truncatedAttributeCount,
    })
    const metadataBytes = Buffer.byteLength(JSON.stringify(buildResult()), 'utf8')
    if (metadataBytes > this.perCallByteCeiling) {
      throw new TraceAnalysisLimitError(
        'viewSpans',
        metadataBytes,
        this.perCallByteCeiling,
        `viewSpans accounting requires ${metadataBytes} bytes, over the ${this.perCallByteCeiling}-byte response limit`,
      )
    }
    let spanIndex = 0
    let smallestRejectedBytes = Number.POSITIVE_INFINITY
    for (const id of requested) {
      await scanCheckpoint(context?.signal, spanIndex++)
      const s = foundById.get(id)
      if (!s) continue
      const counter: TruncationCounter = { value: 0 }
      const projected = this.projectSpan(buf, trace.trace_id, s, cap, counter)
      spans.push(projected)
      omitted.delete(id)
      truncatedAttributeCount += counter.value
      const responseBytes = Buffer.byteLength(JSON.stringify(buildResult()), 'utf8')
      if (responseBytes <= this.perCallByteCeiling) {
        continue
      }
      smallestRejectedBytes = Math.min(smallestRejectedBytes, responseBytes)
      if (requested.length === 1) {
        throw new TraceAnalysisLimitError(
          'viewSpans',
          responseBytes,
          this.perCallByteCeiling,
          `viewSpans cannot fit span ${JSON.stringify(id)} in the ${this.perCallByteCeiling}-byte response limit`,
        )
      }
      spans.pop()
      omitted.add(id)
      truncatedAttributeCount -= counter.value
    }
    if (foundById.size > 0 && spans.length === 0) {
      throw new TraceAnalysisLimitError(
        'viewSpans',
        smallestRejectedBytes,
        this.perCallByteCeiling,
        `viewSpans cannot fit one requested span in the ${this.perCallByteCeiling}-byte response limit`,
      )
    }
    return buildResult()
  }

  async searchTrace(
    opts: { trace_id: string; regex_pattern: string; max_matches?: number },
    context?: TraceAnalysisStoreContext,
  ): Promise<SearchTraceResult> {
    const max_matches = validateInteger(
      opts.max_matches ?? 50,
      'searchTrace.max_matches',
      1,
      TRACE_ANALYSIS_LIMITS.searchMatches,
    )
    const idx = await this.index(context)
    const trace = idx.byTrace.get(opts.trace_id)
    if (!trace) throw new TraceNotFoundError(opts.trace_id)
    const re = compileSearchRegex(opts.regex_pattern)

    const buf = await this.buffer(context)
    const hits: SpanMatchRecord[] = []
    let hasMore = false
    let spanIndex = 0
    for (const s of trace.spans) {
      await scanCheckpoint(context?.signal, spanIndex++)
      const remaining = max_matches - hits.length
      const localHits = await this.scanSpanForMatches(
        buf,
        trace.trace_id,
        s,
        re,
        this.perMatchTextBudget,
        remaining,
        context,
      )
      for (const h of localHits.records) {
        if (hits.length >= max_matches) break
        hits.push(h)
      }
      if (localHits.hasMore) {
        hasMore = true
        break
      }
    }
    return {
      trace_id: trace.trace_id,
      hits,
      has_more: hasMore,
    }
  }

  async searchSpan(
    opts: { trace_id: string; span_id: string; regex_pattern: string; max_matches?: number },
    context?: TraceAnalysisStoreContext,
  ): Promise<SearchSpanResult> {
    const max_matches = validateInteger(
      opts.max_matches ?? 50,
      'searchSpan.max_matches',
      1,
      TRACE_ANALYSIS_LIMITS.searchMatches,
    )
    const idx = await this.index(context)
    const trace = idx.byTrace.get(opts.trace_id)
    if (!trace) throw new TraceNotFoundError(opts.trace_id)
    let span: SpanIndexEntry | undefined
    for (let index = 0; index < trace.spans.length; index += 1) {
      await scanCheckpoint(context?.signal, index)
      const candidate = trace.spans[index]!
      if (candidate.span_id === opts.span_id) {
        span = candidate
        break
      }
    }
    if (!span) {
      throw new SpanNotFoundError(opts.trace_id, opts.span_id)
    }
    const re = compileSearchRegex(opts.regex_pattern)
    const buf = await this.buffer(context)
    const localHits = await this.scanSpanForMatches(
      buf,
      trace.trace_id,
      span,
      re,
      this.perMatchTextBudget,
      max_matches,
      context,
    )
    return {
      trace_id: trace.trace_id,
      span_id: span.span_id,
      hits: localHits.records,
      has_more: localHits.hasMore,
    }
  }

  // ─── Index building ────────────────────────────────────────────────

  /** Force the index to materialise. Useful to amortise startup cost
   *  before the first agent call. */
  async ensureIndexed(context?: TraceAnalysisStoreContext): Promise<void> {
    await this.index(context)
  }

  private async buffer(context?: TraceAnalysisStoreContext): Promise<Buffer> {
    context?.signal?.throwIfAborted()
    if (this.bufferValue) return this.bufferValue
    if (!this.bufferTask) {
      const task = createSharedAbortableTask((signal) => this.readBuffer(signal))
      this.bufferTask = task
      void task.promise.then(
        (value) => {
          this.bufferValue = value
          if (this.bufferTask === task) this.bufferTask = undefined
        },
        () => {
          if (this.bufferTask === task) this.bufferTask = undefined
        },
      )
    }
    return waitForSharedTask(this.bufferTask, context?.signal)
  }

  protected abstract readBuffer(signal?: AbortSignal): Promise<Buffer>

  protected abstract sourcePath(): string

  protected projectRecord(raw: Record<string, unknown>): TraceAnalystSpan | null {
    return projectOtlpFlatLine(raw)
  }

  private async index(context?: TraceAnalysisStoreContext): Promise<DatasetIndex> {
    context?.signal?.throwIfAborted()
    if (this.indexValue) return this.indexValue
    if (!this.indexTask) {
      const task = createSharedAbortableTask((signal) => this.buildIndex(signal))
      this.indexTask = task
      void task.promise.then(
        (value) => {
          this.indexValue = value
          if (this.indexTask === task) this.indexTask = undefined
        },
        () => {
          if (this.indexTask === task) this.indexTask = undefined
        },
      )
    }
    return waitForSharedTask(this.indexTask, context?.signal)
  }

  private async buildIndex(signal?: AbortSignal): Promise<DatasetIndex> {
    // readGuarded surfaces missing/oversized files as typed errors.
    const buf = await this.buffer({ signal })
    signal?.throwIfAborted()

    const byTrace = new Map<string, TraceIndexEntry>()
    let cursor = 0
    let lineNumber = 0
    let sinceYield = 0
    while (cursor < buf.length) {
      lineNumber += 1
      // Yield to the event loop every INDEX_YIELD_LINES lines so a huge
      // file doesn't monopolise the thread for the whole index build.
      if (++sinceYield >= INDEX_YIELD_LINES) {
        sinceYield = 0
        await yieldToEventLoop()
        signal?.throwIfAborted()
      }
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
      } catch (cause) {
        throw new TraceFileMalformedError(this.sourcePath(), lineNumber, lineOffset, cause)
      }
      if (!parsed || typeof parsed !== 'object') {
        throw new TraceFileMalformedError(this.sourcePath(), lineNumber, lineOffset)
      }
      const span = this.projectRecord(parsed as Record<string, unknown>)
      if (!span) {
        throw new TraceFileMalformedError(this.sourcePath(), lineNumber, lineOffset)
      }

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
          agents: new Set(),
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
      if (compareSpanTime(span.start_time, entry.start_time) < 0) entry.start_time = span.start_time
      if (compareSpanTime(span.end_time, entry.end_time) > 0) entry.end_time = span.end_time
      if (span.agent_name) entry.agents.add(span.agent_name)
      if (span.model_name) entry.models.add(span.model_name)
      if (span.tool_name) entry.tools.add(span.tool_name)
    }

    // Compute trace duration once, sort spans by start time for
    // stable iteration.
    let totalRawBytes = 0
    for (const t of byTrace.values()) {
      signal?.throwIfAborted()
      totalRawBytes += t.raw_jsonl_bytes
      t.spans.sort(
        (a, b) =>
          compareSpanTime(a.start_time, b.start_time) || a.line_byte_offset - b.line_byte_offset,
      )
      // Duration is 0 unless BOTH bounds parse — a missing/garbage timestamp
      // yields 0, never a NaN (→ null in JSON) or a bogus epoch-from-zero span.
      const startMs = spanEpochMillis(t.start_time)
      const endMs = spanEpochMillis(t.end_time)
      t.duration_ms = startMs === null || endMs === null ? 0 : Math.max(0, endMs - startMs)
    }
    const sortedTraceIds = [...byTrace.keys()].sort()
    signal?.throwIfAborted()

    return { byTrace, totalRawBytes, sortedTraceIds }
  }

  // ─── Filter pipeline ───────────────────────────────────────────────

  private async matchedTraces(
    idx: DatasetIndex,
    filters: TraceAnalystFilters | undefined,
    context?: TraceAnalysisStoreContext,
  ): Promise<TraceIndexEntry[]> {
    context?.signal?.throwIfAborted()
    const traces: TraceIndexEntry[] = []
    for (let index = 0; index < idx.sortedTraceIds.length; index += 1) {
      await scanCheckpoint(context?.signal, index)
      const trace = idx.byTrace.get(idx.sortedTraceIds[index]!)
      if (trace) traces.push(trace)
    }
    if (!filters) return traces

    const indexedFiltered: TraceIndexEntry[] = []
    for (let index = 0; index < traces.length; index += 1) {
      await scanCheckpoint(context?.signal, index)
      const t = traces[index]!
      if (filters.has_errors !== undefined && t.has_errors !== filters.has_errors) continue
      if (filters.service_names && filters.service_names.length > 0) {
        if (!t.service_name || !filters.service_names.includes(t.service_name)) continue
      }
      if (filters.agent_names && filters.agent_names.length > 0) {
        if (![...t.agents].some((agent) => filters.agent_names!.includes(agent))) continue
      }
      if (filters.model_names && filters.model_names.length > 0) {
        if (![...t.models].some((m) => filters.model_names!.includes(m))) continue
      }
      if (filters.tool_names && filters.tool_names.length > 0) {
        if (![...t.tools].some((tn) => filters.tool_names!.includes(tn))) continue
      }
      if (filters.start_time_after && t.start_time < filters.start_time_after) continue
      if (filters.start_time_before && t.start_time > filters.start_time_before) continue
      indexedFiltered.push(t)
    }

    if (!filters.regex_pattern) return indexedFiltered

    // Opt-in raw-bytes scan — only over the already-narrowed set.
    const re = compileSearchRegex(filters.regex_pattern)
    const buf = await this.buffer(context)
    const out: TraceIndexEntry[] = []
    let traceIndex = 0
    for (const t of indexedFiltered) {
      await scanCheckpoint(context?.signal, traceIndex++)
      let matched = false
      let spanIndex = 0
      for (const s of t.spans) {
        await scanCheckpoint(context?.signal, spanIndex++)
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

  private projectSpan(
    buf: Buffer,
    trace_id: string,
    s: SpanIndexEntry,
    perAttrCap: number,
    counter: TruncationCounter,
  ): TraceAnalystSpan {
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
        if (trunc !== v) counter.value += 1
        projected[k] = trunc
      } else if (Array.isArray(v) || (v && typeof v === 'object')) {
        const json = JSON.stringify(v)
        const trunc = truncateForBudget(json, perAttrCap)
        if (trunc !== json) {
          counter.value += 1
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
    re: RE2JS,
    textBudget: number,
    recordCap: number,
    context?: TraceAnalysisStoreContext,
  ): Promise<{ records: SpanMatchRecord[]; hasMore: boolean }> {
    // We scan against the original raw JSONL slice for each span and
    // record byte positions; the matched_text + context window is
    // truncated to `textBudget` bytes per record so total tool output
    // stays bounded even if hits cluster.
    const slice = buf
      .subarray(s.line_byte_offset, s.line_byte_offset + s.line_byte_length)
      .toString('utf8')
    const records: SpanMatchRecord[] = []
    let hasMore = false
    let matchIndex = 0
    for (const match of re.matchAll(slice)) {
      await scanCheckpoint(context?.signal, matchIndex++)
      if (records.length >= recordCap) {
        hasMore = true
        break
      }
      const offset = match.index ?? 0
      const before = slice.slice(Math.max(0, offset - textBudget / 2), offset)
      const after = slice.slice(
        offset + match[0].length,
        offset + match[0].length + Math.floor(textBudget / 2),
      )
      records.push({
        trace_id,
        span_id: s.span_id,
        span_name: s.name,
        span_kind: s.kind,
        attribute_path: bestAttributePathForOffset(slice, offset) ?? 'span.raw',
        matched_text: truncateForBudget(match[0], textBudget),
        context_before: truncateForBudget(before, textBudget),
        context_after: truncateForBudget(after, textBudget),
        match_offset: offset,
      })
    }
    return { records, hasMore }
  }
}

// ─── OTLP shape readers ──────────────────────────────────────────────
//
// The per-line projection lives in `./otlp-span` so the index here and
// `otlpToRunRecords` read the same vocabulary off the same parser.

// Per-call truncation counter. Each public read that projects spans
// owns one of these and threads it through projectSpan; a store-keyed
// counter would let two concurrent reads on the same store report each
// other's truncation counts.
interface TruncationCounter {
  value: number
}
