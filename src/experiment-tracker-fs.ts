/**
 * FileSystemExperimentStore — NDJSON-backed `ExperimentStore` for local + CI.
 *
 * Mirrors the file layout of `FileSystemTraceStore`: two append-only NDJSON
 * files (`experiments.ndjson` + `runs.ndjson`) under one directory, with size-
 * based rollover. Writes are append-only so the file log doubles as an audit
 * trail of every state transition the tracker ever wrote.
 *
 * Reads lazy-load every NDJSON file in the directory (including rolled-over
 * archives), latest-write-wins per `id`. Subsequent writes update the
 * in-memory index in place so reads after writes are O(1).
 *
 * Node-only — imports `node:fs/promises`. Don't import this from a Worker;
 * use the in-memory store or the D1 store from `./experiment-tracker-d1`.
 */

import {
  type Experiment,
  type ExperimentStore,
  InMemoryExperimentStore,
  type Run,
} from './experiment-tracker'

export interface FileSystemExperimentStoreOptions {
  /** Directory the NDJSON files live in. Created on first write. */
  dir: string
  /** Bytes after which a file is rolled over. Default 32 MB (matches FileSystemTraceStore). */
  maxBytes?: number
}

export class FileSystemExperimentStore implements ExperimentStore {
  private readonly dir: string
  private readonly maxBytes: number
  private index?: InMemoryExperimentStore
  private loaded = false

  constructor(options: FileSystemExperimentStoreOptions) {
    this.dir = options.dir
    this.maxBytes = options.maxBytes ?? 32 * 1024 * 1024
  }

  async saveExperiment(exp: Experiment): Promise<void> {
    const idx = await this.load()
    await idx.saveExperiment(exp)
    await this.append('experiments', exp)
  }

  async getExperiment(id: string): Promise<Experiment | null> {
    const idx = await this.load()
    return idx.getExperiment(id)
  }

  async listExperiments(): Promise<Experiment[]> {
    const idx = await this.load()
    return idx.listExperiments()
  }

  async saveRun(run: Run): Promise<void> {
    const idx = await this.load()
    await idx.saveRun(run)
    await this.append('runs', run)
  }

  async getRun(id: string): Promise<Run | null> {
    const idx = await this.load()
    return idx.getRun(id)
  }

  async listRuns(experimentId: string): Promise<Run[]> {
    const idx = await this.load()
    return idx.listRuns(experimentId)
  }

  private async ensureDir(): Promise<void> {
    const fs = await import('node:fs/promises')
    await fs.mkdir(this.dir, { recursive: true })
  }

  private async append(name: 'experiments' | 'runs', record: unknown): Promise<void> {
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
  }

  private async load(): Promise<InMemoryExperimentStore> {
    if (this.loaded && this.index) return this.index
    const fs = await import('node:fs/promises')
    const path = await import('node:path')
    const store = new InMemoryExperimentStore()
    try {
      const entries = await fs.readdir(this.dir)
      // Sort so older rollover files load first; the active *.ndjson wins on
      // duplicate ids because saves replay in insertion order and the in-memory
      // store is last-write-wins.
      const sorted = entries.filter((f) => f.endsWith('.ndjson')).sort((a, b) => a.localeCompare(b))
      for (const file of sorted) {
        const full = path.join(this.dir, file)
        const content = await fs.readFile(full, 'utf8')
        const base = file.split('.')[0]
        for (const line of content.split('\n')) {
          if (!line.trim()) continue
          let record: unknown
          try {
            record = JSON.parse(line)
          } catch {
            // Truncated tail line during a crash; skip.
            continue
          }
          if (base === 'experiments') {
            await store.saveExperiment(record as Experiment)
          } else if (base === 'runs') {
            await store.saveRun(record as Run)
          }
        }
      }
    } catch {
      /* empty dir, first run */
    }
    this.index = store
    this.loaded = true
    return store
  }
}
