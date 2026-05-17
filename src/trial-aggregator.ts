/**
 * Trial-aggregator modes.
 *
 * The prompt-evolution loop's internal `aggregateTrials` defaulted to
 * including every non-`error` trial in the mean — which corrupted the mean
 * when a trial had `score: 0` because the judge silently aborted (the
 * caller's try/catch swallowed the abort and returned zero). Today's
 * tax/gtm evals show this: every trial scored judge=0 because the judge
 * aborted, and the composite then reflected `structural * 0.3 + slop * 0.1`
 * instead of the intended `judge * 0.6 + structural * 0.3 + slop * 0.1`.
 *
 * `aggregateTrialsByMode` is the substrate fix. Consumers can choose:
 *
 *   - `strict-fail` — any trial with `judgeSucceeded === false` fails the
 *     whole aggregate. Right for production-gate runs where one corrupted
 *     trial means "we don't know if the prompt is good, halt the gate."
 *
 *   - `exclude-failed` — drop trials with `judgeSucceeded === false` from
 *     the mean; report `failedTrials` separately. Right for research /
 *     comparison runs where you want to use the signal that DID land.
 *     Default for new code.
 *
 *   - `zero-fill` — legacy behavior: failed trials count as score=0 in
 *     the mean. Default ONLY for backwards-compat with adapters that
 *     don't yet set `judgeSucceeded`. Migrate off this — it's the source
 *     of today's data corruption.
 */

import type { TrialResult } from './prompt-evolution'

export type AggregatorMode = 'strict-fail' | 'exclude-failed' | 'zero-fill'

export interface TrialAggregate {
  /** Mean score over the trials counted by the chosen mode. */
  meanScore: number
  /** Mean cost (legacy, kept for compatibility). */
  meanCost: number
  /** Mean wall time (legacy). */
  meanDurationMs: number
  /** ok-rate (legacy). */
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

/**
 * Aggregate trials with explicit failed-judge handling. Returns counts for
 * counted + excluded so callers can surface "the score is based on 7 of 10
 * trials; 3 judges failed" instead of silently weighting zero.
 */
export function aggregateTrialsByMode(
  trials: TrialResult[],
  opts: { mode: AggregatorMode },
): TrialAggregate {
  // Filter out hard-errored trials (agent crash) regardless of mode — those
  // are not eval signal, they're infrastructure failure.
  const gradedTrials = trials.filter((t) => !t.error)

  // Partition by judge success. `undefined` (consumer didn't report) is
  // treated as `true` for back-compat with adapters that don't yet wire
  // `judgeSucceeded`. The migration path is: add `judgeSucceeded` to your
  // adapter, then switch to `exclude-failed` mode.
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
    okRate: gradedTrials.length === 0 ? 0 : gradedTrials.filter((t) => t.ok).length / gradedTrials.length,
    countedTrials: counted.length,
    excludedFailedTrials: judgeFailed.length,
    totalTrials: trials.length,
    metrics: meanMetrics(counted.map((t) => t.metrics ?? {})),
  }
}
