/**
 * HeldOutGate — first-class held-out paired-delta promotion gate.
 *
 * Encodes the "honesty override" pattern that lived inline in
 * `~/webb/redteam/scripts/agent-eval-autoresearch.ts:138–171`.
 * The optimizer's best-guess is one thing; what we should actually
 * ship is another. The gate is the line between them.
 *
 * A candidate is promoted iff ALL three pass:
 *
 *   1. **Productive runs**: the candidate has at least
 *      `minProductiveRuns` paired observations on items where BOTH
 *      candidate and baseline produced a real (non-silent) score.
 *   2. **Paired delta**: the lower bound of the CI on the per-item
 *      holdout delta (candidate − baseline) is strictly greater than
 *      `pairedDeltaThreshold`. WHICH paired statistic carries that CI
 *      depends on the outcome's shape — see "Choosing the statistic".
 *   3. **Overfit gap**: the candidate's gap between search-split
 *      score and holdout-split score is no worse (more positive)
 *      than the baseline's gap by more than `overfitGapThreshold`.
 *      "Better on search, worse on holdout" is the canonical
 *      overfit pattern; this catches it.
 *
 * ## Choosing the statistic
 *
 * The median paired delta is the robust default, but it goes BLIND wherever
 * ties dominate: with more than half the pairs tied its sample value is exactly
 * 0 whatever the shift on the rest, and the whole bootstrap CI collapses to
 * [0, 0]. `low > threshold` is then "no" forever at a non-negative threshold
 * and "yes" forever at a negative one — the gate refuses real gains AND
 * promotes real regressions. Measured: 76 held-out items with 15 candidate
 * wins, 5 candidate losses and 56 ties is a real +13.2pp lift whose median
 * paired delta is 0; the median-CI gate refused it at every non-negative
 * threshold while PROMOTING the mirror-image −13.2pp regression at any
 * negative one.
 *
 * So the statistic is picked by the shape of the data, in three cases:
 *
 * 1. **Two-point (pass/fail) outcomes on ANY encoding** — every value on both
 *    arms is either 0 or one common positive level, so {0,1} and {0,100} and
 *    {0,5} all qualify (see `pairedBinaryScale`). Decided on the EXACT paired
 *    risk difference: the change in success rate, rescaled into the caller's
 *    native units, with a Clopper-Pearson conditional interval that is dual to
 *    McNemar's exact test by construction. `lower > 0` holds exactly when the
 *    exact test rejects, so the gate can never promote what the exact test
 *    refuses — the Wald normal-approximation interval (`pairedRiskDifference`)
 *    does NOT have that property and undercovers badly on a handful of
 *    discordant pairs (n = 3, b = 2, c = 0: Wald [0.133, 1.000], exact
 *    [−0.456, 0.667], McNemar p = 0.50). McNemar's b/c/p ship as evidence.
 * 2. **Everything else** — the bootstrap CI of the MEAN paired delta. The mean
 *    is the estimator that answers the gate's own question ("by how much did
 *    the score move") in the caller's units, and it is well defined on every
 *    shape the median loses: tie-dominated vectors, low-cardinality lattices
 *    (block scores in {⅔, 1} from averaging pass/fail leaves; integer 0-100
 *    judge dimensions), and mixed arms. Measured: 26 blocks of 3 pass/fail
 *    leaves carrying a real +12.8pp lift, only 23% of pairs tied, give a
 *    median CI of [0, 0.333] — a lower bound of exactly 0 refuses a real lift
 *    at threshold 0, which is the original bug one lattice over. There is
 *    therefore no tie-fraction cutoff: any cutoff leaves the lattice case open
 *    on the far side of it. `heldoutSignificance` has defaulted to the mean
 *    since #316 for the same reason.
 *
 * Set `deltaStatistic: 'median'` to force the median on every input — the
 * pre-0.134 behaviour, kept for callers who want outlier robustness and accept
 * the blindness that comes with it.
 *
 * ## Fail closed
 *
 * A CI of exactly [0, 0] carries no directional information at all: it cannot
 * tell a gain from a regression, and it clears every negative threshold. That
 * is not a promotion, it is an absence of evidence, so the gate refuses with
 * `indeterminate_delta` rather than answering "promote". It arises when every
 * pair is concordant (no discordant pairs on the binary path) or every paired
 * delta is an exact tie.
 *
 * The decision carries a machine-readable `rejectionCode` plus an
 * `evidence` block with every number the gate looked at, so the
 * downstream researcher / paper / dashboard can re-derive the
 * verdict without re-running.
 *
 * See also:
 *   - `src/statistics.ts` for `pairedBootstrap` + `wilcoxonSignedRank`, and
 *     `pairedRiskDifferenceExact` (+ `pairedBinaryScale`) for the binary path
 *   - `src/run-record.ts` for the input row schema
 *   - `src/reference-replay.ts` for the older, reference-replay-
 *     specific promotion path (still useful for replay-style evals).
 */

