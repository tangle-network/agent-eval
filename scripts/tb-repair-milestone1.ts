/**
 * TB-Repair milestone 1: run the admission pre-pass and the repair funnel over
 * real Terminal-Bench-2 containers, and report `Delta-repair`.
 *
 * The analyst here is deterministic on purpose. Two answers run through the
 * same grader for every row:
 *
 *   oracle-fix   the task's own reference solution, injected as the action at
 *                step k. The strongest repair that exists, so a funnel that
 *                does not pay it is broken rather than strict.
 *   inert-probe  an action that executes and writes a file no task grades,
 *                injected at the same k. It shares the intervention's cut
 *                point, so the difference between the two arms is the
 *                intervention and not the cut.
 *
 * Both are executed, neither is a model call, and neither can see a label.
 * That is what makes this run a calibration of the instrument: a grader that
 * cannot separate these two answers cannot separate any two answers.
 *
 * Continuation is pinned to zero model steps. Every arm therefore stops after
 * its own action, `t4` collapses onto `t3`, and the run reports `t4` as
 * unmeasured rather than reporting `t3` twice.
 *
 * That control is declared, not implied. A rollout that makes no model call
 * executes no command, so both control arms grade the bytes the end-state
 * check already graded as failing, and admission is told so: the criteria run
 * `controlScreening: 'declared-inert'`, which reads a control pass as the
 * task's grader disagreeing with itself rather than as a rescue. Under the
 * default `enforced` criteria this configuration is refused outright.
 *
 * Task oracles are read from the checked-in certification file. A task with no
 * certification, or one whose suite returned different verdicts on identical
 * bytes, does not run: every check below reads that suite.
 */

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { promisify } from 'node:util'
import {
  type AdmissionCriteria,
  type AdmissionEvidence,
  type AdmissionScreeningRecord,
  admitRow,
  classifyActionPayload,
  type AdmittedRow,
  type AnalystResponse,
  defineControlPolicy,
  deltaRepair,
  gradeRepairRow,
  injectedTestOracle,
  type OracleDeterminismVerdict,
  parseTaskOracleRegistry,
  type RepairContinuationOutcome,
  type RepairContinuationRunner,
  type RepairRowResult,
  type RepairSession,
  type RepairSessionFactory,
  type RepairSessionRequest,
  repairFinding,
  type TaskOracleRegistry,
  TB_REPAIR_ADMISSION_CRITERIA,
  type TestOracle,
  type TestSuiteFile,
  testSuiteDigest,
} from '../src/trace-repair'
import {
  isRecordedTimeout,
  parseRecordedReturncode,
  type RecordedTrajectoryStep,
} from '../src/trajectory-replay/steps'

const run = promisify(execFile)

const REPO = '/home/drew/bench-cache/terminal-bench-2'
const WORK = '/home/drew/bench-cache/t8-milestone1'
const CONTROL_ROLLOUTS = 3
/**
 * The action the admission no-op control injects at the recorded end state.
 *
 * A literal no-op is what "an action that changes nothing" means for the
 * control arm, which never passes through the analyst budget.
 */
const NO_OP_ACTION = 'true'
/**
 * The matched negative answer at k: it executes, writes a file, and cannot
 * repair any task in the set.
 *
 * The budget rejects a literal no-op before opening a container, so a negative
 * arm that must reach the execution tier has to do real but irrelevant work.
 */
const INERT_PROBE_ACTION = 'ls -la / > /tmp/tbr-probe.txt'
const STEP_TIMEOUT_MS = 300_000
const VERIFIER_TIMEOUT_MS = 900_000
/**
 * Bound for a step the recording itself killed for running too long.
 *
 * The scaffold renders such a step with no returncode, so the replay cannot
 * adjudicate it either way and it counts as a divergence under the same rule
 * as any other unadjudicable step. Waiting the full bound buys no information,
 * so a recorded timeout is replayed under a short one. This changes what the
 * run costs, never what it counts.
 */
