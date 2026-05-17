/**
 * Aggregate trials with explicit handling of judge failure. Three modes:
 *
 *   - `strict-fail` — any `judgeSucceeded === false` trial fails the whole
 *     aggregate. Use for production gates: one corrupt trial halts the gate.
 *
 *   - `exclude-failed` — drop `judgeSucceeded === false` trials from the
 *     mean; report `excludedFailedTrials` separately. Default for new code.
 *
 *   - `zero-fill` — failed trials count as `score: 0` in the mean. Available
 *     only for adapters that don't yet set `judgeSucceeded`.
 *
 * Hard-errored trials (`t.error` set) are always excluded — those are
 * infrastructure failures, not eval signal.
 */

import type { TrialResult } from './prompt-evolution'

export type AggregatorMode = 'strict-fail' | 'exclude-failed' | 'zero-fill'

export interface TrialAggregate {
  /** Mean score over the trials counted by the chosen mode. */
  meanScore: number
  /** Mean cost across counted trials. */
  meanCost: number
  /** Mean wall time across counted trials. */
  meanDurationMs: number
  /** Fraction of counted trials with `ok === true`. */
  okRate: number
  /** Trials counted in the mean (mode-dependent). */
  countedTrials: number
  /** Trials excluded because `judgeSucceeded === false` (exclude-failed mode). */
  excludedFailedTrials: number
  /** Total trials passed in. */
  totalTrials: number
  /** Mean of every numeric metric across counted trials. */
  metrics: Record<string, number>
  /**
   * Set when mode is `strict-fail` AND at least one trial had
   * `judgeSucceeded === false`. Caller should refuse to use this aggregate
   * downstream — the eval is corrupt.
   */
  strictFailure?: { failedCount: number; firstError?: string }
}

function meanOf(xs: number[]): number {
  if (xs.length === 0) return 0
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

function meanMetrics(rows: Array<Record<string, number>>): Record<string, number> {
  if (rows.length === 0) return {}
  const keys = new Set<string>()
  for (const row of rows) for (const k of Object.keys(row)) keys.add(k)
  const out: Record<string, number> = {}
  for (const k of keys) {
    const xs = rows.map((r) => r[k]).filter((x): x is number => typeof x === 'number')
    if (xs.length > 0) out[k] = meanOf(xs)
  }
  return out
}

export function aggregateTrialsByMode(
  trials: TrialResult[],
  opts: { mode: AggregatorMode },
): TrialAggregate {
  // Hard-errored trials are excluded in every mode — infrastructure failure, not eval signal.
  const gradedTrials = trials.filter((t) => !t.error)

  // `judgeSucceeded === undefined` counts as success (adapter hasn't wired the field yet).
  const judgeOk = gradedTrials.filter((t) => t.judgeSucceeded !== false)
  const judgeFailed = gradedTrials.filter((t) => t.judgeSucceeded === false)

  if (opts.mode === 'strict-fail' && judgeFailed.length > 0) {
    return {
      meanScore: 0,
      meanCost: 0,
      meanDurationMs: 0,
      okRate: 0,
      countedTrials: 0,
      excludedFailedTrials: judgeFailed.length,
      totalTrials: trials.length,
      metrics: {},
      strictFailure: {
        failedCount: judgeFailed.length,
        firstError: judgeFailed.find((t) => t.judgeError)?.judgeError,
      },
    }
  }

  const counted = opts.mode === 'exclude-failed' ? judgeOk : gradedTrials
  return {
    meanScore: meanOf(counted.map((t) => t.score)),
    meanCost: meanOf(counted.map((t) => t.cost ?? 0)),
    meanDurationMs: meanOf(counted.map((t) => t.durationMs ?? 0)),
    okRate:
      gradedTrials.length === 0 ? 0 : gradedTrials.filter((t) => t.ok).length / gradedTrials.length,
    countedTrials: counted.length,
    excludedFailedTrials: judgeFailed.length,
    totalTrials: trials.length,
    metrics: meanMetrics(counted.map((t) => t.metrics ?? {})),
  }
}