import { pairRunRecords } from './paired-arms'
import { isRealnessGated, observedSplitScore, type ScorePreference } from './rollout/reward'
import type { RunRecord } from './run-record'
import {
  DECISION_PAIRED_DELTA_STATISTIC,
  pairedBinaryScale,
  pairedBootstrap,
  pairedDeltaTieFraction,
  pairedRiskDifferenceExact,
  wilcoxonSignedRank,
} from './statistics'

export type HeldOutGateRejectionCode =
  | 'few_runs'
  | 'missing_split_scores'
  | 'missing_cost'
  | 'negative_delta'
  | 'indeterminate_delta'
  | 'overfit_gap'
  | 'cost_ceiling'

export interface HeldOutGateConfig {
  /** Minimum number of paired (candidate, baseline) holdout observations
   *  required before the gate will even consider promoting. Default 3. */
  minProductiveRuns?: number
  /** The CI lower bound on the paired holdout delta must exceed this to
   *  promote. Read in the same units as the holdout scores: with binary
   *  (0/1) outcomes that is a change in success RATE (0.05 = +5pp).
   *  Default 0. */
  pairedDeltaThreshold?: number
  /**
   * Which paired statistic carries the promotion CI.
   *
   * `'auto'` (default) picks by outcome shape — two-point outcomes on the exact
   * paired risk difference, everything else on the mean bootstrap (see the
   * module header). `'median'` forces the median bootstrap on every input,
   * including shapes where it is structurally blind and will refuse a real lift
   * and accept a real regression. Set it for outlier robustness on genuinely
   * continuous outcomes, or to reproduce a pre-0.134 verdict.
   */
  deltaStatistic?: 'auto' | 'median'
  /** Maximum allowed worsening of (search − holdout) gap relative to
   *  baseline. Default 0.15 (i.e. candidate may overfit by up to 15
   *  absolute score points more than baseline before rejection). */
  overfitGapThreshold?: number
  /** Stable label of the baseline candidate. Required — paper-grade
   *  evaluation never compares two unlabelled candidates. */
  baselineKey: string
  /** Confidence level for the bootstrap CI. Default 0.95. */
  confidence?: number
  /** Bootstrap resamples. Default 2000. */
  bootstrapResamples?: number
  /** Optional deterministic seed for the bootstrap. Default undefined
   *  (Math.random). */
  seed?: number
  /**
   * Hard ceiling on the candidate's median per-task USD cost. When the
   * candidate clears the quality gates (paired-delta + overfit-gap) but
   * its median cost exceeds this number, the gate rejects with
   * `cost_ceiling`. Default `undefined` = no cost ceiling, behaving
   * exactly like the pre-cost gate.
   *
   * This exists because "we ship the better prompt" is only an honest
   * pitch when the better prompt also fits a customer-stated budget.
   * Cost is read from `RunRecord.costUsd`; a null amount rejects a
   * configured cost check because the limit cannot be proven.
   */
  costPerTaskCeiling?: number
}

/** Which paired statistic a `HeldOutGate` verdict was decided on. */
export type DeltaStatistic = 'median_bootstrap' | 'mean_bootstrap' | 'paired_risk_difference'

/** The outcome shape the gate detected, and the statistic it admits. */
interface OutcomeShape {
  statistic: DeltaStatistic
  /** Common positive level of a two-point outcome; null when not two-point. */
  binaryScale: number | null
  /** Exact-tie fraction over the paired deltas; null when there are no pairs. */
  tieFraction: number | null
}

