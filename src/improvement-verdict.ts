/**
 * Improvement verdict — N-rep stats and a KEEP / REGRESSION / NOISE verdict
 * for a candidate against a parent baseline.
 *
 * Every loop the fleet runs reduces to the same question: "I ran the candidate
 * N times — is the median measurably better than the parent, or is the delta
 * inside the noise band?" Stats and verdict are pure functions: no store, no
 * git provenance, no persistence seam. The caller owns identity and evidence;
 * this module owns only the arithmetic.
 *
 * Stats per candidate: median / mean / min / max / iqr / stddev / passRate /
 * n, plus a `stable` flag (`iqr < iqrUnstableAbove && stddev < stddevUnstableAbove`).
 *
 * Verdict against a parent (both must have `n >= minRepsForVerdict`):
 *   - NOISE       — the candidate is too unstable to judge (`!stable`)
 *   - KEEP        — `medianDelta >  keepThreshold`
 *   - REGRESSION  — `medianDelta < -regressionThreshold`
 *   - NOISE       — otherwise (delta inside the band)
 * With no parent (or insufficient reps) the verdict is the neutral ITERATE.
 */

import type { EvidenceRef } from './analyst/types'
import { iqr } from './baseline'
import { ValidationError } from './errors'

/** Verdict for one candidate relative to its parent. ITERATE is the neutral
 *  "keep collecting reps / no parent to compare against" state. */
export type ExperimentVerdict = 'KEEP' | 'ITERATE' | 'NOISE' | 'REGRESSION'

/** A single repetition of a candidate run, carrying the score the verdict is
 *  computed on plus any free-form per-rep metrics the consumer wants kept. */
export interface ExperimentRep {
  /** 0-indexed repetition number. */
  rep: number
  /** The score this rep is judged on (same scale as the thresholds). */
  score: number
  /** ISO timestamp the rep completed. */
  timestamp: string
  /** Stable execution/run identity that produced this score. */
  runId?: string
  /** Mechanically resolvable trace, artifact, metric, or finding evidence. */
  evidence?: EvidenceRef[]
  /** Whether this rep passed the consumer's own gate — folded into `passRate`. */
  passed?: boolean
  /** Free-form numeric metrics retained for later analysis. */
  metrics?: Record<string, number>
}

export interface ExperimentStats {
  median: number
  mean: number
  min: number
  max: number
  /** Inter-quartile range of the rep scores. */
  iqr: number
  /** Population standard deviation of the rep scores. */
  stddev: number
  /** Fraction of reps with `passed === true`, over reps that set `passed`.
   *  null when no rep declared a pass/fail outcome. */
  passRate: number | null
  /** Number of reps. */
  n: number
  /** True when the sample is tight enough to trust for a verdict. */
  stable: boolean
}

export interface ImprovementThresholds {
  /** medianDelta strictly above this ⇒ KEEP. Default 5. */
  keepThreshold?: number
  /** medianDelta strictly below the negative of this ⇒ REGRESSION. Default 5. */
  regressionThreshold?: number
  /** iqr at or above this ⇒ unstable. Default 10. */
  iqrUnstableAbove?: number
  /** stddev at or above this ⇒ unstable. Default Infinity (iqr-only stability). */
  stddevUnstableAbove?: number
  /** Reps required on BOTH candidate and parent before a verdict is rendered.
   *  Default 3. */
  minRepsForVerdict?: number
}

export interface ImprovementVerdictResult {
  verdict: ExperimentVerdict
  /** candidate.median − parent.median; null when no parent or insufficient reps. */
  medianDelta: number | null
  /** Human-readable reason for the verdict — for dashboards and logs. */
  reason: string
}

const DEFAULTS: Required<ImprovementThresholds> = {
  keepThreshold: 5,
  regressionThreshold: 5,
  iqrUnstableAbove: 10,
  stddevUnstableAbove: Number.POSITIVE_INFINITY,
  minRepsForVerdict: 3,
}

function resolveThresholds(t: ImprovementThresholds | undefined): Required<ImprovementThresholds> {
  const r = { ...DEFAULTS, ...(t ?? {}) }
  if (r.keepThreshold < 0) {
    throw new ValidationError(
      `improvement-verdict: keepThreshold must be >= 0, got ${r.keepThreshold}`,
    )
  }
  if (r.regressionThreshold < 0) {
    throw new ValidationError(
      `improvement-verdict: regressionThreshold must be >= 0, got ${r.regressionThreshold}`,
    )
  }
  if (r.minRepsForVerdict < 1) {
    throw new ValidationError(
      `improvement-verdict: minRepsForVerdict must be >= 1, got ${r.minRepsForVerdict}`,
    )
  }
  return r
}

