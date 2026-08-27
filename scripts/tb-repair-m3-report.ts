/**
 * Milestone 3, phase 3: every arm against every other, on the same rows.
 *
 * Three things this reports that a per-arm table cannot:
 *
 *   arm vs arm      the paired difference between EVERY pair of arms, not only
 *                   each arm against the controls. "Does the harness beat the
 *                   incumbent analyst" and "does either beat one bare prompt"
 *                   are different questions and get different rows.
 *   clusters        every interval is bootstrapped over TASKS, because rows of
 *                   one task share an image and a suite and are not independent
 *                   draws. The row-level interval is reported beside it so the
 *                   gap between the two is visible rather than chosen.
 *   unmeasured      a ceiling arm whose own reference solution failed to
 *                   execute is UNMEASURED on that task, never a measured zero.
 *                   A zero would read as "no fix exists" when what happened is
 *                   that the fix was written in a shell the scaffold does not
 *                   run.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { countFunnel } from '../src/trace-repair'

const BOOTSTRAP_RESAMPLES = 10_000
const BOOTSTRAP_SEED = 20260810

/** Deterministic PRNG: the same rows give the same interval on every run. */
function makeRng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (state * 1_664_525 + 1_013_904_223) >>> 0
    return state / 0x1_0000_0000
  }
}

interface Interval {
  clusters: number
  rows: number
  mean: number
  low: number
  high: number
  resamples: number
}

interface RowDelta {
  task: string
  delta: number
}

/** Resamples TASKS with replacement, carrying each task's rows whole. */
function clusteredBootstrap(rows: readonly RowDelta[], confidence = 0.95): Interval {
  const byTask = new Map<string, number[]>()
  for (const row of rows) {
    const bucket = byTask.get(row.task)
    if (bucket) bucket.push(row.delta)
    else byTask.set(row.task, [row.delta])
  }
  const tasks = [...byTask.keys()].sort()
  const mean = rows.length === 0 ? 0 : rows.reduce((sum, r) => sum + r.delta, 0) / rows.length
  if (tasks.length === 0) return { clusters: 0, rows: 0, mean: 0, low: 0, high: 0, resamples: 0 }
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
    resamples: BOOTSTRAP_RESAMPLES,
  }
}

/** Resamples ROWS, which assumes rows are independent. They are not; reported
 *  only so the difference from the clustered interval is visible. */
function rowBootstrap(rows: readonly RowDelta[], confidence = 0.95): Interval {
  const deltas = rows.map((row) => row.delta)
  const mean = deltas.length === 0 ? 0 : deltas.reduce((sum, d) => sum + d, 0) / deltas.length
  if (deltas.length === 0) return { clusters: 0, rows: 0, mean: 0, low: 0, high: 0, resamples: 0 }
  const rng = makeRng(BOOTSTRAP_SEED)
  const samples: number[] = []
  for (let draw = 0; draw < BOOTSTRAP_RESAMPLES; draw += 1) {
    let sum = 0
    for (let pick = 0; pick < deltas.length; pick += 1) {
      sum += deltas[Math.floor(rng() * deltas.length)]!
    }
    samples.push(sum / deltas.length)
  }
  samples.sort((a, b) => a - b)
  const tail = (1 - confidence) / 2
  return {
    clusters: new Set(rows.map((r) => r.task)).size,
    rows: deltas.length,
    mean,
    low: samples[Math.floor(tail * (samples.length - 1))]!,
    high: samples[Math.ceil((1 - tail) * (samples.length - 1))]!,
    resamples: BOOTSTRAP_RESAMPLES,
  }
}

interface GradedAnswer {
  rowId: string
  arm: string
  taskName: string
  answerStatus: string
  k: number | null
  actionBytes: number | null
  costUsd: number | null
  calls: number | null
  inputTokens: number | null
  outputTokens: number | null
  answerWallMs: number | null
  source: string
  outcome: string | null
  rejection: string | null
  interventionRate: number | null
  delta: number | null
  gradeWallMs: number
  result: { grade: Parameters<typeof countFunnel>[0][number] } | null
}