export interface GateEvidence {
  /** Number of paired (candidate, baseline) holdout observations used. */
  productiveRuns: number
  /** Candidate holdout rows with no baseline row at the same work identity. */
  unpairedCandidateRuns: number
  /** Baseline holdout rows with no candidate row at the same work identity. */
  unpairedBaselineRuns: number
  /** Median of paired holdout deltas, or null when there are no pairs.
   *  ALWAYS the literal median — a diagnostic, not necessarily the statistic
   *  the verdict keyed on (see `deltaStatistic` / `decidingDelta`). On binary
   *  outcomes this is normally 0 by construction. */
  medianPairedDelta: number | null
  /** Which paired statistic the promotion CI was computed on, and therefore
   *  what `decidingDelta` / `pairedCI` mean. `'median_bootstrap'` = bootstrap
   *  CI on the median paired delta (continuous outcomes).
   *  `'mean_bootstrap'` = bootstrap CI on the mean paired delta, used when ties
   *  dominate and pin the median at 0. `'paired_risk_difference'` = change in
   *  success rate on a two-point (pass/fail) outcome, on an EXACT conditional
   *  interval dual to McNemar's exact test, rescaled to the outcome's native
   *  units (so a 0-100 dimension reports points, not a rate). */
  deltaStatistic: DeltaStatistic
  /** Point estimate of `deltaStatistic` — the number the `pairedDeltaThreshold`
   *  check is about. Null when no CI was computed. */
  decidingDelta: number | null
  /** CI on `deltaStatistic`, if computed. The gate promotes iff
   *  `pairedCI.low > pairedDeltaThreshold`. */
  pairedCI: { low: number; high: number } | null
  /** Wilcoxon signed-rank p-value, if computed. Always the Wilcoxon, on both
   *  paths, so this field never changes meaning. */
  pairedPValue: number | null
  /** McNemar's exact paired-binary test on the holdout pairs, or null when the
   *  outcomes were not two-point (or no CI was computed). `b` = candidate-only
   *  wins, `c` = baseline-only wins; only these discordant pairs carry signal.
   *  When present it is not merely reported: the promotion interval is dual to
   *  this p-value, so a promotion at a non-negative threshold implies
   *  `pValue < 1 − confidence`. */
  mcnemar: { b: number; c: number; nDiscordant: number; pValue: number } | null
  /** The common positive level of a two-point outcome — 1 for {0,1}, 100 for a
   *  0-100 pass/fail dimension — or null when the outcome is not two-point.
   *  Non-null is exactly the condition for the `paired_risk_difference` path,
   *  and it is the factor `decidingDelta` / `pairedCI` were rescaled by. */
  binaryScale: number | null
  /** Fraction of paired holdout deltas that are exact ties, or null when there
   *  are no pairs. At or above 0.5 the median paired delta is pinned at 0 by
   *  construction; this is the diagnostic for why a median-decided verdict
   *  (`deltaStatistic: 'median'`) saw nothing. */
  tieFraction: number | null
  /** Mean candidate score on the search split, or null when absent. */
  searchScore: number | null
  /** Mean candidate score on the holdout split, or null when absent. */
  holdoutScore: number | null
  /** Candidate (search − holdout) gap, or null when either side is absent. */
  overfitGap: number | null
  /** Baseline (search − holdout) gap, or null when either side is absent. */
  baselineOverfitGap: number | null
  /** Median per-task USD cost across the candidate's runs. Recorded
   *  even when no `costPerTaskCeiling` is configured so downstream
   *  dashboards (intelligence.tangle.tools) can render \$/task per
   *  generation regardless of gating policy. */
  medianCandidateCost: number | null
  /** Median per-task USD cost across the baseline runs, for
   *  symmetric reporting. */
  medianBaselineCost: number | null
  /**
   * Runs (candidate + baseline) dropped before pairing because the
   * authenticity gate flagged them as gamed. Surfaced rather than silent: a
   * promotion decision computed over a shrunken pool has to say by how much,
   * and a nonzero count here is itself the finding.
   */
  realnessGatedRuns: number
}

export interface GateDecision {
  /** Final promote/no-promote verdict. */
  promote: boolean
  /** The candidate that was evaluated. */
  candidateId: string
  /** The baseline it was compared against. */
  baselineId: string
  /** Every number the gate looked at, for audit + paper export. */
  evidence: GateEvidence
  /** Human-readable reason. */
  reason: string
  /** Machine-readable rejection code, or null on promote. */
  rejectionCode: HeldOutGateRejectionCode | null
}

/**
 * Held-out paired-delta promotion gate. Construct once with config,
 * call `evaluate(candidateRuns, baselineRuns)` per (candidate,
 * baseline) pair. Stateless across calls.
 */
