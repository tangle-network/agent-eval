/**
 * Liveness canaries — cheap statistical checks that catch the failure
 * modes a green test suite never sees.
 *
 * Three canary types in this module:
 *
 *   1. **Silent judge fallback** — the judge degraded to a fallback
 *      path (rules-only / cached / heuristic) without anyone
 *      noticing. Signature: a string of consecutive runs whose
 *      `judgeMetadata.confidence` equals a known fallback constant
 *      (default 0.30) OR whose `judgeMetadata.fallback` is true.
 *
 *   2. **Judge calibration drift** — the judge's confidence
 *      distribution has drifted from a historical window. Two-sample
 *      Kolmogorov-Smirnov test on the recent vs historical confidences,
 *      with the empirical-CDF max-difference statistic.
 *
 *   3. **Eval-set distribution shift** — the mix of categories /
 *      buckets in the recent runs differs significantly from the
 *      historical mix. Chi-square test on the binned counts.
 *
 * Outputs are alerts. The canary does NOT fail loud the way a test
 * does — failing tests are reserved for hard correctness violations.
 * A canary that fires is a *signal* to investigate, not a verdict.
 *
 * Why this lives here rather than in `observability.ts`: that module
 * exports already, and is a pure-fanout-to-Langfuse/Prometheus
 * adapter. Canaries are statistical detectors, not adapters.
 */

import type { RunRecord } from './run-record'

export type CanaryKind = 'silent_judge_fallback' | 'judge_calibration_drift' | 'distribution_shift'

export type CanarySeverity = 'info' | 'warn' | 'error'

export interface CanaryAlert {
  kind: CanaryKind
  severity: CanarySeverity
  message: string
  /** Numbers that informed the decision — drop straight into a
   *  dashboard / paper figure. */
  evidence: Record<string, unknown>
}

export interface CanaryReport {
  alerts: CanaryAlert[]
  /** Per-kind summary count. */
  counts: Record<CanaryKind, number>
  /** Whether each enabled detector had enough observations to run. */
  evaluations: CanaryEvaluation[]
}

export interface CanaryEvaluation {
  kind: CanaryKind
  status: 'evaluated' | 'not_evaluated'
  observations: number
  reason?: string
}

export interface CanaryOptions {
  /**
   * Silent-fallback detection.
   * - `constant`: confidence value treated as the fallback signal.
   *   Default 0.30 (matches the soft-fail default in
   *   `propose-review.ts`).
   * - `consecutiveThreshold`: trip the alert after this many
   *   consecutive runs at `constant` (or `fallback === true`).
   *   Default 3.
   */
  silentFallback?: {
    constant?: number
    consecutiveThreshold?: number
    /** Floating-point tolerance when comparing against `constant`. */
    epsilon?: number
  }

  /**
   * Calibration-drift detection.
   * - `historyWindow`: number of past runs (oldest-first) treated as
   *   the historical baseline. Default 50.
   * - `recentWindow`: number of recent runs (newest-first) compared
   *   against history. Default 20.
   * - `ksAlpha`: alpha for the KS statistic vs critical value.
   *   Default 0.05.
   * - `minRecent`: minimum recent runs required to even attempt the
   *   check. Default 10.
   */
  calibrationDrift?: {
    historyWindow?: number
    recentWindow?: number
    ksAlpha?: number
    minRecent?: number
  }

  /**
   * Distribution-shift detection.
   * - `category`: function that maps a run to a categorical bucket.
   *   Required to enable this canary; if omitted the chi-square check
   *   is skipped entirely.
   * - `chiSquareAlpha`: alpha. Default 0.05.
   * - `historyWindow`, `recentWindow`, `minRecent`: like above.
   */
  distributionShift?: {
    category: (run: RunRecord) => string | null
    chiSquareAlpha?: number
    historyWindow?: number
    recentWindow?: number
    minRecent?: number
  }
}

/**
 * Run all configured canaries against a chronological run list.
 * Runs MUST be sorted oldest-to-newest by the caller — the order of
 * the input is used to define "recent" vs "historical" windows.
 */
