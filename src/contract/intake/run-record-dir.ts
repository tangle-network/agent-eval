/**
 * # `intake/run-record-dir` — load a directory or file of `RunRecord`s.
 *
 * The on-disk counterpart to the in-memory intake adapters: point it at a
 * single `.json` (array) / `.jsonl` (one record per line) file or at a
 * directory of such files, and it returns the substrate-canonical
 * `RunRecord[]` ready for `analyzeRuns({ runs })`.
 *
 * Validation is at the boundary: each parsed object goes through
 * `parseRunRecordSafe`. By default an invalid record fails loud with its
 * file + index; pass `onInvalid: 'collect'` to keep the valid records and
 * receive the rejects as structured diagnostics instead.
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { parseRunRecordSafe, type RunRecord } from '../../run-record'

/** A record that failed boundary validation, with enough context to fix it. */
export interface RunRecordRejection {
  /** Absolute or caller-relative path to the file the record came from. */
  file: string
  /** Zero-based position within the file (array index or JSONL line number). */
  index: number
  /** The validator's message. */
  reason: string
}

export interface FromRunRecordDirOptions {
  /**
   * How to treat a record that fails `parseRunRecordSafe`:
   *   - `'throw'` (default) — fail loud on the first invalid record.
   *   - `'collect'` — drop it, keep the rest, and return it under `rejected`.
   */
  onInvalid?: 'throw' | 'collect'
  /**
   * When the input is a directory, only files matching this predicate are
   * read. Default: any file ending in `.json` or `.jsonl`. The `analysis.json`
   * artifact `evalReportingSuite` writes is always skipped so a re-run never
   * ingests its own output.
   */
  include?: (fileName: string) => boolean
  /**
   * Recurse into subdirectories when the input is a directory. Default false —
   * a flat run directory is the common case and recursion can silently pull in
   * unrelated corpora.
   */
  recursive?: boolean
}

export interface FromRunRecordDirResult {
  /** Records that passed boundary validation, in file-then-index order. */
  runs: RunRecord[]
  /** Records that failed validation. Empty unless `onInvalid: 'collect'`. */
  rejected: RunRecordRejection[]
  /** The files that were read, in the order they were processed. */
  files: string[]
}

const ANALYSIS_ARTIFACT = 'analysis.json'

function defaultInclude(fileName: string): boolean {
  if (fileName === ANALYSIS_ARTIFACT) return false
  return fileName.endsWith('.json') || fileName.endsWith('.jsonl')
}

/**
 * Resolve a file or directory path into validated `RunRecord[]`.
 *
 * A `.json` file must parse to a top-level array; a `.jsonl` file is one
 * record per non-empty line. Directories are read shallowly by default
 * (set `recursive` to descend); the `analysis.json` output artifact is
 * always excluded.
 */
export async function fromRunRecordDir(
  path: string,
  options: FromRunRecordDirOptions = {},
): Promise<FromRunRecordDirResult> {
  const onInvalid = options.onInvalid ?? 'throw'
  const include = options.include ?? defaultInclude

  const stats = await stat(path)
  const filePaths = stats.isDirectory()
    ? await collectFiles(path, include, options.recursive ?? false)
    : [path]

  const runs: RunRecord[] = []
  const rejected: RunRecordRejection[] = []

  for (const file of filePaths) {
    const raw = await parseRecordFile(file)
    for (const { index, value } of raw) {
      const parsed = parseRunRecordSafe(value)
      if (parsed.ok) {
        runs.push(parsed.value)
        continue
      }
      const rejection: RunRecordRejection = { file, index, reason: parsed.error.message }
      if (onInvalid === 'throw') {
        throw new Error(
          `fromRunRecordDir: invalid RunRecord in '${file}' at index ${index}: ${parsed.error.message}`,
        )
      }
      rejected.push(rejection)
    }
  }

  return { runs, rejected, files: filePaths }
}

/** Read a single `.json` / `.jsonl` file into `{ index, value }` pairs. A
 *  malformed JSONL line throws with its line number rather than being skipped —
 *  silent line-dropping is how corpora quietly shrink. */
async function parseRecordFile(file: string): Promise<Array<{ index: number; value: unknown }>> {
  const text = await readFile(file, 'utf8')
  const trimmed = text.trim()
  if (trimmed.length === 0) return []

  if (trimmed.startsWith('[')) {
    const parsed = JSON.parse(trimmed) as unknown
    if (!Array.isArray(parsed)) {
      throw new Error(`fromRunRecordDir: file '${file}' did not parse to an array`)
    }
    return parsed.map((value, index) => ({ index, value }))
  }

  const out: Array<{ index: number; value: unknown }> = []
  const lines = trimmed.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim()
    if (line.length === 0) continue
    try {
      out.push({ index: i, value: JSON.parse(line) as unknown })
    } catch (err) {
      throw new Error(
        `fromRunRecordDir: file '${file}' line ${i + 1} is not valid JSON: ${
          err instanceof Error ? err.message : String(err)
        }`,
      )
    }
  }
  return out
}

/** Sorted file list under a directory, filtered by `include`. Sorted so the
 *  resulting `RunRecord` order — and any downstream fingerprint — is stable
 *  across filesystems. */
async function collectFiles(
  dir: string,
  include: (fileName: string) => boolean,
  recursive: boolean,
): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const files: string[] = []
  const subdirs: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (recursive) subdirs.push(join(dir, entry.name))
      continue
    }
    if (include(entry.name)) files.push(join(dir, entry.name))
  }
  files.sort()
  subdirs.sort()
  for (const sub of subdirs) {
    files.push(...(await collectFiles(sub, include, recursive)))
  }
  return files
}