const ANALYST_ARMS = ['dspy-repair', 'prime', 'bare-framing']
const REFERENCE_ARMS = ['oracle-fix', 'inert-probe']

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

function main(): void {
  const m3Dir = process.env.TBR_M3_OUT ?? '/home/drew/bench-cache/tbench-20260808/m3'
  const grade = JSON.parse(readFileSync(join(m3Dir, 'grade-m3.json'), 'utf8')) as {
    rows: string[]
    graded: GradedAnswer[]
  }
  const rows = grade.rows
  const arms = [...new Set(grade.graded.map((g) => g.arm))]

  const byArm = new Map<string, Map<string, GradedAnswer>>()
  for (const unit of grade.graded) {
    const bucket = byArm.get(unit.arm) ?? new Map<string, GradedAnswer>()
    bucket.set(unit.rowId, unit)
    byArm.set(unit.arm, bucket)
  }

  /** An arm's per-row repair delta. A row it never answered counts as zero. */
  const deltasOf = (arm: string): RowDelta[] =>
    rows.map((rowId) => {
      const unit = byArm.get(arm)?.get(rowId)
      return { task: rowId.split('::')[0]!, delta: unit?.delta ?? 0 }
    })

  const armReports = arms.map((arm) => {
    const units = rows.map((rowId) => byArm.get(arm)?.get(rowId)).filter((u): u is GradedAnswer => !!u)
    const deltas = deltasOf(arm)
    const outcomes = new Map<string, number>()
    for (const unit of units) {
      const key = unit.outcome ?? 'ungraded'
      outcomes.set(key, (outcomes.get(key) ?? 0) + 1)
    }
    const statuses = new Map<string, number>()
    for (const unit of units) statuses.set(unit.answerStatus, (statuses.get(unit.answerStatus) ?? 0) + 1)
    const costs = units.map((u) => u.costUsd).filter((c): c is number => c !== null)
    const uncaptured = units.filter((u) => u.costUsd === null).length
    const calls = units.map((u) => u.calls).filter((c): c is number => c !== null)
    const bytes = units.map((u) => u.actionBytes).filter((b): b is number => b !== null)

    // Per-task ceiling reading: an arm whose action never executed on a task is
    // unmeasured there, not zero.
    const byTask = new Map<string, GradedAnswer[]>()
    for (const unit of units) {
      const bucket = byTask.get(unit.taskName) ?? []
      bucket.push(unit)
      byTask.set(unit.taskName, bucket)
    }
    const perTask = [...byTask.entries()].sort().map(([task, taskUnits]) => {
      const executed = taskUnits.filter((u) => u.outcome !== 'did-not-execute')
      const rate =
        executed.length === 0
          ? null
          : executed.reduce((sum, u) => sum + (u.delta ?? 0), 0) / executed.length
      return {
        task,
        rows: taskUnits.length,
        didNotExecute: taskUnits.filter((u) => u.outcome === 'did-not-execute').length,
        repaired: taskUnits.filter((u) => (u.delta ?? 0) > 0).length,
        rate,
        measured: executed.length > 0,
      }
    })

    // Counted by the substrate's own funnel, over the grades that exist. Rows
    // the arm never answered carry no grade, so `rows` below is the arm's
    // denominator and the gap to it is the arm's unanswered count.
    const grades = units.map((u) => u.result?.grade).filter((g): g is NonNullable<typeof g> => !!g)
    return {
      arm,
      rows: units.length,
      funnel: { ...countFunnel(grades), answered: grades.length, denominator: rows.length },
      answerStatuses: Object.fromEntries(statuses),
      outcomes: Object.fromEntries(outcomes),
      rowsRepaired: units.filter((u) => (u.delta ?? 0) > 0).length,
      repairRate: deltas.reduce((sum, d) => sum + d.delta, 0) / rows.length,
      clustered: clusteredBootstrap(deltas),
      perRow: rowBootstrap(deltas),
      cost: {
        totalUsd: costs.reduce((sum, c) => sum + c, 0),
        medianUsd: median(costs),
        uncapturedRows: uncaptured,
      },
      calls: { total: calls.reduce((sum, c) => sum + c, 0), median: median(calls) },
      actionBytes: { median: median(bytes), max: bytes.length ? Math.max(...bytes) : null },
      answerWallMsMedian: median(
        units.map((u) => u.answerWallMs).filter((w): w is number => w !== null),
      ),
      perTask,
    }
  })

  // Every ordered pair, so a reader never has to infer B-vs-A from A-vs-B.
  const pairs: unknown[] = []
  for (const left of arms) {
    for (const right of arms) {
      if (left === right) continue
      const leftDeltas = deltasOf(left)
      const rightDeltas = deltasOf(right)
      const paired = leftDeltas.map((row, index) => ({
        task: row.task,
        delta: row.delta - rightDeltas[index]!.delta,
      }))
      pairs.push({
        left,
        right,
        meanDifference: paired.reduce((sum, p) => sum + p.delta, 0) / paired.length,
        won: paired.filter((p) => p.delta > 0).length,
        lost: paired.filter((p) => p.delta < 0).length,
        tied: paired.filter((p) => p.delta === 0).length,
        clustered: clusteredBootstrap(paired),
        perRow: rowBootstrap(paired),
      })
    }
  }

  const report = {
    phase: 'm3-report',
    generatedAt: new Date().toISOString(),
    rows: rows.length,
    clusters: [...new Set(rows.map((r) => r.split('::')[0]!))].sort(),
    analystArms: ANALYST_ARMS.filter((arm) => arms.includes(arm)),
    referenceArms: REFERENCE_ARMS.filter((arm) => arms.includes(arm)),
    arms: armReports,
    pairs,
  }
  writeFileSync(join(m3Dir, 'report-m3.json'), JSON.stringify(report, null, 2))

  const pct = (value: number): string => `${(value * 100).toFixed(1)}%`
  const lines: string[] = []
  lines.push(`rows=${rows.length} clusters=${report.clusters.length} [${report.clusters.join(', ')}]`)
  lines.push('')
  lines.push('arm            rate    clustered95        row95              won  cost/row   calls/row')
  for (const arm of armReports) {
    lines.push(
      `${arm.arm.padEnd(14)} ${pct(arm.repairRate).padStart(6)}  ` +
        `[${pct(arm.clustered.low).padStart(6)},${pct(arm.clustered.high).padStart(7)}]  ` +
        `[${pct(arm.perRow.low).padStart(6)},${pct(arm.perRow.high).padStart(7)}]  ` +
        `${String(arm.rowsRepaired).padStart(3)}  ` +
        `${arm.cost.medianUsd === null ? 'uncaptured' : `$${arm.cost.medianUsd.toFixed(4)}`.padStart(9)}  ` +
        `${arm.calls.median === null ? 'n/a' : arm.calls.median.toFixed(0).padStart(5)}`,
    )
  }
  lines.push('')
  lines.push('pair (left - right)              mean    clustered95         W/L/T')
  for (const pair of pairs as {
    left: string
    right: string
    meanDifference: number
    won: number
    lost: number
    tied: number
    clustered: Interval
  }[]) {
    lines.push(
      `${`${pair.left} - ${pair.right}`.padEnd(32)} ${pct(pair.meanDifference).padStart(6)}  ` +
        `[${pct(pair.clustered.low).padStart(6)},${pct(pair.clustered.high).padStart(7)}]  ` +
        `${pair.won}/${pair.lost}/${pair.tied}`,
    )
  }
  process.stdout.write(`${lines.join('\n')}\n`)
}

main()
