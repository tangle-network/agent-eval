import { createRequire } from 'node:module'

/**
 * @experimental
 *
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
  const { existsSync, mkdirSync, readFileSync, writeFileSync } = nodeRequire(
    'node:fs',
  ) as typeof import('node:fs')
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
  }
}
