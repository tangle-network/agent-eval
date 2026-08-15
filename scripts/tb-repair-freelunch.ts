/**
 * The free-lunch measurement: what fraction of failed runs does unconditional
 * continuation rescue when it is given a real budget?
 *
 * One arm. No analyst, no hint, no gate, no injected action. A row is replayed
 * to the stop point its recording ended at, and the pinned mini-swe-agent
 * policy runs forward from there under a real model.
 *
 * This is the control TB-Repair's admission condition 3 always meant and never
 * ran: both milestone runs screened rows with a control pinned to zero model
 * calls, which executes no command and therefore grades the same bytes the
 * end-state check already graded as failing.
 *
 * Three container generations per rollout, because two constraints point in
 * opposite directions:
 *
 *   replay    default network, as the recording had and the milestones used
 *   continue  `--network none`, which the pinned policy requires
 *   grade     network again, because every task's `test.sh` runs apt-get,
 *             curl and uvx before it can run a single assertion
 *
 * A container created in `none` mode cannot be attached to a network, so the
 * state moves between generations as a committed image rather than as a
 * re-networked container.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  type ContinuationMessage,
  type ContinuationRollout,
  createDockerContinuationEnvironment,
  definePinnedContinuationPolicy,
  injectedTestOracle,
  MINI_SWE_SYSTEM_MESSAGE,
  nodeProcessRunner,
  type OracleDeterminismVerdict,
  parseTaskOracleRegistry,
  type PinnedContinuationPolicy,
  type RepairSession,
  renderInstanceMessage,
  renderObservation,
  runContinuation,
  type TaskOracleRegistry,
  type TestOracle,
  type TestSuiteFile,
  testSuiteDigest,
} from '../src/trace-repair'
import type { RecordedTrajectoryStep } from '../src/trajectory-replay/steps'
import { routerContinuationModel } from './tb-repair-freelunch-model'

const run = promisify(execFile)

const REPO = '/home/drew/bench-cache/terminal-bench-2'
const CORPUS = '/home/drew/bench-cache/t8-milestone2'
const WORK = process.env.TBR_FL_WORK ?? '/home/drew/bench-cache/freelunch-20260810'

/** Rollouts per row in this invocation. */
const ROLLOUTS = Number(process.env.TBR_FL_ROLLOUTS ?? '3')
/**
 * First rollout index this invocation produces.
 *
 * A campaign that adds rollouts in uniform passes runs one invocation per pass
 * and shifts the base, so pass 2 draws the seeds of index 1 rather than
 * redrawing index 0. The seed derives from the row and the index, so an index
 * that repeats is a rollout that repeats.
 */
const ROLLOUT_BASE = Number(process.env.TBR_FL_ROLLOUT_BASE ?? '0')
const SEED = Number(process.env.TBR_FL_SEED ?? '20260810')
const MODEL = process.env.TBR_FL_MODEL ?? 'deepseek/deepseek-v3.2'

const STEP_TIMEOUT_MS = 300_000
const VERIFIER_TIMEOUT_MS = 900_000
/**
 * Bound for a step the recording itself killed for running too long. The
 * scaffold renders such a step with no returncode, so waiting the full bound
 * buys no information. This changes what the run costs, never what it counts.
 */
const RECORDED_TIMEOUT_STEP_MS = 60_000
const RECORDED_TIMEOUT_MARKER = 'timed out and has been killed'

const TASK_ORACLES_PATH = join(
  import.meta.dirname,
  '..',
  'benchmarks',
  'trace-repair',
  'task-oracles.json',
)

const CONTINUATION_POLICY: PinnedContinuationPolicy = definePinnedContinuationPolicy({
  model: MODEL,
  seed: SEED,
})

interface CorpusRow {
  rowId: string
  taskName: string
  recordedModel: string
  recordedCommands: number
  finalReturncode: number | null
  steps: { step_id: number; action: string; observation: string | null }[]
}

interface AdmitRecord {
  rowId: string
  taskName: string
  stratum: string
  admitted: boolean
  rejection: string | null
  prefixDivergenceRatio: number | null
  evidence: { endStatePassed: boolean } | null
}

