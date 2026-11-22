import { ValidationError } from '../errors'
import { studentTCdf } from '../math/student-t'
import { clusterBootstrap } from './cluster'
import { rocAuc } from './comparison-effects'
import { spearmanR } from './descriptive'
import { seedFromData } from './internal'
import { normalizeSignedZero } from './normalize-signed-zero'

/** One observation of a score and an outcome, and the independent unit it belongs to. */
export interface ClusteredAssociationRow {
  x: number
  /** 0 or 1 for `auc`; any finite value for `spearman`. */
  y: number
  unit: string
  /** The comparison group under the `stratified` scope, such as a bin of an exposure. */
  stratum?: string
}

export type ClusteredAssociationScope = 'pooled' | 'within-unit' | 'stratified'

export interface ClusteredAssociationOptions {
  /** `auc`: probability a 1 outranks a 0 on x (null 0.5). `spearman`: rank correlation (null 0). */
  statistic: 'auc' | 'spearman'
  /**
   * `pooled` compares rows across all units. `stratified` compares rows only
   * inside each `stratum` and averages the strata, weighting each by its
   * comparable pairs, so differences between strata cannot move it.
   * `within-unit` is the stratified statistic with the unit as the stratum.
   * Every scope resamples whole units. Default `pooled`.
   */
  scope?: ClusteredAssociationScope
  /** `greater` tests only for an association above the null. Default `two-sided`. */
  alternative?: 'two-sided' | 'greater'
  /** Whole-unit resamples. Default 1000. */
  resamples?: number
  /** Percentile interval level. Default 0.95. */
  confidence?: number
  /** Absent, the seed is derived from the rows, so the same rows give the same result. */
  seed?: number
}

export interface ClusteredAssociation {
  statistic: 'auc' | 'spearman'
  scope: ClusteredAssociationScope
  alternative: 'two-sided' | 'greater'
  /** Rows and distinct units the estimate reads; within strata or units, only those holding a comparable pair. */
  n: number
  units: number
  estimate: number
  /** Value of the statistic under no association. */
  null: number
  /** Standard deviation of the statistic over whole-unit resamples. */
  standardError: number
  /** Percentile interval over the same resamples. */
  low: number
  high: number
  confidence: number
  /** p-value of `(estimate - null) / standardError` on Student-t with `units - 1` degrees of freedom, under `alternative`. */
  pValue: number
  resamples: number
  /** Resamples whose statistic was defined; a resample with one outcome class or a constant side is omitted. */
  definedResamples: number
}

/**
 * Association between a score and an outcome when rows share independent units.
 *
 * The interval and the standard error come from resampling whole units, never
 * rows: rows of one unit share whatever makes that unit differ, and a row
 * resample counts them as independent evidence. The p-value is a Wald test on
 * that standard error with `units - 1` degrees of freedom, so it stays
 * continuous for a false-discovery correction across many measures instead of
 * stopping at the bootstrap's `1 / resamples` floor. When every defined
 * resample gives the same value the standard error is zero and the p-value
 * falls back to `1 / (definedResamples + 1)` for an estimate on the tested
 * side of the null, and 1 otherwise.
 *
 * The stratified scope answers whether the score separates rows of the same
 * stratum: AUC inside each stratum weighted by its positive-negative pairs, or
 * Spearman inside each stratum weighted by its row pairs, where a score
 * constant inside a stratum counts as no association there. A resample draws
 * whole units and regroups their rows by stratum. The within-unit scope is the
 * same statistic with each unit its own stratum, so a drawn unit is drawn with
 * its stratum.
 */
