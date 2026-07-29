import {
  type PairedBootstrapOptions,
  type PairedBootstrapResult,
  pairedBootstrap,
  pairedSignTest,
} from './statistics'

export interface PairedDeltaTestOptions extends PairedBootstrapOptions {
  /** Smallest candidate-minus-baseline delta that counts as improvement. Default 0. */
  threshold?: number
  /** Caller-required paired observations. The exact test may impose a higher minimum. */
  minPairs?: number
}

export interface PairedDeltaTestResult {
  bootstrap: PairedBootstrapResult
  method: 'bootstrap-ci' | 'exact-sign'
  /** Exact one-sided p-value below the bootstrap minimum; otherwise null. */
  pValue: number | null
  /** Effective observation minimum after accounting for confidence. */
  minimumPairs: number
  sufficient: boolean
  /**
   * The bootstrap interval has zero width (or is non-finite), so it carries no
   * information about how far the estimate could be wrong and cannot support a
   * decision in either direction. See {@link pairedDeltaTest}.
   */
  indeterminate: boolean
  significant: boolean
}

/** Smallest all-positive sample that can clear a one-sided exact sign test. */
export function minimumPairsForPairedDeltaTest(confidence = 0.95): number {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new Error(
      `minimumPairsForPairedDeltaTest: confidence must be in (0,1), got ${confidence}`,
    )
  }
  const oneSidedAlpha = (1 - confidence) / 2
  return Math.ceil(Math.log2(1 / oneSidedAlpha))
}

/**
 * Tests whether a paired candidate-minus-baseline delta clears a threshold.
 *
 * At 20 or more pairs, the percentile bootstrap lower bound carries the
 * decision. Below that point the interval is descriptive only, so the function
 * switches to a pre-registered one-sided exact sign test. The exact path is
 * deliberately conservative: it requires both a point estimate above the
 * threshold and enough consistently positive paired differences.
 *
 * ## A zero-width interval is never significant
 *
 * When every paired delta is identical the resample distribution is a point
 * mass and the interval collapses: `[0, 0]` when all pairs tie, `[g, g]` on n
 * identical deltas of g. Neither says the effect is certain — both say the
 * sample carries no information about how far the estimate could be wrong, and
 * `low > threshold` then answers on the point estimate alone. It fails in both
 * directions: `[0, 0]` clears every NEGATIVE threshold, which is how a
 * tie-dominated pass/fail comparison laundered a regression into a
 * noninferiority pass, and `[g, g]` clears every threshold below g with no
 * spread behind it. Under a bounded asymmetric null whose true mean paired
 * delta is exactly 0 — 2 % of pairs dropping by 1.0, the rest gaining 0.0204 —
 * every sample that misses the drop is exactly that shape, and deciding on
 * `low > 0` promoted 65.65 % of samples at n = 20 against a nominal 5 %.
 *
 * So `indeterminate` is reported and `significant` is false whenever the
 * interval has zero width, on BOTH paths: at small n the exact sign test is a
 * test of the MEDIAN and a zero-spread sample is precisely where it stops
 * saying anything about the mean the caller is thresholding.
 *
 * `threshold` may be negative — that is a noninferiority margin, and it is the
 * regime the zero-width hole is worst in. For a two-point (pass/fail) outcome
 * the percentile bootstrap is not a valid interval at a nonzero margin at all;
 * use {@link decidePairedPromotion}, which routes those to Tango's score
 * interval, rather than thresholding this function's bootstrap directly.
 */
export function pairedDeltaTest(
  before: number[],
  after: number[],
  options: PairedDeltaTestOptions = {},
): PairedDeltaTestResult {
  const threshold = options.threshold ?? 0
  if (!Number.isFinite(threshold)) {
    throw new Error(`pairedDeltaTest: threshold must be finite, got ${threshold}`)
  }
  const confidence = options.confidence ?? 0.95
  const exactMinimum = minimumPairsForPairedDeltaTest(confidence)
  const requestedMinimum = options.minPairs ?? exactMinimum
  if (!Number.isInteger(requestedMinimum) || requestedMinimum < 1) {
    throw new Error(`pairedDeltaTest: minPairs must be a positive integer, got ${requestedMinimum}`)
  }
  const minimumPairs = Math.max(requestedMinimum, exactMinimum)
  const bootstrap = pairedBootstrap(before, after, options)
  const sufficient = bootstrap.n >= minimumPairs
  // A point-mass resample distribution is an absence of evidence, not a
  // certainty, and it is the shape that clears every negative threshold. Both
  // paths refuse it: see the "zero-width" section of this function's docs.
  const indeterminate =
    bootstrap.n > 0 &&
    (!Number.isFinite(bootstrap.low) ||
      !Number.isFinite(bootstrap.high) ||
      bootstrap.low === bootstrap.high)

  if (bootstrap.gateEligible) {
    return {
      bootstrap,
      method: 'bootstrap-ci',
      pValue: null,
      minimumPairs,
      sufficient,
      indeterminate,
      significant: sufficient && !indeterminate && bootstrap.low > threshold,
    }
  }

  const differences = before.map((value, index) => after[index]! - value - threshold)
  const exact = pairedSignTest(differences, 'greater')
  const estimate = options.statistic === 'mean' ? bootstrap.mean : bootstrap.median
  return {
    bootstrap,
    method: 'exact-sign',
    pValue: exact.pValue,
    minimumPairs,
    sufficient,
    indeterminate,
    significant:
      sufficient &&
      !indeterminate &&
      estimate > threshold &&
      exact.pValue <= (1 - bootstrap.confidence) / 2,
  }
}
