/**
 * Milestone 3, phase 2: grade every arm with ONE grader, on ONE row set.
 *
 * The milestone-2 grades cannot be mixed with a grade produced now. The grader
 * moved between them — the action budget stopped rejecting a repair for how it
 * labels itself, and admission gained the control declaration — so a comparison
 * built from both would attribute a grader change to an arm. Model answers are
 * reused because they are what the money bought; the grading they get here is
 * new for every arm alike, and costs nothing but container time.
 *
 * The two reference arms are rebuilt rather than reused for the same reason:
 * the ceiling is the task's own reference solution and the floor is an inert
 * probe, so both are reconstructed from the task fixture and graded through the
 * identical path the analyst arms take.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AnalystResponse,
  admitRow,
  classifyActionPayload,
  gradeRepairRow,
  type RepairRowResult,
  repairFinding,
} from '../src/trace-repair'
import type { AnswerRecord } from './tb-repair-m2-analyze'
import {
  CONTROL_ROLLOUTS,
  dockerSessions,
  INERT_PROBE_ACTION,
  loadTask,
  makeLogger,
  mapLimit,
  RECORDED_TIMEOUT_STEP_MS,
  STEP_TIMEOUT_MS,
  type TaskFixture,
  taskOracle,
} from './tb-repair-m2-lib'
import {
  type LegacyAdmissionEvidence,
  M3_CONTROL_POLICY,
  M3_CRITERIA,
  m3ZeroStepContinuation,
  taskNameOf,
  upgradeEvidence,
} from './tb-repair-m3-lib'

/** Arms whose answers a model produced, and the file each was recorded in. */
interface ArmSource {
  readonly arm: string
  readonly file: string
  /** The arm id as recorded inside the file, when it differs from `arm`. */
  readonly recordedAs?: string
}

function responseOf(record: AnswerRecord): AnalystResponse | null {
  if (record.status === 'declined') return { kind: 'no-decisive-failure' }
  if (record.status !== 'finding' || record.k === null || record.action === null) return null
  return repairFinding({
    k: record.k,
    failureClaim: record.failureClaim ?? 'the recorded run did not satisfy the task',
    intervention: {
      kind: record.interventionKind === 'edit' ? 'edit' : 'shell',
      action: record.action,
    },
  })
}

function rejectionLabel(grade: unknown): string | null {
  const rejection = (grade as { rejection?: { source?: string; reason?: string } }).rejection
  if (!rejection || typeof rejection !== 'object') return null
  return `${rejection.source ?? 'unknown'}:${rejection.reason ?? 'unknown'}`
}

interface GradeUnit {
  rowId: string
  arm: string
  taskName: string
  answerStatus: string
  response: AnalystResponse | null
  k: number | null
  actionBytes: number | null
  costUsd: number | null
  calls: number | null
  inputTokens: number | null
  outputTokens: number | null
  answerWallMs: number | null
  source: 'reused-answer' | 'new-answer' | 'reference'
}

interface GradedAnswer extends Omit<GradeUnit, 'response'> {
  outcome: string | null
  rejection: string | null
  interventionRate: number | null
  delta: number | null
  gradeWallMs: number
  result: RepairRowResult | null
}

