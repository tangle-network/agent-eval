/**
 * @module
 * ONE rule for "does this paired interval clear a promotion threshold".
 *
 * The rule below was derived on `HeldOutGate` (#479) after the same estimator
 * bug shipped twice. It then turned out that a SECOND gate — the composable
 * `heldOutGate`, plus everything else routed through `heldoutSignificance` —
 * still carried the original defect, because the rule had been written into one
 * gate's method body rather than into a shared function. Two copies of a
 * statistical rule is how a defect survives in one of them, so there is now
 * exactly one copy and both gates call it.
 *
 * Three things the rule does that a bare `pairedBootstrap(...).low > threshold`
 * does not:
 *
 * 1. **Two-point (pass/fail) outcomes decide on Tango's SCORE interval.** On a
 *    pass/fail eval the paired delta vector is dominated by ties, so the
 *    bootstrap of the mean is a resample of a lattice with three atoms and its
 *    percentile interval is not valid at a nonzero margin. The score interval
 *    (`pairedRiskDifferenceScore`) re-estimates the nuisance loss rate under
 *    each hypothesised margin instead of fixing it at the observed value, which
 *    is the only construction that stays a confidence interval as the margin
 *    moves off zero — the regime every noninferiority threshold lives in.
 *    Measured on the composable gate before this change, at a true risk
 *    difference sitting exactly on the production caller's -0.05 margin and a
 *    nominal 5 %: 14.60 % false promotion at n = 40 and 10.10 % at n = 76.
 * 2. **McNemar's exact test holds a VETO at every non-negative threshold.**
 *    Redundant with the interval by construction and kept anyway, so that
 *    swapping the estimator for one without that duality cannot silently
 *    reintroduce "promotes what the exact test refuses". Witness: n = 6, b = 5,
 *    c = 0 — no exact argument reaches alpha = 0.05 with 5 discordant pairs
 *    (two-sided floor 2/2^5 = 0.0625), whatever an interval says. A NEGATIVE
 *    threshold is a noninferiority question, which McNemar's test of "no
 *    difference" is not the right test for, so the veto does not apply there.
 * 3. **A ZERO-WIDTH interval is refused, wherever it sits.** At [0, 0] it
 *    cannot tell a gain from a regression and clears every negative threshold.
 *    Away from zero it fails the opposite way: n identical positive deltas give
 *    [g, g], which clears threshold 0 on no spread at all. Both are an absence
 *    of evidence. Measured on the composable gate before this change, under a
 *    bounded asymmetric null whose true mean paired delta is exactly 0: 88.50 %
 *    false promotion at n = 6 and 65.65 % at n = 20 against a nominal 5 %.
 *
 * Eligibility follows the requested target. A continuous mean needs the
 * bootstrap minimum; binary outcomes and explicit median targets use the
 * exact-test minimum. A small-sample sign diagnostic cannot certify a mean
 * effect. These floors establish estimator eligibility, not adequate power.
 */

import { minimumPairsForPairedDeltaTest, pairedDeltaTest } from './paired-delta-test'
import {
  BOOTSTRAP_GATE_MIN_N,
  type PairedBootstrapResult,
  pairedBinaryScale,
  pairedDeltaTieFraction,
  pairedRiskDifferenceExact,
  pairedRiskDifferenceScore,
} from './statistics'

/** Which paired estimator produced the deciding interval. */
export type PairedDecisionStatistic =
  | 'paired_risk_difference'
  | 'mean_bootstrap'
  | 'median_bootstrap'

/** Which test carried the decision, given the estimator and the sample size. */
export type PairedDecisionMethod = 'score-interval' | 'bootstrap-ci' | 'exact-sign'

/** McNemar's exact paired-binary evidence, on the two-point path only. */
export interface PairedMcNemarEvidence {
  /** Discordant pairs the treatment won. */
  b: number
  /** Discordant pairs the control won. */
  c: number
  /** b + c — the only pairs carrying information. */
  nDiscordant: number
  /** Two-sided exact p-value. */
  pValue: number
}

