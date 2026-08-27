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
 *   2. **Paired delta**: the lower bound of the bootstrap CI on the
 *      median per-item delta (candidate − baseline) on the HOLDOUT
 *      split is strictly greater than `pairedDeltaThreshold`.
 *   3. **Overfit gap**: the candidate's gap between search-split
 *      score and holdout-split score is no worse (more positive)
 *      than the baseline's gap by more than `overfitGapThreshold`.
 *      "Better on search, worse on holdout" is the canonical
 *      overfit pattern; this catches it.
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

import { pairRunRecords } from '../src/paired-arms'
import { isRealnessGated, observedSplitScore, type ScorePreference } from '../src/rollout/reward'
import type { RunRecord } from '../src/run-record'
import { pairedBootstrap, wilcoxonSignedRank } from '../src/statistics'

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

    // Paired bootstrap on holdout deltas.
    const ci = pairedBootstrap(beforeHoldout, afterHoldout, {
      confidence: this.confidence,
      resamples: this.resamples,
      statistic: 'median',
      seed: this.seed,
    })
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

    // Negative-delta gate (CI lower bound must clear the threshold).
    if (!(ci.low > this.pairedDeltaThreshold)) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence,
        reason:
          `negative_delta: paired holdout median Δ=${fmt(ci.median)} ` +
          `CI=[${fmt(ci.low)}, ${fmt(ci.high)}] does not clear threshold ${fmt(this.pairedDeltaThreshold)}`,
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
