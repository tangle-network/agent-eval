/**
 * The headline metric.
 *
 *   Delta-repair = P(tests pass | intervention) − P(tests pass | no-fix control)
 *
 * Paired per row, then bootstrapped over rows. Paired because the rows differ
 * enormously from each other and not at all between arms: the same trajectory,
 * the same image, the same held-out suite, the same continuation policy, and
 * one difference — the state the continuation starts from.
 *
 * Every admitted row stays in the denominator, including the ones an analyst
 * declined and the ones whose answer was rejected. Those rows contribute a
 * paired difference of exactly zero, because with no intervention to run their
 * arm IS their control arm. Declining is therefore free of error and free of
 * reward, which is what makes it an honest answer rather than a way to pick an
 * easy subset.
 *
 * The report never collapses to this one number. The funnel counts, the rates
 * on measured rows alone, the per-row table and the threats travel with it,
 * because a difference of means computed on a corpus that was admitted on the
 * control failing is conditional on that admission and the reader has to see
 * it to price it.
 */

import { ValidationError } from '../errors'
import { BOOTSTRAP_GATE_MIN_N, pairedBootstrap } from '../statistics'
import { countFunnel, type RepairFunnelCounts, type RepairGrade } from './funnel'
import type { RepairRowResult } from './grade'

export interface DeltaRepairOptions {
  /** Deterministic resampling seed. Derived from the deltas when omitted. */
  readonly seed?: number
  readonly resamples?: number
  readonly confidence?: number
}

export interface DeltaRepairInterval {
  readonly n: number
  readonly mean: number
  readonly median: number
  readonly low: number
  readonly high: number
  readonly confidence: number
  readonly resamples: number
  /** False below the pair count where a percentile interval carries its
   *  nominal error rate. A gate must not turn on a false one. */
  readonly gateEligible: boolean
}

export type RepairThreatId =
  | 'control-position-asymmetry'
  | 'control-cannot-rescue'
  | 'admission-conditions-on-control-failure'
  | 'bootstrap-below-min-n'
  | 'prefix-divergence-present'
  | 'intervention-failures-present'
  | 'zero-variance-interval'
  | 'declines-carry-the-denominator'

export interface RepairThreat {
  readonly id: RepairThreatId
  readonly statement: string
  /** Which way the threat pushes the headline if it is real. */
  readonly direction: 'understates' | 'overstates' | 'unknown'
}

export interface DeltaRepairReport {
  readonly rows: number
  readonly funnel: RepairFunnelCounts
  /** Mean over every admitted row. */
  readonly interventionRate: number
  readonly controlRate: number
  readonly deltaRepair: DeltaRepairInterval
  /** The same estimate restricted to rows that reached t2, where an
   *  intervention actually ran. Conditional on the analyst answering, so it is
   *  never the headline. */
  readonly measuredOnly: DeltaRepairInterval
  readonly measuredRows: number
  readonly rowResults: readonly RepairRowResult[]
  readonly threats: readonly RepairThreat[]
}

export function deltaRepair(
  rowResults: readonly RepairRowResult[],
  options: DeltaRepairOptions = {},
): DeltaRepairReport {
  if (rowResults.length === 0) {
    throw new ValidationError('deltaRepair needs at least one graded row')
  }
  const seen = new Set<string>()
  for (const row of rowResults) {
    if (seen.has(row.rowId)) {
      throw new ValidationError(`deltaRepair received row ${row.rowId} twice`)
    }
    seen.add(row.rowId)
  }

  const grades = rowResults.map((row) => row.grade)
  const funnel = countFunnel(grades)
  const control = rowResults.map((row) => row.controlRate)
  const intervention = rowResults.map((row) => row.interventionRate)
  const deltaAll = interval(control, intervention, options)

  const measured = rowResults.filter((row) => row.grade.outcome === 'measured')
  const measuredOnly =
    measured.length === 0
      ? emptyInterval(options)
      : interval(
          measured.map((row) => row.controlRate),
          measured.map((row) => row.interventionRate),
          options,
        )

  return {
    rows: rowResults.length,
    funnel,
    interventionRate: mean(intervention),
    controlRate: mean(control),
    deltaRepair: deltaAll,
    measuredOnly,
    measuredRows: measured.length,
    rowResults,
    threats: collectThreats(rowResults, funnel, deltaAll),
  }
}