export function runCanaries(runs: RunRecord[], opts: CanaryOptions = {}): CanaryReport {
  const detections = [
    detectSilentFallback(runs, opts.silentFallback ?? {}),
    detectCalibrationDrift(runs, opts.calibrationDrift ?? {}),
  ]
  if (opts.distributionShift) {
    detections.push(detectDistributionShift(runs, opts.distributionShift))
  }
  const alerts = detections.flatMap((detection) => detection.alerts)
  const counts: Record<CanaryKind, number> = {
    silent_judge_fallback: 0,
    judge_calibration_drift: 0,
    distribution_shift: 0,
  }
  for (const a of alerts) counts[a.kind]++
  return {
    alerts,
    counts,
    evaluations: detections.map((detection) => detection.evaluation),
  }
}

// ── 1. Silent judge fallback ─────────────────────────────────────────

interface CanaryDetection {
  alerts: CanaryAlert[]
  evaluation: CanaryEvaluation
}

function detectSilentFallback(
  runs: RunRecord[],
  opts: NonNullable<CanaryOptions['silentFallback']>,
): CanaryDetection {
  const constant = opts.constant ?? 0.3
  const threshold = opts.consecutiveThreshold ?? 3
  const eps = opts.epsilon ?? 1e-9

  const alerts: CanaryAlert[] = []
  let observations = 0
  let streak = 0
  let streakStartRunId: string | null = null
  let streakValues: number[] = []
  let reportedInStreak = false

  for (let i = 0; i < runs.length; i++) {
    const run = runs[i]!
    const meta = run.judgeMetadata
    if (!meta) {
      streak = 0
      streakStartRunId = null
      streakValues = []
      reportedInStreak = false
      continue
    }
    observations += 1
    const isFallback = meta.fallback === true || Math.abs(meta.confidence - constant) <= eps
    if (isFallback) {
      streak += 1
      if (streak === 1) streakStartRunId = run.runId
      streakValues.push(meta.confidence)
      if (streak >= threshold && !reportedInStreak) {
        alerts.push({
          kind: 'silent_judge_fallback',
          severity: 'error',
          message:
            `silent judge fallback: ${streak} consecutive run(s) at ` +
            `confidence≈${constant} or fallback=true`,
          evidence: {
            streakLength: streak,
            firstRunId: streakStartRunId,
            lastRunId: run.runId,
            confidences: streakValues.slice(-Math.min(streakValues.length, 10)),
            fallbackConstant: constant,
          },
        })
        reportedInStreak = true
      }
    } else {
      streak = 0
      streakStartRunId = null
      streakValues = []
      reportedInStreak = false
    }
  }

  return {
    alerts,
    evaluation:
      observations >= threshold
        ? {
            kind: 'silent_judge_fallback',
            status: 'evaluated',
            observations,
          }
        : {
            kind: 'silent_judge_fallback',
            status: 'not_evaluated',
            observations,
            reason: `requires at least ${threshold} run(s) with judge metadata`,
          },
  }
}

// ── 2. Judge calibration drift (KS test) ─────────────────────────────