export interface PairedPromotionDecisionOptions {
  /** Smallest candidate-minus-baseline delta that counts as improvement, in the
   *  caller's native units. May be negative (a noninferiority margin). Default 0. */
  threshold?: number
  /** Confidence level. Default 0.95. */
  confidence?: number
  /** Bootstrap resamples, on the paths where a bootstrap decides. Default 2000. */
  resamples?: number
  /** Deterministic bootstrap seed. Omitted ⇒ derived from the deltas. */
  seed?: number
  /** Caller-required paired observations. The test also imposes its own
   *  minimum: bootstrap eligibility for a continuous mean, or the exact-test
   *  minimum for binary and explicit median targets. This is not a power guarantee. */
  minPairs?: number
  /**
   * `'mean'` (default) routes by SHAPE: a two-point (pass/fail) outcome on any
   * encoding decides on the score interval, everything else on the mean
   * bootstrap. `'median'` forces the median bootstrap on every input, including
   * shapes where it is structurally blind — kept for callers who want outlier
   * robustness on genuinely continuous outcomes and accept that cost.
   */
  statistic?: 'mean' | 'median'
  /** Declared binary support {0, binaryScale}, including when all observations
   *  are zero. Must be finite and positive; every observation must use that
   *  support. Uses the risk-difference mean, so cannot accompany 'median'.
   *  Omitted: infer binary support from observed positive values. */
  binaryScale?: number
  /**
   * Declare the outcome continuous: never infer a two-point support from the
   * observed values, so the estimator is fixed before the data is seen. A
   * sealed call on a continuous measure must route to the bootstrap whatever
   * the sample happens to look like; with inference on, a sample whose values
   * all land on {0, s} is silently decided on the score interval instead.
   * Measured under discovery's E1 alternative (deltas in {+1, -0.5, 0} on a
   * zero baseline) at 20 pairs: 5.4 % of 2,000 simulated samples (seed 11)
   * re-route without this flag, 0 with it; the exact rate is 5.54 %
   * (`paired-promotion-power.test.ts`). Cannot accompany `binaryScale`.
   */
  continuous?: boolean
}

export interface PairedPromotionDecision {
  /** Paired observations supplied. */
  n: number
  /** Threshold the interval was judged against, native units. */
  threshold: number
  confidence: number
  statistic: PairedDecisionStatistic
  method: PairedDecisionMethod
  /** Declared or inferred positive level ({0,1} ⇒ 1, {0,100} ⇒ 100),
   *  or null when the outcome is not two-point. Non-null is exactly the
   *  condition for the `paired_risk_difference` path, and it is the factor
   *  `delta` / `low` / `high` were rescaled by. */
  binaryScale: number | null
  /** Exact-tie fraction over the paired deltas; null when there are no pairs. */
  tieFraction: number | null
  /** Point estimate of the DECIDING statistic, in the caller's native units. */
  delta: number
  /** Lower bound of the DECIDING interval, native units. */
  low: number
  /** Upper bound of the DECIDING interval, native units. */
  high: number
  /** The bootstrap that decided, or null when the score interval did. Callers
   *  that need a bootstrap as a diagnostic on the two-point path compute their
   *  own — it is not computed here, so the binary path costs no resamples. */
  bootstrap: PairedBootstrapResult | null
  /** McNemar's exact evidence, or null off the two-point path. */
  mcnemar: PairedMcNemarEvidence | null
  /** Exact one-sided sign-test p-value on the small-sample bootstrap path;
   *  null otherwise. */
  pValue: number | null
  /** Effective observation minimum for the target, confidence, and caller floor. */
  minimumPairs: number
  /** n >= minimumPairs. */
  sufficient: boolean
  /** The deciding interval is zero-width at numeric precision or non-finite — no evidence in either
   *  direction, so it cannot clear any threshold on evidence. */
  indeterminate: boolean
  /** McNemar's exact test refuses at a non-negative threshold. */
  exactTestVetoes: boolean
  /** The deciding interval clears the threshold, ignoring the other two guards. */
  clearsThreshold: boolean
  /** `sufficient && !indeterminate && clearsThreshold && !exactTestVetoes` —
   *  the whole rule. */
  promote: boolean
  /** What `delta` measures, for a reason string. */
  label: 'success-rate' | 'mean' | 'median'
  /** Why a zero-width interval is zero-width; empty when it is not. */
  indeterminateCause: string
  /** Sentence naming the test when the exact sign test decided; else empty. */
  methodDetail: string
}