interface TaskFixture {
  name: string
  image: string
  cwd: string
  suite: readonly TestSuiteFile[]
  suiteDigest: string
  instruction: string
}

function stepTimeoutMs(observation: string | null): number {
  return observation !== null && observation.includes(RECORDED_TIMEOUT_MARKER)
    ? RECORDED_TIMEOUT_STEP_MS
    : STEP_TIMEOUT_MS
}

function recordedReturncode(observation: string | null): number | null {
  if (!observation) return null
  const m = /<returncode>(-?\d+)<\/returncode>/.exec(observation)
  return m ? Number(m[1]) : null
}

function loadSuite(task: string): TestSuiteFile[] {
  const dir = join(REPO, task, 'tests')
  const files: TestSuiteFile[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel))) {
      const relPath = rel ? `${rel}/${entry}` : entry
      if (statSync(join(dir, relPath)).isDirectory()) walk(relPath)
      else
        files.push({
          path: `/tests/${relPath}`,
          contents: readFileSync(join(dir, relPath), 'utf8'),
        })
    }
  }
  walk('')
  return files
}

async function loadTask(name: string): Promise<TaskFixture> {
  const tag = `alexgshaw/${name}:20251031`
  const { stdout: workdir } = await run('docker', [
    'image',
    'inspect',
    tag,
    '--format',
    '{{.Config.WorkingDir}}',
  ])
  const { stdout: digest } = await run('docker', [
    'image',
    'inspect',
    tag,
    '--format',
    '{{index .RepoDigests 0}}',
  ])
  const suite = loadSuite(name)
  return {
    name,
    image: digest.trim(),
    cwd: workdir.trim() || '/app',
    suite,
    suiteDigest: testSuiteDigest(suite),
    instruction: readFileSync(join(REPO, name, 'instruction.md'), 'utf8'),
  }
}

/**
 * The held-out suite, uploaded from outside the container at grade time and
 * digest-checked after upload. `test.sh` always exits 0 and writes its verdict
 * to `/logs/verifier/reward.txt`, so the command reads that file.
 */
function taskOracle(task: TaskFixture): TestOracle {
  return injectedTestOracle({
    files: task.suite,
    command:
      'chmod +x /tests/test.sh; rm -f /logs/verifier/reward.txt; ' +
      '(/tests/test.sh) > /logs/verifier/test-stdout.txt 2>&1; ' +
      'grep -qx 1 /logs/verifier/reward.txt',
    purge: ['/tests'],
    commandTimeoutMs: VERIFIER_TIMEOUT_MS,
  })
}

/** A networked container at the task image or a snapshot of one. */
async function startNetworkedContainer(image: string, name: string): Promise<string> {
  await run('docker', [
    'run',
    '-d',
    '--name',
    name,
    '--entrypoint',
    '',
    '--memory',
    '2g',
    '--cpus',
    '1',
    image,
    'sleep',
    'infinity',
  ])
  await run('docker', ['exec', name, 'mkdir', '-p', '/logs/verifier', '/logs/agent', '/logs/artifacts'])
  return name
}

function dockerSession(name: string, cwd: string): RepairSession {
  return {
    ref: name,
    async exec(command: string, timeoutMs: number) {
      const seconds = Math.ceil(timeoutMs / 1000)
      try {
        const { stdout, stderr } = await run(
          'docker',
          [
            'exec',
            '-e',
            'DEBIAN_FRONTEND=noninteractive',
            '-w',
            cwd,
            name,
            'timeout',
            '--kill-after=5',
            String(seconds),
            'bash',
            '-lc',
            command,
          ],
          { maxBuffer: 64 * 1024 * 1024, timeout: timeoutMs + 30_000 },
        )
        return { exitCode: 0, stdout, stderr, timedOut: false }
      } catch (error) {
        const err = error as { code?: number; stdout?: string; stderr?: string }
        const exitCode = typeof err.code === 'number' ? err.code : 1
        return {
          exitCode,
          stdout: err.stdout ?? '',
          stderr: err.stderr ?? '',
          timedOut: exitCode === 124 || exitCode === 137,
        }
      }
    },
    async close() {
      await run('docker', ['rm', '-f', name]).catch(() => undefined)
    },
  }
}

