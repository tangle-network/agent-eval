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
 * ## The paired-delta rule, and why it has no shape branch
 *
 * ONE rule runs on every outcome, and it reads only the paired DELTAS
 * (candidate − baseline, per item). Nothing inspects the score VALUES, so
 * adding the same constant to both arms cannot change a verdict — the property
 * every earlier version of this gate lacked, each time in a way that looked
 * like a different bug:
 *
 *   - v1 decided on the MEDIAN paired delta. Ties pin the median at exactly 0
 *     and its bootstrap CI collapses to [0,0], so `low > threshold` answered
 *     "no" forever at a non-negative threshold and "yes" forever at a negative
 *     one. Measured: 76 items, 15 wins / 5 losses / 56 ties — a real +13.2pp
 *     lift — refused at every non-negative threshold, while the mirror-image
 *     −13.2pp regression PROMOTED at every negative one.
 *   - v2 detected "binary" by the literal values {0,1}. One partial-credit
 *     score, or a 0-100 encoding, fell back to the blind median.
 *   - v3 detected it as {0, s} for any positive level s. That still needs a
 *     ZERO to be present, so {⅔, 1} — the block score `bench/rung2` actually
 *     produces — skipped the significance veto entirely. Measured: 4 of 26
 *     pairs improving by ⅓, threshold 0, all defaults — REFUSED at offset 0
 *     and PROMOTED at offsets ⅓, ⅔, 1 and 10, with byte-identical paired
 *     deltas in all five.
 *
 * Each fix extended the list of recognised shapes and the next shape walked
 * past it. So there is no list. The rule is:
 *
 * 1. **The statistic is the MEAN paired delta**, in the caller's own units.
 *    `pairedDeltaThreshold` is read in those units, so a 0-100 judge dimension
 *    is gated in points and a [0,1] score in score. The mean is what "by how
 *    much did the candidate move the score" means, and it is the one estimator
 *    that stays defined on every shape the median loses: tie-dominated vectors,
 *    coarse lattices, mixed arms.
 * 2. **The interval is the most conservative of every method that APPLIES.**
 *    Empirical likelihood (`empiricalLikelihoodMeanInterval`) applies unless
 *    every delta is identical; the percentile bootstrap always applies. The
 *    decision takes the lowest lower bound and the highest upper bound of
 *    those. Composition by "most conservative applicable method" is the point:
 *    a shape nobody anticipated still gets a method, and adding a method can
 *    only ever make the gate stricter.
 * 3. **A significance VETO that no shape escapes.** At a non-negative threshold
 *    the exact sign-flip permutation test (`signFlipMeanTest`) must reject at
 *    α = 1 − confidence. It is total (defined for any deltas), shift-invariant,
 *    and on pass/fail-shaped data it EQUALS McNemar's exact test to the last
 *    bit — the binary test is a derived case, not a branch. Without it the
 *    interval alone promotes 5 wins / 0 losses (McNemar p = 0.0625) and 4
 *    improved of 26 (p = 0.125). A negative threshold is a non-inferiority
 *    question, which a test of "no difference" is not the right test for, so
 *    the veto does not apply there — the interval decides alone.
 * 4. **Fail closed on a directionless interval.** Zero width at ANY location —
 *    not only [0,0] — or a non-finite bound is an absence of evidence, not a
 *    promotion, and returns `indeterminate_delta`. [0,0] clears every negative
 *    threshold by arithmetic; [⅓,⅓] from three identical observations claims
 *    certainty nobody earned.
 *
 * WHY NOT THE EXACT CONDITIONAL RISK-DIFFERENCE INTERVAL, which v3 decided on:
 * it is a valid test of "no difference" but is NOT a confidence interval at a
 * nonzero margin, because conditioning on the discordant count discards the
 * variability of that count. Measured at the exact boundary (n = 76, true risk
 * difference −0.05, threshold −0.05, nominal 95%): it promotes 44.8% of
 * samples, and still 44.8% at n = 200. Empirical likelihood is 0.0% and 2.2%.
 * `bench/rung2` ships `pairedDeltaThreshold: -0.05`, so that was live.
 *
 * Set `deltaStatistic: 'median'` to force the median bootstrap as the interval —
 * the pre-0.134 behaviour, for callers who want outlier robustness and accept
 * the blindness. The veto and the fail-closed rule still apply; the escape
 * hatch can only make the gate stricter, never blinder.
 *
 * The decision carries a machine-readable `rejectionCode` plus an
 * `evidence` block with every number the gate looked at, so the
 * downstream researcher / paper / dashboard can re-derive the
 * verdict without re-running.
 *
 * See also:
 *   - `src/statistics.ts` for `empiricalLikelihoodMeanInterval`,
 *     `signFlipMeanTest`, `pairedDeltaMagnitude`, `pairedBootstrap`
 *   - `src/run-record.ts` for the input row schema
 *   - `src/reference-replay.ts` for the older, reference-replay-
 *     specific promotion path (still useful for replay-style evals).
 */

