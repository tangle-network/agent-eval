/**
 * TraceStore — persistence + query over the TraceSchema v1 corpus.
 *
 * Two implementations ship in the core:
 *   - InMemoryTraceStore: dev + tests, fully in-process
 *   - FileSystemTraceStore: NDJSON append-only files per entity, suitable
 *     for long-running CI jobs; rolled over at 32MB
 *
 * Downstream adapters (DuckDB, Langfuse, R2 parquet) implement this same
 * interface — the rest of the framework is storage-agnostic.
 */

import type {
  Artifact,
  BudgetLedgerEntry,
  EventKind,
  Run,
  RunStatus,
  Span,
  SpanKind,
  TraceEvent,
} from './schema'

export interface RunFilter {
  scenarioId?: string
  variantId?: string
  status?: RunStatus
  since?: number
  until?: number
  tag?: { key: string; value: string }
  parentRunId?: string
  projectId?: string
  chatId?: string
  layer?: import('./schema').RunLayer
}

export interface SpanFilter {
  runId?: string
  parentSpanId?: string
  kind?: SpanKind
  name?: string
  toolName?: string
  judgeId?: string
  since?: number
  until?: number
}

export interface EventFilter {
  runId?: string
  spanId?: string
  kind?: EventKind
  since?: number
  until?: number
}

export interface TraceStore {
  appendRun(run: Run): Promise<void>
  updateRun(runId: string, patch: Partial<Run>): Promise<void>
  appendSpan(span: Span): Promise<void>
  updateSpan(spanId: string, patch: Partial<Span>): Promise<void>
  appendEvent(event: TraceEvent): Promise<void>
  appendArtifact(artifact: Artifact): Promise<void>
  appendBudgetEntry(entry: BudgetLedgerEntry): Promise<void>

  getRun(runId: string): Promise<Run | undefined>
  listRuns(filter?: RunFilter): Promise<Run[]>
  spans(filter?: SpanFilter): Promise<Span[]>
  events(filter?: EventFilter): Promise<TraceEvent[]>
  budget(runId: string): Promise<BudgetLedgerEntry[]>
  artifacts(runId: string): Promise<Artifact[]>
}

// ── In-memory ────────────────────────────────────────────────────────

export class InMemoryTraceStore implements TraceStore {
  private runs = new Map<string, Run>()
  private allSpans: Span[] = []
  private allEvents: TraceEvent[] = []
  private allArtifacts: Artifact[] = []
  private allBudget: BudgetLedgerEntry[] = []

  async appendRun(run: Run): Promise<void> {
    if (this.runs.has(run.runId)) throw new Error(`run ${run.runId} already exists`)
    this.runs.set(run.runId, { ...run })
  }

  async updateRun(runId: string, patch: Partial<Run>): Promise<void> {
    const existing = this.runs.get(runId)
    if (!existing) throw new Error(`run ${runId} not found`)
    this.runs.set(runId, { ...existing, ...patch })
  }

  async appendSpan(span: Span): Promise<void> {
    this.allSpans.push({ ...span })
  }

  async updateSpan(spanId: string, patch: Partial<Span>): Promise<void> {
    const idx = this.allSpans.findIndex((s) => s.spanId === spanId)
    if (idx < 0) throw new Error(`span ${spanId} not found`)
    this.allSpans[idx] = { ...this.allSpans[idx], ...patch } as Span
  }

  async appendEvent(event: TraceEvent): Promise<void> {
    this.allEvents.push({ ...event })
  }

  async appendArtifact(artifact: Artifact): Promise<void> {
    this.allArtifacts.push({ ...artifact })
  }

  async appendBudgetEntry(entry: BudgetLedgerEntry): Promise<void> {
    this.allBudget.push({ ...entry })
  }

  async getRun(runId: string): Promise<Run | undefined> {
    const r = this.runs.get(runId)
    return r ? { ...r } : undefined
  }

  async listRuns(filter: RunFilter = {}): Promise<Run[]> {
    return [...this.runs.values()].filter((r) => matchesRun(r, filter))
  }

  async spans(filter: SpanFilter = {}): Promise<Span[]> {
    return this.allSpans.filter((s) => matchesSpan(s, filter)).map((s) => ({ ...s }))
  }

  async events(filter: EventFilter = {}): Promise<TraceEvent[]> {
    return this.allEvents.filter((e) => matchesEvent(e, filter)).map((e) => ({ ...e }))
  }

  async budget(runId: string): Promise<BudgetLedgerEntry[]> {
    return this.allBudget.filter((b) => b.runId === runId).map((b) => ({ ...b }))
  }

  async artifacts(runId: string): Promise<Artifact[]> {
    return this.allArtifacts.filter((a) => a.runId === runId).map((a) => ({ ...a }))
  }
}

