import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { CostLedger } from '../cost-ledger'

/**
 * `CampaignStorage` — the filesystem seam `runCampaign` writes through
 * (run/cell dirs, the resumability cache, per-cell artifacts, trace spans).
 *
 * The default (`fsCampaignStorage`) is the Node filesystem — identical
 * behavior to the inline `node:fs` calls it replaces, so existing CLI
 * consumers are unaffected. `inMemoryCampaignStorage` keeps everything in a
 * `Map`, so the substrate runs in environments WITHOUT a filesystem
 * (Cloudflare Workers, Deno Deploy, other edge runtimes) — the campaign
 * still produces its `CampaignResult` (cells + aggregates) in memory;
 * artifacts/traces simply aren't persisted to disk.
 *
 * Paths are opaque keys to the in-memory adapter — it does not parse them,
 * so the same `join(...)`-built paths work unchanged across both adapters.
 */
export interface CampaignStorage {
  /** Ensure a directory exists (recursive). No-op for in-memory. */
  ensureDir(dir: string): void
  /** Does this path exist (as a written file or an ensured dir)? */
  exists(path: string): boolean
  /** Read a UTF-8 file; `undefined` when missing or unreadable. */
  read(path: string): string | undefined
  /** Write a file (string or bytes). Parent dir is assumed ensured. */
  write(path: string, content: string | Uint8Array): void
  /** Append only when the current UTF-8 byte length matches `expectedBytes`.
   * Returns the new length, or undefined when another writer won. */
  append?(path: string, content: string, expectedBytes: number): number | undefined
}

/** Node-filesystem storage — the default. Lazily requires `node:fs` so the
 *  module imports cleanly in non-Node runtimes (where the caller passes
 *  `inMemoryCampaignStorage` instead and never constructs this).
 *
 *  `createRequire(import.meta.url)` is the ESM-native lazy require — a bare
 *  `require` is a ReferenceError under `"type": "module"`, which is exactly
 *  the shape this package publishes. */
export function fsCampaignStorage(): CampaignStorage {
  const nodeRequire = createRequire(import.meta.url)
  const {
    closeSync,
    existsSync,
    fsyncSync,
    mkdirSync,
    openSync,
    readFileSync,
    statSync,
    writeFileSync,
  } = nodeRequire('node:fs') as typeof import('node:fs')
  const lockfile = nodeRequire('proper-lockfile') as typeof import('proper-lockfile')
  return {
    ensureDir(dir) {
      if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
    },
    exists(path) {
      return existsSync(path)
    },
    read(path) {
      try {
        return readFileSync(path, 'utf8')
      } catch {
        return undefined
      }
    },
    write(path, content) {
      writeFileSync(path, content as Uint8Array)
    },
    append(path, content, expectedBytes) {
      let release: (() => void) | undefined
      try {
        release = lockfile.lockSync(path, {
          realpath: false,
          retries: 0,
          stale: 10_000,
        })
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ELOCKED') return undefined
        throw error
      }
      try {
        let actualBytes = 0
        try {
          actualBytes = statSync(path).size
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        }
        if (actualBytes !== expectedBytes) return undefined
        const fd = openSync(path, 'a')
        try {
          writeFileSync(fd, content)
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        const directoryFd = openSync(dirname(path), 'r')
        try {
          fsyncSync(directoryFd)
        } finally {
          closeSync(directoryFd)
        }
        return expectedBytes + Buffer.byteLength(content)
      } finally {
        release?.()
      }
    },
  }
}

/** In-memory storage for filesystem-less runtimes. Artifacts + trace spans
 *  live in a `Map` for the duration of the run; the `CampaignResult` is
 *  fully populated, but nothing is persisted to disk. */
export function inMemoryCampaignStorage(): CampaignStorage {
  const files = new Map<string, string | Uint8Array>()
  const dirs = new Set<string>()
  return {
    ensureDir(dir) {
      dirs.add(dir)
    },
    exists(path) {
      return files.has(path) || dirs.has(path)
    },
    read(path) {
      const value = files.get(path)
      if (value === undefined) return undefined
      return typeof value === 'string' ? value : new TextDecoder().decode(value)
    },
    write(path, content) {
      files.set(path, content)
    },
    append(path, content, expectedBytes) {
      const current = files.get(path)
      const currentText =
        current === undefined
          ? ''
          : typeof current === 'string'
            ? current
            : new TextDecoder().decode(current)
      const currentBytes = new TextEncoder().encode(currentText).byteLength
      if (currentBytes !== expectedBytes) return undefined
      files.set(path, `${currentText}${content}`)
      return currentBytes + new TextEncoder().encode(content).byteLength
    },
  }
}

/** Open the durable spend account stored beside a logical run. */
export function createRunCostLedger(input: {
  storage: CampaignStorage
  runDir: string
  costCeilingUsd?: number
}): CostLedger {
  const path = join(input.runDir, 'cost-ledger.jsonl')
  input.storage.ensureDir(input.runDir)
  return new CostLedger({
    costCeilingUsd: input.costCeilingUsd,
    persistence: {
      read: () => {
        const stored = input.storage.read(path)
        if (stored === undefined && input.storage.exists(path)) {
          throw new Error(`CostLedger: cannot read existing event log '${path}'`)
        }
        const events = stored ?? ''
        return {
          revision: String(new TextEncoder().encode(events).byteLength),
          events,
        }
      },
      append: (expectedRevision, event) => {
        const expectedBytes = Number(expectedRevision)
        if (!Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
          throw new Error(`CostLedger: invalid storage revision '${expectedRevision}'`)
        }
        if (!input.storage.append) {
          throw new Error('CostLedger: CampaignStorage.append is required for paid calls')
        }
        const next = input.storage.append(path, event, expectedBytes)
        return next === undefined ? undefined : String(next)
      },
    },
  })
}