/** The shape facts that pick the estimator, without computing an interval. */
export interface PairedDecisionShape {
  statistic: PairedDecisionStatistic
  /** Declared or inferred positive binary level; null off the binary path. */
  binaryScale: number | null
  /** Exact-tie fraction over the paired deltas; null when there are no pairs. */
  tieFraction: number | null
}

/**
 * Which estimator {@link decidePairedPromotion} would use on this data, and the
 * shape facts behind it — for callers that must report the shape on a path
 * where no interval is computed at all (an early rejection, or zero pairs).
 * Cheap: no bootstrap, no interval.
 */
export function pairedDecisionShape(
  before: number[],
  after: number[],
  statistic: 'mean' | 'median' = 'mean',
  declaredBinaryScale?: number,
  continuous = false,
): PairedDecisionShape {
  if (continuous && declaredBinaryScale !== undefined) {
    throw new Error('pairedDecisionShape: continuous cannot accompany binaryScale')
  }
  if (declaredBinaryScale !== undefined) {
    if (!Number.isFinite(declaredBinaryScale) || declaredBinaryScale <= 0) {
      throw new Error('pairedDecisionShape: binaryScale must be finite and positive')
    }
    if (statistic === 'median') {
      throw new Error('pairedDecisionShape: binaryScale requires the mean statistic, not median')
    }
    for (const [name, arm] of [
      ['before', before],
      ['after', after],
    ] as const) {
      for (let i = 0; i < arm.length; i++) {
        const value = arm[i]!
        if (value !== 0 && value !== declaredBinaryScale) {
          throw new Error(
            `pairedDecisionShape: ${name}[${i}] must be 0 or binaryScale (${declaredBinaryScale}); got ${value}`,
          )
        }
      }
    }
  }
  const tieFraction = before.length === 0 ? null : pairedDeltaTieFraction(before, after)
  if (statistic === 'median') {
    return { statistic: 'median_bootstrap', binaryScale: null, tieFraction }
  }
  if (continuous) {
    return { statistic: 'mean_bootstrap', binaryScale: null, tieFraction }
  }
  const binaryScale = declaredBinaryScale ?? pairedBinaryScale(before, after)
  if (binaryScale !== null) {
    return { statistic: 'paired_risk_difference', binaryScale, tieFraction }
  }
  return { statistic: 'mean_bootstrap', binaryScale: null, tieFraction }
}

/**
 * Decide whether a paired candidate-minus-baseline delta clears a promotion
 * threshold. `before` is the baseline arm, `after` the candidate arm, paired by
 * position. Throws on unequal lengths.
 */
