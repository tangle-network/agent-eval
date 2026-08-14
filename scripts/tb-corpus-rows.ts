/**
 * Decode the Terminal-Bench-2 trajectory dump into replayable corpus rows.
 *
 * The dump holds turns, not steps. A turn carries a command, an observation,
 * both, or neither, and only `trajectory-replay/steps` knows which shapes mean
 * what. This tool moves bytes and decides nothing: duckdb reads the parquet
 * shards, `decodeRecordedTurns` turns each row's turns into steps, and the
 * fields an admission funnel reads come out of that one decoder.
 *
 * A second decoder — SQL that collects commands and observations into two lists
 * and zips them — pairs every observation after a rejected turn with the wrong
 * command, and reads the run's last turn as the end of the trajectory when it
 * is the sentinel that ends it. Both mistakes look like an unreplayable corpus.
 *
 *   node --import tsx scripts/tb-corpus-rows.ts \
 *     --data-dir ~/bench-cache/tbench-20260808 \
 *     --out ~/bench-cache/gated-stop-ab/rows-decoded.json \
 *     --report benchmarks/trace-repair/tb-corpus-decode.json
 *
 * Every input is checked on entry. A missing shard, a missing duckdb binary or
 * a missing certification stops the run rather than shrinking the corpus.
 */

import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { parseTaskOracleRegistry } from '../src/trace-repair'
import {
  classifyObservation,
  decodeRecordedTurns,
  finalRecordedOutcome,
  type RecordedObservationKind,
  type RecordedTrajectoryTurn,
  unreadableExitCount,
} from '../src/trajectory-replay/steps'

/** The scaffold whose recorded grammar this decoder reads. */
const SCAFFOLD = 'mini-swe-agent'

interface Options {
  dataDir: string
  duckdb: string
  oracles: string
  images: string
  out: string
  report: string | null
}

function parseOptions(argv: readonly string[]): Options {
  const repoRoot = join(import.meta.dirname, '..')
  const options: Options = {
    dataDir: join(homedir(), 'bench-cache', 'tbench-20260808'),
    duckdb: 'duckdb',
    oracles: join(repoRoot, 'benchmarks', 'trace-repair', 'task-oracles.json'),
    images: join(repoRoot, 'benchmarks', 'trace-repair', 'tb-images.lock.json'),
    out: join(homedir(), 'bench-cache', 'gated-stop-ab', 'rows-decoded.json'),
    report: null,
  }
  for (let i = 0; i < argv.length; i += 1) {
    const flag = argv[i]
    const value = argv[i + 1]
    const need = (): string => {
      if (value === undefined) throw new Error(`${flag} needs a value`)
      i += 1
      return value.startsWith('~') ? join(homedir(), value.slice(1)) : value
    }
    if (flag === '--data-dir') options.dataDir = resolve(need())
    else if (flag === '--duckdb') options.duckdb = need()
    else if (flag === '--oracles') options.oracles = resolve(need())
    else if (flag === '--images') options.images = resolve(need())
    else if (flag === '--out') options.out = resolve(need())
    else if (flag === '--report') options.report = resolve(need())
    else throw new Error(`unknown flag: ${flag}`)
  }
  return options
}

function shardsOf(dataDir: string): string[] {
  if (!existsSync(dataDir)) throw new Error(`data directory not found: ${dataDir}`)
  const shards = readdirSync(dataDir)
    .filter((name) => name.startsWith('train-') && name.endsWith('.parquet'))
    .sort()
  if (shards.length === 0) {
    throw new Error(
      `no train-*.parquet shards in ${dataDir}. Fetch them with:\n` +
        '  huggingface-cli download yoonholee/terminalbench-trajectories --repo-type dataset',
    )
  }
  return shards
}