export class HeldOutGate {
  private readonly minProductiveRuns: number
  private readonly pairedDeltaThreshold: number
  private readonly overfitGapThreshold: number
  private readonly baselineKey: string
  private readonly confidence: number
  private readonly resamples: number
  private readonly seed?: number
  private readonly costPerTaskCeiling?: number
  private readonly deltaStatistic: 'auto' | 'median'

  constructor(config: HeldOutGateConfig) {
    if (!config.baselineKey) {
      throw new Error('HeldOutGate: baselineKey is required')
    }
    this.minProductiveRuns = config.minProductiveRuns ?? 3
    this.pairedDeltaThreshold = config.pairedDeltaThreshold ?? 0
    this.overfitGapThreshold = config.overfitGapThreshold ?? 0.15
    this.baselineKey = config.baselineKey
    this.confidence = config.confidence ?? 0.95
    this.resamples = config.bootstrapResamples ?? 2000
    this.seed = config.seed
    this.deltaStatistic = config.deltaStatistic ?? 'auto'
    if (
      config.costPerTaskCeiling !== undefined &&
      !(Number.isFinite(config.costPerTaskCeiling) && config.costPerTaskCeiling > 0)
    ) {
      throw new Error('HeldOutGate: costPerTaskCeiling must be a positive finite number')
    }
    this.costPerTaskCeiling = config.costPerTaskCeiling
  }

