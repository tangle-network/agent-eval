/**
 * Persona discovery — replaces every consumer's hardcoded TRAINING_PERSONA_FILES.
 *
 * Today's failure mode: each product agent (legal/gtm/tax/creative) defines
 * a TRAINING_PERSONA_FILES const with 5 hardcoded filenames. When the 2yr
 * rewrite added 10+ new personas, those personas existed on disk but the
 * evolve runner never loaded them — the new rubric dims (audit_defendability,
 * intake_discipline, etc) got no training signal. The personas were
 * cosmetic, the rewrites partially uninformed.
 *
 * `discoverPersonas` walks a personas directory and returns every persona
 * file matching the convention. Consumers can filter by include/exclude
 * patterns. Default behavior — discover everything — eliminates the
 * "forgot to add the new persona to the list" failure mode.
 */

import { promises as fs } from 'node:fs'
import { join, basename, extname } from 'node:path'

export interface DiscoverPersonasOptions {
  /**
   * Regex applied to filenames. Files that don't match are skipped.
   * Default: `^[0-9]{2}-.+\.(yaml|yml|json|md)$` (the prevailing convention
   * across legal/gtm/tax/creative: `NN-slug.yaml`).
   */
  pattern?: RegExp
  /**
   * Filenames (or basenames) to skip. Use this to exclude WIP / archived
   * personas without removing the file.
   */
  exclude?: readonly string[]
  /**
   * If set, return only personas whose basename contains one of these
   * substrings (post-pattern filter). Used by the CLI's `--personas a,b,c`
   * flag — consumers pass through.
   */
  include?: readonly string[]
  /**
   * Recurse into subdirectories. Default false (legal/gtm/tax/creative all
   * store personas flat).
   */
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

/**
 * Walk `dir` and return every persona file matching the convention. Async
 * because the consumer almost always wants this to be I/O-driven (so a new
 * persona added on disk is picked up without a code change).
 *
 * Sorted by filename (which gives stable persona id order via the `NN-`
 * numeric prefix convention) for reproducibility.
 */
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
      if (exclude.has(entry.name) || exclude.has(basename(entry.name, extname(entry.name)))) continue
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