const RECORDED_TIMEOUT_STEP_MS = 60_000

function stepTimeoutMs(observation: string | null): number {
  return isRecordedTimeout(observation) ? RECORDED_TIMEOUT_STEP_MS : STEP_TIMEOUT_MS
}

/**
 * Zero model steps. The rollout stops where its own action left the container,
 * so every arm is compared at the same depth and no arm buys extra turns.
 *
 * The declaration is hashed rather than labelled, so the step budget travels
 * with the digest onto every admission decision this run publishes.
 */
const ZERO_STEP_CONTINUATION_POLICY = defineControlPolicy({
  id: 'zero-step-continuation',
  stepBudget: 0,
  scaffold: 'mini-swe-agent',
  model: null,
  commandTimeoutSeconds: Math.ceil(STEP_TIMEOUT_MS / 1000),
})

const INERT_CONTROL_CRITERIA: AdmissionCriteria = {
  ...TB_REPAIR_ADMISSION_CRITERIA,
  controlRollouts: CONTROL_ROLLOUTS,
  controlScreening: 'declared-inert',
}

const zeroStepContinuation: RepairContinuationRunner = async (): Promise<
  RepairContinuationOutcome
> => ({
  policyId: ZERO_STEP_CONTINUATION_POLICY.id,
  policyDigest: ZERO_STEP_CONTINUATION_POLICY.digest,
  steps: 0,
  exitStatus: 'zero-step-policy',
  submitted: false,
})

const TASK_ORACLES_PATH = join(
  import.meta.dirname,
  '..',
  'benchmarks',
  'trace-repair',
  'task-oracles.json',
)

function loadTaskOracles(): TaskOracleRegistry {
  return parseTaskOracleRegistry(JSON.parse(readFileSync(TASK_ORACLES_PATH, 'utf8')))
}

interface FeasibleRow {
  rowId: string
  taskName: string
  recordedModel: string
  recordedCommands: number
  unknownReturncodes: number
  unknownRatio: number
  finalReturncode: number | null
  steps: { step_id: number; action: string; observation: string | null }[]
}

interface TaskFixture {
  name: string
  image: string
  cwd: string
  suite: readonly TestSuiteFile[]
  suiteDigest: string
  oracleAction: string
  instruction: string
}

function loadSuite(task: string): TestSuiteFile[] {
  const dir = join(REPO, task, 'tests')
  const files: TestSuiteFile[] = []
  const walk = (rel: string): void => {
    for (const entry of readdirSync(join(dir, rel))) {
      const relPath = rel ? `${rel}/${entry}` : entry
      if (statSync(join(dir, relPath)).isDirectory()) walk(relPath)
      // Harbor uploads `tests/` to `/tests`, so the in-container path is the
      // suite-relative path under that root.
      else files.push({ path: `/tests/${relPath}`, contents: readFileSync(join(dir, relPath), 'utf8') })
    }
  }
  walk('')
  return files
}

async function imageDigest(image: string): Promise<string> {
  const { stdout } = await run('docker', [
    'image',
    'inspect',
    image,
    '--format',
    '{{index .RepoDigests 0}}',
  ])
  return stdout.trim()
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
  const suite = loadSuite(name)
  // The reference solution is the strongest repair the task admits. Its shebang
  // is dropped because the scaffold's action is already a shell command.
  // Braced so the multi-statement script is the one top-level statement the
  // scaffold takes per action. The budget module counts a compound block as
  // inside a statement, so this buys no extra action, only the same one.
  const body = readFileSync(join(REPO, name, 'solution', 'solve.sh'), 'utf8').replace(
    /^#![^\n]*\n/,
    '',
  )
  const solve = `{\n${body}\n}`
  return {
    name,
    image: await imageDigest(tag),
    cwd: workdir.trim() || '/app',
    suite,
    suiteDigest: testSuiteDigest(suite),
    oracleAction: solve,
    instruction: readFileSync(join(REPO, name, 'instruction.md'), 'utf8'),
  }
}

