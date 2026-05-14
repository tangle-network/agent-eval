/**
 * Baseline regression detection.
 *
 * Lifted from ADC baseline.ts. Every promotion-blocking signal boils down
 * to: "is this run measurably worse than baseline?" — with enough
 * statistical rigor to distinguish noise from drift.
 *
 * Uses:
 *   - Welch's t-test (unequal variance) for per-metric mean comparison
 *   - Cohen's d for effect size magnitude
 *   - IQR for stability flag (unstable samples can't be trusted for comparisons)
 *
 * Returns a structured verdict: improved | regressed | stable | unstable.
 */

import { cohensD } from './statistics'

export interface MetricSamples {
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
  cohensD: number
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

/**
 * Compare candidate samples against baseline per metric. Verdict logic:
 *   - unstable: IQR/|mean| > threshold on either set — not enough signal
 *   - improved: meaningful effect in the "better" direction AND p < alpha
 *   - regressed: meaningful effect in the "worse" direction AND p < alpha
 *   - stable: otherwise (no significant change)
 */
export function compareToBaseline(
  samples: MetricSamples[],
  options: BaselineOptions = {},
): BaselineReport {
  const effectThreshold = options.effectThreshold ?? 0.5
  const alpha = options.alpha ?? 0.05
  const cvThreshold = options.unstableCvThreshold ?? 0.3

  const metrics: MetricVerdict[] = samples.map((s) => {
    if (s.baseline.length < 2 || s.candidate.length < 2) {
      throw new Error(`compareToBaseline: need ≥2 samples per side for "${s.metric}"`)
    }
    const bMean = mean(s.baseline)
    const cMean = mean(s.candidate)
    const delta = cMean - bMean
    const d = cohensD(s.baseline, s.candidate) // positive = candidate higher
    const { t, df, p } = welchsTTest(s.baseline, s.candidate)
    // Stability is per-side: a comparison is trustworthy only when BOTH
    // samples are internally consistent. Combining the sides would flag
    // large-but-real deltas as "unstable" which is exactly what we want
    // to detect.
    const baselineIqr = iqr(s.baseline)
    const candidateIqr = iqr(s.candidate)
    const baselineStable = baselineIqr / Math.max(Math.abs(bMean), 1e-9) <= cvThreshold
    const candidateStable = candidateIqr / Math.max(Math.abs(cMean), 1e-9) <= cvThreshold
    const stable = baselineStable && candidateStable
    const reportedIqr = Math.max(baselineIqr, candidateIqr)

    let verdict: MetricVerdict['verdict']
    if (!stable) {
      verdict = 'unstable'
    } else if (p < alpha && Math.abs(d) >= effectThreshold) {
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
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

/** Inter-quartile range; 0 when the sample has no spread. */
export function iqr(xs: number[]): number {
  if (xs.length === 0) return 0
  const sorted = [...xs].sort((a, b) => a - b)
  const q = (p: number) => {
    const idx = p * (sorted.length - 1)
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return sorted[lo]! + (sorted[hi]! - sorted[lo]!) * (idx - lo)
  }
  return q(0.75) - q(0.25)
}

/**
 * Welch's t-test — unequal-variance two-sample t. Uses the same Student-t
 * CDF as `pairedTTest` (via incomplete beta); falls back to normal tail
 * when df is large.
 */
export function welchsTTest(a: number[], b: number[]): { t: number; df: number; p: number } {
  if (a.length < 2 || b.length < 2) return { t: 0, df: 0, p: 1 }
  const mA = mean(a)
  const mB = mean(b)
  const vA = variance(a, mA)
  const vB = variance(b, mB)
  const seSquared = vA / a.length + vB / b.length
  if (seSquared === 0) return { t: mA === mB ? 0 : Infinity, df: 0, p: mA === mB ? 1 : 0 }
  const t = (mB - mA) / Math.sqrt(seSquared)
  const df =
    (seSquared * seSquared) /
    ((vA / a.length) ** 2 / (a.length - 1) + (vB / b.length) ** 2 / (b.length - 1))
  const p = 2 * (1 - studentTCdf(Math.abs(t), df))
  return { t, df, p }
}

function variance(xs: number[], m: number): number {
  return xs.reduce((acc, x) => acc + (x - m) ** 2, 0) / (xs.length - 1)
}

// Re-used from statistics.ts via small local copy to avoid exporting internals.
function studentTCdf(t: number, df: number): number {
  if (df <= 0) return 0.5
  if (df > 100) return normalCdf(t)
  const x = df / (df + t * t)
  const ib = incompleteBeta(x, df / 2, 0.5)
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib
}

function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b)
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a
  let c = 1
  let d = 1 - ((a + b) * x) / (a + 1)
  if (Math.abs(d) < 1e-30) d = 1e-30
  d = 1 / d
  let f = d
  for (let m = 1; m <= 200; m++) {
    const m2 = 2 * m
    let num = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    d = 1 + num * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + num / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    f *= d * c
    num = -((a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    d = 1 + num * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + num / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    const delta = d * c
    f *= delta
    if (Math.abs(delta - 1) < 3e-7) break
  }
  return front * f
}

function lnGamma(z: number): number {
  const coefs = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (z < 0.5) return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z)
  z -= 1
  let x = coefs[0]!
  for (let i = 1; i < 9; i++) x += coefs[i]! / (z + i)
  const t = z + 7.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

function normalCdf(x: number): number {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911
  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x)
  const t = 1 / (1 + p * absX)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp((-absX * absX) / 2)
  return 0.5 * (1 + sign * y)
}
