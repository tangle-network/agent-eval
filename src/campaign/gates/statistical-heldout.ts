/**
 * Statistical held-out promotion machinery — the trustworthy core the
 * point-estimate `heldout-delta` gate lacked.
 *
 * The shipped false positive it prevents: a winner re-scored against the
 * baseline on the holdout read run-to-run model NOISE (e.g. 91 vs 95) as a
 * "+4 lift" and shipped, because the gate compared point estimates with no
 * confidence interval. Here we pair candidate vs baseline holdout observations
 * and bootstrap a CI on the paired delta — a candidate ships only when the CI
 * lower bound clears the effect-size threshold (the gain is real at the
 * confidence level, not noise), and is blocked when a critical dimension
 * (e.g. `hallucination_free` for a legal agent) significantly regresses even if
 * the net composite rose (anti-Goodhart).
 *
 * Two traps this module is built around (both produce a NEW false positive if
 * gotten wrong):
 *   1. PAIRING GRANULARITY — pairs by FULL `cellId` (`scenario:rep`), never by
 *      `scenarioId` (which averages reps away and destroys the within-pair
 *      variance reduction that makes a paired bootstrap tighter than unpaired).
 *      One paired observation per cell ⇒ reps multiply n.
 *   2. SCALE — a judge may emit composites/dimensions on [0,1] or 0-100. The
 *      threshold + tolerance are interpreted in the judge's NATIVE scale; the
 *      per-dimension tolerance auto-scales off the observed baseline magnitudes
 *      so `-0.10` on [0,1] doesn't silently become a no-op on a 0-100 dimension.
 */

import {
  decidePairedPromotion,
  type PairedDecisionMethod,
  type PairedDecisionStatistic,
  type PairedMcNemarEvidence,
  type PairedPromotionDecision,
} from '../../paired-promotion-decision'
import {
  DECISION_PAIRED_DELTA_STATISTIC,
  type PairedBootstrapResult,
  pairedBootstrap,
} from '../../statistics'
import type { JudgeScore } from '../types'

/** Tie fraction at/above which a gate annotates its verdict with the tie share.
 *  Tie-domination of the median bites structurally at >= 0.5 (the median is then
 *  0 by construction); 0.4 is a softer warn threshold that flags a run APPROACHING
 *  that regime, so an operator sees it before the median goes fully blind. */
export const TIE_WARN_FRACTION = 0.4

export interface PairedHoldout {
  /** Baseline scalar per paired cell (same order as `after`/`cellIds`). */
  before: number[]
  /** Candidate scalar per paired cell. */
  after: number[]
  /** The full cellIds (`scenario:rep`) that paired, in order. */
  cellIds: string[]
}

/**
 * Pair candidate vs baseline holdout observations by FULL cellId. `select`
 * pulls the scalar from a cell's judge reports (composite, or a named
 * dimension); a cell contributes the mean of `select` across its judges. Cells
 * whose scenario is not in `scenarioIds`, or where `select` is undefined for
 * every judge on either side, are skipped on BOTH sides so the arrays stay
 * paired. Throws when the two maps disagree on which holdout cells exist — a
 * load-bearing invariant: the baseline + winner holdout campaigns run the same
 * scenarios with the same seed base, so their cellIds MUST align; a mismatch
 * means a silent pairing bug, not a soft fallback.
 */
export function pairHoldout(
  candidate: Map<string, Record<string, JudgeScore>>,
  baseline: Map<string, Record<string, JudgeScore>>,
  scenarioIds: Set<string>,
  select: (s: JudgeScore) => number | undefined,
): PairedHoldout {
  const cellValue = (
    byCell: Map<string, Record<string, JudgeScore>>,
    cellId: string,
  ): number | undefined => {
    const scores = byCell.get(cellId)
    if (!scores) return undefined
    const vals: number[] = []
    for (const s of Object.values(scores)) {
      if (s.failed === true) {
        throw new Error(`pairHoldout: cell '${cellId}' contains a failed judge score`)
      }
      const v = select(s)
      if (typeof v === 'number' && !Number.isFinite(v)) {
        throw new Error(`pairHoldout: cell '${cellId}' contains a non-finite selected score`)
      }
      if (typeof v === 'number') vals.push(v)
    }
    if (vals.length === 0) return undefined
    return vals.reduce((a, b) => a + b, 0) / vals.length
  }

  const inScope = (cellId: string) => scenarioIds.has(cellId.split(':')[0] ?? '')
  const candCells = [...candidate.keys()].filter(inScope).sort()
  const baseCells = [...baseline.keys()].filter(inScope).sort()
  // Alignment invariant — the holdout campaigns share scenarios + seed, so the
  // cell sets must be identical. Differ ⇒ a real pairing bug; fail loud.
  if (candCells.length !== baseCells.length || candCells.some((c, i) => c !== baseCells[i])) {
    throw new Error(
      `pairHoldout: candidate/baseline holdout cells do not align — ` +
        `candidate=[${candCells.join(',')}] baseline=[${baseCells.join(',')}]. ` +
        `Both holdout campaigns must run the same scenarios with the same seed base.`,
    )
  }

  const before: number[] = []
  const after: number[] = []
  const cellIds: string[] = []
  for (const cellId of candCells) {
    const b = cellValue(baseline, cellId)
    const a = cellValue(candidate, cellId)
    // A scalar absent on both sides means that dimension was not scored. A
    // one-sided absence is asymmetric evidence loss, never a row to discard.
    if (b === undefined && a === undefined) continue
    if (b === undefined || a === undefined) {
      throw new Error(`pairHoldout: cell '${cellId}' has a selected score on only one arm`)
    }
    before.push(b)
    after.push(a)
    cellIds.push(cellId)
  }
  return { before, after, cellIds }
}

