/**
 * Milestone 2, phase 5: assemble every measured number for the comparison.
 *
 * Nothing here executes or spends. It reads the three artifacts the earlier
 * phases wrote — the admission record with the two deterministic controls, the
 * graded analyst answers, and the answer log with cost and wall — and restricts
 * all four arms to the SAME pre-registered rows, so the ceiling, the floor and
 * the two analysts are compared on one denominator.
 *
 * Two intervals travel with every arm. The row-level paired bootstrap treats
 * rows as independent, which they are not: rows from one task share an image, a
 * test suite and a failure mode. The task-clustered bootstrap resamples TASKS
 * and takes every row of a sampled task, which is the honest unit of
 * independence here — and with four tasks it is a wide, coarse interval, which
 * is the point.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { countFunnel, deltaRepair, type RepairRowResult } from '../src/trace-repair'
import type { AnswerRecord } from './tb-repair-m2-analyze'
import { WORK } from './tb-repair-m2-lib'

const BOOTSTRAP_RESAMPLES = 10_000
const BOOTSTRAP_SEED = 7

function taskOf(rowId: string): string {
  return rowId.split('::')[0]!
}

/** Deterministic 32-bit generator, so a reported interval reproduces exactly. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0 || 0x9e3779b9
  return () => {
    state ^= state << 13
    state ^= state >>> 17
    state ^= state << 5
    state >>>= 0
    return state / 0x100000000
  }
}

interface ClusterInterval {
  clusters: number
  rows: number
  mean: number
  low: number
  high: number
  confidence: number
  resamples: number
}

/**
 * Percentile interval over a bootstrap that resamples whole tasks.
 *
 * A row's paired difference is already the arm-minus-control quantity, so the
 * cluster bootstrap resamples those differences by task and re-means them.
 */
function clusteredBootstrap(
  rows: readonly { task: string; delta: number }[],
  confidence = 0.95,
): ClusterInterval {
  const byTask = new Map<string, number[]>()
  for (const row of rows) {
    const bucket = byTask.get(row.task)
    if (bucket) bucket.push(row.delta)
    else byTask.set(row.task, [row.delta])
  }
  const tasks = [...byTask.keys()].sort()
  const mean = rows.length === 0 ? 0 : rows.reduce((sum, r) => sum + r.delta, 0) / rows.length
  if (tasks.length === 0) {
    return { clusters: 0, rows: 0, mean: 0, low: 0, high: 0, confidence, resamples: 0 }
  }
  const rng = makeRng(BOOTSTRAP_SEED)
  const samples: number[] = []
  for (let draw = 0; draw < BOOTSTRAP_RESAMPLES; draw += 1) {
    let sum = 0
    let count = 0
    for (let pick = 0; pick < tasks.length; pick += 1) {
      const deltas = byTask.get(tasks[Math.floor(rng() * tasks.length)]!)!
      for (const delta of deltas) {
        sum += delta
        count += 1
      }
    }
    samples.push(count === 0 ? 0 : sum / count)
  }
  samples.sort((a, b) => a - b)
  const tail = (1 - confidence) / 2
  return {
    clusters: tasks.length,
    rows: rows.length,
    mean,
    low: samples[Math.floor(tail * (samples.length - 1))]!,
    high: samples[Math.ceil((1 - tail) * (samples.length - 1))]!,
    confidence,
    resamples: BOOTSTRAP_RESAMPLES,
  }
}

/** Percentile interval over a bootstrap that resamples ROWS, which assumes
 *  rows are independent. They are not: rows of one task share an image and a
 *  suite. Reported beside the clustered interval so the gap is visible. */
function rowBootstrap(
  rows: readonly { task: string; delta: number }[],
  confidence = 0.95,
): ClusterInterval {
  const deltas = rows.map((row) => row.delta)
  const mean = deltas.length === 0 ? 0 : deltas.reduce((sum, d) => sum + d, 0) / deltas.length
  if (deltas.length === 0) {
    return { clusters: 0, rows: 0, mean: 0, low: 0, high: 0, confidence, resamples: 0 }
  }
  const rng = makeRng(BOOTSTRAP_SEED)
  const samples: number[] = []
  for (let draw = 0; draw < BOOTSTRAP_RESAMPLES; draw += 1) {
    let sum = 0
    for (let pick = 0; pick < deltas.length; pick += 1) sum += deltas[Math.floor(rng() * deltas.length)]!
    samples.push(sum / deltas.length)
  }
  samples.sort((a, b) => a - b)
  const tail = (1 - confidence) / 2
  return {
    clusters: deltas.length,
    rows: deltas.length,
    mean,
    low: samples[Math.floor(tail * (samples.length - 1))]!,
    high: samples[Math.ceil((1 - tail) * (samples.length - 1))]!,
    confidence,
    resamples: BOOTSTRAP_RESAMPLES,
  }
}