function duckdbVersion(binary: string): string {
  try {
    return execFileSync(binary, ['--version'], { encoding: 'utf8' }).trim()
  } catch {
    throw new Error(
      `duckdb CLI not runnable at "${binary}". Install:\n` +
        '  curl -sL -o duckdb.zip https://github.com/duckdb/duckdb/releases/latest/download/duckdb_cli-linux-amd64.zip && unzip duckdb.zip',
    )
  }
}

interface RawRow {
  task_name: string
  model: string
  trial_name: string
  trial_id: string
  steps: string
}

/**
 * Read the failed rows of one scaffold on the certified tasks.
 *
 * The query selects columns and filters rows. It does not parse a step: every
 * `steps` blob crosses the boundary whole, so nothing about the grammar is
 * decided in SQL.
 */
function readRawRows(options: Options, tasks: readonly string[]): RawRow[] {
  const scratch = mkdtempSync(join(tmpdir(), 'tb-corpus-rows-'))
  const dump = join(scratch, 'rows.jsonl')
  const taskList = tasks.map((task) => `'${task.replaceAll("'", "''")}'`).join(', ')
  const sql =
    `COPY (SELECT task_name, model, trial_name, trial_id, steps ` +
    `FROM read_parquet('${options.dataDir}/train-*.parquet') ` +
    `WHERE agent='${SCAFFOLD}' AND reward=0 AND json_array_length(steps) > 0 ` +
    `AND task_name IN (${taskList}) ` +
    `ORDER BY task_name, trial_name, trial_id) ` +
    `TO '${dump}' (FORMAT JSON, ARRAY false);`
  try {
    execFileSync(options.duckdb, ['-c', sql], { encoding: 'utf8', maxBuffer: 1 << 28 })
    return readFileSync(dump, 'utf8')
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line) as RawRow)
  } finally {
    rmSync(scratch, { recursive: true, force: true })
  }
}

/**
 * Tasks whose pinned image is in the local docker store, by digest.
 *
 * A daemon that cannot answer is not an empty store. Without the probe below,
 * a broken docker maps every image to absent and the tool emits a corpus whose
 * rows all read `imageLocal: false`, which is indistinguishable in the report
 * from a machine that pulled nothing.
 */
function localImages(imagesPath: string): Set<string> {
  const lock = JSON.parse(readFileSync(imagesPath, 'utf8')) as {
    images: Record<string, { repository: string; digest: string }>
  }
  try {
    execFileSync('docker', ['version', '--format', '{{.Server.Version}}'], { stdio: 'ignore' })
  } catch (error) {
    throw new Error(
      `docker is not usable, so image presence cannot be measured: ${
        error instanceof Error ? error.message : String(error)
      }`,
    )
  }
  const local = new Set<string>()
  for (const [task, image] of Object.entries(lock.images)) {
    try {
      execFileSync('docker', ['image', 'inspect', `${image.repository}@${image.digest}`], {
        stdio: 'ignore',
      })
      local.add(task)
    } catch {
      // Absent from the store. The row keeps `imageLocal: false` and the funnel
      // reports it; pulling is a separate, explicit step.
    }
  }
  return local
}

export interface DecodedCorpusRow {
  rowId: string
  taskName: string
  recordedModel: string
  trialName: string
  trialId: string
  /** Commands the run executed, excluding a trailing submit sentinel. */
  recordedCommands: number
  /** Commands whose text the dump dropped. Any at all blocks replay. */
  placeholderCommands: number
  /** Turns the scaffold rejected before anything ran. */
  formatErrorTurns: number
  /** Steps whose recorded exit a replay cannot check. */
  unknownReturncodes: number
  unknownRatio: number
  /** Exit of the last executed command; null when it was killed or unreadable. */
  finalReturncode: number | null
  finalOutcome: 'returncode' | 'killed' | `unreadable:${RecordedObservationKind}`
  endedOnSubmitSentinel: boolean
  imageLocal: boolean
  steps: { step_id: number; action: string; observation: string | null }[]
}

