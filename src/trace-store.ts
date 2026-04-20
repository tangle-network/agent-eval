/**
 * LLM trace store — one record per model call.
 *
 * Sink for the full eval data-plane: what got sent, what came back, what it
 * cost, how long it took. Replayable, queryable, diff-able.
 *
 * Two built-in stores:
 *   - `MemoryTraceStore` — fast, ephemeral, useful in tests and short runs
 *   - `FileSystemTraceStore` — NDJSON files per-run, grepable, committable
 *
 * Consumers plug in custom stores for Langfuse / OTEL / D1 / Postgres.
 */

export interface LlmTrace {
  id: string
  runId: string
  scenarioId?: string
  turnIndex?: number
  role: 'driver' | 'judge' | 'product' | 'optimizer' | string
  model: string
  prompt: string
  output: string
  inputTokens?: number
  outputTokens?: number
  costUsd?: number
  durationMs?: number
  timestamp: string
  metadata?: Record<string, unknown>
}

export interface TraceQuery {
  runId?: string
  scenarioId?: string
  role?: string
  model?: string
  sinceMs?: number
  limit?: number
}

export interface TraceStore {
  record(trace: LlmTrace): Promise<void>
  query(query: TraceQuery): Promise<LlmTrace[]>
  count(query?: TraceQuery): Promise<number>
}

// ---------------------------------------------------------------------------
// In-memory implementation — O(1) record, O(n) query
// ---------------------------------------------------------------------------

export class MemoryTraceStore implements TraceStore {
  private traces: LlmTrace[] = []

  async record(trace: LlmTrace): Promise<void> {
    this.traces.push(trace)
  }

  async query(query: TraceQuery): Promise<LlmTrace[]> {
    let result = this.filter(query)
    if (query.limit !== undefined) result = result.slice(0, query.limit)
    return result
  }

  async count(query?: TraceQuery): Promise<number> {
    return query ? this.filter(query).length : this.traces.length
  }

  /** Clear the store — test helper. */
  reset(): void {
    this.traces = []
  }

  private filter(query: TraceQuery): LlmTrace[] {
    return this.traces.filter((t) => {
      if (query.runId && t.runId !== query.runId) return false
      if (query.scenarioId && t.scenarioId !== query.scenarioId) return false
      if (query.role && t.role !== query.role) return false
      if (query.model && t.model !== query.model) return false
      if (query.sinceMs !== undefined) {
        const ts = Date.parse(t.timestamp)
        if (Number.isFinite(ts) && ts < query.sinceMs) return false
      }
      return true
    })
  }
}

// ---------------------------------------------------------------------------
// NDJSON filesystem implementation — append-only, grepable
// ---------------------------------------------------------------------------

export interface FileSystemTraceStoreOptions {
  dir: string
  /** Max file size before rolling to a new segment (default 32 MB). */
  rolloverBytes?: number
  /** Function to write the file — defaults to node:fs/promises.appendFile */
  append?: (path: string, data: string) => Promise<void>
  read?: (path: string) => Promise<string>
  list?: (dir: string) => Promise<string[]>
  stat?: (path: string) => Promise<{ size: number }>
  mkdir?: (dir: string) => Promise<void>
}

export class FileSystemTraceStore implements TraceStore {
  private readonly opts: Required<FileSystemTraceStoreOptions>

  constructor(opts: FileSystemTraceStoreOptions) {
    this.opts = {
      rolloverBytes: 32 * 1024 * 1024,
      append: defaultAppend,
      read: defaultRead,
      list: defaultList,
      stat: defaultStat,
      mkdir: defaultMkdir,
      ...opts,
    }
  }

  async record(trace: LlmTrace): Promise<void> {
    const file = await this.currentSegment()
    await this.opts.append(file, JSON.stringify(trace) + '\n')
  }

  async query(query: TraceQuery): Promise<LlmTrace[]> {
    const files = await this.segments()
    const out: LlmTrace[] = []
    for (const file of files) {
      const contents = await this.opts.read(file).catch(() => '')
      for (const line of contents.split('\n')) {
        if (!line) continue
        try {
          const t = JSON.parse(line) as LlmTrace
          if (!matches(t, query)) continue
          out.push(t)
          if (query.limit !== undefined && out.length >= query.limit) return out
        } catch {
          // skip malformed line
        }
      }
    }
    return out
  }

  async count(query?: TraceQuery): Promise<number> {
    if (!query) {
      // Fast path: sum line counts across segments
      const files = await this.segments()
      let total = 0
      for (const file of files) {
        const contents = await this.opts.read(file).catch(() => '')
        total += contents.split('\n').filter(Boolean).length
      }
      return total
    }
    return (await this.query(query)).length
  }

  private async segments(): Promise<string[]> {
    try {
      const all = await this.opts.list(this.opts.dir)
      return all.filter((f) => f.endsWith('.ndjson')).sort()
    } catch {
      return []
    }
  }

  private async currentSegment(): Promise<string> {
    await this.opts.mkdir(this.opts.dir)
    const existing = await this.segments()
    if (existing.length === 0) return pathJoin(this.opts.dir, `traces-000.ndjson`)
    const latest = existing[existing.length - 1]
    try {
      const s = await this.opts.stat(latest)
      if (s.size < this.opts.rolloverBytes) return latest
    } catch {
      return latest
    }
    const n = existing.length
    return pathJoin(this.opts.dir, `traces-${String(n).padStart(3, '0')}.ndjson`)
  }
}

function matches(t: LlmTrace, query: TraceQuery): boolean {
  if (query.runId && t.runId !== query.runId) return false
  if (query.scenarioId && t.scenarioId !== query.scenarioId) return false
  if (query.role && t.role !== query.role) return false
  if (query.model && t.model !== query.model) return false
  if (query.sinceMs !== undefined) {
    const ts = Date.parse(t.timestamp)
    if (Number.isFinite(ts) && ts < query.sinceMs) return false
  }
  return true
}

function pathJoin(dir: string, file: string): string {
  return dir.endsWith('/') ? `${dir}${file}` : `${dir}/${file}`
}

// Default fs shim — dynamic import so the package stays importable in Workers
async function defaultAppend(path: string, data: string): Promise<void> {
  const fs = await import('node:fs/promises')
  await fs.appendFile(path, data)
}
async function defaultRead(path: string): Promise<string> {
  const fs = await import('node:fs/promises')
  return fs.readFile(path, 'utf8')
}
async function defaultList(dir: string): Promise<string[]> {
  const fs = await import('node:fs/promises')
  const p = await import('node:path')
  try {
    const entries = await fs.readdir(dir)
    return entries.map((e) => p.join(dir, e))
  } catch {
    return []
  }
}
async function defaultStat(path: string): Promise<{ size: number }> {
  const fs = await import('node:fs/promises')
  const s = await fs.stat(path)
  return { size: s.size }
}
async function defaultMkdir(dir: string): Promise<void> {
  const fs = await import('node:fs/promises')
  await fs.mkdir(dir, { recursive: true })
}