import { pairRunRecords } from './paired-arms'
import { isRealnessGated, observedSplitScore, type ScorePreference } from './rollout/reward'
import type { RunRecord } from './run-record'
import {
  empiricalLikelihoodMeanInterval,
  mcnemar,
  PAIRED_DELTA_TIE_EPSILON,
  pairedBootstrap,
  pairedDeltaMagnitude,
  pairedDeltaTieFraction,
  signFlipMeanTest,
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
   * `'mean'` (default) is the mean paired delta, on the most conservative of
   * every interval method that applies (see the module header). `'median'`
   * forces the median bootstrap on every input, including the shapes where it
   * is structurally blind and refuses a real lift. It is kept for outlier
   * robustness on genuinely continuous outcomes and to reproduce a pre-0.134
   * verdict; the sign-flip veto and the fail-closed rule still apply, so it can
   * only make the gate stricter than the default, never blinder.
   */
  deltaStatistic?: 'mean' | 'median'
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

/** Which paired statistic a `HeldOutGate` verdict was decided on. Not a shape
 *  the gate detected — only what the caller asked for. */
export type DeltaStatistic = 'mean' | 'median'

/** One interval method's contribution to the promotion CI. */
export interface DeltaIntervalMethod {
  /** `'empirical_likelihood'` = nonparametric score interval for the mean;
   *  `'percentile_bootstrap'` = resampled mean; `'median_bootstrap'` = the
   *  opt-in `deltaStatistic: 'median'` path. */
  method: 'empirical_likelihood' | 'percentile_bootstrap' | 'median_bootstrap'
  low: number
  high: number
}

/** The exact sign-flip permutation test that vetoes every promotion at a
 *  non-negative threshold. */
export interface SignFlipEvidence {
  /** Two-sided p-value for "the candidate changed nothing". */
  pValue: number
  /** The number the veto actually reads: `pValue` when the test is exact, and
   *  its 99.9% upper confidence bound when it is Monte-Carlo, so no verdict
   *  turns on which way a finite set of draws happened to fall. */
  pValueUpperBound: number
  /** Whether the whole sign-flip distribution was enumerated, or a valid
   *  Monte-Carlo p-value was drawn. Never an asymptotic approximation. */
  method: 'exact' | 'monte_carlo'
  /** Sign draws used, or null when exact. */
  resamples: number | null
  /** Pairs where the candidate scored higher / lower / the same. */
  improved: number
  worsened: number
  tied: number
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
  /** Which paired statistic the verdict keyed on: `'mean'` by default,
   *  `'median'` only when the caller asked for it. This reflects CONFIG, never
   *  a shape the gate sniffed out of the data — nothing here branches on the
   *  outcome's values. */
  deltaStatistic: DeltaStatistic
  /** Point estimate of `deltaStatistic` — the number the `pairedDeltaThreshold`
   *  check is about, in the holdout scores' own units. Null when no CI was
   *  computed. */
  decidingDelta: number | null
  /** The promotion CI: the envelope of every method in `intervalMethods`, i.e.
   *  the lowest lower bound and the highest upper bound any applicable method
   *  produced. The gate promotes only if `pairedCI.low > pairedDeltaThreshold`,
   *  so composing this way can only ever make it stricter. */
  pairedCI: { low: number; high: number } | null
  /** Every interval method that applied, and what each one said — so the method
   *  that BOUND the decision is visible rather than inferred. Empty when no CI
   *  was computed. */
  intervalMethods: DeltaIntervalMethod[]
  /** Wilcoxon signed-rank p-value, if computed. Always the Wilcoxon, so this
   *  field never changes meaning. Reported, never decided on. */
  pairedPValue: number | null
  /** The exact sign-flip permutation test on the paired deltas — the veto. Null
   *  only when no CI was computed. At a non-negative `pairedDeltaThreshold` a
   *  promotion REQUIRES `signFlip.pValue < 1 − confidence`; at a negative one
   *  (a non-inferiority question) it is reported but does not gate. */
  signFlip: SignFlipEvidence | null
  /** McNemar's exact test on the improved/worsened indicator. `b` =
   *  candidate-only wins, `c` = baseline-only wins. On pass/fail-shaped data
   *  (`deltaMagnitude !== null`) this is the SAME test as `signFlip` and the two
   *  p-values agree to the last bit — the gate asserts that and refuses if they
   *  ever disagree. On other shapes it is the unweighted sign test, reported as
   *  a diagnostic while `signFlip` (which weights by magnitude) decides. Null
   *  when no CI was computed. */
  mcnemar: { b: number; c: number; nDiscordant: number; pValue: number } | null
  /** The single magnitude every non-tied paired delta shares, or null when they
   *  carry more than one (or none). Non-null means the outcome is pass/fail in
   *  shape — {0,1}, {0,100}, {⅔,1} and {10, 10⅓} all report their step, because
   *  it is measured on the DELTAS and no additive shift can change it. Purely
   *  descriptive: nothing routes on it. */
  deltaMagnitude: number | null
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
  private readonly deltaStatistic: DeltaStatistic

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
    this.deltaStatistic = config.deltaStatistic ?? 'mean'
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
     *  shape diagnostics are still reported so a caller can see what their data
     *  looks like without a verdict being produced from it. */
    const noCiEvidence: GateEvidence = {
      ...commonEvidence,
      medianPairedDelta: productiveRuns > 0 ? medianDelta(beforeHoldout, afterHoldout) : null,
      deltaStatistic: this.deltaStatistic,
      decidingDelta: null,
      pairedCI: null,
      intervalMethods: [],
      pairedPValue: null,
      signFlip: null,
      mcnemar: null,
      deltaMagnitude: productiveRuns > 0 ? pairedDeltaMagnitude(beforeHoldout, afterHoldout) : null,
      tieFraction: productiveRuns > 0 ? pairedDeltaTieFraction(beforeHoldout, afterHoldout) : null,
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

    // Everything below reads the paired DELTAS and nothing else, which is what
    // makes the verdict invariant to adding the same constant to both arms.
    const deltas = beforeHoldout.map((b, i) => afterHoldout[i]! - b)
    const literalMedian = medianDelta(beforeHoldout, afterHoldout)
    const wilcoxon = wilcoxonSignedRank(beforeHoldout, afterHoldout)
    const deltaMagnitude = pairedDeltaMagnitude(beforeHoldout, afterHoldout)
    const tieFraction = pairedDeltaTieFraction(beforeHoldout, afterHoldout)
    const signFlip = signFlipMeanTest(deltas)
    // The same discordant counts McNemar reads, taken off the delta SIGNS so it
    // is defined for every outcome rather than only for a recognised encoding.
    const mc = mcnemar(
      deltas.map((d) => (d < 0 ? 1 : 0)),
      deltas.map((d) => (d > 0 ? 1 : 0)),
    )
    const mcnemarEvidence = {
      b: mc.b,
      c: mc.c,
      nDiscordant: mc.nDiscordant,
      pValue: mc.pValue,
    }

    // Every interval method that APPLIES to this data, then the envelope of
    // them. There is no shape test here: `empiricalLikelihoodMeanInterval`
    // declines only when the deltas are all identical (no interval exists), and
    // the bootstrap always applies. Composing by "most conservative applicable"
    // means an unanticipated shape still gets judged, and adding a method can
    // only tighten the gate.
    const bootstrap = pairedBootstrap(beforeHoldout, afterHoldout, {
      confidence: this.confidence,
      resamples: this.resamples,
      statistic: this.deltaStatistic,
      seed: this.seed,
    })
    const decidingDelta = this.deltaStatistic === 'mean' ? bootstrap.mean : bootstrap.median
    const intervalMethods: DeltaIntervalMethod[] = []
    if (this.deltaStatistic === 'median') {
      // Opt-in legacy path: the caller asked for the median, and an
      // empirical-likelihood interval for the MEAN would not be an interval for
      // it. The veto and the fail-closed rule below still apply.
      intervalMethods.push({
        method: 'median_bootstrap',
        low: bootstrap.low,
        high: bootstrap.high,
      })
    } else {
      intervalMethods.push({
        method: 'percentile_bootstrap',
        low: bootstrap.low,
        high: bootstrap.high,
      })
      const el = empiricalLikelihoodMeanInterval(deltas, this.confidence)
      if (el.low !== null && el.high !== null) {
        intervalMethods.push({ method: 'empirical_likelihood', low: el.low, high: el.high })
      }
    }
    const low = Math.min(...intervalMethods.map((m) => m.low))
    const high = Math.max(...intervalMethods.map((m) => m.high))

    const evidence: GateEvidence = {
      ...commonEvidence,
      medianPairedDelta: literalMedian,
      deltaStatistic: this.deltaStatistic,
      decidingDelta,
      pairedCI: { low, high },
      intervalMethods,
      pairedPValue: wilcoxon.p,
      signFlip,
      mcnemar: mcnemarEvidence,
      deltaMagnitude,
      tieFraction,
    }

    // SELF-CHECK. On pass/fail-shaped deltas the sign-flip distribution IS the
    // binomial sign distribution, so the two p-values are the same number by
    // construction. If they ever differ, one of the two is wrong and the gate
    // does not know which — that is not a promotion, it is a defect, and the
    // honest answer is to refuse rather than pick the one that promotes.
    if (deltaMagnitude !== null && Math.abs(signFlip.pValue - mc.pValue) > 1e-9) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence,
        reason:
          `indeterminate_delta: internal disagreement — sign-flip p=${signFlip.pValue} ` +
          `and McNemar exact p=${mc.pValue} must be identical on a single-magnitude ` +
          `delta vector (magnitude ${fmt(deltaMagnitude)}); refusing rather than guessing`,
        rejectionCode: 'indeterminate_delta',
      }
    }

    // FAIL CLOSED. An interval of zero width decides nothing, wherever it sits.
    // [0,0] cannot tell a gain from a regression and clears every negative
    // threshold, which is exactly how a tie-pinned median laundered a −13.2pp
    // regression into a promotion; [⅓,⅓] from three identical observations
    // claims a certainty nobody earned. Absence of evidence is not evidence of
    // improvement — refuse, and say which way the data was empty.
    //
    // The FIRST test is on the deltas, not on the interval: a vector whose whole
    // spread is under the tie epsilon has no variation for any method to work
    // with, and testing that on the data rather than on a computed width is what
    // keeps the answer stable when an additive shift perturbs the floats.
    const deltaSpread = Math.max(...deltas) - Math.min(...deltas)
    if (
      !(deltaSpread > PAIRED_DELTA_TIE_EPSILON) ||
      !Number.isFinite(low) ||
      !Number.isFinite(high) ||
      !(high > low)
    ) {
      const cause =
        mcnemarEvidence.nDiscordant === 0 && tieFraction === 1
          ? 'every paired delta is an exact tie'
          : mcnemarEvidence.nDiscordant === 0
            ? 'every pair is concordant (0 discordant pairs)'
            : !(deltaSpread > PAIRED_DELTA_TIE_EPSILON)
              ? `every pair moved by the same ${fmt(decidingDelta)}, so the paired deltas have no spread for any interval to measure`
              : `every method's interval collapsed to the single point ${fmt(low)}`
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

    // THE VETO, and it has no shape condition — every outcome reaches it. The
    // sign-flip permutation test is exact on pass/fail-shaped data (where it is
    // McNemar's exact test) and valid on everything else, so no encoding, no
    // lattice and no partial-credit contamination can route a promotion around
    // it. Without it the interval alone promotes 5 wins / 0 losses (p = 0.0625)
    // and 4-improved-of-26 (p = 0.125). It applies only at a NON-NEGATIVE
    // threshold: a negative one asks a non-inferiority question, and a test of
    // "no difference" is not the right test for that — there the interval,
    // whose calibration at a nonzero margin is what `empiricalLikelihoodMean-
    // Interval` was chosen for, decides alone.
    const alpha = 1 - this.confidence
    const signFlipVetoes = this.pairedDeltaThreshold >= 0 && !(signFlip.pValueUpperBound < alpha)

    // Negative-delta gate (CI lower bound must clear the threshold).
    if (!(low > this.pairedDeltaThreshold) || signFlipVetoes) {
      const detail = signFlipVetoes
        ? ` Sign-flip ${signFlip.method} p=${signFlip.pValue.toExponential(2)}` +
          (signFlip.method === 'monte_carlo'
            ? ` (99.9% upper bound ${signFlip.pValueUpperBound.toExponential(2)})`
            : '') +
          ` does not reject at α=${fmt(alpha)}.`
        : ''
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence,
        reason:
          `negative_delta: paired holdout ${this.deltaStatistic} Δ=${fmt(decidingDelta)} ` +
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
        `promote: paired holdout ${this.deltaStatistic} Δ=${fmt(decidingDelta)} ` +
        `CI=[${fmt(low)}, ${fmt(high)}] over ${productiveRuns} pairs ` +
        `(sign-flip ${signFlip.method} p=${signFlip.pValue.toExponential(2)}); ` +
        `overfit gap candidate=${fmt(overfitGap)} vs baseline=${fmt(baselineOverfitGap)}; ` +
        `median cost candidate=$${fmt(medianCandidateCost)} vs baseline=$${fmt(medianBaselineCost)}`,
      rejectionCode: null,
    }
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
