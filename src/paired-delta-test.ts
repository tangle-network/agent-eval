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

  if (bootstrap.gateEligible) {
    return {
      bootstrap,
      method: 'bootstrap-ci',
      pValue: null,
      minimumPairs,
      sufficient,
      significant: sufficient && bootstrap.low > threshold,
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
    significant:
      sufficient && estimate > threshold && exact.pValue <= (1 - bootstrap.confidence) / 2,
  }
}
