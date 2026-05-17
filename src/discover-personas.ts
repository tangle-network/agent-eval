/**
 * Walk a personas directory and return every file matching the convention
 * `NN-slug.{yaml,yml,json,md}`. Sorted by filename so the numeric prefix
 * gives stable persona ordering for reproducibility. Consumers filter
 * through `include` / `exclude`.
 */

import { promises as fs } from 'node:fs'
import { basename, extname, join } from 'node:path'

export interface DiscoverPersonasOptions {
  /**
   * Regex applied to filenames. Files that don't match are skipped.
   * Default: `^[0-9]{2}-.+\.(yaml|yml|json|md)$`.
   */
  pattern?: RegExp
  /**
   * Filenames (or basenames) to skip. Use this to exclude WIP / archived
   * personas without removing the file.
   */
  exclude?: readonly string[]
  /**
   * If set, return only personas whose basename contains one of these
   * substrings (post-pattern filter).
   */
  include?: readonly string[]
  /** Recurse into subdirectories. Default false. */
  recursive?: boolean
}

export interface DiscoveredPersona {
  /** Absolute file path. */
  path: string
  /** Filename without directory. */
  filename: string
  /** Filename without extension — the conventional persona id. */
  id: string
}

const DEFAULT_PATTERN = /^\d{2}-.+\.(yaml|yml|json|md)$/

export async function discoverPersonas(
  dir: string,
  opts: DiscoverPersonasOptions = {},
): Promise<DiscoveredPersona[]> {
  const pattern = opts.pattern ?? DEFAULT_PATTERN
  const exclude = new Set(opts.exclude ?? [])
  const include = opts.include

  async function walk(d: string): Promise<DiscoveredPersona[]> {
    let entries: Array<{ name: string; isDir: boolean }>
    try {
      const raw = await fs.readdir(d, { withFileTypes: true })
      entries = raw.map((e) => ({ name: e.name, isDir: e.isDirectory() }))
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'ENOENT') return []
      throw err
    }
    const out: DiscoveredPersona[] = []
    for (const entry of entries) {
      const full = join(d, entry.name)
      if (entry.isDir) {
        if (opts.recursive) out.push(...(await walk(full)))
        continue
      }
      if (!pattern.test(entry.name)) continue
      if (exclude.has(entry.name) || exclude.has(basename(entry.name, extname(entry.name))))
        continue
      if (include && include.length > 0) {
        const id = basename(entry.name, extname(entry.name))
        const matched = include.some((needle) => entry.name.includes(needle) || id.includes(needle))
        if (!matched) continue
      }
      out.push({
        path: full,
        filename: entry.name,
        id: basename(entry.name, extname(entry.name)),
      })
    }
    return out
  }

  const results = await walk(dir)
  results.sort((a, b) => a.filename.localeCompare(b.filename))
  return results
}