function matchesRun(r: Run, f: RunFilter): boolean {
  if (f.scenarioId && r.scenarioId !== f.scenarioId) return false
  if (f.variantId && r.variantId !== f.variantId) return false
  if (f.status && r.status !== f.status) return false
  if (f.since !== undefined && r.startedAt < f.since) return false
  if (f.until !== undefined && r.startedAt > f.until) return false
  if (f.tag && r.tags?.[f.tag.key] !== f.tag.value) return false
  if (f.parentRunId && r.parentRunId !== f.parentRunId) return false
  if (f.projectId && r.projectId !== f.projectId) return false
  if (f.chatId && r.chatId !== f.chatId) return false
  if (f.layer && r.layer !== f.layer) return false
  return true
}

function matchesSpan(s: Span, f: SpanFilter): boolean {
  if (f.runId && s.runId !== f.runId) return false
  if (f.parentSpanId && s.parentSpanId !== f.parentSpanId) return false
  if (f.kind && s.kind !== f.kind) return false
  if (f.name && s.name !== f.name) return false
  if (f.toolName && (s.kind !== 'tool' || s.toolName !== f.toolName)) return false
  if (f.judgeId && (s.kind !== 'judge' || s.judgeId !== f.judgeId)) return false
  if (f.since !== undefined && s.startedAt < f.since) return false
  if (f.until !== undefined && s.startedAt > f.until) return false
  return true
}

function matchesEvent(e: TraceEvent, f: EventFilter): boolean {
  if (f.runId && e.runId !== f.runId) return false
  if (f.spanId && e.spanId !== f.spanId) return false
  if (f.kind && e.kind !== f.kind) return false
  if (f.since !== undefined && e.timestamp < f.since) return false
  if (f.until !== undefined && e.timestamp > f.until) return false
  return true
}

// ── Filesystem (NDJSON append-only, one file per entity) ─────────────

export interface FileSystemTraceStoreOptions {
  dir: string
  /** Roll over NDJSON files when they exceed this size in bytes. Default 32 MB. */
  maxBytes?: number
}

export class FileSystemTraceStore implements TraceStore {
  private dir: string
  private maxBytes: number
  /** Lazy in-memory index for queries — populated on first read. */
  private index?: InMemoryTraceStore
  private loaded = false
  /**
   * Per-file append serialization. stat → conditional-rename → appendFile is a
   * read-modify-write on the active file; without a lock two concurrent appends
   * to the same `name` can both pass the size check (exceeding maxBytes) or one
   * can append to a file the other just renamed away. Each entry chains the
   * next append behind the prior one for that file.
   */
  private appendLocks = new Map<string, Promise<void>>()

  constructor(options: FileSystemTraceStoreOptions) {
    this.dir = options.dir
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  }

  private async ensureDir(): Promise<void> {
    const fs = await import('node:fs/promises')
    await fs.mkdir(this.dir, { recursive: true })
  }

  private async append(name: string, record: unknown): Promise<void> {
    // Chain this append behind any in-flight append for the same file. The tail
    // promise never rejects (errors are isolated to each caller's `result`), so
    // one failed append can't break the lock chain for the next one.
    const prior = this.appendLocks.get(name) ?? Promise.resolve()
    const result = prior.then(() => this.appendLocked(name, record))
    const tail = result.then(
      () => {},
      () => {},
    )
    this.appendLocks.set(name, tail)
    try {
      await result
    } finally {
      // Drop the slot once this append is the current tail, so the map doesn't
      // grow without bound across many appends to the same file.
      if (this.appendLocks.get(name) === tail) this.appendLocks.delete(name)
    }
  }

  private async appendLocked(name: string, record: unknown): Promise<void> {
    await this.ensureDir()
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const active = path.join(this.dir, `${name}.ndjson`)
    try {
      const stat = await fs.stat(active)
      if (stat.size >= this.maxBytes) {
        const rolled = path.join(this.dir, `${name}.${Date.now()}.ndjson`)
        await fs.rename(active, rolled)
      }
    } catch {
      /* file doesn't exist yet */
    }
    await fs.appendFile(active, `${JSON.stringify(record)}\n`, 'utf8')
    // Mirror genuinely-new rows into the lazy index. Update rows (marked
    // with `_update: true` by updateRun/updateSpan) are applied by those
    // methods directly via the index's update* APIs — re-inserting them
    // here triggers a duplicate-id error once the first read populates
    // the index. Await the mirror: a fire-and-forget would let an index
    // rejection go unhandled and let disk + index diverge silently.
    if (this.index && !(record as { _update?: boolean })?._update) {
      await this.insertInto(name, record)
    }
  }

  private async insertInto(name: string, record: unknown): Promise<void> {
    if (!this.index) return
    switch (name) {
      case 'runs':
        await this.index.appendRun(record as Run)
        break
      case 'spans':
        await this.index.appendSpan(record as Span)
        break
      case 'events':
        await this.index.appendEvent(record as TraceEvent)
        break
      case 'artifacts':
        await this.index.appendArtifact(record as Artifact)
        break
      case 'budget':
        await this.index.appendBudgetEntry(record as BudgetLedgerEntry)
        break
    }
  }

