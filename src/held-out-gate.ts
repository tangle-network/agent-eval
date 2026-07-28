/**
 * HeldOutGate — first-class held-out paired-delta promotion gate.
 *
 * Encodes the "honesty override" pattern that lived inline in
 * `~/webb/redteam/scripts/agent-eval-autoresearch.ts:138–171`.
 * The optimizer's best-guess is one thing; what we should actually
 * ship is another. The gate is the line between them.
 *
 * A candidate is promoted iff ALL FOUR pass:
 *
 *   0. **Coverage**: on BOTH splits, the fraction of DEALT work items that
 *      carry a real score on BOTH arms is at least `minCoverage`
 *      (default 1 — all of them). See "Missing scores are missing data".
 *   1. **Productive runs**: the candidate has at least
 *      `minProductiveRuns` paired observations on items where BOTH
 *      candidate and baseline produced a real (non-silent) score.
 *   2. **Paired delta**: the lower bound of the bootstrap CI on the
 *      median per-item delta (candidate − baseline) on the HOLDOUT
 *      split is strictly greater than `pairedDeltaThreshold`.
 *   3. **Overfit gap**: the candidate's gap between search-split
 *      score and holdout-split score is no worse (more positive)
 *      than the baseline's gap by more than `overfitGapThreshold`.
 *      "Better on search, worse on holdout" is the canonical
 *      overfit pattern; this catches it.
 *
 * ## Missing scores are missing data
 *
 * Gates 1-3 all read numbers off the items where BOTH arms produced a finite
 * score. Without gate 0 that set is a SILENT FILTER: an item the candidate
 * crashed on, timed out on, or never wrote a row for simply left the
 * comparison, and the verdict was computed over whatever survived. Measured on
 * the pre-0.134 gate: 26 held-out items, a candidate that produced no score at
 * all on 20 of them, promoted at every threshold from −0.05 to +0.30 on the 6
 * it answered (`unpairedBaselineRuns: 20` sat in the evidence, read by
 * nothing); the control — the same 20 failures scored as the 0 they earned —
 * was correctly refused at a mean paired delta of −0.3808. An agent that fails
 * 77% of its tasks was promoted, and every guarantee gates 1-3 provide sat
 * behind that filter.
 *
 * The gate does NOT impute a value for those items. It cannot: it does not know
 * the failure value of the caller's metric (0 on [0,1]? 0 on 0-100? a
 * lower-is-better latency?), and guessing one is exactly the silent assumption
 * this gate exists to remove. A caller who DOES know it writes it onto the
 * record before calling — that is the caller's decision to make and to be
 * accountable for, and it then travels in the run corpus where an auditor can
 * see it. What the gate does instead is REFUSE, and report the full coverage
 * accounting (`GateEvidence.holdoutCoverage` / `searchCoverage`) so the caller
 * can see exactly which items went dark and on which arm.
 *
 * The denominator is MEASURED, never assumed: it is the set of work items the
 * comparison was DEALT, which is what `pairRunRecords` reports when it is given
 * every row of a split rather than only the scored ones. There is no list of
 * "expected" scenarios to keep in sync and nothing to trust — an item counts as
 * dealt because a row for it exists on at least one arm.
 *
 * The decision carries a machine-readable `rejectionCode` plus an
 * `evidence` block with every number the gate looked at, so the
 * downstream researcher / paper / dashboard can re-derive the
 * verdict without re-running.
 *
 * See also:
 *   - `src/statistics.ts` for `pairedBootstrap` + `wilcoxonSignedRank`
 *   - `src/run-record.ts` for the input row schema
 *   - `src/reference-replay.ts` for the older, reference-replay-
 *     specific promotion path (still useful for replay-style evals).
 */

import { pairRunRecords } from './paired-arms'
import { minimumPairsForPairedDeltaTest, pairedDeltaTest } from './paired-delta-test'
import { isRealnessGated, observedSplitScore, type ScorePreference } from './rollout/reward'
import type { RunRecord } from './run-record'
import { wilcoxonSignedRank } from './statistics'

export type HeldOutGateRejectionCode =
  | 'few_runs'
  | 'incomplete_coverage'
  | 'missing_split_scores'
  | 'missing_cost'
  | 'negative_delta'
  | 'indeterminate_delta'
  | 'overfit_gap'
  | 'cost_ceiling'