export function decidePairedPromotion(
  before: number[],
  after: number[],
  options: PairedPromotionDecisionOptions = {},
): PairedPromotionDecision {
  if (before.length !== after.length) {
    throw new Error(
      `decidePairedPromotion: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  const threshold = options.threshold ?? 0
  if (!Number.isFinite(threshold)) {
    throw new Error(`decidePairedPromotion: threshold must be finite, got ${threshold}`)
  }
  const confidence = options.confidence ?? 0.95
  const exactMinimum = minimumPairsForPairedDeltaTest(confidence)
  const requestedMinimum = options.minPairs ?? exactMinimum
  if (!Number.isInteger(requestedMinimum) || requestedMinimum < 1) {
    throw new Error(
      `decidePairedPromotion: minPairs must be a positive integer, got ${requestedMinimum}`,
    )
  }
  const { binaryScale, tieFraction } = pairedDecisionShape(
    before,
    after,
    options.statistic,
    options.binaryScale,
    options.continuous ?? false,
  )
  const estimatorMinimum =
    binaryScale === null && options.statistic !== 'median' ? BOOTSTRAP_GATE_MIN_N : exactMinimum
  const minimumPairs = Math.max(requestedMinimum, exactMinimum, estimatorMinimum)
  const n = before.length
  const sufficient = n >= minimumPairs

  let core: {
    statistic: PairedDecisionStatistic
    method: PairedDecisionMethod
    delta: number
    low: number
    high: number
    bootstrap: PairedBootstrapResult | null
    mcnemar: PairedMcNemarEvidence | null
    pValue: number | null
    clearsThreshold: boolean
    label: PairedPromotionDecision['label']
    methodDetail: string
  }

  if (binaryScale !== null) {
    // Normalise the two-point encoding to {0,1} so the estimators see the
    // pass/fail structure, then rescale the answer back into the caller's
    // native units — the threshold is read in the units of the scores, so a
    // 0-100 pass/fail dimension must be gated in points, not in a rate.
    const unitControl = before.map((v) => v / binaryScale)
    const unitTreatment = after.map((v) => v / binaryScale)
    // TWO estimators with different jobs, because no single one does both.
    // `exact` is the authority on RD = 0 and supplies the veto; its
    // Clopper-Pearson interval conditions on the discordant count and is
    // therefore NOT a confidence interval at a nonzero margin. `score` is
    // Tango's, which is.
    const exact = pairedRiskDifferenceExact(unitControl, unitTreatment, confidence)
    const score = pairedRiskDifferenceScore(unitControl, unitTreatment, confidence)
    const low = score.lower * binaryScale
    core = {
      statistic: 'paired_risk_difference',
      method: 'score-interval',
      delta: score.riskDifference * binaryScale,
      low,
      high: score.upper * binaryScale,
      bootstrap: null,
      mcnemar: {
        b: exact.b,
        c: exact.c,
        nDiscordant: exact.nDiscordant,
        pValue: exact.pValue,
      },
      pValue: null,
      clearsThreshold: low > threshold,
      label: 'success-rate',
      methodDetail: '',
    }
  } else {
    const bootstrapStatistic = options.statistic === 'median' ? 'median' : 'mean'
    const test = pairedDeltaTest(before, after, {
      confidence,
      resamples: options.resamples,
      statistic: bootstrapStatistic,
      seed: options.seed,
      threshold,
      minPairs: minimumPairs,
    })
    const ci = test.bootstrap
    core = {
      statistic: bootstrapStatistic === 'mean' ? 'mean_bootstrap' : 'median_bootstrap',
      method: test.method,
      delta: bootstrapStatistic === 'mean' ? ci.mean : ci.median,
      low: ci.low,
      high: ci.high,
      bootstrap: ci,
      mcnemar: null,
      pValue: test.pValue,
      clearsThreshold: test.significant,
      label: bootstrapStatistic,
      methodDetail:
        test.method === 'exact-sign'
          ? bootstrapStatistic === 'mean'
            ? ` The mean requires ${minimumPairs} pairs for bootstrap eligibility;` +
              ` the exact sign-test p=${fmt(test.pValue ?? 1)} does not establish a mean effect.`
            : ` Below ${BOOTSTRAP_GATE_MIN_N} pairs the interval is descriptive only;` +
              ` the median decision uses the exact one-sided sign test, p=${fmt(test.pValue ?? 1)}.`
          : '',
    }
  }

  // Equivalent deltas can differ by rounding after subtraction and averaging.
  // Use the interval's own scale so tiny score units retain the same decision
  // as a rescaled copy of the evidence.
  const intervalScale = Math.max(Math.abs(core.low), Math.abs(core.high))
  const intervalTolerance = intervalScale * Number.EPSILON * 8
  const indeterminate =
    !Number.isFinite(core.low) ||
    !Number.isFinite(core.high) ||
    core.high - core.low <= intervalTolerance
  const indeterminateCause = !indeterminate
    ? ''
    : tieFraction === 1
      ? 'every paired delta is an exact tie'
      : core.mcnemar !== null && core.mcnemar.nDiscordant === 0
        ? 'every pair is concordant (0 discordant pairs)'
        : `the ${core.label} CI collapsed to a point at ${fmt(core.low)}`
  // Only at a non-negative threshold: a negative threshold asks a
  // noninferiority question, which McNemar's test of "no difference" does not
  // answer.
  const exactTestVetoes =
    core.mcnemar !== null && threshold >= 0 && !(core.mcnemar.pValue < 1 - confidence)

  return {
    n,
    threshold,
    confidence,
    binaryScale,
    tieFraction,
    minimumPairs,
    sufficient,
    indeterminate,
    indeterminateCause,
    exactTestVetoes,
    promote: sufficient && !indeterminate && core.clearsThreshold && !exactTestVetoes,
    ...core,
  }
}

function fmt(x: number): string {
  return x.toFixed(4)
}
