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


/** Verdict for one candidate relative to its parent. ITERATE is the neutral
 *  "keep collecting reps / no parent to compare against" state. */
type ExperimentVerdict = 'KEEP' | 'ITERATE' | 'NOISE' | 'REGRESSION'

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