interface ReplayResult {
  divergences: number
  replayed: number
  /** The message list the continuation inherits, ending on the last observation. */
  prefix: ContinuationMessage[]
}

/**
 * Replay every recorded command and build the message list the continuation
 * inherits.
 *
 * The corpus stores each recorded assistant message as an elided placeholder,
 * so the reasoning text does not exist. A turn is rendered as the bash block
 * alone rather than with invented prose, and every observation is the one this
 * replay produced.
 */
async function replayPrefix(
  session: RepairSession,
  task: TaskFixture,
  steps: readonly RecordedTrajectoryStep[],
  systemInformation: string,
): Promise<ReplayResult> {
  const prefix: ContinuationMessage[] = [
    { role: 'system', content: MINI_SWE_SYSTEM_MESSAGE },
    {
      role: 'user',
      content: renderInstanceMessage({ task: task.instruction, systemInformation }),
    },
  ]
  let divergences = 0
  for (const step of steps) {
    const result = await session.exec(step.action, stepTimeoutMs(step.observation))
    const recorded = recordedReturncode(step.observation)
    if (recorded === null || recorded !== result.exitCode) divergences += 1
    prefix.push({ role: 'assistant', content: `\`\`\`bash\n${step.action}\n\`\`\`` })
    prefix.push({
      role: 'user',
      content: renderObservation({
        returncode: result.exitCode,
        output: `${result.stdout}${result.stderr}`,
      }),
    })
  }
  return { divergences, replayed: steps.length, prefix }
}

interface RolloutOutcome {
  rowId: string
  taskName: string
  rolloutIndex: number
  /** Divergences of the row's replay against the recording, measured once. */
  divergences: number
  replayed: number
  passed: boolean
  gradeExitCode: number
  gradeTimedOut: boolean
  suiteDigest: string
  continuationSteps: number
  exitStatus: string
  submission: string | null
  terminalError: string | null
  usage: ContinuationRollout['usage']
  costProvenance: ContinuationRollout['costProvenance']
  servedModels: string[]
  networkMode: string
  continuationWallMs: number
  totalWallMs: number
  actions: string[]
}

/** Docker-safe fragment of a row id. */
function slug(rowId: string): string {
  return rowId.replace(/[^a-zA-Z0-9]+/g, '-').slice(-40).replace(/^-+/, '')
}

interface StopPoint {
  /** Image holding the state the recording stopped at. */
  image: string
  replay: ReplayResult
  buildWallMs: number
  /** True when this invocation found the stop point already built. */
  reused: boolean
}

/**
 * Where a built stop point is recorded so a later pass reuses it.
 *
 * A campaign that adds rollouts in passes must hand every pass the same stop
 * point, or the passes differ by their replay as well as by their rollout. The
 * image carries the container state and this file carries the message list and
 * the divergence count the replay produced, which cannot be recovered from the
 * image.
 */
function stopPointRecordPath(rowId: string): string {
  return join(WORK, 'stop-points', `${slug(rowId)}.json`)
}

/**
 * Reconstruct the recorded stop point once for a row and snapshot it.
 *
 * Every rollout of the row starts from this one image, so the stop point is
 * held constant and the only thing that varies within a row is the
 * continuation. It also pays the expensive commit once rather than per rollout:
 * a recording that installed packages writes a multi-gigabyte layer.
 */