function decodeRow(raw: RawRow, imageLocal: boolean): DecodedCorpusRow | null {
  const turns = JSON.parse(raw.steps) as RecordedTrajectoryTurn[]
  const decoded = decodeRecordedTurns(turns)
  if (decoded.steps.length === 0) return null
  const outcome = finalRecordedOutcome(decoded.steps)
  if (outcome === null) return null
  const unknown = unreadableExitCount(decoded.steps)
  return {
    rowId: `${raw.task_name}::${raw.trial_name}::${raw.trial_id === '' ? 'ord0' : raw.trial_id}`,
    taskName: raw.task_name,
    recordedModel: raw.model,
    trialName: raw.trial_name,
    trialId: raw.trial_id,
    recordedCommands: decoded.steps.length,
    placeholderCommands: decoded.elidedCommands,
    formatErrorTurns: decoded.formatErrorTurns,
    unknownReturncodes: unknown,
    unknownRatio: unknown / decoded.steps.length,
    finalReturncode: outcome.kind === 'returncode' ? outcome.value : null,
    finalOutcome: outcome.kind === 'unreadable' ? `unreadable:${outcome.reason}` : outcome.kind,
    endedOnSubmitSentinel: decoded.endedOnSubmitSentinel,
    imageLocal,
    steps: [...decoded.steps],
  }
}

function main(): void {
  const options = parseOptions(process.argv.slice(2))
  const shards = shardsOf(options.dataDir)
  const version = duckdbVersion(options.duckdb)
  const registry = parseTaskOracleRegistry(JSON.parse(readFileSync(options.oracles, 'utf8')))
  const certified = [...registry.values()]
    .filter((verdict) => verdict.stable)
    .map((verdict) => verdict.taskName)
    .sort()
  if (certified.length === 0) throw new Error(`no certified stable task in ${options.oracles}`)

  const raws = readRawRows(options, certified)
  const local = localImages(options.images)
  const rows: DecodedCorpusRow[] = []
  let noExecutedCommand = 0
  for (const raw of raws) {
    const row = decodeRow(raw, local.has(raw.task_name))
    if (row === null) noExecutedCommand += 1
    else rows.push(row)
  }

  mkdirSync(dirname(options.out), { recursive: true })
  writeFileSync(options.out, JSON.stringify(rows))

  const observations: Record<string, number> = {}
  for (const row of rows) {
    for (const step of row.steps) {
      const kind = classifyObservation(step.observation)
      observations[kind] = (observations[kind] ?? 0) + 1
    }
  }
  const finalOutcomes: Record<string, number> = {}
  for (const row of rows) finalOutcomes[row.finalOutcome] = (finalOutcomes[row.finalOutcome] ?? 0) + 1
  // Commands, counted separately from observations: both are elided by the same
  // marker, and a report that names only one cannot corroborate the other.
  const executedCommands = rows.reduce((total, row) => total + row.recordedCommands, 0)
  const elidedCommands = rows.reduce((total, row) => total + row.placeholderCommands, 0)

  const report = {
    version: 1,
    generator: 'tb-corpus-rows.ts',
    generatedAt: new Date().toISOString(),
    source: { scaffold: SCAFFOLD, reward: 0, shards, duckdb: version },
    certifiedTasks: certified.length,
    rawRows: raws.length,
    rowsWithNoExecutedCommand: noExecutedCommand,
    decodedRows: rows.length,
    observationKinds: observations,
    executedCommands,
    elidedCommands,
    formatErrorTurns: rows.reduce((total, row) => total + row.formatErrorTurns, 0),
    finalOutcomes,
    imagesLocal: [...new Set(rows.filter((row) => row.imageLocal).map((row) => row.taskName))].length,
  }
  if (options.report !== null) {
    mkdirSync(dirname(options.report), { recursive: true })
    writeFileSync(options.report, `${JSON.stringify(report, null, 2)}\n`)
  }
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
}

main()