  private async load(): Promise<InMemoryTraceStore> {
    if (this.loaded && this.index) return this.index
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const store = new InMemoryTraceStore()
    let entries: string[]
    try {
      entries = await fs.readdir(this.dir)
    } catch {
      // No dir yet (first run / empty corpus). Anything past this point — parse
      // errors, missing patch bases — is real corruption and must fail loud.
      this.index = store
      this.loaded = true
      return store
    }
    {
      // Two-pass load. Pass 1 indexes all full (base) rows; pass 2 replays the
      // `_update` patch rows that updateRun/updateSpan append. readdir order is
      // not deterministic and rollover splits a stream across files, so a patch
      // can be read before its base. Applying patches in a separate pass — after
      // every base row is indexed — means a patch always finds its target.
      // Doing it in one pass let a patch hit the catch and append a runId-less
      // fragment, corrupting span/run counts cross-instance.
      const runUpdates: Array<Record<string, unknown>> = []
      const spanUpdates: Array<Record<string, unknown>> = []
      for (const file of entries) {
        if (!file.endsWith('.ndjson')) continue
        const full = path.join(this.dir, file)
        const content = await fs.readFile(full, 'utf8')
        const base = file.split('.')[0]
        for (const line of content.split('\n')) {
          if (!line.trim()) continue
          const record = JSON.parse(line)
          if (base === 'runs') {
            if (record?._update) {
              runUpdates.push(record)
              continue
            }
            // A duplicate full row (same dir loaded twice into one stream) is
            // collapsed last-write-wins rather than thrown.
            try {
              await store.appendRun(record)
            } catch {
              await store.updateRun(record.runId, record)
            }
          } else if (base === 'spans') {
            // `updateSpan` appends an `_update: true` patch row instead of
            // rewriting the original span. Deferred to pass 2 so it collapses
            // onto the original span — otherwise a fresh FileSystemTraceStore
            // reading the same dir reports duplicate spans (one full, one
            // fragment with no runId/kind/name), which breaks any downstream
            // consumer that re-opens the store cross-process (e.g. the OTLP
            // converter).
            if (record?._update) {
              spanUpdates.push(record)
              continue
            }
            await store.appendSpan(record)
          } else if (base === 'events') {
            await store.appendEvent(record)
          } else if (base === 'artifacts') {
            await store.appendArtifact(record)
          } else if (base === 'budget') {
            await store.appendBudgetEntry(record)
          }
        }
      }
      // Pass 2: every base row is now indexed. A patch whose base is genuinely
      // absent (truncated/partial corpus) throws inside update* — we let it
      // propagate rather than silently appending a fragment, so a corrupt
      // corpus fails loud instead of polluting counts.
      for (const record of runUpdates) {
        await store.updateRun(record.runId as string, record as Partial<Run>)
      }
      for (const record of spanUpdates) {
        await store.updateSpan(record.spanId as string, record as Partial<Span>)
      }
    }
    this.index = store
    this.loaded = true
    return store
  }

  async appendRun(run: Run): Promise<void> {
    await this.append('runs', run)
  }
  async updateRun(runId: string, patch: Partial<Run>): Promise<void> {
    // NDJSON is append-only; record updates as new rows with the same runId —
    // readers collapse by last-write-wins on load.
    await this.append('runs', { runId, ...patch, _update: true })
    if (this.index) await this.index.updateRun(runId, patch)
  }
  async appendSpan(span: Span): Promise<void> {
    await this.append('spans', span)
  }
  async updateSpan(spanId: string, patch: Partial<Span>): Promise<void> {
    await this.append('spans', { spanId, ...patch, _update: true })
    if (this.index) await this.index.updateSpan(spanId, patch)
  }
  async appendEvent(event: TraceEvent): Promise<void> {
    await this.append('events', event)
  }
  async appendArtifact(artifact: Artifact): Promise<void> {
    await this.append('artifacts', artifact)
  }
  async appendBudgetEntry(entry: BudgetLedgerEntry): Promise<void> {
    await this.append('budget', entry)
  }

  async getRun(runId: string): Promise<Run | undefined> {
    return (await this.load()).getRun(runId)
  }
  async listRuns(filter?: RunFilter): Promise<Run[]> {
    return (await this.load()).listRuns(filter)
  }
  async spans(filter?: SpanFilter): Promise<Span[]> {
    return (await this.load()).spans(filter)
  }
  async events(filter?: EventFilter): Promise<TraceEvent[]> {
    return (await this.load()).events(filter)
  }
  async budget(runId: string): Promise<BudgetLedgerEntry[]> {
    return (await this.load()).budget(runId)
  }
  async artifacts(runId: string): Promise<Artifact[]> {
    return (await this.load()).artifacts(runId)
  }
}