/**
 * How much of one split's DEALT work the comparison actually measured.
 *
 * `answered + unscoredPairs + candidateOnly + baselineOnly === dealt` — a
 * complete, mutually exclusive partition of the item slots the split was dealt,
 * so nothing can leave the comparison without appearing in exactly one bucket.
 */
export interface SplitCoverage {
  /** Work items the split was dealt: every item with a row on either arm. */
  dealt: number
  /** Dealt items carrying a finite score on BOTH arms — the only ones any
   *  paired statistic can read. */
  answered: number
  /** Dealt items with a row on both arms where at least one row carried no
   *  finite score: a run happened and produced nothing (crash, timeout, judge
   *  failure). Measured absence, not an absent item. */
  unscoredPairs: number
  /** Dealt items only the candidate produced a row for. */
  candidateOnly: number
  /** Dealt items only the baseline produced a row for. */
  baselineOnly: number
  /** `answered / dealt`, or 0 when nothing was dealt. 1 means every dealt item
   *  was scored on both arms. */
  coverage: number
}

export interface HeldOutGateConfig {
  /** Minimum number of paired (candidate, baseline) holdout observations
   *  required before promotion. The exact small-sample test may require more
   *  observations at the selected confidence. */
  minProductiveRuns?: number
  /** The bootstrap-CI lower bound on the median paired holdout delta
   *  must exceed this to promote. Default 0. */
  pairedDeltaThreshold?: number
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
   * Smallest acceptable `answered / dealt` fraction, required on BOTH splits.
   * Default 1: every work item the comparison was dealt must carry a real score
   * on both arms before the gate will decide anything.
   *
   * The default is 1 because a missing score is missing data, and a promotion
   * computed over "the items that happened to answer" is a promotion computed
   * over a set the candidate selected by failing (see the module header). One
   * split below `minCoverage` rejects with `incomplete_coverage`.
   *
   * Lowering it is a real, defensible choice for a caller who accepts a known
   * flake rate — but it must be DECLARED, not inherited: the shrunken
   * denominator then still ships in `GateEvidence.holdoutCoverage` /
   * `searchCoverage`, so the verdict can never be read without it. Must be in
   * [0, 1]; anything else throws rather than clamping.
   */
  minCoverage?: number
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

export interface GateEvidence {
  /** Number of paired (candidate, baseline) holdout observations used. */
  productiveRuns: number
  /** Candidate holdout rows with no baseline row at the same work identity. */
  unpairedCandidateRuns: number
  /** Baseline holdout rows with no candidate row at the same work identity. */
  unpairedBaselineRuns: number
  /**
   * How much of the dealt HOLDOUT work carried a score on both arms — the
   * denominator behind `productiveRuns`, `medianPairedDelta`, `pairedCI` and
   * `holdoutScore`. A `coverage` below 1 means those numbers describe a
   * SUBSET of the items the comparison was dealt, and which items are in that
   * subset was decided by whichever arm went dark.
   */
  holdoutCoverage: SplitCoverage
  /**
   * The same accounting for the SEARCH split — the denominator behind
   * `searchScore`, and therefore behind both overfit gaps.
   */
  searchCoverage: SplitCoverage
  /** Median of paired holdout deltas, or null when there are no pairs. */
  medianPairedDelta: number | null
  /** Bootstrap CI on the median paired holdout delta, if computed. */
  pairedCI: { low: number; high: number } | null
  /** Wilcoxon signed-rank p-value, if computed. */
  pairedPValue: number | null
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
  private readonly minCoverage: number