/** One fresh container per session, at the digest the trajectory was recorded against. */
function dockerSessions(image: string, cwd: string): RepairSessionFactory {
  return {
    async open(request: RepairSessionRequest): Promise<RepairSession> {
      const name = `tbr-${request.arm}-${request.rolloutIndex}-${randomUUID().slice(0, 8)}`
      // The recorded runs declare `allow_internet = true` and their test suites
      // fetch at grade time, so replay keeps the network the recording had.
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
      await run('docker', [
        'exec',
        name,
        'mkdir',
        '-p',
        '/logs/verifier',
        '/logs/agent',
        '/logs/artifacts',
      ])
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
    },
  }
}

/**
 * The held-out suite, uploaded from outside the container at grade time.
 *
 * `test.sh` always exits 0 — it writes the verdict to `/logs/verifier/reward.txt`
 * and returns the exit code of its own `echo`. The command therefore reads the
 * reward file, which is what harbor grades on.
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

interface ArmObservation {
  passed: boolean
  exitCode: number
  suiteDigest: string
  timedOut: boolean
  wallMs: number
}

/** Replay `steps`, optionally run `after`, then grade. One fresh container. */
async function runArm(
  sessions: RepairSessionFactory,
  oracle: TestOracle,
  task: TaskFixture,
  rowId: string,
  arm: 'no-fix-control' | 'no-op-control' | 'end-state',
  rolloutIndex: number,
  steps: readonly RecordedTrajectoryStep[],
  after: string | null,
): Promise<{ observation: ArmObservation; divergences: number; replayed: number }> {
  const startedMs = Date.now()
  const session = await sessions.open({ rowId, image: task.image, arm, rolloutIndex })
  try {
    let divergences = 0
    for (const step of steps) {
      const result = await session.exec(step.action, stepTimeoutMs(step.observation))
      const recorded = parseRecordedReturncode(step.observation)
      // An unadjudicable step is a divergence: the recording cannot confirm the
      // replayed state, so counting it as agreement would inflate fidelity.
      if (recorded === null || recorded !== result.exitCode) divergences += 1
    }
    if (after !== null) await session.exec(after, STEP_TIMEOUT_MS)
    const graded = await oracle.grade(session, { rowId, arm, rolloutIndex })
    return {
      observation: {
        passed: graded.passed,
        exitCode: graded.exitCode,
        suiteDigest: graded.suiteDigest,
        timedOut: graded.timedOut,
        wallMs: Date.now() - startedMs,
      },
      divergences,
      replayed: steps.length,
    }
  } finally {
    await session.close()
  }
}

interface RowOutcome {
  rowId: string
  taskName: string
  stratum: string
  recordedCommands: number
  admitted: boolean
  /** The control that screened this row, recorded whether it was admitted or not. */
  screening: AdmissionScreeningRecord | null
  rejection: string | null
  detail: string | null
  prefixDivergenceRatio: number | null
  endStatePassed: boolean | null
  noFixPasses: number | null
  noOpPasses: number | null
  admissionWallMs: number
  results: Record<string, RepairRowResult | null>
  gradeWallMs: Record<string, number>
}