async function buildStopPoint(
  row: CorpusRow,
  task: TaskFixture,
  systemInformation: string,
): Promise<StopPoint> {
  const startedMs = Date.now()
  const base = `tbfl-${slug(row.rowId)}`.toLowerCase()
  const image = `tbfl/stop:${base}`
  const recordPath = stopPointRecordPath(row.rowId)

  const built = await run('docker', ['image', 'inspect', image, '--format', '{{.Id}}']).then(
    () => true,
    () => false,
  )
  if (built) {
    const record = JSON.parse(readFileSync(recordPath, 'utf8')) as {
      image: string
      replay: ReplayResult
      buildWallMs: number
    }
    if (record.image !== image) {
      throw new Error(`stop-point record for ${row.rowId} names image ${record.image}, not ${image}`)
    }
    return { ...record, reused: true }
  }

  const steps: RecordedTrajectoryStep[] = row.steps.map((s) => ({
    step_id: s.step_id,
    action: s.action,
    observation: s.observation,
  }))
  const container = await startNetworkedContainer(task.image, `${base}-replay-${randomUUID().slice(0, 6)}`)
  try {
    const replay = await replayPrefix(
      dockerSession(container, task.cwd),
      task,
      steps,
      systemInformation,
    )
    await run('docker', ['commit', container, image])
    const record = { image, replay, buildWallMs: Date.now() - startedMs }
    mkdirSync(join(WORK, 'stop-points'), { recursive: true })
    writeFileSync(recordPath, JSON.stringify(record))
    return { ...record, reused: false }
  } finally {
    await run('docker', ['rm', '-f', container]).catch(() => undefined)
  }
}

async function runRollout(
  row: CorpusRow,
  task: TaskFixture,
  stopPoint: StopPoint,
  rolloutIndex: number,
  log: (m: string) => void,
): Promise<RolloutOutcome> {
  const startedMs = Date.now()
  const base = `tbfl-${slug(row.rowId)}-${rolloutIndex}-${randomUUID().slice(0, 6)}`.toLowerCase()
  const replayImage = stopPoint.image
  const continuedImage = `tbfl/continued:${base}`
  const replay = stopPoint.replay

  const continuationStartedMs = Date.now()
  const continuationContainer = `${base}-cont`
  let rollout: ContinuationRollout
  try {
    const rollouts = await runContinuation({
      policy: CONTINUATION_POLICY,
      arm: 'no-fix-control',
      rowId: row.rowId,
      prefix: replay.prefix,
      rollouts: 1,
      // The seed derives from the global rollout index, so a pass that shifts
      // ROLLOUT_BASE draws new seeds instead of redrawing index 0.
      rolloutBase: rolloutIndex,
      model: routerContinuationModel(`${row.rowId.split('::')[1] ?? row.rowId}#${rolloutIndex}`),
      environments: {
        id: 'docker-network-none',
        async create() {
          await run('docker', [
            'run',
            '-d',
            '--name',
            continuationContainer,
            '--entrypoint',
            '',
            '--network',
            'none',
            '--memory',
            '2g',
            '--cpus',
            '1',
            '-w',
            task.cwd,
            replayImage,
            'sleep',
            '4h',
          ])
          return createDockerContinuationEnvironment({
            containerRef: continuationContainer,
            cwd: task.cwd,
            runProcess: nodeProcessRunner,
            // The container is committed after the rollout, so this owns it.
            removeOnDispose: false,
          })
        },
      },
    })
    const only = rollouts[0]
    if (only === undefined) throw new Error(`no rollout recorded for ${row.rowId}#${rolloutIndex}`)
    rollout = only
    await run('docker', ['commit', continuationContainer, continuedImage])
  } finally {
    // The environment factory keeps the container alive so it can be committed,
    // so the container is removed here whether the commit happened or a throw
    // skipped it. The stop-point image outlives the rollout and is removed by
    // the row that owns it.
    await run('docker', ['rm', '-f', continuationContainer]).catch(() => undefined)
  }
  const continuationWallMs = Date.now() - continuationStartedMs

  const gradeContainer = await startNetworkedContainer(continuedImage, `${base}-grade`)
  const gradeSession = dockerSession(gradeContainer, task.cwd)
  try {
    const graded = await taskOracle(task).grade(gradeSession, {
      rowId: row.rowId,
      arm: 'no-fix-control',
      rolloutIndex,
    })
    const outcome: RolloutOutcome = {
      rowId: row.rowId,
      taskName: row.taskName,
      rolloutIndex,
      divergences: replay.divergences,
      replayed: replay.replayed,
      passed: graded.passed,
      gradeExitCode: graded.exitCode,
      gradeTimedOut: graded.timedOut,
      suiteDigest: graded.suiteDigest,
      continuationSteps: rollout.steps.length,
      exitStatus: rollout.exitStatus,
      submission: rollout.submission,
      terminalError: rollout.terminalError ?? null,
      usage: rollout.usage,
      costProvenance: rollout.costProvenance,
      servedModels: [...new Set(rollout.steps.map((s) => s.model.servedModel))],
      networkMode: rollout.environment.networkMode,
      continuationWallMs,
      totalWallMs: Date.now() - startedMs,
      actions: rollout.steps.map((s) => s.action ?? '<format-error>'),
    }
    log(
      `${row.rowId}#${rolloutIndex} passed=${outcome.passed} exit=${outcome.exitStatus} ` +
        `steps=${outcome.continuationSteps} div=${replay.divergences}/${replay.replayed} ` +
        `in=${outcome.usage.input} out=${outcome.usage.output} ` +
        `cost=${outcome.costProvenance.usd === null ? 'uncaptured' : `$${outcome.costProvenance.usd.toFixed(4)}`} ` +
        `${outcome.totalWallMs}ms`,
    )
    writeFileSync(join(WORK, 'rollouts.jsonl'), `${JSON.stringify(outcome)}\n`, { flag: 'a' })
    return outcome
  } finally {
    await gradeSession.close()
    await run('docker', ['rmi', '-f', continuedImage]).catch(() => undefined)
  }
}