function median(sorted: number[]): number {
  const n = sorted.length
  if (n === 0) return 0
  const mid = Math.floor(n / 2)
  return n % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!
}

/** Population standard deviation (÷n). 0 for fewer than 2 values. */
function stddev(values: number[], mean: number): number {
  if (values.length < 2) return 0
  const variance = values.reduce((acc, v) => acc + (v - mean) ** 2, 0) / values.length
  return Math.sqrt(variance)
}

/**
 * Compute the N-rep statistics for a set of reps. Pure — no I/O. The `stable`
 * flag is the trust gate the verdict depends on: a sample whose spread exceeds
 * the configured bounds can't distinguish a real delta from run-to-run noise.
 */
export function computeExperimentStats(
  reps: ExperimentRep[],
  thresholds?: ImprovementThresholds,
): ExperimentStats {
  const t = resolveThresholds(thresholds)
  const n = reps.length
  if (n === 0) {
    return {
      median: 0,
      mean: 0,
      min: 0,
      max: 0,
      iqr: 0,
      stddev: 0,
      passRate: null,
      n: 0,
      stable: false,
    }
  }
  const scores = reps.map((r) => {
    if (!Number.isFinite(r.score)) {
      throw new ValidationError(`improvement-verdict: rep ${r.rep} has non-finite score ${r.score}`)
    }
    return r.score
  })
  const sorted = [...scores].sort((a, b) => a - b)
  const mean = scores.reduce((s, v) => s + v, 0) / n
  const sd = stddev(scores, mean)
  const spread = iqr(scores)
  const rated = reps.filter((r) => typeof r.passed === 'boolean')
  const passRate = rated.length === 0 ? null : rated.filter((r) => r.passed).length / rated.length
  const stable = spread < t.iqrUnstableAbove && sd < t.stddevUnstableAbove
  return {
    median: median(sorted),
    mean,
    min: sorted[0]!,
    max: sorted[n - 1]!,
    iqr: spread,
    stddev: sd,
    passRate,
    n,
    stable,
  }
}

/**
 * Verdict for a candidate against its parent. Pure — operates on already-computed
 * stats. KEEP/REGRESSION require both sides to have `>= minRepsForVerdict` reps
 * AND the candidate to be `stable`; otherwise the result is NOISE (unstable) or
 * ITERATE (not enough reps / no parent).
 */
export function improvementVerdict(
  candidate: ExperimentStats,
  parent: ExperimentStats | null,
  thresholds?: ImprovementThresholds,
): ImprovementVerdictResult {
  const t = resolveThresholds(thresholds)
  if (!parent) {
    return {
      verdict: 'ITERATE',
      medianDelta: null,
      reason: 'no parent experiment to compare against',
    }
  }
  if (candidate.n < t.minRepsForVerdict || parent.n < t.minRepsForVerdict) {
    return {
      verdict: 'ITERATE',
      medianDelta: null,
      reason: `need >= ${t.minRepsForVerdict} reps on both sides (candidate n=${candidate.n}, parent n=${parent.n})`,
    }
  }
  if (!candidate.stable) {
    return {
      verdict: 'NOISE',
      medianDelta: candidate.median - parent.median,
      reason: `candidate unstable (iqr=${candidate.iqr}, stddev=${candidate.stddev.toFixed(2)})`,
    }
  }
  const medianDelta = candidate.median - parent.median
  if (medianDelta > t.keepThreshold) {
    return { verdict: 'KEEP', medianDelta, reason: `median +${medianDelta} > +${t.keepThreshold}` }
  }
  if (medianDelta < -t.regressionThreshold) {
    return {
      verdict: 'REGRESSION',
      medianDelta,
      reason: `median ${medianDelta} < -${t.regressionThreshold}`,
    }
  }
  return {
    verdict: 'NOISE',
    medianDelta,
    reason: `median delta ${medianDelta} inside noise band [-${t.regressionThreshold}, +${t.keepThreshold}]`,
  }
}