async function main(): Promise<void> {
  const m2Dir = process.env.TBR_OUT ?? '/home/drew/bench-cache/t8-milestone2/out'
  const m3Dir = process.env.TBR_M3_OUT ?? '/home/drew/bench-cache/tbench-20260808/m3'
  const concurrency = Number(process.env.TBR_CONCURRENCY ?? '6')
  mkdirSync(m3Dir, { recursive: true })

  const legacy = JSON.parse(readFileSync(join(m2Dir, 'admit.json'), 'utf8')) as {
    records: { rowId: string; admitted: boolean; evidence: LegacyAdmissionEvidence | null }[]
  }
  const measurementSet = new Set(
    JSON.parse(readFileSync(join(m3Dir, 'row-subset-m3.json'), 'utf8')) as string[],
  )
  const byRow = new Map(legacy.records.map((record) => [record.rowId, record]))

  const sources: ArmSource[] = [
    { arm: 'prime', file: join(m2Dir, 'answers-final.json') },
    { arm: 'bare-framing', file: join(m2Dir, 'answers-final.json') },
    { arm: 'dspy-repair', file: join(m3Dir, 'answers-dspy-repair.json') },
  ]

  const tasks = new Map<string, TaskFixture>()
  for (const rowId of measurementSet) {
    const name = taskNameOf(rowId)
    if (!tasks.has(name)) tasks.set(name, await loadTask(name))
  }

  const units: GradeUnit[] = []
  const missing: string[] = []
  for (const source of sources) {
    let answers: AnswerRecord[] = []
    try {
      answers = (JSON.parse(readFileSync(source.file, 'utf8')) as { answers: AnswerRecord[] }).answers
    } catch {
      missing.push(`${source.arm}: ${source.file} is unreadable`)
      continue
    }
    const recordedAs = source.recordedAs ?? source.arm
    for (const answer of answers) {
      if (answer.arm !== recordedAs) continue
      if (!measurementSet.has(answer.rowId)) continue
      units.push({
        rowId: answer.rowId,
        arm: source.arm,
        taskName: taskNameOf(answer.rowId),
        answerStatus: answer.status,
        response: responseOf(answer),
        k: answer.k,
        actionBytes: answer.actionBytes,
        costUsd: answer.costUsd,
        calls: answer.usage?.calls ?? null,
        inputTokens: answer.usage?.inputTokens ?? null,
        outputTokens: answer.usage?.outputTokens ?? null,
        answerWallMs: answer.wallMs,
        source: source.arm === 'dspy-repair' ? 'new-answer' : 'reused-answer',
      })
    }
  }

  // The reference arms. Rebuilt from the task fixture, so the ceiling is the
  // task's own reference solution and the floor writes a file nothing reads.
  for (const rowId of measurementSet) {
    const record = byRow.get(rowId)
    if (!record?.evidence) continue
    const taskName = taskNameOf(rowId)
    const task = tasks.get(taskName)!
    const k = record.evidence.steps.length
    const references = {
      'oracle-fix': {
        kind: classifyActionPayload(task.oracleAction),
        action: task.oracleAction,
      },
      'inert-probe': { kind: 'shell' as const, action: INERT_PROBE_ACTION },
    }
    for (const [arm, intervention] of Object.entries(references)) {
      units.push({
        rowId,
        arm,
        taskName,
        answerStatus: 'finding',
        response: repairFinding({
          k,
          failureClaim: 'the recorded run ended without satisfying the task',
          intervention,
        }),
        k,
        actionBytes: Buffer.byteLength(intervention.action),
        costUsd: 0,
        calls: 0,
        inputTokens: 0,
        outputTokens: 0,
        answerWallMs: null,
        source: 'reference',
      })
    }
  }

  const logPath = join(m3Dir, 'grade-m3.log')
  writeFileSync(logPath, '')
  const log = makeLogger((line) => writeFileSync(logPath, line, { flag: 'a' }))
  const arms = [...new Set(units.map((unit) => unit.arm))]
  log(
    `phase=m3-grade units=${units.length} rows=${measurementSet.size} arms=${arms.join(',')} ` +
      `concurrency=${concurrency} policy=${M3_CONTROL_POLICY.digest}`,
  )
  for (const gap of missing) log(`MISSING ${gap}`)

  const started = Date.now()
  const graded = await mapLimit(units, concurrency, async (unit): Promise<GradedAnswer> => {
    const { response, ...rest } = unit
    const base: GradedAnswer = {
      ...rest,
      outcome: null,
      rejection: null,
      interventionRate: null,
      delta: null,
      gradeWallMs: 0,
      result: null,
    }
    const record = byRow.get(unit.rowId)
    const task = tasks.get(unit.taskName)
    if (!record?.evidence || task === undefined) {
      log(`${unit.rowId} ${unit.arm} SKIPPED: no evidence`)
      return base
    }
    if (response === null) {
      // An arm that produced no answer is carried as a graded zero. Dropping it
      // would let an arm raise its own score by failing on hard rows.
      log(`${unit.rowId} ${unit.arm} no-answer (${unit.answerStatus}) — graded as zero`)
      return { ...base, outcome: 'no-answer' }
    }
    const decision = admitRow(upgradeEvidence(record.evidence), M3_CRITERIA)
    if (!decision.admitted) {
      log(`${unit.rowId} ${unit.arm} SKIPPED: ${decision.rejection}`)
      return base
    }
    const startedMs = Date.now()
    try {
      const result = await gradeRepairRow({
        row: decision.row,
        response,
        sessions: dockerSessions(task.image, task.cwd),
        oracle: taskOracle(task),
        continuation: m3ZeroStepContinuation,
        repairRollouts: CONTROL_ROLLOUTS,
        stepTimeoutMs: STEP_TIMEOUT_MS,
        recordedTimeoutStepMs: RECORDED_TIMEOUT_STEP_MS,
      })
      log(
        `${unit.rowId} ${unit.arm} outcome=${result.grade.outcome} rate=${result.interventionRate} delta=${result.delta}`,
      )
      return {
        ...base,
        outcome: result.grade.outcome,
        rejection: rejectionLabel(result.grade),
        interventionRate: result.interventionRate,
        delta: result.delta,
        gradeWallMs: Date.now() - startedMs,
        result,
      }
    } catch (error) {
      log(`${unit.rowId} ${unit.arm} ERROR ${(error as Error).message}`)
      return { ...base, outcome: 'error', gradeWallMs: Date.now() - startedMs }
    }
  })

  writeFileSync(
    join(m3Dir, 'grade-m3.json'),
    JSON.stringify(
      {
        phase: 'm3-grade',
        generatedAt: new Date().toISOString(),
        wallMs: Date.now() - started,
        concurrency,
        rows: [...measurementSet],
        controlPolicy: M3_CONTROL_POLICY,
        criteria: M3_CRITERIA,
        missing,
        graded,
      },
      null,
      2,
    ),
  )
  log(`graded=${graded.length} wall=${Math.round((Date.now() - started) / 1000)}s`)
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack}\n`)
  process.exit(1)
})