function interval(
  control: readonly number[],
  intervention: readonly number[],
  options: DeltaRepairOptions,
): DeltaRepairInterval {
  const result = pairedBootstrap([...control], [...intervention], {
    statistic: 'mean',
    seed: options.seed,
    resamples: options.resamples,
    confidence: options.confidence,
  })
  return {
    n: result.n,
    mean: result.mean,
    median: result.median,
    low: result.low,
    high: result.high,
    confidence: result.confidence,
    resamples: result.resamples,
    gateEligible: result.gateEligible,
  }
}

function emptyInterval(options: DeltaRepairOptions): DeltaRepairInterval {
  return {
    n: 0,
    mean: 0,
    median: 0,
    low: 0,
    high: 0,
    confidence: options.confidence ?? 0.95,
    resamples: options.resamples ?? 2000,
    gateEligible: false,
  }
}

function collectThreats(
  rowResults: readonly RepairRowResult[],
  funnel: RepairFunnelCounts,
  delta: DeltaRepairInterval,
): RepairThreat[] {
  const threats: RepairThreat[] = [
    {
      id: 'control-position-asymmetry',
      statement:
        'The no-fix control continues from the recorded end state, while the intervention arm continues from step k and has to redo the work the recording did after k inside the same step budget. The arms are matched on policy and budget, not on position.',
      direction: 'understates',
    },
  ]
  const inert = rowResults.filter((row) => row.controlScreening === 'declared-inert')
  if (inert.length > 0) {
    threats.push({
      id: 'control-cannot-rescue',
      statement: `${inert.length}/${rowResults.length} rows were screened under a control that makes no model call, so its rollouts graded the same bytes the end-state check graded as failing. A control rate of zero on those rows is a restatement of the end-state check, not a measurement of what continuing alone can repair.`,
      direction: 'unknown',
    })
  }
  if (inert.length === 0 && rowResults.every((row) => row.controlRate === 0)) {
    threats.push({
      id: 'admission-conditions-on-control-failure',
      statement:
        'Every row was admitted on its no-fix control failing every rollout, so the control rate is zero everywhere and Delta-repair equals the intervention rate. The estimate is conditional on that admission and does not describe rows the control can already repair.',
      direction: 'unknown',
    })
  }
  if (!delta.gateEligible) {
    threats.push({
      id: 'bootstrap-below-min-n',
      statement: `The interval covers ${delta.n} paired rows, below the ${BOOTSTRAP_GATE_MIN_N} where a percentile bootstrap holds its nominal error rate. Read it as descriptive spread; a promotion must not turn on it.`,
      direction: 'unknown',
    })
  }
  const divergent = rowResults.filter((row) => measuredPrefixDivergences(row.grade) > 0).length
  if (divergent > 0) {
    threats.push({
      id: 'prefix-divergence-present',
      statement: `${divergent}/${rowResults.length} rows replayed at least one prefix step to a different exit code than the recording. The state the intervention landed on is close to the recorded one, not identical to it.`,
      direction: 'unknown',
    })
  }
  const withFailures = rowResults.filter(
    (row) => row.grade.outcome === 'measured' && row.grade.repair.interventionFailures > 0,
  ).length
  if (withFailures > 0) {
    threats.push({
      id: 'intervention-failures-present',
      statement: `${withFailures} rows had at least one rollout where the intervention failed to run after it had already run cleanly in the local-flip session. Those rollouts count as non-passes.`,
      direction: 'understates',
    })
  }
  if (delta.low === delta.high) {
    threats.push({
      id: 'zero-variance-interval',
      statement:
        'Every resample produced the same statistic, so the interval has zero width. That is an absence of variation in the data, not certainty about the effect.',
      direction: 'unknown',
    })
  }
  if (funnel.declined + funnel.rejected > funnel.rows / 2) {
    threats.push({
      id: 'declines-carry-the-denominator',
      statement: `${funnel.declined} declined and ${funnel.rejected} rejected of ${funnel.rows} rows contribute a paired delta of zero. The headline is dominated by rows where no intervention ran.`,
      direction: 'understates',
    })
  }
  return threats
}

function measuredPrefixDivergences(grade: RepairGrade): number {
  if (grade.outcome === 'measured' || grade.outcome === 'did-not-execute') {
    return grade.execution.prefix.divergences
  }
  if (
    grade.outcome === 'not-reproduced' &&
    grade.reproduction.basis !== 'no-recorded-observation'
  ) {
    return grade.reproduction.prefix.divergences
  }
  return 0
}

function mean(values: readonly number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length
}

/** Markdown report: provenance, the funnel, every per-row column, the
 *  distribution, and the threats. */