export interface HeldoutSignificance {
  paired: PairedHoldout
  /**
   * The paired bootstrap on the requested statistic (MEAN by default — see the
   * tie note on `heldoutSignificance`).
   *
   * DIAGNOSTIC, not necessarily the interval the verdict keyed on. On a
   * two-point (pass/fail) outcome the decision routes to Tango's score interval
   * instead, because a percentile bootstrap of the mean over a three-atom
   * lattice is not a valid interval at a nonzero margin. Read
   * `decision.low`/`decision.high` for the interval that actually decided, and
   * `decisionStatistic` for which one it is.
   */
  bootstrap: PairedBootstrapResult
  /** The MEDIAN paired-delta bootstrap, reported as a diagnostic. When many
   *  scenarios are tied (both sides solve them), the median is pinned near 0
   *  regardless of the mean lift — comparing the two exposes tie-domination. */
  medianBootstrap: PairedBootstrapResult
  /**
   * The full promotion decision: which estimator the outcome's shape admits,
   * the interval it produced, McNemar's exact veto on the two-point path, and
   * whether the interval was zero-width (no evidence in either direction). The
   * single source of `significant`.
   */
  decision: PairedPromotionDecision
  /** Which paired estimator the verdict was decided on. */
  decisionStatistic: PairedDecisionStatistic
  /** McNemar's exact evidence on the two-point path; null otherwise. */
  mcnemar: PairedMcNemarEvidence | null
  /** Fraction of paired observations that are exact ties (|delta| < 1e-9). A
   *  high tie fraction is WHY a median-based gate would have missed a real lift;
   *  it is the observability the tie fix adds. */
  tieFraction: number
  /** n paired observations. */
  n: number
  /** Effective minimum after applying the bootstrap's hard statistical floor. */
  minimumRequired: number
  /** Statistical method that carried the decision. */
  decisionMethod: PairedDecisionMethod
  /** Exact one-sided p-value on the small-sample path; otherwise null. */
  pValue: number | null
  /** True iff n >= minimumRequired, the DECIDING interval has nonzero width,
   *  its lower bound clears the threshold, and McNemar's exact test does not
   *  veto at a non-negative threshold. */
  significant: boolean
  /** Set when n < minimumRequired — too little evidence to claim significance. */
  fewRuns: boolean
}

export interface HeldoutSignificanceOptions {
  deltaThreshold?: number
  minProductiveRuns?: number
  confidence?: number
  resamples?: number
  /** Fixed by default for a deterministic, reproducible gate verdict. */
  seed?: number
  statistic?: 'mean' | 'median'
}

/**
 * Significance of the held-out composite lift: ship only when the lower bound
 * of the interval the outcome's shape ADMITS exceeds `deltaThreshold` (default
 * 0 ⇒ "confidently positive"). Interpret `deltaThreshold` in the judge's native
 * scale.
 *
 * The decision is delegated whole to {@link decidePairedPromotion}, the one
 * copy of the rule (`src/paired-promotion-decision.ts`), which `HeldOutGate`
 * also calls. That module's header carries the measurements; the short version
 * is three guards a bare `bootstrap.low > threshold` does not have:
 *
 *   - a two-point (pass/fail) outcome decides on Tango's SCORE interval, the
 *     only paired-binary construction that stays valid at a nonzero margin;
 *   - McNemar's exact test VETOES at any non-negative threshold;
 *   - a ZERO-WIDTH interval is refused rather than promoted, in either
 *     direction — [0,0] clears every negative threshold and [g,g] clears every
 *     threshold below g, and both are an absence of evidence, not a result.
 *
 * Measured on this function before those guards landed, at a nominal 5 %:
 * 14.60 % false promotion at n = 40 on a paired-binary noninferiority boundary,
 * and 88.50 % at n = 6 under a bounded asymmetric null whose true mean paired
 * delta is exactly 0.
 *
 * At small n, where the percentile bootstrap is descriptive only, a
 * pre-registered exact sign test still carries the bootstrap path.
 */
