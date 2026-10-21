/**
 * EvalTraceStore — JSONL save / query / compare over the analysis-time
 * `RunRecord` row.
 *
 * `FileSystemTraceStore` (in `./trace/store`) persists the rich TraceSchema-v1
 * span corpus — runs, spans, events, artifacts — the runtime emits live. That
 * is NOT the thing three consumers hand-roll in `tests/eval/lib/trace-store.ts`.
 * What they hand-roll is the *analysis* layer: append each finished run as one
 * JSONL line keyed by scenario/candidate, then query it ("every run where score
 * < 50"), pick the best run for a scenario (few-shot seeding), and compare two
 * candidates on matched scenarios.
 *
 * The substrate already has the canonical analysis-time row — `RunRecord` — so
 * this is that query/compare API expressed over `RunRecord[]`, with a
 * JSONL-backed store. It does NOT fork `FileSystemTraceStore`; it sits beside it
 * for the analysis projection.
 */

import { ValidationError } from './errors'

import { isRunRecord, type RunRecord, validateRunRecord } from './run-record'









/**
 * Backing persistence for `EvalTraceStore`. The in-memory store is the default;
 * the JSONL file store appends one validated `RunRecord` per line. Both keep an
 * append order so `getBest` / `compareRuns` are reproducible.
 */
export interface RunRecordBackend {
  append(record: RunRecord): Promise<void>
  load(): Promise<RunRecord[]>
}



/**
 * JSONL-backed store at `path`, one `RunRecord` per line. Malformed lines fail
 * loud on load (a corrupt corpus must not silently shrink the analysis set);
 * pass `skipInvalid` only for forensics on a known-bad file.
 */
export function jsonlRunRecordBackend(
  path: string,
  opts: { skipInvalid?: boolean } = {},
): RunRecordBackend {
  return {
    async append(record) {
      const fs = await import('node:fs/promises')
      const pathMod = await import('node:path')
      await fs.mkdir(pathMod.dirname(path), { recursive: true })
      await fs.appendFile(path, `${JSON.stringify(record)}\n`, 'utf8')
    },
    async load() {
      const fs = await import('node:fs/promises')
      let raw: string
      try {
        raw = await fs.readFile(path, 'utf8')
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return []
        throw err
      }
      const out: RunRecord[] = []
      let lineNo = 0
      for (const line of raw.split('\n')) {
        lineNo++
        if (!line.trim()) continue
        let parsed: unknown
        try {
          parsed = JSON.parse(line)
        } catch (err) {
          if (opts.skipInvalid) continue
          throw new ValidationError(`EvalTraceStore: ${path}:${lineNo} is not valid JSON`)
        }
        if (opts.skipInvalid) {
          if (isRunRecord(parsed)) out.push(parsed)
          continue
        }
        try {
          out.push(validateRunRecord(parsed))
        } catch (err) {
          throw new ValidationError(
            `EvalTraceStore: ${path}:${lineNo} is not a valid RunRecord — ${(err as Error).message}`,
          )
        }
      }
      return out
    },
  }
}