export function clusteredAssociation(
  rows: readonly ClusteredAssociationRow[],
  options: ClusteredAssociationOptions,
): ClusteredAssociation {
  const { statistic } = options
  const scope = options.scope ?? 'pooled'
  const alternative = options.alternative ?? 'two-sided'
  const resamples = options.resamples ?? 1000
  const confidence = options.confidence ?? 0.95
  if (statistic !== 'auc' && statistic !== 'spearman') {
    throw new ValidationError('clusteredAssociation: statistic must be auc or spearman')
  }
  if (scope !== 'pooled' && scope !== 'within-unit' && scope !== 'stratified') {
    throw new ValidationError(
      'clusteredAssociation: scope must be pooled, within-unit or stratified',
    )
  }
  if (alternative !== 'two-sided' && alternative !== 'greater') {
    throw new ValidationError('clusteredAssociation: alternative must be two-sided or greater')
  }
  if (!Number.isSafeInteger(resamples) || resamples < 1) {
    throw new ValidationError('clusteredAssociation: resamples must be a positive safe integer')
  }
  for (const [index, row] of rows.entries()) {
    if (!Number.isFinite(row.x) || !Number.isFinite(row.y)) {
      throw new ValidationError(`clusteredAssociation: rows[${index}] must have finite x and y`)
    }
    if (statistic === 'auc' && row.y !== 0 && row.y !== 1) {
      throw new ValidationError(`clusteredAssociation: rows[${index}].y must be 0 or 1 for auc`)
    }
    if (typeof row.unit !== 'string' || row.unit.length === 0) {
      throw new ValidationError(`clusteredAssociation: rows[${index}].unit must be nonempty`)
    }
    if (scope === 'stratified' && (typeof row.stratum !== 'string' || row.stratum.length === 0)) {
      throw new ValidationError(
        `clusteredAssociation: rows[${index}].stratum must be nonempty for the stratified scope`,
      )
    }
  }
  const seed = options.seed ?? seedFromData([rows.map((row) => row.x), rows.map((row) => row.y)])
  const draws: number[] = []
  const record = (value: number) => {
    if (Number.isFinite(value)) draws.push(value)
    return value
  }
  let estimate: number
  let n: number
  let units: number
  let interval: { low: number; high: number }
  if (scope === 'pooled') {
    estimate = associationEstimate(statistic, rows)
    n = rows.length
    units = new Set(rows.map((row) => row.unit)).size
    if (Number.isFinite(estimate) && units >= 2) {
      interval = clusterBootstrap(
        rows,
        (row) => row.unit,
        (sample) => record(associationEstimate(statistic, sample)),
        { resamples, level: confidence, seed },
      )
    } else interval = { low: Number.NaN, high: Number.NaN }
  } else if (scope === 'within-unit') {
    // Each comparable unit is summarized once; resampling the summaries resamples whole units.
    const summaries = stratumSummaries(statistic, rows, (row) => row.unit)
    estimate = weightedMean(summaries)
    n = summaries.reduce((sum, unit) => sum + unit.rows.length, 0)
    units = summaries.length
    if (Number.isFinite(estimate) && units >= 2) {
      interval = clusterBootstrap(
        summaries,
        (unit) => unit.stratum,
        (sample) => record(weightedMean(sample)),
        { resamples, level: confidence, seed },
      )
    } else interval = { low: Number.NaN, high: Number.NaN }
  } else {
    const summaries = stratumSummaries(statistic, rows, (row) => row.stratum!)
    estimate = weightedMean(summaries)
    const contributing = summaries.flatMap((stratum) => stratum.rows)
    n = contributing.length
    units = new Set(contributing.map((row) => row.unit)).size
    if (Number.isFinite(estimate) && units >= 2) {
      interval = clusterBootstrap(
        rows,
        (row) => row.unit,
        (sample) =>
          record(weightedMean(stratumSummaries(statistic, sample, (row) => row.stratum!))),
        { resamples, level: confidence, seed },
      )
    } else interval = { low: Number.NaN, high: Number.NaN }
  }
  if (!Number.isFinite(estimate) || units < 2) {
    throw new ValidationError(
      `clusteredAssociation: the ${scope} ${statistic} needs two units with both outcome classes for auc, or variation on both sides, in a comparable unit or stratum`,
    )
  }
  const nullValue = statistic === 'auc' ? 0.5 : 0
  const standardError = sampleStandardDeviation(draws)
  const distance = estimate - nullValue
  let pValue: number
  if (!(standardError > 0)) {
    const onTestedSide = alternative === 'greater' ? distance > 0 : distance !== 0
    pValue = onTestedSide ? 1 / (draws.length + 1) : 1
  } else if (alternative === 'greater') {
    pValue = 1 - studentTCdf(distance / standardError, units - 1)
  } else {
    pValue = Math.min(1, 2 * (1 - studentTCdf(Math.abs(distance) / standardError, units - 1)))
  }
  return {
    statistic,
    scope,
    alternative,
    n,
    units,
    estimate: normalizeSignedZero(estimate),
    null: nullValue,
    standardError,
    low: interval.low,
    high: interval.high,
    confidence,
    pValue,
    resamples,
    definedResamples: draws.length,
  }
}

