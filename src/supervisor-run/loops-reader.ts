/**
 * ONE implementation of `SupervisorRunReader`: the on-disk layout the loops
 * supervisor writes — `<runDir>/ws/.loops/supervisor/<id>/{journal.jsonl,
 * state.json, progress.ndjson, workers/*.ndjson}` alongside the run's
 * `result.json` / `judge.json` / `driver.log` / delivered patch.
 *
 * Nothing in `analyze.ts` knows this layout exists. A different store (an
 * archive, an object bucket, a database) implements the same interface and
 * gets the same report.
 *
 * Worker token recovery reuses the rollout module's opencode reader rather
 * than opening a second sqlite path — one store client, one corruption policy.
 */

import { appendFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import {
  DEFAULT_OPENCODE_DB,
  findOpencodeSessionsByDirectory,
  openOpencodeDb,
} from '../rollout/readers/opencode-sqlite'
import { analyzeSupervisorRunSources, parseJson, parseJsonl, rollupSupervisorRuns } from './analyze'
import {
  renderSupervisorRollupMarkdown,
  renderSupervisorRunHeadline,
  renderSupervisorRunMarkdown,
} from './render'
import type {
  SupervisorRunReader,
  SupervisorRunReport,
  SupervisorRunRollup,
  SupervisorRunSources,
  WorkerLogSource,
} from './types'

async function readMaybe(path: string): Promise<string | null> {
  return readFile(path, 'utf8').catch(() => null)
}

/** Locate the (single) supervisor run dir under `<ws>/.loops/supervisor`. */
export async function findSupervisorRunDirIn(ws: string): Promise<string | null> {
  const root = join(ws, '.loops', 'supervisor')
  const entries = await readdir(root, { withFileTypes: true }).catch(() => [])
  const dirs = entries.filter((e) => e.isDirectory()).map((e) => join(root, e.name))
  return dirs[0] ?? null
}

export interface LoopsReaderOptions {
  /** Override the workspace dir (default `<runDir>/ws`). */
  readonly ws?: string
  /** Delivered patch path (default: `patchPath` from result.json). */
  readonly patchPath?: string
  /** opencode sqlite store; set to `null` to skip the worker-token join entirely. */
  readonly opencodeDb?: string | null
  /** Ledger to fall back to when the run has no `judge.json` (matched on iid + arm + runDir). */
  readonly ledgerPath?: string
}

/**
 * Read a loops supervisor run directory into source bytes. Never throws on a
 * missing artifact — an absent file becomes a `null` field, which is what makes
 * the dependent metric `unavailable` instead of 0.
 */
export async function readLoopsSupervisorRun(
  runDir: string,
  opts: LoopsReaderOptions = {},
): Promise<SupervisorRunSources> {
  const ws = opts.ws ?? join(runDir, 'ws')
  const supRunDir = await findSupervisorRunDirIn(ws)
  const result = await readMaybe(join(runDir, 'result.json'))
  const resultObj = parseJson(result)

  let workers: WorkerLogSource[] | null = null
  let workersMissingReason: string | null = null
  const workerCwds: string[] = []
  if (supRunDir === null) {
    workersMissingReason = `no supervisor run dir under ${join(ws, '.loops', 'supervisor')}`
  } else {
    const workersDir = join(supRunDir, 'workers')
    const entries = await readdir(workersDir).catch(() => null)
    if (entries === null) {
      workersMissingReason = `workers/ directory absent under ${supRunDir}`
    } else {
      const labels = [
        ...new Set(
          entries
            .filter((f) => f.endsWith('.ndjson'))
            .map((f) => f.replace(/\.inbox\.ndjson$/, '').replace(/\.ndjson$/, '')),
        ),
      ].sort()
      workers = []
      for (const label of labels) {
        const events = await readMaybe(join(workersDir, `${label}.ndjson`))
        const inbox = await readMaybe(join(workersDir, `${label}.inbox.ndjson`))
        const patch = await readMaybe(join(workersDir, `${label}.patch`))
        workers.push({
          label,
          events,
          inbox,
          patchBytes: patch === null ? null : Buffer.byteLength(patch),
        })
        for (const ev of parseJsonl(events)) {
          if (ev.kind === 'started' && typeof ev.cwd === 'string') workerCwds.push(ev.cwd)
        }
      }
    }
  }

  let harnessWorkerTokens: SupervisorRunSources['harnessWorkerTokens'] = null
  let harnessMissingReason: string | null = null
  if (opts.opencodeDb === null) {
    harnessMissingReason = 'opencode join disabled'
  } else if (workerCwds.length === 0) {
    harnessMissingReason = 'no worker clone cwds in workers/*.ndjson (nothing to join)'
  } else {
    const db = await openOpencodeDb(opts.opencodeDb ?? DEFAULT_OPENCODE_DB)
    if (db === null) {
      harnessMissingReason = `opencode session store unreadable at ${opts.opencodeDb ?? DEFAULT_OPENCODE_DB}`
    } else {
      try {
        const seen = new Set<string>()
        let sessions = 0
        let input = 0
        let output = 0
        for (const cwd of new Set(workerCwds)) {
          for (const row of findOpencodeSessionsByDirectory(db, cwd)) {
            if (seen.has(row.id)) continue
            seen.add(row.id)
            sessions += 1
            input += row.tokensInput
            output += row.tokensOutput + row.tokensReasoning
          }
        }
        harnessWorkerTokens = { store: 'opencode', sessions, input, output }
      } finally {
        db.close()
      }
    }
  }

  const patchPath =
    opts.patchPath ?? (typeof resultObj?.patchPath === 'string' ? resultObj.patchPath : null)

  let judge = await readMaybe(join(runDir, 'judge.json'))
  let judgeSource = judge === null ? null : join(runDir, 'judge.json')
  if (judge === null && opts.ledgerPath !== undefined) {
    const row = await findLedgerRow(opts.ledgerPath, runDir)
    if (row !== null) {
      judge = JSON.stringify(row)
      judgeSource = `${opts.ledgerPath} (ledger row)`
    }
  }

  return {
    runRef: runDir,
    instanceId: typeof resultObj?.iid === 'string' ? resultObj.iid : instanceIdFromPath(runDir),
    arm: typeof resultObj?.arm === 'string' ? resultObj.arm : basename(runDir),
    supRunDir,
    journal: supRunDir === null ? null : await readMaybe(join(supRunDir, 'journal.jsonl')),
    brainLog: supRunDir === null ? null : await readMaybe(join(supRunDir, 'brain.jsonl')),
    state: supRunDir === null ? null : await readMaybe(join(supRunDir, 'state.json')),
    progress: supRunDir === null ? null : await readMaybe(join(supRunDir, 'progress.ndjson')),
    workers,
    workersMissingReason,
    result,
    judge,
    judgeSource,
    patch: patchPath === null ? null : await readMaybe(patchPath),
    driverLog: await readMaybe(join(runDir, 'driver.log')),
    harnessWorkerTokens,
    harnessMissingReason,
  }
}

/** The loops on-disk layout, as a `SupervisorRunReader`. */
export function loopsSupervisorRunReader(
  runDir: string,
  opts: LoopsReaderOptions = {},
): SupervisorRunReader {
  return { runRef: runDir, read: () => readLoopsSupervisorRun(runDir, opts) }
}

/** The ledger row whose `runDir` is this run (falling back to iid + arm match). */
async function findLedgerRow(
  ledgerPath: string,
  runDir: string,
): Promise<Record<string, unknown> | null> {
  const rows = parseJsonl(await readMaybe(ledgerPath))
  const exact = rows.find((r) => r.runDir === runDir)
  if (exact !== undefined) return exact
  const iid = instanceIdFromPath(runDir)
  const arm = basename(runDir)
  return rows.find((r) => r.iid === iid && r.arm === arm) ?? null
}

/** `<outDir>/runs/<iid>/<arm>` → `<iid>`. */
function instanceIdFromPath(runDir: string): string | null {
  const parts = runDir.split('/').filter(Boolean)
  const armIdx = parts.length - 1
  const iid = parts[armIdx - 1]
  return parts[armIdx - 2] === 'runs' && iid !== undefined ? iid : null
}

// ---------------------------------------------------------------------------
// Entry point + write helpers.
// ---------------------------------------------------------------------------

/**
 * Analyze a supervisor run. Accepts a run directory (read through the loops
 * reader), any `SupervisorRunReader`, or already-read source bytes — so a
 * caller with its own store never has to touch the filesystem layout.
 */
export async function analyzeSupervisorRun(
  input: string | SupervisorRunReader | SupervisorRunSources,
  opts: LoopsReaderOptions = {},
): Promise<SupervisorRunReport> {
  if (typeof input === 'string') {
    return analyzeSupervisorRunSources(await readLoopsSupervisorRun(input, opts))
  }
  if (isReader(input)) return analyzeSupervisorRunSources(await input.read())
  return analyzeSupervisorRunSources(input)
}

function isReader(input: SupervisorRunReader | SupervisorRunSources): input is SupervisorRunReader {
  return typeof (input as SupervisorRunReader).read === 'function'
}

export interface WriteSupervisorRunOptions extends LoopsReaderOptions {
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
  const sources = await readLoopsSupervisorRun(runDir, opts)
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
export function supervisorReportStem(runDir: string): string {
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

/** Every `<...>/runs/<iid>/<arm>` directory under `root`. */
export async function findSupervisorRunDirs(root: string): Promise<string[]> {
  const found: string[] = []
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > 8) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (e.name === 'node_modules' || e.name === '.git') continue
      const full = join(dir, e.name)
      if (e.name === 'runs') {
        const iids = await readdir(full, { withFileTypes: true }).catch(() => [])
        for (const iid of iids) {
          if (!iid.isDirectory()) continue
          const arms = await readdir(join(full, iid.name), { withFileTypes: true }).catch(() => [])
          for (const arm of arms) if (arm.isDirectory()) found.push(join(full, iid.name, arm.name))
        }
        continue
      }
      await walk(full, depth + 1)
    }
  }
  await walk(root, 0)
  return found.sort()
}
