/** Deployment observations join to evaluation records through their runId. */

import { z } from 'zod'

export interface DeploymentOutcome {
  runId: string
  capturedAt: number
  /** Finite numeric outcomes; absence of a key means unmeasured. */
  metrics: Record<string, number>
  labels?: Record<string, string>
  /** Source system or pipeline version. */
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
  forRun(runId: string): Promise<DeploymentOutcome[]>
  list(filter?: OutcomeFilter): Promise<DeploymentOutcome[]>
}

const outcomeSchema = z
  .object({
    runId: z.string().min(1),
    capturedAt: z.number().finite(),
    metrics: z.record(z.string(), z.number().finite()),
    labels: z.record(z.string(), z.string()).optional(),
    source: z.string().optional(),
  })
  .passthrough()

export class InMemoryOutcomeStore implements OutcomeStore {
  private items: DeploymentOutcome[] = []

  async append(outcome: DeploymentOutcome): Promise<void> {
    this.items.push(structuredClone(outcomeSchema.parse(outcome)))
  }

  async forRun(runId: string): Promise<DeploymentOutcome[]> {
    return this.list({ runIds: [runId] })
  }

  async list(filter: OutcomeFilter = {}): Promise<DeploymentOutcome[]> {
    return this.items
      .filter((outcome) => matches(outcome, filter))
      .map((outcome) => structuredClone(outcome))
  }
}

export interface FileSystemOutcomeStoreOptions {
  dir: string
  /** Rotate before a write once the active file reaches this size. Default 32 MiB. */
  maxBytes?: number
}

/** Storage failures retain operation, path, source line, and the original cause. */
export class OutcomeStoreError extends Error {
  constructor(
    public readonly operation: 'read' | 'decode' | 'write',
    public readonly path: string,
    cause: unknown,
    public readonly line?: number,
  ) {
    super(`outcome store ${operation} failed at ${path}${line === undefined ? '' : `:${line}`}`, {
      cause,
    })
    this.name = 'OutcomeStoreError'
  }
}

/** Local storage with serialized operations per instance; use one writer per directory. */
export class FileSystemOutcomeStore implements OutcomeStore {
  private readonly dir: string
  private readonly maxBytes: number
  private pending: Promise<void> = Promise.resolve()

  constructor(options: FileSystemOutcomeStoreOptions) {
    if (!options.dir.trim()) throw new Error('outcome store dir must be nonempty')
    this.dir = options.dir
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024
    if (!Number.isSafeInteger(this.maxBytes) || this.maxBytes < 1) {
      throw new Error('outcome store maxBytes must be a positive safe integer')
    }
  }

  async append(outcome: DeploymentOutcome): Promise<void> {
    const snapshot = structuredClone(outcomeSchema.parse(outcome))
    return this.serialize(async () => {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      const active = path.join(this.dir, 'outcomes.ndjson')
      try {
        await fs.mkdir(this.dir, { recursive: true })
        let size = 0
        try {
          const stat = await fs.stat(active)
          if (!stat.isFile()) throw new Error('active outcome path is not a regular file')
          size = stat.size
        } catch (error) {
          if (!isMissing(error)) throw error
        }
        if (size >= this.maxBytes) {
          const { randomUUID } = await import('node:crypto')
          await fs.rename(
            active,
            path.join(this.dir, `outcomes.${Date.now()}.${randomUUID()}.ndjson`),
          )
        }
        await fs.appendFile(active, `${JSON.stringify(snapshot)}\n`, 'utf8')
      } catch (error) {
        throw new OutcomeStoreError('write', active, error)
      }
    })
  }

  async forRun(runId: string): Promise<DeploymentOutcome[]> {
    return this.list({ runIds: [runId] })
  }

  async list(filter: OutcomeFilter = {}): Promise<DeploymentOutcome[]> {
    return this.serialize(async () => {
      const fs = await import('node:fs/promises')
      const path = await import('node:path')
      let entries: string[]
      try {
        entries = await fs.readdir(this.dir)
      } catch (error) {
        if (isMissing(error)) return []
        throw new OutcomeStoreError('read', this.dir, error)
      }
      const outcomes: DeploymentOutcome[] = []
      // Read each snapshot from disk so later observations from another instance remain visible.
      for (const file of entries.sort()) {
        if (file !== 'outcomes.ndjson' && !/^outcomes\..+\.ndjson$/.test(file)) continue
        const filePath = path.join(this.dir, file)
        let content: string
        try {
          content = await fs.readFile(filePath, 'utf8')
        } catch (error) {
          throw new OutcomeStoreError('read', filePath, error)
        }
        for (const [index, line] of content.split('\n').entries()) {
          if (!line.trim()) continue
          let outcome: DeploymentOutcome
          try {
            outcome = outcomeSchema.parse(JSON.parse(line))
          } catch (error) {
            throw new OutcomeStoreError('decode', filePath, error, index + 1)
          }
          if (matches(outcome, filter)) outcomes.push(outcome)
        }
      }
      return outcomes
    })
  }

  private serialize<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.pending.then(operation)
    // A failed operation remains rejected to its caller, but does not disable later repaired reads or writes.
    this.pending = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

function matches(outcome: DeploymentOutcome, filter: OutcomeFilter): boolean {
  if (filter.runIds && !filter.runIds.includes(outcome.runId)) return false
  if (filter.since !== undefined && outcome.capturedAt < filter.since) return false
  if (filter.until !== undefined && outcome.capturedAt > filter.until) return false
  if (filter.source && outcome.source !== filter.source) return false
  if (filter.label && outcome.labels?.[filter.label.key] !== filter.label.value) return false
  return true
}
