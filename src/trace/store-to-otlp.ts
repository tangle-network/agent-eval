/**
 * Convert agent-eval's internal trace shape (`FileSystemTraceStore` → `Run`,
 * `Span`, `TraceEvent`) into the OTLP-flat JSONL the trace analyst
 * (`analyzeTraces` + `OtlpFileTraceStore`) reads.
 *
 * Eval harnesses shard a `FileSystemTraceStore` per cell (persona / variant)
 * under a run directory. The analyst consumes a single OTLP-NDJSON file keyed
 * on `trace_id` + `span_id` with `start_time`/`end_time` in ISO-8601 and
 * resource + `attributes` rolled up per-span. This module walks every shard,
 * projects each `Span` (plus events pinned to it) into the flat OTLP shape,
 * and emits one NDJSON file.
 *
 * Generic OTLP/OpenInference fields are always emitted (`service.name`,
 * `agent.name`, `run.id`/`run.status`, `openinference.span.kind`,
 * `llm.model_name`, …). Domain attributes (`legal.*`, `tax.*`, …) are injected
 * per-run via {@link TraceStoreToOtlpOptions.resourceAttributes} /
 * {@link TraceStoreToOtlpOptions.runAttributes} so consumers don't re-roll the
 * walker.
 */

import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  applyToolSpanOtlpAttributes,
  LLM_CACHE_WRITE_TOKENS,
  LLM_CACHED_TOKENS,
  LLM_COST_USD,
  LLM_INPUT_TOKENS,
  LLM_MODEL_NAME,
  LLM_OUTPUT_TOKENS,
  LLM_REASONING_TOKENS,
  OPENINFERENCE_SPAN_KIND,
  traceSpanKindToOpenInferenceKind,
} from './otlp-attributes'
import type { Run, Span, TraceEvent } from './schema'

/** Marker `FileSystemTraceStore` stamps on partial-update NDJSON rows. */
interface MaybeUpdate {
  _update?: boolean
}