async function processRow(
  row: FeasibleRow,
  task: TaskFixture,
  certification: OracleDeterminismVerdict,
  log: (message: string) => void,
): Promise<RowOutcome> {
  const sessions = dockerSessions(task.image, task.cwd)
  const oracle = taskOracle(task)
  const steps: RecordedTrajectoryStep[] = row.steps.map((s) => ({
    step_id: s.step_id,
    action: s.action,
    observation: s.observation,
  }))
  const stratum =
    row.finalReturncode === 0
      ? 'clean-exit'
      : (row.finalReturncode ?? 0) < 0
        ? 'signal-kill'
        : 'command-error'
  const base: RowOutcome = {
    rowId: row.rowId,
    taskName: row.taskName,
    stratum,
    recordedCommands: row.recordedCommands,
    admitted: false,
    screening: null,
    rejection: null,
    detail: null,
    prefixDivergenceRatio: null,
    endStatePassed: null,
    noFixPasses: null,
    noOpPasses: null,
    admissionWallMs: 0,
    results: {},
    gradeWallMs: {},
  }

  const admissionStart = Date.now()
  // The no-fix control replays the full recording and grades the end state, so
  // rollout 0 is also the end-state check. One arm, one set of containers.
  const noFix: ArmObservation[] = []
  let divergences = 0
  let replayed = 0
  for (let i = 0; i < CONTROL_ROLLOUTS; i += 1) {
    const r = await runArm(sessions, oracle, task, row.rowId, 'no-fix-control', i, steps, null)
    noFix.push(r.observation)
    if (i === 0) {
      divergences = r.divergences
      replayed = r.replayed
    }
    log(
      `${row.rowId} no-fix[${i}] passed=${r.observation.passed} divergences=${r.divergences}/${r.replayed} ${r.observation.wallMs}ms`,
    )
  }
  const noOp: ArmObservation[] = []
  for (let i = 0; i < CONTROL_ROLLOUTS; i += 1) {
    const r = await runArm(
      sessions,
      oracle,
      task,
      row.rowId,
      'no-op-control',
      i,
      steps,
      NO_OP_ACTION,
    )
    noOp.push(r.observation)
    log(`${row.rowId} no-op[${i}] passed=${r.observation.passed} ${r.observation.wallMs}ms`)
  }
  base.admissionWallMs = Date.now() - admissionStart
  base.prefixDivergenceRatio = replayed === 0 ? null : divergences / replayed
  base.endStatePassed = noFix[0]?.passed ?? null
  base.noFixPasses = noFix.filter((o) => o.passed).length
  base.noOpPasses = noOp.filter((o) => o.passed).length

  const evidence: AdmissionEvidence = {
    rowId: row.rowId,
    taskName: row.taskName,
    image: task.image,
    cwd: task.cwd,
    taskStatement: task.instruction,
    steps,
    oracleDeterminism: certification,
    controlPolicy: ZERO_STEP_CONTINUATION_POLICY,
    prefixFidelity: { stepsReplayed: replayed, divergences },
    endStatePassed: noFix[0]?.passed ?? true,
    suiteDigest: task.suiteDigest,
    noFixControl: {
      rollouts: noFix.length,
      passes: base.noFixPasses,
      policyDigest: ZERO_STEP_CONTINUATION_POLICY.digest,
    },
    noOpControl: {
      rollouts: noOp.length,
      passes: base.noOpPasses,
      policyDigest: ZERO_STEP_CONTINUATION_POLICY.digest,
    },
  }
  const decision = admitRow(evidence, INERT_CONTROL_CRITERIA)
  base.screening = decision.screening
  if (!decision.admitted) {
    base.rejection = decision.rejection
    base.detail = decision.detail
    log(`${row.rowId} EXCLUDED ${decision.rejection}: ${decision.detail}`)
    return base
  }
  base.admitted = true
  const admitted: AdmittedRow = decision.row

  // k is the last recorded command: the analyst answers "instead of the last
  // thing the agent did, do this". Both deterministic answers use the same k,
  // so the arms differ only in the action.
  const k = steps.length
  const answers: Record<string, AnalystResponse> = {
    'oracle-fix': repairFinding({
      k,
      failureClaim: 'the recorded run ended without satisfying the task',
      intervention: {
        kind: classifyActionPayload(task.oracleAction),
        action: task.oracleAction,
      },
    }),
    'inert-probe': repairFinding({
      k,
      failureClaim: 'the recorded run ended without satisfying the task',
      intervention: { kind: 'shell', action: INERT_PROBE_ACTION },
    }),
  }
  for (const [arm, response] of Object.entries(answers)) {
    const startedMs = Date.now()
    try {
      const result = await gradeRepairRow({
        row: admitted,
        response,
        sessions,
        oracle,
        continuation: zeroStepContinuation,
        repairRollouts: CONTROL_ROLLOUTS,
        stepTimeoutMs: STEP_TIMEOUT_MS,
        recordedTimeoutStepMs: RECORDED_TIMEOUT_STEP_MS,
      })
      base.results[arm] = result
      log(
        `${row.rowId} ${arm} outcome=${result.grade.outcome} intervention=${result.interventionRate} delta=${result.delta}`,
      )
    } catch (error) {
      base.results[arm] = null
      log(`${row.rowId} ${arm} ERROR ${(error as Error).message}`)
    }
    base.gradeWallMs[arm] = Date.now() - startedMs
  }
  return base
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

async function main(): Promise<void> {
  const concurrency = Number(process.env.TBR_CONCURRENCY ?? '6')
  const rows: FeasibleRow[] = JSON.parse(readFileSync(join(WORK, 'rows-sample.json'), 'utf8'))
  const taskNames = [...new Set(rows.map((r) => r.taskName))]
  // Before a container opens: every check this run makes reads the task's own
  // suite, so a task whose suite has not been shown to answer about the state
  // stops the run rather than contributing rows nobody can read.
  const taskOracles = loadTaskOracles()
  const uncertified = taskNames.filter((name) => !taskOracles.has(name))
  if (uncertified.length > 0) {
    throw new Error(
      `no oracle-determinism certification for ${uncertified.join(', ')} in ${TASK_ORACLES_PATH}; ` +
        'run benchmarks/trace-repair/tools/certify-task-oracle.sh for those tasks first',
    )
  }
  const tasks = new Map<string, TaskFixture>()
  for (const name of taskNames) tasks.set(name, await loadTask(name))
  mkdirSync(join(WORK, 'out'), { recursive: true })
  const logPath = join(WORK, 'out', 'run.log')
  writeFileSync(logPath, '')
  const log = (message: string): void => {
    const line = `${new Date().toISOString()} ${message}\n`
    process.stdout.write(line)
    // Appended per line so a run that dies mid-way still shows where it got to.
    writeFileSync(logPath, line, { flag: 'a' })
  }

  log(`rows=${rows.length} tasks=${taskNames.join(',')} concurrency=${concurrency}`)
  const startedMs = Date.now()
  const outcomes = await mapLimit(rows, concurrency, (row) =>
    processRow(row, tasks.get(row.taskName)!, taskOracles.get(row.taskName)!, log),
  )
  const wallMs = Date.now() - startedMs

  const report: Record<string, unknown> = {
    generatedAt: new Date().toISOString(),
    wallMs,
    concurrency,
    controlPolicy: ZERO_STEP_CONTINUATION_POLICY,
    criteria: INERT_CONTROL_CRITERIA,
    taskOracles: Object.fromEntries(
      [...taskOracles].map(([name, verdict]) => [
        name,
        { stable: verdict.stable, flipRate: verdict.flipRate, replicates: verdict.replicates },
      ]),
    ),
    images: Object.fromEntries([...tasks].map(([n, t]) => [n, t.image])),
    suiteDigests: Object.fromEntries([...tasks].map(([n, t]) => [n, t.suiteDigest])),
    outcomes,
  }
  for (const arm of ['oracle-fix', 'inert-probe']) {
    const graded = outcomes
      .map((o) => o.results[arm])
      .filter((r): r is RepairRowResult => r !== null && r !== undefined)
    report[arm] = graded.length === 0 ? null : deltaRepair(graded, { resamples: 10_000, seed: 7 })
  }
  writeFileSync(join(WORK, 'out', 'milestone1.json'), JSON.stringify(report, null, 2))
  log(`done wallMs=${wallMs}`)
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack}\n`)
  process.exit(1)
})
