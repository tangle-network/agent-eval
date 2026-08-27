/**
 * Milestone 2, phase 1: fix the denominator and measure the two deterministic
 * arms. No model is called here.
 *
 * Runs the admission pre-pass over the whole stage-10 pool rather than the
 * milestone 1 sample, then grades `oracle-fix` and `inert-probe` on every
 * admitted row. Those two arms bracket what the analysts are later measured
 * against: the strongest repair the task admits, and an action that executes
 * and repairs nothing.
 *
 * Writes `evidence.json`, which carries the recorded admission evidence for
 * every row. The later phases re-run `admitRow` on it rather than trusting a
 * serialized verdict.
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AdmissionEvidence,
  admitRow,
  type AdmittedRow,
  classifyActionPayload,
  deltaRepair,
  gradeRepairRow,
  type RepairRowResult,
  repairFinding,
} from '../src/trace-repair'
import type { RecordedTrajectoryStep } from '../src/trajectory-replay/steps'
import {
  CONTROL_ROLLOUTS,
  dockerSessions,
  type FeasibleRow,
  INERT_PROBE_ACTION,
  loadTask,
  makeLogger,
  mapLimit,
  recordedReturncode,
  RECORDED_TIMEOUT_STEP_MS,
  STEP_TIMEOUT_MS,
  stepTimeoutMs,
  stratumOfRow,
  type TaskFixture,
  taskOracle,
  WORK,
  ZERO_STEP_CONTINUATION_POLICY,
  zeroStepContinuation,
} from './tb-repair-m2-lib'

const NO_OP_ACTION = 'true'

interface ArmObservation {
  passed: boolean
  wallMs: number
}

async function runControlArm(
  task: TaskFixture,
  rowId: string,
  arm: 'no-fix-control' | 'no-op-control',
  rolloutIndex: number,
  steps: readonly RecordedTrajectoryStep[],
  after: string | null,
): Promise<{ observation: ArmObservation; divergences: number; replayed: number }> {
  const startedMs = Date.now()
  const sessions = dockerSessions(task.image, task.cwd)
  const oracle = taskOracle(task)
  const session = await sessions.open({ rowId, image: task.image, arm, rolloutIndex })
  try {
    let divergences = 0
    for (const step of steps) {
      const result = await session.exec(step.action, stepTimeoutMs(step.observation))
      const recorded = recordedReturncode(step.observation)
      if (recorded === null || recorded !== result.exitCode) divergences += 1
    }
    if (after !== null) await session.exec(after, STEP_TIMEOUT_MS)
    const graded = await oracle.grade(session, { rowId, arm, rolloutIndex })
    return {
      observation: { passed: graded.passed, wallMs: Date.now() - startedMs },
      divergences,
      replayed: steps.length,
    }
  } finally {
    await session.close()
  }
}

export interface RowRecord {
  rowId: string
  taskName: string
  stratum: string
  recordedModel: string
  recordedCommands: number
  admitted: boolean
  rejection: string | null
  detail: string | null
  prefixDivergenceRatio: number | null
  noFixPasses: number | null
  noOpPasses: number | null
  admissionWallMs: number
  evidence: AdmissionEvidence | null
  results: Record<string, RepairRowResult | null>
  gradeWallMs: Record<string, number>
}

async function processRow(
  row: FeasibleRow,
  task: TaskFixture,
  log: (message: string) => void,
): Promise<RowRecord> {
  const steps: RecordedTrajectoryStep[] = row.steps.map((s) => ({
    step_id: s.step_id,
    action: s.action,
    observation: s.observation,
  }))
  const base: RowRecord = {
    rowId: row.rowId,
    taskName: row.taskName,
    stratum: stratumOfRow(row.finalReturncode),
    recordedModel: row.recordedModel,
    recordedCommands: row.recordedCommands,
    admitted: false,
    rejection: null,
    detail: null,
    prefixDivergenceRatio: null,
    noFixPasses: null,
    noOpPasses: null,
    admissionWallMs: 0,
    evidence: null,
    results: {},
    gradeWallMs: {},
  }

  const admissionStart = Date.now()
  const noFix: ArmObservation[] = []
  let divergences = 0
  let replayed = 0
  for (let i = 0; i < CONTROL_ROLLOUTS; i += 1) {
    const r = await runControlArm(task, row.rowId, 'no-fix-control', i, steps, null)
    noFix.push(r.observation)
    if (i === 0) {
      divergences = r.divergences
      replayed = r.replayed
    }
    log(`${row.rowId} no-fix[${i}] passed=${r.observation.passed} div=${r.divergences}/${r.replayed}`)
  }
  const noOp: ArmObservation[] = []
  for (let i = 0; i < CONTROL_ROLLOUTS; i += 1) {
    const r = await runControlArm(task, row.rowId, 'no-op-control', i, steps, NO_OP_ACTION)
    noOp.push(r.observation)
    log(`${row.rowId} no-op[${i}] passed=${r.observation.passed}`)
  }
  base.admissionWallMs = Date.now() - admissionStart
  base.prefixDivergenceRatio = replayed === 0 ? null : divergences / replayed
  base.noFixPasses = noFix.filter((o) => o.passed).length
  base.noOpPasses = noOp.filter((o) => o.passed).length

  const evidence: AdmissionEvidence = {
    rowId: row.rowId,
    image: task.image,
    cwd: task.cwd,
    taskStatement: task.instruction,
    steps,
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
  base.evidence = evidence
  const decision = admitRow(evidence)
  if (!decision.admitted) {
    base.rejection = decision.rejection
    base.detail = decision.detail
    log(`${row.rowId} EXCLUDED ${decision.rejection}: ${decision.detail}`)
    return base
  }
  base.admitted = true
  const admitted: AdmittedRow = decision.row
  const k = steps.length
  const answers = {
    'oracle-fix': repairFinding({
      k,
      failureClaim: 'the recorded run ended without satisfying the task',
      intervention: { kind: classifyActionPayload(task.oracleAction), action: task.oracleAction },
    }),
    'inert-probe': repairFinding({
      k,
      failureClaim: 'the recorded run ended without satisfying the task',
      intervention: { kind: 'shell' as const, action: INERT_PROBE_ACTION },
    }),
  }
  for (const [arm, response] of Object.entries(answers)) {
    const startedMs = Date.now()
    try {
      const result = await gradeRepairRow({
        row: admitted,
        response,
        sessions: dockerSessions(task.image, task.cwd),
        oracle: taskOracle(task),
        continuation: zeroStepContinuation,
        repairRollouts: CONTROL_ROLLOUTS,
        stepTimeoutMs: STEP_TIMEOUT_MS,
        recordedTimeoutStepMs: RECORDED_TIMEOUT_STEP_MS,
      })
      base.results[arm] = result
      log(`${row.rowId} ${arm} outcome=${result.grade.outcome} rate=${result.interventionRate}`)
    } catch (error) {
      base.results[arm] = null
      log(`${row.rowId} ${arm} ERROR ${(error as Error).message}`)
    }
    base.gradeWallMs[arm] = Date.now() - startedMs
  }
  return base
}

async function main(): Promise<void> {
  const concurrency = Number(process.env.TBR_CONCURRENCY ?? '6')
  const rowsFile = process.env.TBR_ROWS ?? join(WORK, 'rows-all.json')
  const outDir = process.env.TBR_OUT ?? join(WORK, 'out')
  const rows: FeasibleRow[] = JSON.parse(readFileSync(rowsFile, 'utf8'))
  const taskNames = [...new Set(rows.map((r) => r.taskName))]
  const tasks = new Map<string, TaskFixture>()
  for (const name of taskNames) tasks.set(name, await loadTask(name))
  mkdirSync(outDir, { recursive: true })
  const logPath = join(outDir, 'admit.log')
  writeFileSync(logPath, '')
  const log = makeLogger((line) => writeFileSync(logPath, line, { flag: 'a' }))

  log(`phase=admit rows=${rows.length} tasks=${taskNames.join(',')} concurrency=${concurrency}`)
  const startedMs = Date.now()
  const records = await mapLimit(rows, concurrency, (row) => processRow(row, tasks.get(row.taskName)!, log))
  const wallMs = Date.now() - startedMs

  const report: Record<string, unknown> = {
    phase: 'admit',
    generatedAt: new Date().toISOString(),
    wallMs,
    concurrency,
    policy: ZERO_STEP_CONTINUATION_POLICY,
    images: Object.fromEntries([...tasks].map(([n, t]) => [n, t.image])),
    suiteDigests: Object.fromEntries([...tasks].map(([n, t]) => [n, t.suiteDigest])),
    records,
  }
  for (const arm of ['oracle-fix', 'inert-probe']) {
    const graded = records
      .map((r) => r.results[arm])
      .filter((r): r is RepairRowResult => r !== null && r !== undefined)
    report[arm] = graded.length === 0 ? null : deltaRepair(graded, { resamples: 10_000, seed: 7 })
  }
  writeFileSync(join(outDir, 'admit.json'), JSON.stringify(report, null, 2))
  log(`done admitted=${records.filter((r) => r.admitted).length}/${records.length} wallMs=${wallMs}`)
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack}\n`)
  process.exit(1)
})