  constructor(config: HeldOutGateConfig) {
    if (!config.baselineKey) {
      throw new Error('HeldOutGate: baselineKey is required')
    }
    if (
      config.minCoverage !== undefined &&
      !(Number.isFinite(config.minCoverage) && config.minCoverage >= 0 && config.minCoverage <= 1)
    ) {
      throw new Error(
        `HeldOutGate: minCoverage must be a finite fraction in [0, 1], got ${config.minCoverage}`,
      )
    }
    this.minCoverage = config.minCoverage ?? 1
    this.confidence = config.confidence ?? 0.95
    this.minProductiveRuns = Math.max(
      config.minProductiveRuns ?? 3,
      minimumPairsForPairedDeltaTest(this.confidence),
    )
    this.pairedDeltaThreshold = config.pairedDeltaThreshold ?? 0
    this.overfitGapThreshold = config.overfitGapThreshold ?? 0.15
    this.baselineKey = config.baselineKey
    this.resamples = config.bootstrapResamples ?? 2000
    this.seed = config.seed
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
    // The DEALT denominators, measured over every row of each split — scored or
    // not — so an item that produced no number is still counted as work the
    // comparison was given. `splitCoverage` re-pairs the unfiltered rows with
    // the same primitive the decision pairs with, which is the only way the
    // "dealt" set can be derived rather than assumed.
    const searchCoverage = splitCoverage(honestBaseline, honestCandidate, 'search')
    const holdoutCoverage = splitCoverage(honestBaseline, honestCandidate, 'holdout')
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

    // Cost summary — surfaced in evidence regardless of gating policy so
    // downstream dashboards always know what the candidate cost.
    //
    // The population is the rows that DECIDED this verdict: the matched pairs
    // on both splits, and nothing else. Taking the median over every row the
    // caller happened to pass is a denominator nobody measured, and it is
    // trivially movable — 48 rows tagged `dev` at $0.0001, which the gate never
    // scores and the coverage check never counts, drag a real $5.00/task
    // candidate to a reported $0.0001 and clear a $1.00 ceiling. Deriving the
    // population from the pairing rather than from a list of split tags means
    // there is no tag to sit outside the rule: a row either decided the verdict
    // or it does not describe its cost.
    const medianCandidateCost = completeCostMedian([
      ...searchPairing.pairs.map((pair) => pair.treatment),
      ...holdoutPairing.pairs.map((pair) => pair.treatment),
    ])
    const medianBaselineCost = completeCostMedian([
      ...searchPairing.pairs.map((pair) => pair.baseline),
      ...holdoutPairing.pairs.map((pair) => pair.baseline),
    ])
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
      searchCoverage,
      holdoutCoverage,
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
        evidence: {
          ...commonEvidence,
          medianPairedDelta: productiveRuns > 0 ? medianDelta(beforeHoldout, afterHoldout) : null,
          pairedCI: null,
          pairedPValue: null,
        },
        reason: `missing_split_scores: ${missingSplitScores.join(', ')} score evidence is absent`,
        rejectionCode: 'missing_split_scores',
      }
    }

    // COVERAGE — before every statistic, because every statistic below reads
    // only the items that answered. A candidate that went dark on most of its
    // work does not get judged on the remainder; missing scores are missing
    // data, and the gate refuses rather than shrinking the denominator to the
    // subset that happened to answer. Checked ahead of `few_runs` because "6 of
    // 26 items produced no score" is the finding, and "6 paired observations"
    // is only its shadow.
    const shortfalls = (
      [
        ['holdout', holdoutCoverage],
        ['search', searchCoverage],
      ] as const
    ).filter(([, cov]) => cov.coverage < this.minCoverage)
    if (shortfalls.length > 0) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence: {
          ...commonEvidence,
          medianPairedDelta: productiveRuns > 0 ? medianDelta(beforeHoldout, afterHoldout) : null,
          pairedCI: null,
          pairedPValue: null,
        },
        reason:
          `incomplete_coverage: ${shortfalls.map(([split, cov]) => describeCoverage(split, cov)).join('; ')}` +
          ` — required ${fmt(this.minCoverage)} of every dealt item scored on both arms.` +
          ' A missing score is missing data, not an absent item: the gate will not decide on the subset that answered',
        rejectionCode: 'incomplete_coverage',
      }
    }

    if (productiveRuns < this.minProductiveRuns) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence: {
          ...commonEvidence,
          medianPairedDelta: productiveRuns > 0 ? medianDelta(beforeHoldout, afterHoldout) : null,
          pairedCI: null,
          pairedPValue: null,
        },
        reason: `few_runs: ${productiveRuns} paired holdout observation(s) < min ${this.minProductiveRuns}`,
        rejectionCode: 'few_runs',
      }
    }
    if (overfitGap === null || baselineOverfitGap === null) {
      throw new Error('HeldOutGate: complete split scores did not produce overfit gaps')
    }

    const deltaTest = pairedDeltaTest(beforeHoldout, afterHoldout, {
      confidence: this.confidence,
      resamples: this.resamples,
      statistic: 'median',
      seed: this.seed,
      threshold: this.pairedDeltaThreshold,
      minPairs: this.minProductiveRuns,
    })
    const ci = deltaTest.bootstrap
    const wilcoxon = wilcoxonSignedRank(beforeHoldout, afterHoldout)

    const evidence: GateEvidence = {
      ...commonEvidence,
      medianPairedDelta: ci.median,
      pairedCI: { low: ci.low, high: ci.high },
      pairedPValue: wilcoxon.p,
    }

    if (!Number.isFinite(ci.low) || !Number.isFinite(ci.high) || (ci.low === 0 && ci.high === 0)) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence,
        reason:
          `indeterminate_delta: paired holdout median CI=[${fmt(ci.low)}, ${fmt(ci.high)}] ` +
          'carries no direction',
        rejectionCode: 'indeterminate_delta',
      }
    }

    if (!deltaTest.significant) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence,
        reason:
          `negative_delta: paired holdout median Δ=${fmt(ci.median)} ` +
          `${deltaTest.method === 'bootstrap-ci' ? `CI=[${fmt(ci.low)}, ${fmt(ci.high)}]` : `exact one-sided p=${fmt(deltaTest.pValue ?? 1)}`} ` +
          `does not clear threshold ${fmt(this.pairedDeltaThreshold)}`,
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
        `promote: paired holdout median Δ=${fmt(ci.median)} ` +
        `CI=[${fmt(ci.low)}, ${fmt(ci.high)}] over ${productiveRuns} pairs; ` +
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

