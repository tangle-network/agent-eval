import { ValidationError } from '../errors'
import { interpolatedQuantile as quantile } from '../math/quantile'
import { assertFiniteSample, makeRng, medianInPlace } from './internal'

export interface SampleSummaryOptions {
  confidence?: number
  seed?: number
  resamples?: number
}

export interface SampleSummary {
  n: number
  median: number
  mean: number
  stddev: number
  q1: number
  q3: number
  iqr: number
  min: number
  max: number
  range: number
  cv: number | null
  skewness: number | null
  kurtosis: number | null
  mad: number
  outliers: number[]
  medianInterval: { low: number; high: number; confidence: number; resamples: number } | null
}

/** Interpolated sample median; an empty population has no measured median. */
export function sampleMedian(values: readonly number[]): number | null {
  assertFiniteSample('sampleMedian', 'values', values)
  return values.length ? medianInPlace([...values]) : null
}

/** Descriptive facts, not stability policy or a significance test. */
export function summarizeSample(
  values: readonly number[],
  options: SampleSummaryOptions = {},
): SampleSummary | null {
  assertFiniteSample('summarizeSample', 'values', values)
  const confidence = options.confidence ?? 0.95
  const resamples = options.resamples ?? 1000
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new ValidationError('summarizeSample: confidence must be between zero and one')
  }
  if (!Number.isSafeInteger(resamples) || resamples < 1) {
    throw new ValidationError('summarizeSample: resamples must be a positive safe integer')
  }
  const rng = makeRng(options.seed, [...values])
  if (!values.length) return null
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  const mean = sorted.reduce((sum, value) => sum + value / n, 0)
  const centered = sorted.map((value) => value - mean)
  const sumSquares = centered.reduce((sum, value) => sum + value ** 2, 0)
  const stddev = n > 1 ? Math.sqrt(sumSquares / (n - 1)) : 0
  const median = quantile(sorted, 0.5)
  const q1 = quantile(sorted, 0.25)
  const q3 = quantile(sorted, 0.75)
  const iqr = q3 - q1
  const deviations = sorted.map((value) => Math.abs(value - median)).sort((a, b) => a - b)
  const skewness =
    n >= 3 && stddev > 0
      ? (n * centered.reduce((sum, value) => sum + (value / stddev) ** 3, 0)) / ((n - 1) * (n - 2))
      : null
  const kurtosis =
    n >= 4 && stddev > 0
      ? (n * (n + 1) * centered.reduce((sum, value) => sum + (value / stddev) ** 4, 0)) /
          ((n - 1) * (n - 2) * (n - 3)) -
        (3 * (n - 1) ** 2) / ((n - 2) * (n - 3))
      : null
  const bootstrap: number[] = []
  if (n >= 3) {
    for (let i = 0; i < resamples; i++) {
      const sample = Array.from({ length: n }, () => sorted[Math.floor(rng() * n)]!)
      bootstrap.push(medianInPlace(sample))
    }
    bootstrap.sort((a, b) => a - b)
  }
  const alpha = (1 - confidence) / 2
  const summary: SampleSummary = {
    n,
    median,
    mean,
    stddev,
    q1,
    q3,
    iqr,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    range: sorted[n - 1]! - sorted[0]!,
    cv: mean === 0 ? null : stddev / Math.abs(mean),
    skewness,
    kurtosis,
    mad: quantile(deviations, 0.5),
    outliers: sorted.filter((value) => value < q1 - 1.5 * iqr || value > q3 + 1.5 * iqr),
    medianInterval:
      n < 3
        ? null
        : {
            low: quantile(bootstrap, alpha),
            high: quantile(bootstrap, 1 - alpha),
            confidence,
            resamples,
          },
  }
  if (
    [
      mean,
      stddev,
      iqr,
      summary.range,
      summary.mad,
      summary.cv,
      skewness,
      kurtosis,
      summary.medianInterval?.low ?? null,
      summary.medianInterval?.high ?? null,
    ].some((value) => value !== null && !Number.isFinite(value))
  ) {
    throw new ValidationError('summarizeSample: sample arithmetic exceeded finite range')
  }
  return summary
}