function detectCalibrationDrift(
  runs: RunRecord[],
  opts: NonNullable<CanaryOptions['calibrationDrift']>,
): CanaryDetection {
  const historyWindow = opts.historyWindow ?? 50
  const recentWindow = opts.recentWindow ?? 20
  const alpha = opts.ksAlpha ?? 0.05
  const minRecent = opts.minRecent ?? 10

  const conf: number[] = []
  for (const r of runs) {
    if (r.judgeMetadata && Number.isFinite(r.judgeMetadata.confidence)) {
      conf.push(r.judgeMetadata.confidence)
    }
  }

  const recent = conf.slice(-Math.min(recentWindow, conf.length))
  const historical = conf.slice(0, -recent.length).slice(-historyWindow)
  if (recent.length < minRecent || historical.length < minRecent) {
    return {
      alerts: [],
      evaluation: {
        kind: 'judge_calibration_drift',
        status: 'not_evaluated',
        observations: conf.length,
        reason:
          `requires at least ${minRecent} recent and ${minRecent} historical ` +
          `confidence observation(s); found ${recent.length} recent and ${historical.length} historical`,
      },
    }
  }

  const ks = ksTwoSample(recent, historical)
  // Two-sample KS critical value at alpha:
  //   c(α) * sqrt((n1 + n2) / (n1 * n2))
  // c(0.05) ≈ 1.36, c(0.01) ≈ 1.63
  const c = alpha <= 0.01 ? 1.63 : alpha <= 0.05 ? 1.36 : alpha <= 0.1 ? 1.22 : 1.0
  const critical =
    c * Math.sqrt((recent.length + historical.length) / (recent.length * historical.length))

  if (ks.d > critical) {
    return {
      alerts: [
        {
          kind: 'judge_calibration_drift',
          severity: 'warn',
          message:
            `judge calibration drift: KS D=${ks.d.toFixed(4)} exceeds ` +
            `critical=${critical.toFixed(4)} at alpha=${alpha} ` +
            `(recent n=${recent.length}, history n=${historical.length})`,
          evidence: {
            ksD: ks.d,
            critical,
            alpha,
            recentN: recent.length,
            historyN: historical.length,
            recentMean: mean(recent),
            historyMean: mean(historical),
          },
        },
      ],
      evaluation: {
        kind: 'judge_calibration_drift',
        status: 'evaluated',
        observations: recent.length + historical.length,
      },
    }
  }
  return {
    alerts: [],
    evaluation: {
      kind: 'judge_calibration_drift',
      status: 'evaluated',
      observations: recent.length + historical.length,
    },
  }
}

/**
 * Two-sample Kolmogorov–Smirnov statistic. Returns the max
 * absolute difference between the two empirical CDFs. Pure TS,
 * no dependency on the gamma function — we don't compute the
 * p-value here; the caller compares D to a critical value.
 */
function ksTwoSample(a: number[], b: number[]): { d: number } {
  const sortedA = [...a].sort((x, y) => x - y)
  const sortedB = [...b].sort((x, y) => x - y)
  const n1 = sortedA.length
  const n2 = sortedB.length
  let i = 0
  let j = 0
  let d = 0
  while (i < n1 && j < n2) {
    const ax = sortedA[i]!
    const bx = sortedB[j]!
    if (ax <= bx) i++
    if (bx <= ax) j++
    const diff = Math.abs(i / n1 - j / n2)
    if (diff > d) d = diff
  }
  return { d }
}

// ── 3. Eval-set distribution shift (chi-square) ──────────────────────