/** Every row tagged to one split, scored or not — the work the split was
 *  DEALT, as opposed to the work it managed to measure. */
function dealtRuns(runs: RunRecord[], split: ScorePreference): RunRecord[] {
  return runs.filter((run) => run.splitTag === split)
}

function hasFiniteScore(run: RunRecord, split: ScorePreference): boolean {
  const v = observedSplitScore(run, split)
  return typeof v === 'number' && Number.isFinite(v)
}

/**
 * Partition one split's dealt work into answered / unscored / one-armed.
 *
 * Pairs the UNFILTERED rows with the same `pairRunRecords` the decision uses,
 * so the denominator comes out of the same identity rules as the numerator and
 * cannot drift from it. Deliberately a SECOND pairing rather than a widening of
 * the decision's own: the decision keeps pairing exactly the rows it always
 * paired, so this check can only ever add a refusal, never move a verdict that
 * was already being made on a complete set.
 */
function splitCoverage(
  baseline: RunRecord[],
  candidate: RunRecord[],
  split: ScorePreference,
): SplitCoverage {
  const pairing = pairRunRecords(dealtRuns(baseline, split), dealtRuns(candidate, split))
  let answered = 0
  for (const pair of pairing.pairs) {
    if (hasFiniteScore(pair.baseline, split) && hasFiniteScore(pair.treatment, split)) answered += 1
  }
  const unscoredPairs = pairing.pairs.length - answered
  const candidateOnly = pairing.unpairedTreatment.length
  const baselineOnly = pairing.unpairedBaseline.length
  const dealt = pairing.pairs.length + candidateOnly + baselineOnly
  return {
    dealt,
    answered,
    unscoredPairs,
    candidateOnly,
    baselineOnly,
    coverage: dealt === 0 ? 0 : answered / dealt,
  }
}

function describeCoverage(split: string, cov: SplitCoverage): string {
  const dark = [
    cov.unscoredPairs > 0 ? `${cov.unscoredPairs} ran on both arms but produced no score` : null,
    cov.baselineOnly > 0 ? `${cov.baselineOnly} only the baseline produced a row for` : null,
    cov.candidateOnly > 0 ? `${cov.candidateOnly} only the candidate produced a row for` : null,
  ].filter((part): part is string => part !== null)
  return (
    `${split} scored ${cov.answered} of ${cov.dealt} dealt items (coverage ${fmt(cov.coverage)})` +
    (dark.length > 0 ? ` — ${dark.join(', ')}` : '')
  )
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
