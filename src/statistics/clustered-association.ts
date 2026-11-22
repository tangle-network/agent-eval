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
}

export interface ClusteredAssociationOptions {
  /** `auc`: probability a 1 outranks a 0 on x (null 0.5). `spearman`: rank correlation (null 0). */
  statistic: 'auc' | 'spearman'
  /** Whole-unit resamples. Default 1000. */
  resamples?: number
  /** Percentile interval level. Default 0.95. */
  confidence?: number
  /** Absent, the seed is derived from the rows, so the same rows give the same result. */
  seed?: number
}

export interface ClusteredAssociation {
  statistic: 'auc' | 'spearman'
  /** Rows and distinct units the estimate reads. */
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
  /** Two-sided p-value of `(estimate - null) / standardError` on Student-t with `units - 1` degrees of freedom. */
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
 * falls back to `1 / (definedResamples + 1)`, the smallest a resample count
 * can support, or 1 when that value is the null.
 */
export function clusteredAssociation(
  rows: readonly ClusteredAssociationRow[],
  options: ClusteredAssociationOptions,
): ClusteredAssociation {
  const { statistic } = options
  const resamples = options.resamples ?? 1000
  const confidence = options.confidence ?? 0.95
  if (statistic !== 'auc' && statistic !== 'spearman') {
    throw new ValidationError('clusteredAssociation: statistic must be auc or spearman')
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
  }
  const estimateOf = (sample: readonly ClusteredAssociationRow[]): number =>
    associationEstimate(statistic, sample)
  const estimate = estimateOf(rows)
  const units = new Set(rows.map((row) => row.unit)).size
  if (!Number.isFinite(estimate) || units < 2) {
    throw new ValidationError(
      'clusteredAssociation: needs two units, both outcome classes for auc, and variation on both sides',
    )
  }
  const draws: number[] = []
  const interval = clusterBootstrap(
    rows,
    (row) => row.unit,
    (sample) => {
      const value = estimateOf(sample)
      if (Number.isFinite(value)) draws.push(value)
      return value
    },
    {
      resamples,
      level: confidence,
      seed:
        options.seed ??
        seedFromData([rows.map((row) => row.x), rows.map((row) => row.y)]),
    },
  )
  const nullValue = statistic === 'auc' ? 0.5 : 0
  const standardError = sampleStandardDeviation(draws)
  let pValue: number
  if (!(standardError > 0)) {
    pValue = estimate === nullValue ? 1 : 1 / (draws.length + 1)
  } else {
    const t = Math.abs(estimate - nullValue) / standardError
    pValue = Math.min(1, 2 * (1 - studentTCdf(t, units - 1)))
  }
  return {
    statistic,
    n: rows.length,
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

/** The point statistic alone; NaN when it is undefined on these rows. */
export function associationEstimate(
  statistic: 'auc' | 'spearman',
  rows: readonly { x: number; y: number }[],
): number {
  const xs = rows.map((row) => row.x)
  const ys = rows.map((row) => row.y)
  if (statistic === 'auc') return rocAuc(xs, ys) ?? Number.NaN
  if (!varies(xs) || !varies(ys)) return Number.NaN
  return spearmanR(xs, ys)
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