async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let next = 0
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      for (;;) {
        const index = next
        next += 1
        if (index >= items.length) return
        results[index] = await fn(items[index]!, index)
      }
    }),
  )
  return results
}

function loadRows(): { primary: CorpusRow[]; divergent: CorpusRow[]; chain: Record<string, number> } {
  const rows: CorpusRow[] = JSON.parse(readFileSync(join(CORPUS, 'rows-all.json'), 'utf8'))
  const admit: { records: AdmitRecord[] } = JSON.parse(
    readFileSync(join(CORPUS, 'out', 'admit.json'), 'utf8'),
  )
  const byRow = new Map(admit.records.map((r) => [r.rowId, r]))
  const oracles = loadTaskOracles()

  const chain: Record<string, number> = { evaluated: rows.length }
  const certified = rows.filter((r) => oracles.get(r.taskName)?.stable === true)
  chain.deterministicOracle = certified.length
  const cleanExit = certified.filter((r) => r.finalReturncode === 0)
  chain.cleanExit = cleanExit.length
  const failed = cleanExit.filter((r) => byRow.get(r.rowId)?.evidence?.endStatePassed === false)
  chain.failedEndState = failed.length
  const primary = failed.filter((r) => byRow.get(r.rowId)?.rejection === null)
  const divergent = failed.filter((r) => byRow.get(r.rowId)?.rejection !== null)
  chain.prefixFidelityOk = primary.length
  chain.prefixDivergent = divergent.length
  if (failed.length !== cleanExit.length) {
    throw new Error(
      `expected every clean-exit row to have failed its end state; ${cleanExit.length - failed.length} did not`,
    )
  }
  return { primary, divergent, chain }
}

function loadTaskOracles(): TaskOracleRegistry {
  return parseTaskOracleRegistry(JSON.parse(readFileSync(TASK_ORACLES_PATH, 'utf8')))
}

async function routerSpend(): Promise<{ totalUsage: number; totalCredits: number }> {
  const key = process.env.TANGLE_API_KEY
  if (!key) throw new Error('TANGLE_API_KEY is required to read the router spend counter')
  const response = await fetch('https://router.tangle.tools/v1/credits', {
    headers: { authorization: `Bearer ${key}` },
  })
  if (!response.ok) throw new Error(`router credits read failed: HTTP ${response.status}`)
  const body = (await response.json()) as { data: { total_credits: number; total_usage: number } }
  return { totalUsage: body.data.total_usage, totalCredits: body.data.total_credits }
}