interface ArmReport {
  arm: string
  execution: string
  source: string
  rows: number
  gradedRows: number
  noAnswerRows: number
  funnel: ReturnType<typeof countFunnel>
  interventionRate: number
  controlRate: number
  deltaRowBootstrap: ClusterInterval
  deltaTaskClustered: ClusterInterval
  measuredOnly: ReturnType<typeof deltaRepair>['measuredOnly']
  measuredRows: number
  threats: ReturnType<typeof deltaRepair>['threats']
  perTask: Record<string, { rows: number; mean: number }>
  answers: {
    finding: number
    declined: number
    failed: number
    reused: number
    ran: number
    costUsd: number | null
    costUncapturedRows: number
    wallMsTotal: number
    wallMsMedian: number | null
  } | null
  rowDeltas: { rowId: string; task: string; delta: number; outcome: string | null }[]
}

function summarize(
  arm: string,
  execution: string,
  source: string,
  results: readonly RepairRowResult[],
  answers: readonly AnswerRecord[] | null,
  provenance: readonly { arm: string; rowId: string; source: string }[],
  subset: ReadonlySet<string>,
): ArmReport {
  const report = deltaRepair(results, { resamples: BOOTSTRAP_RESAMPLES, seed: BOOTSTRAP_SEED })
  const graded = new Map(results.map((result) => [result.rowId, result]))
  // EVERY pre-registered row, for EVERY arm. A row an arm never answered — a
  // reply that stayed malformed, a turn that hit its deadline — contributes a
  // paired difference of exactly zero rather than leaving the denominator.
  // Dropping it is the one way an arm can raise its own score by failing on
  // the rows it finds hardest.
  const rowDeltas = [...subset].sort().map((rowId) => {
    const result = graded.get(rowId)
    return {
      rowId,
      task: taskOf(rowId),
      delta: result?.delta ?? 0,
      outcome: result ? ((result.grade as { outcome?: string }).outcome ?? null) : 'no-answer',
    }
  })
  const perTask: Record<string, { rows: number; mean: number }> = {}
  for (const row of rowDeltas) {
    const bucket = (perTask[row.task] ??= { rows: 0, mean: 0 })
    bucket.rows += 1
    bucket.mean += row.delta
  }
  for (const key of Object.keys(perTask)) perTask[key]!.mean /= perTask[key]!.rows
  const walls = (answers ?? []).map((a) => a.wallMs).sort((a, b) => a - b)
  const priced = (answers ?? []).filter((a) => a.costUsd !== null)
  return {
    arm,
    execution,
    source,
    rows: rowDeltas.length,
    gradedRows: results.length,
    noAnswerRows: rowDeltas.filter((row) => row.outcome === 'no-answer').length,
    funnel: report.funnel,
    interventionRate: rowDeltas.filter((row) => row.delta > 0).length / rowDeltas.length,
    controlRate: report.controlRate,
    deltaRowBootstrap: rowBootstrap(rowDeltas),
    deltaTaskClustered: clusteredBootstrap(rowDeltas),
    measuredOnly: report.measuredOnly,
    measuredRows: report.measuredRows,
    threats: report.threats,
    perTask,
    answers:
      answers === null
        ? null
        : {
            finding: answers.filter((a) => a.status === 'finding').length,
            declined: answers.filter((a) => a.status === 'declined').length,
            failed: answers.filter((a) => a.status === 'failed').length,
            reused: provenance.filter((p) => p.arm === arm && p.source === 'reused').length,
            ran: provenance.filter((p) => p.arm === arm && p.source === 'ran').length,
            costUsd: priced.length === 0 ? null : priced.reduce((sum, a) => sum + (a.costUsd ?? 0), 0),
            costUncapturedRows: answers.length - priced.length,
            wallMsTotal: walls.reduce((sum, w) => sum + w, 0),
            wallMsMedian: walls.length === 0 ? null : walls[Math.floor(walls.length / 2)]!,
          },
    rowDeltas,
  }
}

