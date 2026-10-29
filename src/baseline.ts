/** Detect baseline regressions with Welch inference, effect size and per-side stability. */

import { interpolatedQuantile } from './math/quantile'
import { studentTQuantile } from './math/student-t'
import { cohensD } from './statistics/effect-sizes'
import { studentTTwoSidedPValue } from './statistics/inference'

interface MetricSamples {
  /** Stable metric key (e.g. "overallScore", "firstTokenMs"). */
  metric: string
  /** Whether higher values are better. */
  higherIsBetter: boolean
  baseline: number[]
  candidate: number[]
}

export interface MetricVerdict {
  metric: string
  baselineMean: number
  candidateMean: number
  delta: number
  /** Null when both samples are constant with unequal means — the standardized effect is unbounded there, not zero. */
  cohensD: number | null
  welchT: number
  welchDf: number
  welchP: number
  stable: boolean
  /** IQR of the combined samples — used as a rough stability indicator. */
  iqr: number
  verdict: 'improved' | 'regressed' | 'stable' | 'unstable'
}

export interface BaselineReport {
  metrics: MetricVerdict[]
  /** True if any critical metric regressed. */
  hasRegression: boolean
  /** True if any metric is unstable (too noisy to judge). */
  hasUnstable: boolean
}

export interface BaselineOptions {
  /** Effect size threshold for meaningful delta (default 0.5 — medium effect). */
  effectThreshold?: number
  /** p-value threshold for statistical significance (default 0.05). */
  alpha?: number
  /** IQR/mean ratio above which samples are flagged unstable (default 0.30). */
  unstableCvThreshold?: number
}

export type WelchTestStatus = 'ok' | 'insufficient-sample' | 'zero-variance'

/** Independent b − a effects; insufficient counts or zero variance have no confidence interval. */
interface WelchTestResultBase {
  meanA: number
  meanB: number
  delta: number
}

export type WelchTestResult =
  | (WelchTestResultBase & {
      status: 'ok'
      standardError: number
      t: number
      df: number
      p: number
      ci95: [number, number]
      cohensD: number
    })
  | (WelchTestResultBase & {
      status: 'insufficient-sample' | 'zero-variance'
      standardError: number
      t: number
      df: number
      p: number
      ci95: null
      cohensD: null
    })

/** Promotion requires stable samples, a meaningful effect in the right direction and significant inference. */
export function compareToBaseline(
  samples: MetricSamples[],
  options: BaselineOptions = {},
): BaselineReport {
  const effectThreshold = options.effectThreshold ?? 0.5
  const alpha = options.alpha ?? 0.05
  const cvThreshold = options.unstableCvThreshold ?? 0.3

  const metrics: MetricVerdict[] = samples.map((s) => {
    const comparison = welchsTTest(s.baseline, s.candidate)
    if (comparison.status === 'insufficient-sample') {
      throw new Error(`compareToBaseline: need ≥2 samples per side for "${s.metric}"`)
    }
    const { meanA: bMean, meanB: cMean, delta, cohensD: d, t, df, p } = comparison
    // Per-side stability keeps a real mean shift distinct from noisy samples.
    const baselineIqr = iqr(s.baseline)
    const candidateIqr = iqr(s.candidate)
    const baselineStable = baselineIqr / Math.max(Math.abs(bMean), 1e-9) <= cvThreshold
    const candidateStable = candidateIqr / Math.max(Math.abs(cMean), 1e-9) <= cvThreshold
    const stable = baselineStable && candidateStable
    const reportedIqr = Math.max(baselineIqr, candidateIqr)

    // Only status 'ok' can promote; null effects cannot fabricate bounded inference.
    const effectClears = d === null || Math.abs(d) >= effectThreshold

    let verdict: MetricVerdict['verdict']
    if (!stable) {
      verdict = 'unstable'
    } else if (comparison.status === 'ok' && p < alpha && effectClears) {
      const candidateIsBetter = s.higherIsBetter ? delta > 0 : delta < 0
      verdict = candidateIsBetter ? 'improved' : 'regressed'
    } else {
      verdict = 'stable'
    }

    return {
      metric: s.metric,
      baselineMean: bMean,
      candidateMean: cMean,
      delta,
      cohensD: d,
      welchT: t,
      welchDf: df,
      welchP: p,
      stable,
      iqr: reportedIqr,
      verdict,
    }
  })

  return {
    metrics,
    hasRegression: metrics.some((m) => m.verdict === 'regressed'),
    hasUnstable: metrics.some((m) => m.verdict === 'unstable'),
  }
}