async function main(): Promise<void> {
  mkdirSync(WORK, { recursive: true })
  const logPath = join(WORK, 'run.log')
  const log = (message: string): void => {
    const line = `${new Date().toISOString()} ${message}\n`
    process.stdout.write(line)
    writeFileSync(logPath, line, { flag: 'a' })
  }

  const { primary, divergent, chain } = loadRows()
  const only = process.env.TBR_FL_ONLY?.split(',').map((s) => s.trim()).filter(Boolean)
  const includeDivergent = process.env.TBR_FL_SET === 'divergent'
  const selected = (includeDivergent ? divergent : primary).filter(
    (r) => !only || only.includes(r.rowId),
  )
  const limit = Number(process.env.TBR_FL_LIMIT ?? '0')
  const rows = limit > 0 ? selected.slice(0, limit) : selected

  // A stop point is addressed by the row's slug, so two rows sharing one would
  // silently share a container state. Checked before anything is built.
  const bySlug = new Map<string, string>()
  for (const row of rows) {
    const key = slug(row.rowId)
    const other = bySlug.get(key)
    if (other !== undefined) {
      throw new Error(`rows ${other} and ${row.rowId} share the stop-point slug ${key}`)
    }
    bySlug.set(key, row.rowId)
  }

  const taskNames = [...new Set(rows.map((r) => r.taskName))]
  const tasks = new Map<string, TaskFixture>()
  for (const name of taskNames) tasks.set(name, await loadTask(name))
  const oracles = loadTaskOracles()

  // The denominator chain and the selected rows, with no container and no
  // model call, so the set a run will spend on can be read before it spends.
  if (process.argv.includes('--plan')) {
    const perTask = new Map<string, number>()
    for (const row of rows) perTask.set(row.taskName, (perTask.get(row.taskName) ?? 0) + 1)
    process.stdout.write(
      `${JSON.stringify(
        {
          chain,
          selected: rows.length,
          rollouts: ROLLOUTS,
          perTask: Object.fromEntries(perTask),
          excludedTasks: [...oracles]
            .filter(([, v]) => !v.stable)
            .map(([name, v]) => ({ name, flipRate: v.flipRate, replicates: v.replicates })),
          images: Object.fromEntries([...tasks].map(([n, t]) => [n, t.image])),
          rowIds: rows.map((r) => r.rowId),
        },
        null,
        2,
      )}\n`,
    )
    return
  }

  const { stdout: uname } = await run('uname', ['-a'])
  const systemInformation = uname.trim()

  // Reconstructing the stop points needs containers and no model call, so a
  // campaign waiting for the measurement seat can build them first and spend
  // the seat's time on model calls alone.
  if (process.argv.includes('--stop-points-only')) {
    const built: Record<string, unknown> = {}
    await mapLimit(rows, Number(process.env.TBR_FL_CONCURRENCY ?? '6'), async (row) => {
      try {
        const stopPoint = await buildStopPoint(row, tasks.get(row.taskName)!, systemInformation)
        built[row.rowId] = {
          reused: stopPoint.reused,
          divergences: stopPoint.replay.divergences,
          replayed: stopPoint.replay.replayed,
          buildWallMs: stopPoint.buildWallMs,
        }
        log(
          `${row.rowId} stop point ${stopPoint.reused ? 'reused' : 'built'} ` +
            `div=${stopPoint.replay.divergences}/${stopPoint.replay.replayed} ` +
            `${Math.round(stopPoint.buildWallMs / 1000)}s`,
        )
      } catch (error) {
        built[row.rowId] = { error: (error as Error).message }
        log(`${row.rowId} STOP-POINT ERROR ${(error as Error).message}`)
      }
    })
    writeFileSync(join(WORK, 'stop-points.json'), JSON.stringify(built, null, 2))
    log(`stop points ready: ${Object.keys(built).length}`)
    return
  }

  const spendBefore = await routerSpend()
  log(
    `rows=${rows.length} rollouts=${ROLLOUTS} model=${MODEL} seed=${SEED} ` +
      `policyDigest=pinned chain=${JSON.stringify(chain)} routerUsageBefore=${spendBefore.totalUsage}`,
  )

  const concurrency = Number(process.env.TBR_FL_CONCURRENCY ?? '4')
  const startedMs = Date.now()
  const outcomes: (RolloutOutcome | { rowId: string; rolloutIndex: number; error: string })[] = []
  const stopPoints: Record<
    string,
    { divergences: number; replayed: number; buildWallMs: number; reused: boolean }
  > = {}
  // A stop point outlives the pass that built it so later passes inherit the
  // same one. `--drop-stop-points` is how a finished campaign reclaims them.
  const dropStopPoints = process.argv.includes('--drop-stop-points')
  await mapLimit(rows, concurrency, async (row) => {
    const task = tasks.get(row.taskName)!
    let stopPoint: StopPoint
    try {
      stopPoint = await buildStopPoint(row, task, systemInformation)
      stopPoints[row.rowId] = {
        divergences: stopPoint.replay.divergences,
        replayed: stopPoint.replay.replayed,
        buildWallMs: stopPoint.buildWallMs,
        reused: stopPoint.reused,
      }
      log(
        `${row.rowId} stop point ${stopPoint.reused ? 'reused' : 'built'} ` +
          `div=${stopPoint.replay.divergences}/${stopPoint.replay.replayed} ` +
          `${Math.round(stopPoint.buildWallMs / 1000)}s`,
      )
    } catch (error) {
      const message = (error as Error).message
      log(`${row.rowId} STOP-POINT ERROR ${message}`)
      for (let offset = 0; offset < ROLLOUTS; offset += 1) {
        outcomes.push({
          rowId: row.rowId,
          rolloutIndex: ROLLOUT_BASE + offset,
          error: `stop point: ${message}`,
        })
      }
      return
    }
    try {
      // The rollouts of a row share one stop-point image and touch nothing else
      // in common, so they run together rather than one after another.
      await Promise.all(
        Array.from({ length: ROLLOUTS }, async (_unused, offset) => {
          const i = ROLLOUT_BASE + offset
          try {
            outcomes.push(await runRollout(row, task, stopPoint, i, log))
          } catch (error) {
            const message = (error as Error).message
            log(`${row.rowId}#${i} ERROR ${message}`)
            outcomes.push({ rowId: row.rowId, rolloutIndex: i, error: message })
          }
        }),
      )
    } finally {
      if (dropStopPoints) await run('docker', ['rmi', '-f', stopPoint.image]).catch(() => undefined)
    }
  })
  const wallMs = Date.now() - startedMs
  const spendAfter = await routerSpend()

  const report = {
    generatedAt: new Date().toISOString(),
    wallMs,
    concurrency,
    rollouts: ROLLOUTS,
    policy: CONTINUATION_POLICY,
    set: includeDivergent ? 'prefix-divergent' : 'primary',
    denominatorChain: chain,
    rows: rows.map((r) => ({
      rowId: r.rowId,
      taskName: r.taskName,
      recordedModel: r.recordedModel,
      recordedCommands: r.recordedCommands,
    })),
    images: Object.fromEntries([...tasks].map(([n, t]) => [n, t.image])),
    suiteDigests: Object.fromEntries([...tasks].map(([n, t]) => [n, t.suiteDigest])),
    taskOracles: Object.fromEntries(
      [...oracles]
        .filter(([name]) => taskNames.includes(name))
        .map(([name, v]: [string, OracleDeterminismVerdict]) => [
          name,
          { stable: v.stable, flipRate: v.flipRate, replicates: v.replicates },
        ]),
    ),
    routerSpend: {
      before: spendBefore.totalUsage,
      after: spendAfter.totalUsage,
      deltaUsd: spendAfter.totalUsage - spendBefore.totalUsage,
    },
    stopPoints,
    outcomes,
  }
  const outPath = join(WORK, process.env.TBR_FL_OUT ?? 'freelunch.json')
  writeFileSync(outPath, JSON.stringify(report, null, 2))
  log(`done wallMs=${wallMs} routerDelta=$${report.routerSpend.deltaUsd.toFixed(4)} -> ${outPath}`)
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack}\n`)
  process.exit(1)
})