  /** Decide whether `candidate` should replace `baseline`.
   *  Pairing is by `(experimentId, scenarioId, seed)`.
   *  Missing or duplicate identities throw instead of comparing by position. */
  evaluate(candidate: RunRecord[], baseline: RunRecord[]): GateDecision {
    const candidateId = inferCandidateId(candidate, this.baselineKey)
    const baselineId = this.baselineKey
    assertScenarioIdentities([...candidate, ...baseline])

    // Runs flagged as gamed are dropped from BOTH sides before anything is
    // paired. This is a promotion decision, and the whole point of the
    // authenticity gate is that a faked success must not buy a promotion; the
    // count ships in the evidence so the shrunken pool is never invisible.
    const realnessGatedRuns = [...candidate, ...baseline].filter(isRealnessGated).length
    const honestCandidate = candidate.filter((run) => !isRealnessGated(run))
    const honestBaseline = baseline.filter((run) => !isRealnessGated(run))

    const candidateSearch = scoredRuns(honestCandidate, 'search')
    const baselineSearch = scoredRuns(honestBaseline, 'search')
    const candidateHoldout = scoredRuns(honestCandidate, 'holdout')
    const baselineHoldout = scoredRuns(honestBaseline, 'holdout')
    const searchPairing = pairRunRecords(baselineSearch, candidateSearch)
    const holdoutPairing = pairRunRecords(baselineHoldout, candidateHoldout)
    // `scoredRuns` admits only rows whose split score is a finite number, so
    // the non-null assertion below cannot fire on data the pairing saw.
    const splitScoreOf = (run: RunRecord, split: ScorePreference): number =>
      observedSplitScore(run, split) as number
    const beforeSearch = searchPairing.pairs.map((pair) => splitScoreOf(pair.baseline, 'search'))
    const afterSearch = searchPairing.pairs.map((pair) => splitScoreOf(pair.treatment, 'search'))
    const beforeHoldout = holdoutPairing.pairs.map((pair) => splitScoreOf(pair.baseline, 'holdout'))
    const afterHoldout = holdoutPairing.pairs.map((pair) => splitScoreOf(pair.treatment, 'holdout'))

    const productiveRuns = beforeHoldout.length

    const candidateSearchMean = meanOrNull(afterSearch)
    const candidateHoldoutMean = meanOrNull(afterHoldout)
    const baselineSearchMean = meanOrNull(beforeSearch)
    const baselineHoldoutMean = meanOrNull(beforeHoldout)

    const overfitGap = diffOrNull(candidateSearchMean, candidateHoldoutMean)
    const baselineOverfitGap = diffOrNull(baselineSearchMean, baselineHoldoutMean)

    // Cost summary — surfaced in evidence regardless of gating policy
    // so downstream dashboards always know what the candidate cost.
    const medianCandidateCost = completeCostMedian(candidate)
    const medianBaselineCost = completeCostMedian(baseline)
    const commonEvidence = {
      productiveRuns,
      unpairedCandidateRuns: holdoutPairing.unpairedTreatment.length,
      unpairedBaselineRuns: holdoutPairing.unpairedBaseline.length,
      searchScore: candidateSearchMean,
      holdoutScore: candidateHoldoutMean,
      overfitGap,
      baselineOverfitGap,
      medianCandidateCost,
      medianBaselineCost,
      realnessGatedRuns,
    }
    /** Evidence for the early exits, where no CI was computed at all. The
     *  statistic that WOULD have decided is still reported so a caller can see
     *  which branch their data lands in without producing a verdict. */
    const earlyShape = this.chooseShape(beforeHoldout, afterHoldout)
    const noCiEvidence = {
      ...commonEvidence,
      medianPairedDelta: productiveRuns > 0 ? medianDelta(beforeHoldout, afterHoldout) : null,
      deltaStatistic: earlyShape.statistic,
      decidingDelta: null,
      pairedCI: null,
      pairedPValue: null,
      mcnemar: null,
      binaryScale: earlyShape.binaryScale,
      tieFraction: earlyShape.tieFraction,
    }

    const missingSplitScores = [
      candidateSearch.length === 0 ? 'candidate search' : null,
      candidateHoldout.length === 0 ? 'candidate holdout' : null,
      baselineSearch.length === 0 ? 'baseline search' : null,
      baselineHoldout.length === 0 ? 'baseline holdout' : null,
    ].filter((label): label is string => label !== null)
    if (missingSplitScores.length > 0) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence: noCiEvidence,
        reason: `missing_split_scores: ${missingSplitScores.join(', ')} score evidence is absent`,
        rejectionCode: 'missing_split_scores',
      }
    }

    if (productiveRuns < this.minProductiveRuns) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence: noCiEvidence,
        reason: `few_runs: ${productiveRuns} paired holdout observation(s) < min ${this.minProductiveRuns}`,
        rejectionCode: 'few_runs',
      }
    }
    if (overfitGap === null || baselineOverfitGap === null) {
      throw new Error('HeldOutGate: complete split scores did not produce overfit gaps')
    }

    // The paired holdout delta, on the statistic the outcome's shape admits.
    // `medianPairedDelta` stays the literal median on EVERY path so the number
    // that made the old gate blind remains visible in the evidence.
    const shape = this.chooseShape(beforeHoldout, afterHoldout)
    const literalMedian = medianDelta(beforeHoldout, afterHoldout)
    const wilcoxon = wilcoxonSignedRank(beforeHoldout, afterHoldout)

    let decidingDelta: number
    let low: number
    let high: number
    let mcnemarEvidence: GateEvidence['mcnemar'] = null
    let deltaLabel: string
    if (shape.statistic === 'paired_risk_difference') {
      // `binaryScale` is non-null exactly on this branch (see chooseShape).
      const scale = shape.binaryScale as number
      // Normalise the two-point encoding to {0,1} so the estimator sees the
      // pass/fail structure, then rescale the answer back into the caller's
      // native units — `pairedDeltaThreshold` is documented as being read in
      // the units of the holdout scores, so a 0-100 dimension must be gated in
      // points, not in a rate.
      const exact = pairedRiskDifferenceExact(
        beforeHoldout.map((v) => v / scale),
        afterHoldout.map((v) => v / scale),
        this.confidence,
      )
      decidingDelta = exact.riskDifference * scale
      low = exact.lower * scale
      high = exact.upper * scale
      mcnemarEvidence = {
        b: exact.b,
        c: exact.c,
        nDiscordant: exact.nDiscordant,
        pValue: exact.pValue,
      }
      deltaLabel = 'success-rate'
    } else {
      const bootstrapStatistic = shape.statistic === 'mean_bootstrap' ? 'mean' : 'median'
      const ci = pairedBootstrap(beforeHoldout, afterHoldout, {
        confidence: this.confidence,
        resamples: this.resamples,
        statistic: bootstrapStatistic,
        seed: this.seed,
      })
      decidingDelta = bootstrapStatistic === 'mean' ? ci.mean : ci.median
      low = ci.low
      high = ci.high
      deltaLabel = bootstrapStatistic
    }

    const evidence: GateEvidence = {
      ...commonEvidence,
      medianPairedDelta: literalMedian,
      deltaStatistic: shape.statistic,
      decidingDelta,
      pairedCI: { low, high },
      pairedPValue: wilcoxon.p,
      mcnemar: mcnemarEvidence,
      binaryScale: shape.binaryScale,
      tieFraction: shape.tieFraction,
    }

    // FAIL CLOSED. A degenerate interval decides nothing: [0, 0] cannot tell a
    // gain from a regression, and it clears every negative threshold, which is
    // exactly how a tie-pinned median laundered a −13.2pp regression into a
    // promotion. Absence of evidence is not evidence of improvement — refuse
    // and say which way the data was empty.
    if (!Number.isFinite(low) || !Number.isFinite(high) || (low === 0 && high === 0)) {
      const cause =
        mcnemarEvidence !== null && mcnemarEvidence.nDiscordant === 0
          ? 'every pair is concordant (0 discordant pairs)'
          : shape.tieFraction === 1
            ? 'every paired delta is an exact tie'
            : `the ${deltaLabel} CI collapsed to a point at 0`
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence,
        reason:
          `indeterminate_delta: ${cause}, so the paired holdout CI is ` +
          `[${fmt(low)}, ${fmt(high)}] and carries no direction — ` +
          `it cannot clear threshold ${fmt(this.pairedDeltaThreshold)} on evidence`,
        rejectionCode: 'indeterminate_delta',
      }
    }

    // The exact test is a VETO on the two-point path. Redundant by construction
    // — `pairedRiskDifferenceExact`'s interval is dual to this p-value, so
    // `low > 0` already implies `pValue < 1 − confidence` (verified over 8108
    // (b, c, ties, confidence) shapes) — and kept anyway so that swapping the
    // estimator for one without that duality (the Wald interval, which
    // undercovers on a handful of discordant pairs) cannot silently reintroduce
    // "promotes what the exact test refuses". Only applies at a non-negative
    // threshold: a negative threshold is a non-inferiority question, which
    // McNemar's test of "no difference" is not the right test for.
    const exactTestVetoes =
      mcnemarEvidence !== null &&
      this.pairedDeltaThreshold >= 0 &&
      !(mcnemarEvidence.pValue < 1 - this.confidence)

    // Negative-delta gate (CI lower bound must clear the threshold).
    if (!(low > this.pairedDeltaThreshold) || exactTestVetoes) {
      const detail = exactTestVetoes
        ? ` McNemar exact p=${mcnemarEvidence?.pValue.toExponential(2)} does not reject at α=${fmt(1 - this.confidence)}.`
        : ''
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence,
        reason:
          `negative_delta: paired holdout ${deltaLabel} Δ=${fmt(decidingDelta)} ` +
          `CI=[${fmt(low)}, ${fmt(high)}] does not clear threshold ${fmt(this.pairedDeltaThreshold)}.${detail}`,
        rejectionCode: 'negative_delta',
      }
    }

    // Overfit-gap gate. We allow some absolute slack —
    // candidate.gap ≤ baseline.gap + overfitGapThreshold.
    if (overfitGap > baselineOverfitGap + this.overfitGapThreshold) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence,
        reason:
          `overfit_gap: candidate gap=${fmt(overfitGap)} exceeds baseline gap=${fmt(baselineOverfitGap)} ` +
          `by more than ${fmt(this.overfitGapThreshold)}`,
        rejectionCode: 'overfit_gap',
      }
    }

    // Cost-ceiling gate. Runs after quality gates so a cost-driven
    // rejection always carries a "you cleared quality but blew budget"
    // story rather than masking a quality failure.
    if (this.costPerTaskCeiling !== undefined && medianCandidateCost === null) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence,
        reason: 'missing_cost: candidate cost evidence is incomplete',
        rejectionCode: 'missing_cost',
      }
    }
    if (
      this.costPerTaskCeiling !== undefined &&
      medianCandidateCost !== null &&
      medianCandidateCost > this.costPerTaskCeiling
    ) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence,
        reason:
          `cost_ceiling: candidate median cost $${fmt(medianCandidateCost)} ` +
          `exceeds ceiling $${fmt(this.costPerTaskCeiling)} (baseline $${fmt(medianBaselineCost)})`,
        rejectionCode: 'cost_ceiling',
      }
    }

    return {
      promote: true,
      candidateId,
      baselineId,
      evidence,
      reason:
        `promote: paired holdout ${deltaLabel} Δ=${fmt(decidingDelta)} ` +
        `CI=[${fmt(low)}, ${fmt(high)}] over ${productiveRuns} pairs; ` +
        `overfit gap candidate=${fmt(overfitGap)} vs baseline=${fmt(baselineOverfitGap)}; ` +
        `median cost candidate=$${fmt(medianCandidateCost)} vs baseline=$${fmt(medianBaselineCost)}`,
      rejectionCode: null,
    }
  }

  /**
   * Which paired statistic decides this data, and the shape facts behind it.
   *
   * Two-point on BOTH arms at a COMMON level ⇒ the exact paired risk
   * difference. A shared level is required: a pass/fail baseline against a
   * partial-credit candidate ({0,1} vs {0,0.4}) is not a paired binary
   * comparison and its threshold units would be silently reinterpreted.
   *
   * Everything else ⇒ the mean bootstrap
   * ({@link DECISION_PAIRED_DELTA_STATISTIC}), which is well defined on every
   * shape the median goes blind on — tie-dominated, low-cardinality lattices
   * like block scores in {⅔, 1}, and mixed arms.
   * `deltaStatistic: 'median'` forces the median on every input.
   */
  private chooseShape(before: number[], after: number[]): OutcomeShape {
    const tieFraction = before.length === 0 ? null : pairedDeltaTieFraction(before, after)
    if (this.deltaStatistic === 'median') {
      return { statistic: 'median_bootstrap', binaryScale: null, tieFraction }
    }
    const binaryScale = pairedBinaryScale(before, after)
    if (binaryScale !== null) {
      return { statistic: 'paired_risk_difference', binaryScale, tieFraction }
    }
    // One definition of the decision statistic, shared with the campaign gates.
    const statistic =
      DECISION_PAIRED_DELTA_STATISTIC === 'mean' ? 'mean_bootstrap' : 'median_bootstrap'
    return { statistic, binaryScale: null, tieFraction }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function inferCandidateId(candidate: RunRecord[], baselineKey: string): string {
  for (const run of candidate) {
    if (run.candidateId && run.candidateId !== baselineKey) return run.candidateId
  }
  // All candidate rows match the baseline key — caller mistake, but
  // surface the symptom rather than throwing inside the gate.
  return candidate[0]?.candidateId ?? '(unknown candidate)'
}

function assertScenarioIdentities(runs: RunRecord[]): void {
  for (const run of runs) {
    if (typeof run.scenarioId !== 'string' || run.scenarioId.trim() === '') {
      throw new Error(`HeldOutGate: run ${run.runId} is missing scenarioId`)
    }
  }
}

/**
 * Rows carrying a finite score on one split. RAW (`observedSplitScore`) by
 * choice: the gated runs are already removed by the caller, so applying the
 * gate again here would only zero runs that are no longer in the set, and the
 * reported means must describe the runs that actually decided the promotion.
 */
function scoredRuns(runs: RunRecord[], split: ScorePreference): RunRecord[] {
  return runs.filter((run) => {
    if (run.splitTag !== split) return false
    const v = observedSplitScore(run, split)
    return typeof v === 'number' && Number.isFinite(v)
  })
}

function meanOrNull(xs: number[]): number | null {
  if (xs.length === 0) return null
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function diffOrNull(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null
  return a - b
}

function medianDelta(before: number[], after: number[]): number {
  const ds = before.map((b, i) => after[i]! - b).sort((x, y) => x - y)
  if (ds.length === 0) throw new Error('HeldOutGate: median delta requires at least one pair')
  const mid = Math.floor(ds.length / 2)
  return ds.length % 2 === 0 ? (ds[mid - 1]! + ds[mid]!) / 2 : ds[mid]!
}

function medianFinite(xs: number[]): number | null {
  const ys = xs.filter((x) => Number.isFinite(x)).sort((x, y) => x - y)
  if (ys.length === 0) return null
  const mid = Math.floor(ys.length / 2)
  return ys.length % 2 === 0 ? (ys[mid - 1]! + ys[mid]!) / 2 : ys[mid]!
}

function completeCostMedian(runs: RunRecord[]): number | null {
  if (runs.length === 0) return null
  const costs: number[] = []
  for (const run of runs) {
    const provenance = run.costProvenance
    if (provenance.kind === 'uncaptured') return null
    costs.push(provenance.usd)
  }
  return medianFinite(costs)
}

function fmt(x: number | null): string {
  if (x === null) return 'n/a'
  return x.toFixed(4)
}
