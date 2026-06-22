/**
 * # `evalReportingSuite` — one call from runs (or a run dir) to `analysis.json`.
 *
 * A thin wrapper over the analysis primitive (`analyzeRuns`) and the on-disk
 * intake adapter (`fromRunRecordDir`). It does NOT reimplement any statistics,
 * distributions, or clustering — it resolves the input into validated
 * `RunRecord[]`, calls `analyzeRuns` with the options you'd pass it directly,
 * wraps the result in a small provenance envelope, and (optionally) writes a
 * single `analysis.json` artifact.
 *
 * ```ts
 * // From a directory of run files, write ./runs/analysis.json:
 * const suite = await evalReportingSuite('./runs', { write: true })
 * // From records already in memory, no write:
 * const suite = await evalReportingSuite(records, { analyze: { decisionThreshold: 0.03 } })
 * suite.report // the InsightReport — distributions, paired lift, findings rollup
 * ```
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RunRecord } from '../run-record'
import { type AnalyzeRunsOptions, analyzeRuns } from './analyze-runs'
import type { InsightReport } from './insight-report'
import {
  type FromRunRecordDirOptions,
  type FromRunRecordDirResult,
  fromRunRecordDir,
} from './intake/run-record-dir'

/** Either records in hand or a path to a `.json` / `.jsonl` file or a
 *  directory of them. */
export type EvalReportingSuiteInput = RunRecord[] | string

export interface EvalReportingSuiteOptions {
  /** Forwarded verbatim to `analyzeRuns` (everything except `runs`, which the
   *  suite supplies from the resolved input). Use this for split selection,
   *  baseline/candidate ids, canaries, prior-period runs, the analyst registry,
   *  etc. */
  analyze?: Omit<AnalyzeRunsOptions, 'runs'>
  /** Loader options used only when the input is a path. */
  load?: FromRunRecordDirOptions
  /**
   * Write the suite result as a single `analysis.json`.
   *   - `true` — write to `<dir>/analysis.json` when the input is a directory,
   *     or alongside the input file; throws if the input is in-memory records
   *     (no directory to anchor to — pass an explicit path instead).
   *   - a string — write to exactly this path (a directory path gets
   *     `analysis.json` appended; any other path is used verbatim).
   *   - omitted / false — do not write.
   */
  write?: boolean | string
}

/** The suite artifact — the `analyzeRuns` report plus provenance. This is the
 *  exact shape serialized to `analysis.json`. */
export interface EvalReportingSuiteResult {
  /** The analysis itself — distributions, paired stats/lift, failure rollup,
   *  recommendations. Produced by `analyzeRuns`. */
  report: InsightReport
  /** How the suite was run, so a reader can verify provenance. */
  provenance: {
    /** ISO timestamp the suite ran. */
    generatedAt: string
    /** Number of records analyzed (mirrors `report.n`). */
    runCount: number
    /** The source path when the input was a directory/file; null for
     *  in-memory records. */
    sourcePath: string | null
    /** Files read when loading from disk; empty for in-memory input. */
    files: string[]
    /** Records dropped at the validation boundary. Always empty unless
     *  `load.onInvalid` was set to `'collect'`. */
    rejected: FromRunRecordDirResult['rejected']
  }
  /** The path `analysis.json` was written to, or null when `write` was unset. */
  writtenTo: string | null
}

const ANALYSIS_ARTIFACT = 'analysis.json'

/**
 * Resolve runs (or a run dir/file), run `analyzeRuns`, and optionally persist a
 * single `analysis.json`. The only analysis logic lives in `analyzeRuns`; this
 * function is composition + I/O.
 */
export async function evalReportingSuite(
  input: EvalReportingSuiteInput,
  options: EvalReportingSuiteOptions = {},
): Promise<EvalReportingSuiteResult> {
  const fromPath = typeof input === 'string'

  let runs: RunRecord[]
  let files: string[] = []
  let rejected: FromRunRecordDirResult['rejected'] = []
  if (fromPath) {
    const loaded = await fromRunRecordDir(input, options.load)
    runs = loaded.runs
    files = loaded.files
    rejected = loaded.rejected
  } else {
    runs = input
  }

  if (runs.length === 0) {
    throw new Error(
      fromPath
        ? `evalReportingSuite: no RunRecords found at '${input}'`
        : 'evalReportingSuite: no RunRecords to analyze',
    )
  }

  const report = await analyzeRuns({ ...options.analyze, runs })

  const result: EvalReportingSuiteResult = {
    report,
    provenance: {
      generatedAt: new Date().toISOString(),
      runCount: runs.length,
      sourcePath: fromPath ? input : null,
      files,
      rejected,
    },
    writtenTo: null,
  }

  const target = resolveWriteTarget(options.write, fromPath ? input : null)
  if (target) {
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, `${JSON.stringify(result, null, 2)}\n`, 'utf8')
    result.writtenTo = target
  }

  return result
}

/** Resolve where (if anywhere) to write `analysis.json`. Returns null when
 *  writing is disabled. Throws on `write: true` with in-memory input — there is
 *  no directory to anchor the artifact to, and silently inventing `cwd` would
 *  scatter files. */
function resolveWriteTarget(
  write: EvalReportingSuiteOptions['write'],
  sourcePath: string | null,
): string | null {
  if (!write) return null

  if (typeof write === 'string') {
    const looksLikeDir =
      write.endsWith('/') || (!write.endsWith('.json') && !write.endsWith('.jsonl'))
    return looksLikeDir ? join(write, ANALYSIS_ARTIFACT) : write
  }

  // write === true
  if (sourcePath === null) {
    throw new Error(
      'evalReportingSuite: write:true needs a source path to anchor analysis.json — pass an explicit output path when analyzing in-memory records',
    )
  }
  const isFile = sourcePath.endsWith('.json') || sourcePath.endsWith('.jsonl')
  return isFile ? join(dirname(sourcePath), ANALYSIS_ARTIFACT) : join(sourcePath, ANALYSIS_ARTIFACT)
}