/**
 * The point statistic alone, pooled, within units or within strata; NaN when
 * it is undefined on these rows. Within units it needs `unit` on every row,
 * within strata `stratum`.
 */
export function associationEstimate(
  statistic: 'auc' | 'spearman',
  rows: readonly { x: number; y: number; unit?: string; stratum?: string }[],
  scope: ClusteredAssociationScope = 'pooled',
): number {
  if (scope !== 'pooled') {
    const key = scope === 'within-unit' ? 'unit' : 'stratum'
    return weightedMean(stratumSummaries(statistic, rows, (row) => row[key]!))
  }
  const xs = rows.map((row) => row.x)
  const ys = rows.map((row) => row.y)
  if (statistic === 'auc') return rocAuc(xs, ys) ?? Number.NaN
  if (!varies(xs) || !varies(ys)) return Number.NaN
  return spearmanR(xs, ys)
}

interface StratumSummary<T> {
  stratum: string
  rows: T[]
  value: number
  weight: number
}

/** The statistic inside each stratum holding a comparable pair, with its pair-count weight. */
function stratumSummaries<T extends { x: number; y: number }>(
  statistic: 'auc' | 'spearman',
  rows: readonly T[],
  stratumOf: (row: T) => string,
): StratumSummary<T>[] {
  const byStratum = new Map<string, T[]>()
  for (const row of rows) {
    const key = stratumOf(row)
    const members = byStratum.get(key)
    if (members) members.push(row)
    else byStratum.set(key, [row])
  }
  const summaries: StratumSummary<T>[] = []
  for (const [stratum, members] of byStratum) {
    const xs = members.map((row) => row.x)
    const ys = members.map((row) => row.y)
    if (statistic === 'auc') {
      const positive = ys.reduce((sum, y) => sum + y, 0)
      const negative = ys.length - positive
      const value = rocAuc(xs, ys)
      if (value === null) continue
      summaries.push({ stratum, rows: members, value, weight: positive * negative })
    } else {
      if (ys.length < 2 || !varies(ys)) continue
      summaries.push({
        stratum,
        rows: members,
        value: varies(xs) ? spearmanR(xs, ys) : 0,
        weight: (ys.length * (ys.length - 1)) / 2,
      })
    }
  }
  return summaries
}

function weightedMean(summaries: readonly { value: number; weight: number }[]): number {
  let total = 0
  let weight = 0
  for (const summary of summaries) {
    total += summary.value * summary.weight
    weight += summary.weight
  }
  return weight > 0 ? total / weight : Number.NaN
}

function varies(values: readonly number[]): boolean {
  return values.some((value) => value !== values[0])
}

function sampleStandardDeviation(values: readonly number[]): number {
  if (values.length < 2) return 0
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length
  const squares = values.reduce((sum, value) => sum + (value - mean) ** 2, 0)
  return Math.sqrt(squares / (values.length - 1))
}