function main(): void {
  const outDir = process.env.TBR_OUT ?? join(WORK, 'out')
  const admit = JSON.parse(readFileSync(join(outDir, 'admit.json'), 'utf8')) as {
    records: { rowId: string; taskName: string; admitted: boolean; stratum: string }[]
    images: Record<string, string>
    suiteDigests: Record<string, string>
    'oracle-fix': { rowResults: RepairRowResult[] }
    'inert-probe': { rowResults: RepairRowResult[] }
  }
  const subset = new Set(JSON.parse(readFileSync(join(outDir, 'row-subset.json'), 'utf8')) as string[])
  const answerDoc = JSON.parse(readFileSync(join(outDir, process.env.TBR_ANSWER_DOC ?? 'answers-v2.json'), 'utf8')) as {
    arms: { id: string; execution: string }[]
    provenance: { arm: string; rowId: string; source: string }[]
    answers: AnswerRecord[]
  }
  const grade = JSON.parse(readFileSync(join(outDir, 'grade.json'), 'utf8')) as {
    graded: { rowId: string; arm: string; result: RepairRowResult | null }[]
  }

  const inSubset = (result: RepairRowResult): boolean => subset.has(result.rowId)
  const arms: ArmReport[] = []
  for (const control of ['oracle-fix', 'inert-probe'] as const) {
    arms.push(
      summarize(
        control,
        control === 'oracle-fix'
          ? 'the task solution applied at the failing step — the ceiling an execution grader can pay'
          : 'a harmless command that changes nothing — the floor a grader must not pay',
        'admit.json, graded in phase 1 and restricted here to the pre-registered rows',
        admit[control].rowResults.filter(inSubset),
        null,
        [],
        subset,
      ),
    )
  }
  for (const arm of answerDoc.arms) {
    const results = grade.graded
      .filter((g) => g.arm === arm.id && g.result !== null && subset.has(g.rowId))
      .map((g) => g.result!)
    arms.push(
      summarize(
        arm.id,
        arm.execution,
        'answers-v2.json graded in phase 4',
        results,
        answerDoc.answers.filter((a) => a.arm === arm.id && subset.has(a.rowId)),
        answerDoc.provenance,
        subset,
      ),
    )
  }

  // The question the run exists for: on the SAME row, does the harness repair
  // what one-shot inline framing does not. Per-arm Delta-repair answers "is
  // this arm above its own control"; only the paired difference of the two
  // arms answers "is one above the other", and it is paired because both arms
  // saw the same trajectory, image and suite.
  const contrasts: Record<string, unknown>[] = []
  const byArm = new Map(arms.map((arm) => [arm.arm, arm]))
  for (const [left, right] of [['prime', 'bare-framing']] as const) {
    const a = byArm.get(left)
    const b = byArm.get(right)
    if (!a || !b) continue
    const rightDelta = new Map(b.rowDeltas.map((row) => [row.rowId, row.delta]))
    const paired = a.rowDeltas
      .filter((row) => rightDelta.has(row.rowId))
      .map((row) => ({ rowId: row.rowId, task: row.task, delta: row.delta - rightDelta.get(row.rowId)! }))
    const wins = paired.filter((row) => row.delta > 0).length
    const losses = paired.filter((row) => row.delta < 0).length
    contrasts.push({
      contrast: `${left} minus ${right}`,
      pairedRows: paired.length,
      mean: paired.length === 0 ? null : paired.reduce((sum, row) => sum + row.delta, 0) / paired.length,
      rowsWhereLeftWins: wins,
      rowsWhereRightWins: losses,
      rowsTied: paired.length - wins - losses,
      taskClustered: clusteredBootstrap(paired),
      perRow: paired,
    })
  }

  const denominator = {
    admittedRows: admit.records.filter((r) => r.admitted).length,
    corpusRows: admit.records.length,
    subsetRows: subset.size,
    byTask: [...subset].reduce<Record<string, number>>((counts, rowId) => {
      counts[taskOf(rowId)] = (counts[taskOf(rowId)] ?? 0) + 1
      return counts
    }, {}),
    byStratum: admit.records
      .filter((r) => subset.has(r.rowId))
      .reduce<Record<string, number>>((counts, record) => {
        counts[record.stratum] = (counts[record.stratum] ?? 0) + 1
        return counts
      }, {}),
  }

  const report = {
    phase: 'report',
    generatedAt: new Date().toISOString(),
    denominator,
    contrasts,
    images: admit.images,
    suiteDigests: admit.suiteDigests,
    arms,
  }
  writeFileSync(join(outDir, 'report.json'), JSON.stringify(report, null, 2))
  process.stdout.write(`report -> ${join(outDir, 'report.json')}\n`)
  for (const contrast of contrasts) {
    process.stdout.write(
      `${String(contrast.contrast)}: mean=${contrast.mean === null ? 'n/a' : (contrast.mean as number).toFixed(3)} ` +
        `n=${String(contrast.pairedRows)} wins=${String(contrast.rowsWhereLeftWins)} losses=${String(contrast.rowsWhereRightWins)} ` +
        `ties=${String(contrast.rowsTied)} task95=[${(contrast.taskClustered as ClusterInterval).low.toFixed(3)},${(contrast.taskClustered as ClusterInterval).high.toFixed(3)}]\n`,
    )
  }
  for (const arm of arms) {
    process.stdout.write(
      `${arm.arm.padEnd(13)} n=${arm.rows} delta=${arm.deltaRowBootstrap.mean.toFixed(3)} ` +
        `row95=[${arm.deltaRowBootstrap.low.toFixed(3)},${arm.deltaRowBootstrap.high.toFixed(3)}] ` +
        `task95=[${arm.deltaTaskClustered.low.toFixed(3)},${arm.deltaTaskClustered.high.toFixed(3)}] ` +
        `t2=${arm.funnel.t2Executed} t3=${arm.funnel.t3LocalFlip} t4=${arm.funnel.t4RepairFlipAll} ` +
        `cost=${arm.answers?.costUsd === undefined || arm.answers?.costUsd === null ? 'n/a' : `$${arm.answers.costUsd.toFixed(4)}`}\n`,
    )
  }
}

main()
