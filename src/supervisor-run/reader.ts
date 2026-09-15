/**
 * Runtime supervisor-run reader and report writers.
 *
 * Runtime's file-backed supervision context is the only live on-disk contract.
 * Other stores implement `SupervisorRunReader` and feed the same pure analyzer;
 * this module owns path discovery and report output for Runtime runs.
 */

import { appendFile, mkdir, readdir, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { analyzeSupervisorRunSources, rollupSupervisorRuns } from './analyze'
import {
  renderSupervisorRollupMarkdown,
  renderSupervisorRunHeadline,
  renderSupervisorRunMarkdown,
} from './render'
import { isRuntimeSupervisorRunDir, readRuntimeSupervisorRun } from './runtime-reader'
import type {
  SupervisorRunReader,
  SupervisorRunReport,
  SupervisorRunRollup,
  SupervisorRunSources,
} from './types'

/**
 * Analyze a supervisor run. Accepts a Runtime run directory, any
 * `SupervisorRunReader`, or already-read source bytes — so a
 * caller with its own store never has to touch the filesystem layout.
 */
export async function analyzeSupervisorRun(
  input: string | SupervisorRunReader | SupervisorRunSources,
): Promise<SupervisorRunReport> {
  if (typeof input === 'string') {
    return analyzeSupervisorRunSources(await readRuntimeSupervisorRun(input))
  }
  if (isReader(input)) return analyzeSupervisorRunSources(await input.read())
  return analyzeSupervisorRunSources(input)
}

function isReader(input: SupervisorRunReader | SupervisorRunSources): input is SupervisorRunReader {
  return typeof (input as SupervisorRunReader).read === 'function'
}

export interface WriteSupervisorRunOptions {
  /** Append the headline block here (the experiment's run log). */
  readonly appendHeadlineTo?: string
  /** Also console.log the headline (default true). */
  readonly echo?: boolean
  /**
   * Write `run-report.{json,md}` here instead of into the run dir. Set when
   * reporting over a run directory that must stay READ-ONLY (a live run, an
   * archived generation).
   */
  readonly reportDir?: string
}

/**
 * Read a completed run, write `run-report.json` + `run-report.md` beside its
 * artifacts, and append the headline block to the run log. Never throws on a
 * missing artifact — a run that produced nothing still yields a report whose
 * every metric says why.
 */
export async function writeSupervisorRunReport(
  runDir: string,
  opts: WriteSupervisorRunOptions = {},
): Promise<SupervisorRunReport> {
  const sources = await readRuntimeSupervisorRun(runDir)
  const report = analyzeSupervisorRunSources(sources)
  const md = renderSupervisorRunMarkdown(report)
  const dest = opts.reportDir ?? runDir
  const stem = opts.reportDir === undefined ? 'run-report' : supervisorReportStem(runDir)
  if (opts.reportDir !== undefined) await mkdir(opts.reportDir, { recursive: true }).catch(() => {})
  await writeFile(join(dest, `${stem}.json`), JSON.stringify(report, null, 1)).catch(() => {})
  await writeFile(join(dest, `${stem}.md`), md).catch(() => {})
  const headline = renderSupervisorRunHeadline(report)
  if (opts.appendHeadlineTo !== undefined) {
    await appendFile(opts.appendHeadlineTo, `${headline}\n`).catch(() => {})
  }
  if (opts.echo !== false) console.log(headline)
  return report
}

/**
 * File stem for out-of-tree reports. Built from the run path's identifying
 * segments — candidate tag (the segment under `arm-runs/`), rep, instance, arm
 * — so two runs of the same instance from different candidates/reps never
 * overwrite each other.
 */
function supervisorReportStem(runDir: string): string {
  const parts = runDir.split('/').filter(Boolean)
  const arm = parts[parts.length - 1] ?? 'cell'
  const iid = parts[parts.length - 2] ?? 'instance'
  const rep = parts.find((p) => /^rep-\d+$/.test(p))
  const armRunsIdx = parts.indexOf('arm-runs')
  const tag = armRunsIdx >= 0 ? parts[armRunsIdx + 1] : undefined
  return [tag, rep, iid, arm]
    .filter((s): s is string => s !== undefined && s !== 'runs')
    .join('.')
    .replace(/[^A-Za-z0-9._-]/g, '_')
}

/**
 * Best-effort wrapper for a hot path: a reporting failure must never kill a run
 * that already produced real work. Returns null and logs the reason instead.
 */
export async function writeSupervisorRunReportSafe(
  runDir: string,
  opts: WriteSupervisorRunOptions = {},
): Promise<SupervisorRunReport | null> {
  try {
    return await writeSupervisorRunReport(runDir, opts)
  } catch (err) {
    console.log(
      `RUN-REPORT failed for ${runDir}: ${err instanceof Error ? err.message : String(err)}`,
    )
    return null
  }
}

/**
 * Report every run under an experiment `outDir` (any depth of
 * `runs/<iid>/<arm>`), write each run's report, and write the rollup at
 * `<outDir>/run-report-round.{json,md}`.
 */
export async function reportSupervisorRound(
  outDir: string,
  opts: WriteSupervisorRunOptions & { title?: string } = {},
): Promise<SupervisorRunRollup> {
  const runDirs = await findSupervisorRunDirs(outDir)
  const reports: SupervisorRunReport[] = []
  for (const runDir of runDirs) {
    const r = await writeSupervisorRunReportSafe(runDir, { ...opts, echo: opts.echo ?? false })
    if (r !== null) reports.push(r)
  }
  const rollup = rollupSupervisorRuns(reports)
  const md = renderSupervisorRollupMarkdown(
    rollup,
    opts.title ?? `Round rollup — ${basename(outDir)}`,
  )
  const dest = opts.reportDir ?? outDir
  if (opts.reportDir !== undefined) await mkdir(opts.reportDir, { recursive: true }).catch(() => {})
  await writeFile(join(dest, 'run-report-round.json'), JSON.stringify(rollup, null, 1)).catch(
    () => {},
  )
  await writeFile(join(dest, 'run-report-round.md'), md).catch(() => {})
  if (opts.appendHeadlineTo !== undefined) {
    await appendFile(opts.appendHeadlineTo, `${md}\n`).catch(() => {})
  }
  if (opts.echo !== false) console.log(md)
  return rollup
}

/**
 * Every Runtime supervisor run below `root`.
 *
 * When `root` itself is one run, return no children so callers can distinguish
 * a single report from a parent-directory rollup.
 */
export async function findSupervisorRunDirs(root: string): Promise<string[]> {
  if (await isRuntimeSupervisorRunDir(root)) {
    return []
  }
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = join(dir, e.name)
      if (await isRuntimeSupervisorRunDir(full)) {
        found.push(full)
        continue
      }
      await walk(full, depth + 1)
    }
  }
  await walk(root, 0)
  return found.sort()
}