export function heldoutSignificance(
  paired: PairedHoldout,
  opts: HeldoutSignificanceOptions = {},
): HeldoutSignificance {
  const deltaThreshold = opts.deltaThreshold ?? 0
  const confidence = opts.confidence ?? 0.95
  const resamples = opts.resamples ?? 2000
  const seed = opts.seed ?? 1337
  // DEFAULT to the MEAN paired delta, not the median. The median is destroyed by
  // TIES: whenever both baseline and candidate solve a holdout scenario (a common
  // case once the agent is decent — and INCREASINGLY common as you add holdout
  // scenarios for statistical power), that scenario contributes delta 0. When
  // >=50% of paired cells are ties the median is pinned at 0 regardless of a large,
  // consistent lift on the rest, and the gate holds a genuinely better candidate.
  // (Measured live, supervisor-lab run 6: 40 cells, 20 ties, MEAN +0.177, MEDIAN 0
  // → false hold. Doubling the holdout for "power" made it WORSE by adding ties.)
  // The mean equals the reported aggregate lift, ties correctly contribute 0
  // without dominating, and it is the textbook paired-comparison estimator; the
  // median is kept as a reported diagnostic. Callers wanting outlier-robustness at
  // the cost of tie-blindness can still pass `statistic: 'median'`.
  const statistic = opts.statistic ?? 'mean'
  const decision = decidePairedPromotion(paired.before, paired.after, {
    confidence,
    resamples,
    statistic,
    seed,
    threshold: deltaThreshold,
    minPairs: opts.minProductiveRuns,
  })
  // `decision.bootstrap` is null exactly when the score interval decided, so
  // the requested-statistic bootstrap is computed here for the diagnostic
  // field. Same two bootstraps as before on every path.
  const bootstrap =
    decision.bootstrap ??
    pairedBootstrap(paired.before, paired.after, { confidence, resamples, statistic, seed })
  const medianBootstrap =
    statistic === 'median'
      ? bootstrap
      : pairedBootstrap(paired.before, paired.after, {
          confidence,
          resamples,
          statistic: 'median',
          seed,
        })
  const n = paired.before.length
  let ties = 0
  for (let i = 0; i < n; i += 1) {
    const after = paired.after[i] ?? 0
    const before = paired.before[i] ?? 0
    if (Math.abs(after - before) < 1e-9) ties += 1
  }
  const tieFraction = n === 0 ? 0 : ties / n
  return {
    paired,
    bootstrap,
    medianBootstrap,
    decision,
    decisionStatistic: decision.statistic,
    mcnemar: decision.mcnemar,
    tieFraction,
    n,
    minimumRequired: decision.minimumPairs,
    decisionMethod: decision.method,
    pValue: decision.pValue,
    significant: decision.promote,
    fewRuns: !decision.sufficient,
  }
}

export interface DimensionRegression {
  dimension: string
  /** Paired bootstrap on (candidate − baseline). DIAGNOSTIC on a pass/fail
   *  dimension, where `ci` carries the interval that decided instead. */
  bootstrap: PairedBootstrapResult
  /** Which paired statistic `bootstrap.low` is the lower bound of. `'mean'`
   *  unless the caller asked for the median. `bootstrap.median` still carries
   *  the median point estimate either way. */
  bootstrapStatistic: 'median' | 'mean'
  /** The interval `regressed` was decided on, in the dimension's native units. */
  ci: { low: number; high: number }
  /** Which estimator produced `ci`. */
  decisionStatistic: PairedDecisionStatistic
  /** McNemar's exact evidence on a pass/fail dimension; null otherwise. */
  mcnemar: PairedMcNemarEvidence | null
  /** `ci` has zero width — no evidence in either direction. */
  indeterminate: boolean
  /** True iff the candidate may have regressed this dimension by more than
   *  tolerance: the lower bound of the DECIDING interval on (candidate −
   *  baseline) is below −tolerance, OR the exact small-sample test proves a drop
   *  past tolerance. */
  regressed: boolean
  tolerance: number
  n: number
}