function detectDistributionShift(
  runs: RunRecord[],
  opts: NonNullable<CanaryOptions['distributionShift']>,
): CanaryDetection {
  const historyWindow = opts.historyWindow ?? 50
  const recentWindow = opts.recentWindow ?? 20
  const alpha = opts.chiSquareAlpha ?? 0.05
  const minRecent = opts.minRecent ?? 10
  const cat = opts.category

  const cats: Array<{ run: RunRecord; bucket: string }> = []
  for (const r of runs) {
    const b = cat(r)
    if (typeof b === 'string' && b.length > 0) cats.push({ run: r, bucket: b })
  }

  const recent = cats.slice(-Math.min(recentWindow, cats.length))
  const historical = cats.slice(0, -recent.length).slice(-historyWindow)
  if (recent.length < minRecent || historical.length < minRecent) {
    return {
      alerts: [],
      evaluation: {
        kind: 'distribution_shift',
        status: 'not_evaluated',
        observations: cats.length,
        reason:
          `requires at least ${minRecent} recent and ${minRecent} historical ` +
          `categorized run(s); found ${recent.length} recent and ${historical.length} historical`,
      },
    }
  }

  const buckets = new Set<string>()
  for (const r of recent) buckets.add(r.bucket)
  for (const h of historical) buckets.add(h.bucket)
  const bucketList = [...buckets].sort()

  // Build observed (recent) and expected counts (recent total ×
  // historical proportion).
  const recentCounts: Record<string, number> = {}
  const histCounts: Record<string, number> = {}
  for (const b of bucketList) {
    recentCounts[b] = 0
    histCounts[b] = 0
  }
  for (const r of recent) recentCounts[r.bucket]! += 1
  for (const h of historical) histCounts[h.bucket]! += 1

  let chi = 0
  let df = 0
  for (const b of bucketList) {
    const expected = (histCounts[b]! / historical.length) * recent.length
    if (expected < 1) continue // skip cells with too-thin expected — chi-sq breaks down
    const obs = recentCounts[b]!
    chi += (obs - expected) ** 2 / expected
    df += 1
  }
  df = Math.max(1, df - 1)
  const critical = chiSquareCritical(df, alpha)
  if (chi > critical) {
    return {
      alerts: [
        {
          kind: 'distribution_shift',
          severity: 'warn',
          message:
            `eval-set distribution shift: χ²=${chi.toFixed(2)} df=${df} ` +
            `exceeds critical=${critical.toFixed(2)} at alpha=${alpha}`,
          evidence: {
            chi,
            df,
            critical,
            alpha,
            recentCounts,
            historicalCounts: histCounts,
            recentN: recent.length,
            historyN: historical.length,
          },
        },
      ],
      evaluation: {
        kind: 'distribution_shift',
        status: 'evaluated',
        observations: recent.length + historical.length,
      },
    }
  }
  return {
    alerts: [],
    evaluation: {
      kind: 'distribution_shift',
      status: 'evaluated',
      observations: recent.length + historical.length,
    },
  }
}

/**
 * Chi-square critical-value lookup for df ∈ [1, 30] at the most
 * common alpha levels. For df > 30 we fall back to the Wilson-Hilferty
 * normal approximation:
 *
 *   χ²_α ≈ df * (1 − 2/(9 df) + z_α * sqrt(2/(9 df)))^3
 */
function chiSquareCritical(df: number, alpha: number): number {
  const TABLE: Record<number, [number, number, number, number]> = {
    1: [2.71, 3.84, 5.02, 6.63],
    2: [4.61, 5.99, 7.38, 9.21],
    3: [6.25, 7.81, 9.35, 11.34],
    4: [7.78, 9.49, 11.14, 13.28],
    5: [9.24, 11.07, 12.83, 15.09],
    6: [10.64, 12.59, 14.45, 16.81],
    7: [12.02, 14.07, 16.01, 18.48],
    8: [13.36, 15.51, 17.53, 20.09],
    9: [14.68, 16.92, 19.02, 21.67],
    10: [15.99, 18.31, 20.48, 23.21],
    15: [22.31, 25.0, 27.49, 30.58],
    20: [28.41, 31.41, 34.17, 37.57],
    25: [34.38, 37.65, 40.65, 44.31],
    30: [40.26, 43.77, 46.98, 50.89],
  }
  const idx = alpha >= 0.1 ? 0 : alpha >= 0.05 ? 1 : alpha >= 0.025 ? 2 : 3
  if (TABLE[df]) return TABLE[df]![idx]
  if (df > 30) {
    const zMap: Record<number, number> = { 0: 1.282, 1: 1.645, 2: 1.96, 3: 2.326 }
    const z = zMap[idx] ?? 1.96
    const term = 1 - 2 / (9 * df) + z * Math.sqrt(2 / (9 * df))
    return df * term ** 3
  }
  // Linear interpolation between table entries we have.
  const keys = Object.keys(TABLE)
    .map((k) => Number(k))
    .sort((a, b) => a - b)
  for (let i = 1; i < keys.length; i++) {
    const lo = keys[i - 1]!
    const hi = keys[i]!
    if (df >= lo && df <= hi) {
      const t = (df - lo) / (hi - lo)
      return TABLE[lo]![idx] * (1 - t) + TABLE[hi]![idx] * t
    }
  }
  return TABLE[10]![idx]
}

function mean(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((s, x) => s + x, 0) / xs.length
}