export function renderDeltaRepairReport(report: DeltaRepairReport): string {
  const lines: string[] = []
  const pct = (value: number): string => `${(value * 100).toFixed(1)} %`
  lines.push('# Delta-repair')
  lines.push('')
  lines.push(
    `**${signed(report.deltaRepair.mean)}** paired mean over ${report.rows} admitted rows ` +
      `(${(report.deltaRepair.confidence * 100).toFixed(0)} % CI ` +
      `${signed(report.deltaRepair.low)} … ${signed(report.deltaRepair.high)}, ` +
      `${report.deltaRepair.resamples} resamples, gate-eligible: ${report.deltaRepair.gateEligible}).`,
  )
  lines.push('')
  lines.push(
    `P(tests pass | intervention) = ${pct(report.interventionRate)}; ` +
      `P(tests pass | no-fix control) = ${pct(report.controlRate)}.`,
  )
  lines.push('')
  lines.push('## Funnel')
  lines.push('')
  lines.push('| cell | rows | share |')
  lines.push('| --- | --- | --- |')
  const f = report.funnel
  const share = (value: number): string => pct(f.rows === 0 ? 0 : value / f.rows)
  for (const [label, value] of [
    ['admitted rows', f.rows],
    ['t0 parsed', f.t0Parsed],
    ['t1 reproduced (gate, pays nothing)', f.t1Reproduced],
    ['t2 intervention executes', f.t2Executed],
    ['t3 local flip', f.t3LocalFlip],
    ['t4 repair flip (any rollout)', f.t4RepairFlipAny],
    ['t4 repair flip (every rollout)', f.t4RepairFlipAll],
    ['no-decisive-failure', f.declined],
    ['rejected', f.rejected],
  ] as const) {
    lines.push(`| ${label} | ${value} | ${share(value)} |`)
  }
  lines.push('')
  lines.push('## Rows')
  lines.push('')
  lines.push(
    '| row | outcome | k | reproduction basis | reproduced | intervention exit | local flip | repair passes | rollouts | intervention failures | prefix steps | prefix divergences | P(int) | P(ctl) | delta | wall ms |',
  )
  lines.push(
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
  )
  for (const row of report.rowResults) {
    lines.push(`| ${rowCells(row).join(' | ')} |`)
  }
  lines.push('')
  lines.push('## Measured rows only')
  lines.push('')
  lines.push(
    `${report.measuredRows} rows reached t2. Paired mean ${signed(report.measuredOnly.mean)} ` +
      `(CI ${signed(report.measuredOnly.low)} … ${signed(report.measuredOnly.high)}). ` +
      'Conditional on the analyst answering, so it is not the headline.',
  )
  lines.push('')
  lines.push('## Threats')
  lines.push('')
  for (const threat of report.threats) {
    lines.push(`- **${threat.id}** (${threat.direction} the effect) — ${threat.statement}`)
  }
  lines.push('')
  return lines.join('\n')
}

function rowCells(row: RepairRowResult): string[] {
  const grade = row.grade
  const reproduction =
    grade.outcome === 'not-reproduced' ||
    grade.outcome === 'did-not-execute' ||
    grade.outcome === 'measured'
      ? grade.reproduction
      : null
  const execution =
    grade.outcome === 'did-not-execute' || grade.outcome === 'measured' ? grade.execution : null
  const repair = grade.outcome === 'measured' ? grade.repair : null
  const prefix =
    execution?.prefix ??
    (reproduction && reproduction.basis !== 'no-recorded-observation' ? reproduction.prefix : null)
  const rejection =
    grade.outcome === 'rejected' ? `rejected: ${grade.rejection.reason}` : grade.outcome
  return [
    row.rowId,
    rejection,
    grade.outcome === 'rejected' || grade.outcome === 'declined' ? '—' : String(grade.k),
    reproduction ? reproduction.basis : '—',
    reproduction ? String(reproduction.reproduced) : '—',
    execution ? String(execution.exitCode) : '—',
    grade.outcome === 'measured' ? String(grade.localFlip.passed) : '—',
    repair ? String(repair.passes) : '—',
    repair ? String(repair.rollouts) : '0',
    repair ? String(repair.interventionFailures) : '—',
    prefix ? String(prefix.stepsReplayed) : '—',
    prefix ? String(prefix.divergences) : '—',
    row.interventionRate.toFixed(3),
    row.controlRate.toFixed(3),
    signed(row.delta),
    String(row.wallMs),
  ]
}

function signed(value: number): string {
  const points = value * 100
  return `${points >= 0 ? '+' : ''}${points.toFixed(1)} pp`
}
