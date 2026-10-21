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
import { CaptureIntegrityError } from '../errors'
import { TraceFileMissingError, TraceFileTooLargeError } from './errors'
import { type TraceAnalysisStore, validateInteger } from './store'
import {
  BufferedTraceStore,
  type ToolSpansToTraceAnalysisStoreOptions,
} from './store-otlp-buffered'
import { traceSpanSchema } from './store-schemas'
import type { TraceAnalystSpan } from './types'

export interface OtlpFileTraceStoreOptions extends ToolSpansToTraceAnalysisStoreOptions {
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

/** Budgets and authorized source access shared by canonical span-record stores. */
export type SpanRecordsToTraceAnalysisStoreOptions = ToolSpansToTraceAnalysisStoreOptions

/** Default ceiling for {@link OtlpFileTraceStoreOptions.maxFileBytes}. */
export const DEFAULT_MAX_TRACE_FILE_BYTES = 256 * 1024 * 1024

export class OtlpFileTraceStore extends BufferedTraceStore {
  private readonly path: string
  private readonly maxFileBytes: number

  constructor(opts: OtlpFileTraceStoreOptions) {
    super(opts)
    this.path = opts.path
    this.maxFileBytes = validateInteger(
      opts.maxFileBytes ?? DEFAULT_MAX_TRACE_FILE_BYTES,
      'maxFileBytes',
      1,
    )
  }

  /** Stat-then-read so an oversized file fails loud before allocating the
   *  source buffer. Missing files remain distinct from malformed traces. */
  protected async readBuffer(signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted()
    let stats: Awaited<ReturnType<typeof stat>>
    try {
      stats = await stat(this.path)
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') {
        throw new TraceFileMissingError(this.path)
      }
      throw err
    }
    if (stats.size > this.maxFileBytes) {
      throw new TraceFileTooLargeError(this.path, stats.size, this.maxFileBytes)
    }
    signal?.throwIfAborted()
    return readFile(this.path, { signal })
  }

  protected sourcePath(): string {
    return this.path
  }
}

export class BufferTraceStore extends BufferedTraceStore {
  constructor(
    private readonly source: Buffer,
    opts: ToolSpansToTraceAnalysisStoreOptions = {},
  ) {
    super(opts)
  }

  protected async readBuffer(signal?: AbortSignal): Promise<Buffer> {
    signal?.throwIfAborted()
    return this.source
  }

  protected sourcePath(): string {
    return '<memory>'
  }
}

class SpanRecordTraceStore extends BufferTraceStore {
  protected override projectRecord(raw: Record<string, unknown>): TraceAnalystSpan {
    return traceSpanSchema.parse(raw)
  }
}

/**
 * Snapshot canonical spans without reinterpreting their identifiers, kind, or duration.
 * Reads use the same indexed, bounded engine as the OTLP adapters. Raw byte counts
 * and searches refer to the canonical JSONL snapshot, not an external source artifact.
 */
export function spanRecordsToTraceAnalysisStore(
  records: readonly TraceAnalystSpan[],
  options: SpanRecordsToTraceAnalysisStoreOptions = {},
): TraceAnalysisStore {
  if (!records || records.length === 0) {
    throw new CaptureIntegrityError('spanRecordsToTraceAnalysisStore: no span records supplied')
  }
  const seen = new Map<string, Set<string>>()
  const lines = records.map((record, index) => {
    try {
      const span = traceSpanSchema.parse(record)
      const traceSpans = seen.get(span.trace_id) ?? new Set<string>()
      if (traceSpans.has(span.span_id)) {
        throw new CaptureIntegrityError(
          `spanRecordsToTraceAnalysisStore: duplicate span '${span.span_id}' in trace '${span.trace_id}'`,
        )
      }
      traceSpans.add(span.span_id)
      seen.set(span.trace_id, traceSpans)
      return JSON.stringify(span)
    } catch (cause) {
      if (cause instanceof CaptureIntegrityError) throw cause
      throw new CaptureIntegrityError(
        `spanRecordsToTraceAnalysisStore: invalid span record at index ${index}`,
        { cause },
      )
    }
  })
  return new SpanRecordTraceStore(Buffer.from(`${lines.join('\n')}\n`, 'utf8'), options)
}

/** Build the bounded trace store directly from OpenInference JSONL text. */
export function otlpTextToTraceAnalysisStore(
  text: string,
  opts: ToolSpansToTraceAnalysisStoreOptions = {},
): TraceAnalysisStore {
  if (!text.trim()) throw new CaptureIntegrityError('OTLP trace text must not be empty')
  return new BufferTraceStore(Buffer.from(text, 'utf8'), opts)
}