function mean(xs: number[]): number {
  return xs.length ? xs.reduce((sum, value) => sum + value / xs.length, 0) : Number.NaN
}

/** Inter-quartile range; 0 when the sample has no spread. */
export function iqr(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  return interpolatedQuantile(sorted, 0.75) - interpolatedQuantile(sorted, 0.25)
}

/** Use Student-t at finite df; unavailable inference is NaN with a null interval and explicit status. */
export function welchsTTest(a: number[], b: number[]): WelchTestResult {
  assertFiniteSample('a', a)
  assertFiniteSample('b', b)
  const mA = mean(a)
  const mB = mean(b)
  const delta = mB - mA
  if (
    (a.length && !Number.isFinite(mA)) ||
    (b.length && !Number.isFinite(mB)) ||
    (a.length && b.length && !Number.isFinite(delta))
  ) {
    throw new RangeError('welchsTTest: sample arithmetic exceeded finite range')
  }
  if (a.length < 2 || b.length < 2) {
    return {
      status: 'insufficient-sample',
      meanA: mA,
      meanB: mB,
      delta,
      standardError: Number.NaN,
      t: Number.NaN,
      df: Number.NaN,
      p: Number.NaN,
      ci95: null,
      cohensD: null,
    }
  }

  const vA = variance(a, mA)
  const vB = variance(b, mB)
  const seSquared = vA / a.length + vB / b.length
  if (!Number.isFinite(seSquared)) {
    throw new RangeError('welchsTTest: sample arithmetic exceeded finite range')
  }
  const d = cohensD(a, b)
  if (seSquared === 0) {
    return {
      status: 'zero-variance',
      meanA: mA,
      meanB: mB,
      delta,
      standardError: 0,
      t: delta === 0 ? 0 : Math.sign(delta) * Number.POSITIVE_INFINITY,
      df: Number.NaN,
      p: Number.NaN,
      ci95: null,
      cohensD: null,
    }
  }

  const standardError = Math.sqrt(seSquared)
  const t = delta / standardError
  const fractionA = vA / a.length / seSquared
  const fractionB = vB / b.length / seSquared
  const df = 1 / (fractionA ** 2 / (a.length - 1) + fractionB ** 2 / (b.length - 1))
  const p = studentTTwoSidedPValue(t, df)
  if (d === null) {
    throw new Error('welchsTTest: non-zero standard error produced no pooled effect size')
  }
  const halfWidth = studentTQuantile(0.975, df) * standardError
  if (![df, d, halfWidth, delta - halfWidth, delta + halfWidth].every(Number.isFinite)) {
    throw new RangeError('welchsTTest: sample arithmetic exceeded finite range')
  }
  return {
    status: 'ok',
    meanA: mA,
    meanB: mB,
    delta,
    standardError,
    t,
    df,
    p,
    ci95: [delta - halfWidth, delta + halfWidth],
    cohensD: d,
  }
}

function variance(xs: number[], m: number): number {
  return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1)
}

function assertFiniteSample(name: string, sample: readonly number[]): void {
  const invalid = sample.find((value) => !Number.isFinite(value))
  if (invalid !== undefined) {
    throw new RangeError(
      `welchsTTest: sample ${name} must contain only finite values, got ${invalid}`,
    )
  }
}
