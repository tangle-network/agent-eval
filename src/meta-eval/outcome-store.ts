/**
 * OutcomeStore — deployment outcomes attached to Run IDs.
 *
 * Outcomes arrive asynchronously from production telemetry after the
 * eval run completed: user ratings, retention flags, conversion events,
 * revenue, support-ticket rate, anything a product team can measure.
 * The store is a peer to TraceStore — separate lifecycle, same runId
 * foreign key.
 *
 * The whole point of this module is to make the meta-eval correlation
 * question computable: `correlate(evalMetric, outcomeMetric) → r, ρ, n, CI`.
 */

export interface DeploymentOutcome {
  runId: string
  capturedAt: number
  /** Numeric outcomes keyed by name — retention_7d, csat, revenue_usd, etc. */
  metrics: Record<string, number>
  /** Dimensions for stratified analysis — cohort, region, user_segment. */
  labels?: Record<string, string>
  /** Free-form provenance (source system, pipeline version). */
  source?: string
}

export interface OutcomeFilter {
  runIds?: string[]
  since?: number
  until?: number
  label?: { key: string; value: string }
  source?: string
}

export interface OutcomeStore {
  append(outcome: DeploymentOutcome): Promise<void>
  /** All outcomes attached to this run (a single run can have many — multiple
   *  capture windows over deployment time). */
  forRun(runId: string): Promise<DeploymentOutcome[]>
  list(filter?: OutcomeFilter): Promise<DeploymentOutcome[]>
}

export class InMemoryOutcomeStore implements OutcomeStore {
  private items: DeploymentOutcome[] = []

  async append(outcome: DeploymentOutcome): Promise<void> {
    this.items.push({ ...outcome })
  }

  async forRun(runId: string): Promise<DeploymentOutcome[]> {
    return this.items.filter((o) => o.runId === runId).map((o) => ({ ...o }))
  }

  async list(filter: OutcomeFilter = {}): Promise<DeploymentOutcome[]> {
    return this.items.filter((o) => matches(o, filter)).map((o) => ({ ...o }))
  }
}

export interface FileSystemOutcomeStoreOptions {
  dir: string
  maxBytes?: number
}

export class FileSystemOutcomeStore implements OutcomeStore {
  private dir: string
  private maxBytes: number
  private memo?: InMemoryOutcomeStore
  private loaded = false

  constructor(options: FileSystemOutcomeStoreOptions) {
    this.dir = options.dir
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  }

  private async ensureDir(): Promise<void> {
    const fs = await import('node:fs/promises')
    await fs.mkdir(this.dir, { recursive: true })
  }

  async append(outcome: DeploymentOutcome): Promise<void> {
    await this.ensureDir()
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const active = path.join(this.dir, 'outcomes.ndjson')
    try {
      const stat = await fs.stat(active)
      if (stat.size >= this.maxBytes) {
        await fs.rename(active, path.join(this.dir, `outcomes.${Date.now()}.ndjson`))
      }
    } catch { /* first write */ }
    await fs.appendFile(active, JSON.stringify(outcome) + '\n', 'utf8')
    if (this.memo) await this.memo.append(outcome)
  }

  private async load(): Promise<InMemoryOutcomeStore> {
    if (this.loaded && this.memo) return this.memo
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const memo = new InMemoryOutcomeStore()
    try {
      const entries = await fs.readdir(this.dir)
      for (const file of entries) {
        if (!file.endsWith('.ndjson')) continue
        const content = await fs.readFile(path.join(this.dir, file), 'utf8')
        for (const line of content.split('\n')) {
          if (!line.trim()) continue
          await memo.append(JSON.parse(line))
        }
      }
    } catch { /* empty */ }
    this.memo = memo
    this.loaded = true
    return memo
  }

  async forRun(runId: string): Promise<DeploymentOutcome[]> {
    return (await this.load()).forRun(runId)
  }

  async list(filter?: OutcomeFilter): Promise<DeploymentOutcome[]> {
    return (await this.load()).list(filter)
  }
}

function matches(o: DeploymentOutcome, f: OutcomeFilter): boolean {
  if (f.runIds && !f.runIds.includes(o.runId)) return false
  if (f.since !== undefined && o.capturedAt < f.since) return false
  if (f.until !== undefined && o.capturedAt > f.until) return false
  if (f.source && o.source !== f.source) return false
  if (f.label && o.labels?.[f.label.key] !== f.label.value) return false
  return true
}