/** Detect the native scale of a set of scores: 0-100 when any magnitude clears
 *  1.5, else [0,1]. Used to auto-scale the regression tolerance so a default
 *  expressed for [0,1] is not silently a no-op on a 0-100 dimension. */
export function detectScale(values: number[]): 1 | 100 {
  return values.some((v) => Math.abs(v) > 1.5) ? 100 : 1
}

/** Per-critical-dimension regression guard. For each dimension, pair the
 *  candidate vs baseline values by full cellId and bootstrap the paired delta;
 *  a dimension is "regressed" when the CI lower bound < −tolerance (conservative
 *  — blocks if the credible worst case exceeds tolerance, which is the right
 *  posture for safety dimensions like `hallucination_free`). When `tolerance`
 *  is omitted it auto-scales: 0.05 on [0,1], 5 on 0-100.
 *
 *  The interval comes from {@link decidePairedPromotion}, so a pass/fail
 *  dimension is judged on Tango's score interval rather than a percentile
 *  bootstrap of the mean — `tolerance` is a NONZERO margin, and the bootstrap
 *  is not a valid interval at one. That matters most here because this guard
 *  fails OPEN by construction: `tolerance` is positive, so an interval pinned at
 *  [0,0] never satisfies `low < −tolerance` and a real regression on a safety
 *  dimension would be reported as `regressed: false`. On the median it fails the
 *  same way for the same reason — when most pairs tie, which is automatic for a
 *  pass/fail dimension on {0,1} and on the 0-100 encoding `detectScale` exists
 *  to support, the median CI collapses to [0,0]. Pass `statistic: 'median'` to
 *  restore the pre-0.134 behaviour. */
export function dimensionRegressions(
  candidate: Map<string, Record<string, JudgeScore>>,
  baseline: Map<string, Record<string, JudgeScore>>,
  scenarioIds: Set<string>,
  criticalDimensions: string[],
  opts: {
    tolerance?: number
    confidence?: number
    resamples?: number
    seed?: number
    /** Paired statistic the CI is computed on. Default `'mean'` — see
     *  {@link DECISION_PAIRED_DELTA_STATISTIC} for why the median is not. */
    statistic?: 'mean' | 'median'
  } = {},
): DimensionRegression[] {
  const out: DimensionRegression[] = []
  for (const dim of criticalDimensions) {
    const paired = pairHoldout(candidate, baseline, scenarioIds, (s) => s.dimensions[dim])
    if (paired.before.length === 0) continue // dimension not scored on this judge
    const tolerance = opts.tolerance ?? 0.05 * detectScale([...paired.before, ...paired.after])
    const bootstrapStatistic = opts.statistic ?? DECISION_PAIRED_DELTA_STATISTIC
    const shared = {
      confidence: opts.confidence ?? 0.95,
      resamples: opts.resamples ?? 2000,
      statistic: bootstrapStatistic,
      seed: opts.seed ?? 1337,
    }
    const guard = decidePairedPromotion(paired.before, paired.after, shared)
    const regression = decidePairedPromotion(paired.after, paired.before, {
      ...shared,
      threshold: tolerance,
    })
    const bootstrap = guard.bootstrap ?? pairedBootstrap(paired.before, paired.after, shared)
    out.push({
      dimension: dim,
      bootstrap,
      bootstrapStatistic,
      ci: { low: guard.low, high: guard.high },
      decisionStatistic: guard.statistic,
      mcnemar: guard.mcnemar,
      indeterminate: guard.indeterminate,
      // Fires on EITHER burden of proof — see `floorBreached` in
      // `promotion-policy.ts` for the same rule and the reasoning. The CI arm
      // is the contract this interface and `default-production-gate`'s reason
      // string both state ("CI.low < -tolerance"), read off the DECIDING
      // interval; the exact-test arm adds the small-sample path where the
      // bootstrap interval is descriptive only.
      // The credible-worst-case arm stays on the BOOTSTRAP — see the same
      // decision in `floorBreached` (`promotion-policy.ts`). On a pass/fail
      // dimension the score interval is ±z²/(n+z²) even when every pair is
      // concordant, so reading the floor off it would flag an unchanged safety
      // dimension as regressed at any realistic n. The PROVEN-drop arm does use
      // the shared rule, which is what closes the fail-open hole that mattered:
      // a genuine pass/fail regression is now judged on an interval valid at
      // the nonzero `tolerance`, instead of a bootstrap that is pinned wherever
      // ties dominate.
      regressed: bootstrap.low < -tolerance || regression.promote,
      tolerance,
      n: paired.before.length,
    })
  }
  return out
}