interface OtlpFlatSpan {
  trace_id: string
  span_id: string
  parent_span_id: string
  name: string
  kind: string
  start_time: string
  end_time: string
  status: { code: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR'; message: string }
  resource: { attributes: Record<string, unknown> }
  attributes: Record<string, unknown>
}

export interface TracesToOtlpResult {
  /** Total spans emitted across every cell. */
  spanCount: number
  /** Total run-anchor spans (one per Run) appended for analyst visibility. */
  runCount: number
  /** Cells whose shards parsed cleanly. */
  cellCount: number
  /** Cells that errored mid-conversion — surfaced so a partial conversion
   *  isn't silently masked. */
  cellErrorCount: number
}

/**
 * A trace source the analyst should ingest. Two layouts are supported:
 *
 *   - `celled` (default): the root holds one cell subdirectory per
 *     persona/variant, each a `FileSystemTraceStore` (`runs.ndjson`,
 *     `spans.ndjson`, `events.ndjson`).
 *   - `flat`: the root is itself a single `FileSystemTraceStore` (e.g. a
 *     production-ingestion sidecar that appends one ndjson set directly under
 *     the chosen directory).
 */
export interface TraceStoreSource {
  /** Absolute path to the trace store root. */
  root: string
  /** Layout — `celled` (default) or `flat`. */
  layout?: 'celled' | 'flat'
  /** OTLP `service.name` for this source. Overrides the options default. */
  serviceName?: string
}

/** Domain hooks. The walker is generic; consumers inject the namespaced
 *  attributes that ride along on every run + span for analyst discovery. */
export interface TraceStoreToOtlpOptions {
  /** Default OTLP `service.name` when a source doesn't set its own.
   *  Default `agent-eval`. */
  serviceName?: string
  /** Extra resource attributes per run, e.g.
   *  `(run) => ({ 'legal.persona_id': run.tags?.personaId ?? '' })`. */
  resourceAttributes?: (run: Run) => Record<string, unknown>
  /** Extra attributes on the per-run anchor span, e.g. domain outcome fields. */
  runAttributes?: (run: Run) => Record<string, unknown>
}

/**
 * Read every per-cell shard under each source root and write a flat OTLP-JSONL
 * view of the corpus to `outPath`. Each cell directory is a
 * `FileSystemTraceStore` — NDJSON append-only with size-based rotation;
 * `updateRun`/`updateSpan` append `{ id, ...patch, _update: true }` rows
 * rather than rewriting, so readers must merge those patches in (done here).
 *
 * A `string` source is treated as a celled root.
 */
export function convertTraceStoresToOtlp(
  source: string | TraceStoreSource | readonly TraceStoreSource[],
  outPath: string,
  opts: TraceStoreToOtlpOptions = {},
): TracesToOtlpResult {
  const sources: TraceStoreSource[] = Array.isArray(source)
    ? [...source]
    : typeof source === 'string'
      ? [{ root: source, layout: 'celled' }]
      : [source as TraceStoreSource]

  const defaultServiceName = opts.serviceName ?? 'agent-eval'
  const resourceAttributes = opts.resourceAttributes ?? (() => ({}))
  const runAttributes = opts.runAttributes ?? (() => ({}))

  const lines: string[] = []
  let spanCount = 0
  let runCount = 0
  let cellCount = 0
  let cellErrorCount = 0

  for (const src of sources) {
    const serviceName = src.serviceName ?? defaultServiceName
    const cellDirs: Array<{ label: string; dir: string }> =
      src.layout === 'flat'
        ? [{ label: '<root>', dir: src.root }]
        : listCells(src.root).map((name) => ({ label: name, dir: join(src.root, name) }))

    for (const cell of cellDirs) {
      try {
        const result = projectCell({
          cellDir: cell.dir,
          serviceName,
          resourceAttributes,
          runAttributes,
        })
        for (const line of result.lines) lines.push(line)
        spanCount += result.spanCount
        runCount += result.runCount
        cellCount += 1
      } catch (err) {
        console.warn(
          `[traces-to-otlp] cell ${cell.label} (${cell.dir}) skipped: ${err instanceof Error ? err.message : String(err)}`,
        )
        cellErrorCount += 1
      }
    }
  }

  writeFileSync(outPath, lines.join('\n') + (lines.length > 0 ? '\n' : ''))
  return { spanCount, runCount, cellCount, cellErrorCount }
}

interface ProjectCellResult {
  lines: string[]
  runCount: number
  spanCount: number
}

function projectCell(args: {
  cellDir: string
  serviceName: string
  resourceAttributes: (run: Run) => Record<string, unknown>
  runAttributes: (run: Run) => Record<string, unknown>
}): ProjectCellResult {
  const { cellDir, serviceName, resourceAttributes, runAttributes } = args
  const lines: string[] = []
  let runCount = 0
  let spanCount = 0

  const runs = readMergedShards<Run & MaybeUpdate>(cellDir, 'runs', 'runId')
  const spans = readMergedShards<Span & MaybeUpdate>(cellDir, 'spans', 'spanId')
  const events = readShards<TraceEvent>(cellDir, 'events')

  const runByRunId = new Map<string, Run>()
  for (const r of runs) runByRunId.set(r.runId, r)
  const spanBySpanId = new Map<string, Span>()
  for (const s of spans) spanBySpanId.set(s.spanId, s)
  const eventsBySpanId = new Map<string, TraceEvent[]>()

  // An HTTP-backed trace store can only POST `TraceEvent`s through the wire;
  // run/span lifecycle is projected into `state_mutation` events with
  // `payload.entity ∈ { run, run.update, span, span.update }`. Fold those back
  // so the analyst sees a complete Run + Span tree.
  for (const e of events) {
    if (e.kind === 'state_mutation' && e.payload && typeof e.payload === 'object') {
      const entity = (e.payload as Record<string, unknown>).entity
      if (entity === 'run') {
        const run = (e.payload as { run?: Run }).run
        if (run?.runId) runByRunId.set(run.runId, run)
        continue
      }
      if (entity === 'run.update') {
        const patch = (e.payload as { patch?: Partial<Run> }).patch
        if (patch && e.runId) {
          const prior = runByRunId.get(e.runId)
          if (prior) runByRunId.set(e.runId, { ...prior, ...patch })
        }
        continue
      }
      if (entity === 'span') {
        const span = (e.payload as { span?: Span }).span
        if (span?.spanId) spanBySpanId.set(span.spanId, span)
        continue
      }
      if (entity === 'span.update') {
        const spanId = (e.payload as { spanId?: string }).spanId
        const patch = (e.payload as { patch?: Partial<Span> }).patch
        if (spanId && patch) {
          const prior = spanBySpanId.get(spanId)
          if (prior) spanBySpanId.set(spanId, { ...prior, ...patch } as Span)
        }
        continue
      }
    }
    if (!e.spanId) continue
    const arr = eventsBySpanId.get(e.spanId) ?? []
    arr.push(e)
    eventsBySpanId.set(e.spanId, arr)
  }

  for (const run of runByRunId.values()) {
    const traceId = padTraceId(run.runId)
    const agentName = run.variantId ?? run.scenarioId
    const sharedResource = {
      attributes: {
        'service.name': serviceName,
        'agent.name': agentName,
        'run.id': run.runId,
        'run.status': run.status,
        ...resourceAttributes(run),
      },
    }

    const runSpanId = padSpanId(`run-${run.runId}`)
    const runStart = msToIso(run.startedAt)
    const runEnd = msToIso(run.endedAt ?? run.startedAt)
    const runStatus =
      run.outcome?.failureClass && run.outcome.failureClass !== 'success'
        ? 'STATUS_CODE_ERROR'
        : 'STATUS_CODE_OK'
    const runAttrs: Record<string, unknown> = {
      [OPENINFERENCE_SPAN_KIND]: 'AGENT',
      'agent.name': agentName,
      'agent.workflow.name': serviceName,
      ...runAttributes(run),
    }
    lines.push(
      JSON.stringify(
        toLine({
          traceId,
          spanId: runSpanId,
          parentSpanId: '',
          name: `run.${agentName}`,
          kind: 'SPAN_KIND_INTERNAL',
          startTime: runStart,
          endTime: runEnd,
          statusCode: runStatus,
          statusMessage: run.outcome?.notes ?? '',
          resource: sharedResource,
          attributes: runAttrs,
        }),
      ),
    )
    runCount += 1

    for (const span of spanBySpanId.values()) {
      if (span.runId !== run.runId) continue
      const spanAttrs = spanToAttributes(span, eventsBySpanId.get(span.spanId) ?? [])
      const statusCode = span.status === 'error' ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK'
      lines.push(
        JSON.stringify(
          toLine({
            traceId,
            spanId: padSpanId(span.spanId),
            parentSpanId: span.parentSpanId ? padSpanId(span.parentSpanId) : runSpanId,
            name: span.name,
            kind: spanKindToOtlpKind(span.kind),
            startTime: msToIso(span.startedAt),
            endTime: msToIso(span.endedAt ?? span.startedAt),
            statusCode,
            statusMessage: span.error ?? '',
            resource: sharedResource,
            attributes: spanAttrs,
          }),
        ),
      )
      spanCount += 1
    }
  }

  return { lines, runCount, spanCount }
}

function listCells(root: string): string[] {
  try {
    return readdirSync(root, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
  } catch {
    return []
  }
}

/**
 * Read every NDJSON shard for `name` under `cellDir`, ordered by mtime so
 * rotated files apply before the active one. Yields raw rows including any
 * `_update: true` patches.
 */
function readShards<T>(cellDir: string, name: string): T[] {
  let entries: string[]
  try {
    entries = readdirSync(cellDir)
  } catch {
    return []
  }
  const shards = entries
    .filter((f) => (f === `${name}.ndjson` || f.startsWith(`${name}.`)) && f.endsWith('.ndjson'))
    .map((f) => ({ file: f, path: join(cellDir, f) }))
    .map((s) => {
      let mtime = 0
      try {
        mtime = statSync(s.path).mtimeMs
      } catch {
        /* skip stat errors */
      }
      return { ...s, mtime }
    })
    .sort((a, b) => a.mtime - b.mtime || a.file.localeCompare(b.file))

  const rows: T[] = []
  for (const shard of shards) {
    let text: string
    try {
      text = readFileSync(shard.path, 'utf-8')
    } catch {
      continue
    }
    for (const line of text.split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        rows.push(JSON.parse(trimmed) as T)
      } catch {
        /* skip partial line */
      }
    }
  }
  return rows
}

/**
 * Read NDJSON shards and merge `{ ...patch, _update: true }` rows into the
 * prior record keyed on `idKey` — mirrors the in-memory merge
 * `FileSystemTraceStore` keeps but doesn't replay on cross-process load.
 */
function readMergedShards<T extends { _update?: boolean }>(
  cellDir: string,
  name: string,
  idKey: keyof T,
): T[] {
  const rows = readShards<T>(cellDir, name)
  const byId = new Map<string, T>()
  for (const row of rows) {
    const id = row[idKey] as unknown as string
    if (!id) continue
    const prior = byId.get(id)
    if (prior && row._update) {
      byId.set(id, { ...prior, ...row, _update: undefined } as T)
    } else {
      byId.set(id, row)
    }
  }
  return [...byId.values()]
}

function spanToAttributes(span: Span, events: TraceEvent[]): Record<string, unknown> {
  const attrs: Record<string, unknown> = {
    [OPENINFERENCE_SPAN_KIND]: traceSpanKindToOpenInferenceKind(span.kind),
  }
  if (span.kind === 'llm') {
    attrs[LLM_MODEL_NAME] = span.model
    if (span.inputTokens !== undefined) attrs[LLM_INPUT_TOKENS] = span.inputTokens
    if (span.outputTokens !== undefined) attrs[LLM_OUTPUT_TOKENS] = span.outputTokens
    if (span.reasoningTokens !== undefined) attrs[LLM_REASONING_TOKENS] = span.reasoningTokens
    if (span.cachedTokens !== undefined) attrs[LLM_CACHED_TOKENS] = span.cachedTokens
    if (span.cacheWriteTokens !== undefined) {
      attrs[LLM_CACHE_WRITE_TOKENS] = span.cacheWriteTokens
    }
    if (span.costUsd !== undefined) attrs[LLM_COST_USD] = span.costUsd
    if (span.finishReason) attrs['llm.finish_reason'] = span.finishReason
    if (Array.isArray(span.messages)) {
      attrs['llm.input_messages'] = JSON.stringify(span.messages.slice(-6))
    }
    if (typeof span.output === 'string') {
      attrs['llm.output_messages'] = JSON.stringify([{ role: 'assistant', content: span.output }])
    }
  } else if (span.kind === 'tool') {
    applyToolSpanOtlpAttributes(attrs, span)
  } else if (span.kind === 'judge') {
    attrs['judge.id'] = span.judgeId
    attrs['judge.dimension'] = span.dimension
    attrs['judge.score'] = span.score
    attrs['judge.target_span_id'] = span.targetSpanId
  }
  if (span.attributes) {
    for (const [k, v] of Object.entries(span.attributes)) {
      attrs[`agent_eval.${k}`] = v
    }
  }
  if (events.length > 0) {
    attrs['agent_eval.event_count'] = events.length
    attrs['agent_eval.event_kinds'] = JSON.stringify(events.map((e) => e.kind))
  }
  return attrs
}

function spanKindToOtlpKind(kind: Span['kind']): string {
  switch (kind) {
    case 'llm':
      return 'SPAN_KIND_CLIENT'
    case 'retrieval':
      return 'SPAN_KIND_CLIENT'
    default:
      return 'SPAN_KIND_INTERNAL'
  }
}

interface ToLineArgs {
  traceId: string
  spanId: string
  parentSpanId: string
  name: string
  kind: string
  startTime: string
  endTime: string
  statusCode: 'STATUS_CODE_OK' | 'STATUS_CODE_ERROR'
  statusMessage: string
  resource: { attributes: Record<string, unknown> }
  attributes: Record<string, unknown>
}

function toLine(args: ToLineArgs): OtlpFlatSpan {
  return {
    trace_id: args.traceId,
    span_id: args.spanId,
    parent_span_id: args.parentSpanId,
    name: args.name,
    kind: args.kind,
    start_time: args.startTime,
    end_time: args.endTime,
    status: { code: args.statusCode, message: args.statusMessage },
    resource: args.resource,
    attributes: args.attributes,
  }
}

function msToIso(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return new Date(0).toISOString()
  return new Date(ms).toISOString()
}

/** OTLP wants 16-hex span ids; eval traces use UUID-ish strings. Hex-strip +
 *  take 16, else deterministic FNV fold. */
function padSpanId(id: string): string {
  const cleaned = id.replace(/[^a-f0-9]/gi, '').toLowerCase()
  if (cleaned.length >= 16) return cleaned.slice(0, 16)
  return foldTo16Hex(id)
}

/** OTLP wants 32-hex trace ids; fold deterministically when too short. */
function padTraceId(id: string): string {
  const cleaned = id.replace(/[^a-f0-9]/gi, '').toLowerCase()
  if (cleaned.length >= 32) return cleaned.slice(0, 32)
  return foldTo32Hex(id)
}

function foldTo16Hex(s: string): string {
  let h1 = 0x811c9dc5
  for (const ch of s) {
    h1 ^= ch.charCodeAt(0)
    h1 = Math.imul(h1, 0x01000193) >>> 0
  }
  const part = h1.toString(16).padStart(8, '0')
  return (part + part).slice(0, 16)
}

function foldTo32Hex(s: string): string {
  return foldTo16Hex(s) + foldTo16Hex(`${s}::trace`).slice(0, 16)
}
