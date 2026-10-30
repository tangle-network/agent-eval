import { ValidationError } from '../errors'
import { studentTCritical } from './descriptive'

/**
 * Nearest-rank distribution summary for measurement paths (gates, dashboards,
 * load harnesses): min/p50/p90/p95/p99/max + mean + sample stddev + a 95%
 * Student-t CI on the mean. Consolidates the former @repo/shared
 * distribution-stats: identical nearest-rank percentiles, with the CI now the
 * exact t critical value for any df (the retired implementation capped its
 * table at df 30 and fell back to 1.96).
 */

export interface SampleDistribution {
  min: number
  p50: number
  p90: number
  p95: number
  p99: number
  max: number
  mean: number
  stddev?: number
  ci95Low?: number
  ci95High?: number
  n: number
  values: number[]
}

export interface DistributionSummaryOptions {
  lowerBound?: number
}

/** Nearest-rank percentile on a sorted, non-empty sample (0-100 scale). */
function nearestRank(sorted: number[], percentile: number): number {
  const index = Math.min(
    sorted.length - 1,
    Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1),
  )
  return sorted[index]!
}

/**
 * Nearest-rank percentile on an arbitrary sample, `percentile` on a 0-100
 * scale — the same rule `summarizeDistribution` applies, exposed for a single
 * percentile the summary struct does not carry (e.g. p99.9). Returns NaN for
 * an empty sample; callers that need a numeric floor guard it.
 */
export function percentileNearestRank(
  values: number[],
  percentile: number,
): number {
  if (!Array.isArray(values)) throw new ValidationError('percentileNearestRank: values must be an array')
  if (values.length === 0) return Number.NaN
  const sorted = [...values].sort((a, b) => a - b)
  return nearestRank(sorted, percentile)
}

export function summarizeDistribution(
  values: number[],
  options: DistributionSummaryOptions = {},
): SampleDistribution {
  const finite =
    options.lowerBound === undefined
      ? values.filter(Number.isFinite)
      : values.filter((value) => Number.isFinite(value) && value >= options.lowerBound!)
  if (finite.length === 0)
    throw new ValidationError('summarizeDistribution: no finite samples')
  const sorted = [...finite].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((sum, value) => sum + value / n, 0)
  const centered = sorted.map((value) => value - mean)
  const sumSquares = centered.reduce((sum, value) => sum + value ** 2, 0)
  const summary: SampleDistribution = {
    min: sorted[0]!,
    p50: nearestRank(sorted, 50),
    p90: nearestRank(sorted, 90),
    p95: nearestRank(sorted, 95),
    p99: nearestRank(sorted, 99),
    max: sorted[n - 1]!,
    mean,
    n,
    values: sorted,
  }
  if (n >= 2) {
    const stddev = Math.sqrt(sumSquares / (n - 1))
    const t = studentTCritical(n - 1, 0.95)
    const margin = (t * stddev) / Math.sqrt(n)
    summary.stddev = stddev
    summary.ci95Low = mean - margin
    summary.ci95High = mean + margin
  }
  return summary
}
