/**
 * Milestone 2, phase 3: execute every analyst's answer and price it.
 *
 * Each arm's recorded answer goes through `gradeRepairRow` — the same grader,
 * the same rollout count, the same pinned continuation and the same held-out
 * suite the deterministic arms went through in phase 1. No model runs here, so
 * an arm's score cannot depend on when it was graded.
 *
 * A row an arm failed to answer is carried as a graded zero rather than dropped.
 * Dropping it would let an arm raise its own score by failing on hard rows,
 * which is the one degenerate strategy a per-arm denominator cannot catch.
 */

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import {
  type AdmissionEvidence,
  admitRow,
  type AnalystResponse,
  deltaRepair,
  gradeRepairRow,
  type RepairRowResult,
  repairFinding,
} from '../src/trace-repair'
import type { AnswerRecord } from './tb-repair-m2-analyze'
import {
  CONTROL_ROLLOUTS,
  dockerSessions,
  loadTask,
  makeLogger,
  mapLimit,
  RECORDED_TIMEOUT_STEP_MS,
  STEP_TIMEOUT_MS,
  type TaskFixture,
  taskOracle,
  WORK,
  zeroStepContinuation,
} from './tb-repair-m2-lib'

function responseOf(record: AnswerRecord): AnalystResponse | null {
  if (record.status === 'declined') return { kind: 'no-decisive-failure' }
  if (record.status !== 'finding' || record.k === null || record.action === null) return null
  return repairFinding({
    k: record.k,
    failureClaim: record.failureClaim ?? 'the recorded run did not satisfy the task',
    intervention: { kind: record.interventionKind === 'edit' ? 'edit' : 'shell', action: record.action },
  })
}

/** `source:reason` — the two fields that say WHICH gate refused the answer. */
function rejectionLabel(grade: unknown): string | null {
  const rejection = (grade as { rejection?: { source?: string; reason?: string } }).rejection
  if (!rejection || typeof rejection !== 'object') return null
  return `${rejection.source ?? 'unknown'}:${rejection.reason ?? 'unknown'}`
}

interface GradedAnswer {
  rowId: string
  arm: string
  taskName: string
  answerStatus: string
  k: number | null
  actionBytes: number | null
  outcome: string | null
  rejection: string | null
  interventionRate: number | null
  delta: number | null
  gradeWallMs: number
  result: RepairRowResult | null
}

async function main(): Promise<void> {
  const outDir = process.env.TBR_OUT ?? join(WORK, 'out')
  const concurrency = Number(process.env.TBR_CONCURRENCY ?? '6')
  const admit = JSON.parse(readFileSync(join(outDir, 'admit.json'), 'utf8')) as {
    records: { rowId: string; taskName: string; admitted: boolean; evidence: AdmissionEvidence | null }[]
  }
  const answers: AnswerRecord[] = []
  // Which answer files carry the arms being graded. Explicit because a rerun
  // writes a new file beside the old one, and grading both would enter two
  // answers for one arm-row pair and silently double its denominator.
  const answerFiles = (process.env.TBR_ANSWER_FILES ?? 'answers.json,answers-dspy.json')
    .split(',')
    .map((name) => name.trim())
    .filter(Boolean)
  for (const file of answerFiles) {
    try {
      const parsed = JSON.parse(readFileSync(join(outDir, file), 'utf8')) as { answers: AnswerRecord[] }
      answers.push(...parsed.answers)
    } catch {
      // an arm that did not run contributes no answers; the report says so
    }
  }
  const byRow = new Map(admit.records.map((r) => [r.rowId, r]))
  const tasks = new Map<string, TaskFixture>()
  for (const name of new Set(admit.records.map((r) => r.taskName))) tasks.set(name, await loadTask(name))

  mkdirSync(outDir, { recursive: true })
  const logPath = join(outDir, 'grade.log')
  writeFileSync(logPath, '')
  const log = makeLogger((line) => writeFileSync(logPath, line, { flag: 'a' }))
  const arms = [...new Set(answers.map((a) => a.arm))]
  log(`phase=grade answers=${answers.length} arms=${arms.join(',')} concurrency=${concurrency}`)

  const started = Date.now()
  const graded = await mapLimit(answers, concurrency, async (answer): Promise<GradedAnswer> => {
    const row = byRow.get(answer.rowId)
    const task = row ? tasks.get(row.taskName) : undefined
    const base: GradedAnswer = {
      rowId: answer.rowId,
      arm: answer.arm,
      taskName: row?.taskName ?? 'unknown',
      answerStatus: answer.status,
      k: answer.k,
      actionBytes: answer.actionBytes,
      outcome: null,
      rejection: null,
      interventionRate: null,
      delta: null,
      gradeWallMs: 0,
      result: null,
    }
    if (!row || !row.admitted || row.evidence === null || task === undefined) {
      log(`${answer.rowId} ${answer.arm} SKIPPED: row is not admitted`)
      return base
    }
    const response = responseOf(answer)
    if (response === null) {
      log(`${answer.rowId} ${answer.arm} no-answer (${answer.status}) — graded as zero`)
      return { ...base, outcome: 'no-answer' }
    }
    const decision = admitRow(row.evidence)
    if (!decision.admitted) return base
    const startedMs = Date.now()
    try {
      const result = await gradeRepairRow({
        row: decision.row,
        response,
        sessions: dockerSessions(task.image, task.cwd),
        oracle: taskOracle(task),
        continuation: zeroStepContinuation,
        repairRollouts: CONTROL_ROLLOUTS,
        stepTimeoutMs: STEP_TIMEOUT_MS,
        recordedTimeoutStepMs: RECORDED_TIMEOUT_STEP_MS,
      })
      log(
        `${answer.rowId} ${answer.arm} outcome=${result.grade.outcome} rate=${result.interventionRate} delta=${result.delta}`,
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
      log(`${answer.rowId} ${answer.arm} ERROR ${(error as Error).message}`)
      return { ...base, outcome: 'error', gradeWallMs: Date.now() - startedMs }
    }
  })
  const wallMs = Date.now() - started

  const report: Record<string, unknown> = {
    phase: 'grade',
    generatedAt: new Date().toISOString(),
    wallMs,
    concurrency,
    graded,
  }
  for (const arm of arms) {
    const results = graded
      .filter((g) => g.arm === arm)
      .map((g) => g.result)
      .filter((r): r is RepairRowResult => r !== null)
    report[arm] = results.length === 0 ? null : deltaRepair(results, { resamples: 10_000, seed: 7 })
  }
  writeFileSync(join(outDir, 'grade.json'), JSON.stringify(report, null, 2))
  log(`done graded=${graded.length} wallMs=${wallMs}`)
}

main().catch((error) => {
  process.stderr.write(`${(error as Error).stack}\n`)
  process.exit(1)
})
