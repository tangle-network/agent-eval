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
 *   - `src/paired-stats.ts` for `pairedBootstrap` + `pairedWilcoxon`
 *   - `src/run-record.ts` for the input row schema
 *   - `src/reference-replay.ts` for the older, reference-replay-
 *     specific promotion path (still useful for replay-style evals).
 */

import type { RunRecord } from './run-record'
import { pairedBootstrap, pairedWilcoxon } from './paired-stats'

export type HeldOutGateRejectionCode =
  | 'few_runs'
  | 'negative_delta'
  | 'overfit_gap'

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
}

export interface GateEvidence {
  /** Number of paired (candidate, baseline) holdout observations used. */
  productiveRuns: number
  /** Median of (candidate − baseline) paired holdout deltas. */
  medianPairedDelta: number
  /** Bootstrap CI on the median paired holdout delta. */
  pairedCI: { low: number; high: number }
  /** Wilcoxon signed-rank p-value on the paired holdout deltas. */
  pairedPValue: number
  /** Mean candidate score on the search split (NaN if none). */
  searchScore: number
  /** Mean candidate score on the holdout split (NaN if none). */
  holdoutScore: number
  /** Candidate (search − holdout) gap. */
  overfitGap: number
  /** Baseline (search − holdout) gap. */
  baselineOverfitGap: number
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
  }

  /** Decide whether `candidate` should replace `baseline`. Pairing
   *  is by (experimentId, seed) — identical experiment + seed pairs
   *  the candidate run with the matching baseline run. Pairs without
   *  a holdout score on both sides are dropped. */
  evaluate(candidate: RunRecord[], baseline: RunRecord[]): GateDecision {
    const candidateId = inferCandidateId(candidate, this.baselineKey)
    const baselineId = this.baselineKey

    // Pair holdout runs by (experimentId, seed).
    const baselineHoldoutByKey = indexHoldoutByKey(baseline)
    const beforeHoldout: number[] = []
    const afterHoldout: number[] = []
    for (const run of candidate) {
      if (run.splitTag !== 'holdout') continue
      if (run.outcome.holdoutScore === undefined) continue
      const key = pairKey(run)
      const counterpart = baselineHoldoutByKey.get(key)
      if (counterpart === undefined) continue
      beforeHoldout.push(counterpart)
      afterHoldout.push(run.outcome.holdoutScore)
    }

    const productiveRuns = beforeHoldout.length

    // Always compute the gap numbers — useful even when we reject on
    // few_runs (you want to see why).
    const candidateSearchMean = mean(scores(candidate, 'searchScore', 'search'))
    const candidateHoldoutMean = mean(scores(candidate, 'holdoutScore', 'holdout'))
    const baselineSearchMean = mean(scores(baseline, 'searchScore', 'search'))
    const baselineHoldoutMean = mean(scores(baseline, 'holdoutScore', 'holdout'))

    const overfitGap = safeDiff(candidateSearchMean, candidateHoldoutMean)
    const baselineOverfitGap = safeDiff(baselineSearchMean, baselineHoldoutMean)

    // Few-runs gate.
    if (productiveRuns < this.minProductiveRuns) {
      return {
        promote: false,
        candidateId,
        baselineId,
        evidence: {
          productiveRuns,
          medianPairedDelta: productiveRuns > 0 ? medianDelta(beforeHoldout, afterHoldout) : 0,
          pairedCI: { low: 0, high: 0 },
          pairedPValue: 1,
          searchScore: candidateSearchMean,
          holdoutScore: candidateHoldoutMean,
          overfitGap,
          baselineOverfitGap,
        },
        reason: `few_runs: ${productiveRuns} paired holdout observation(s) < min ${this.minProductiveRuns}`,
        rejectionCode: 'few_runs',
      }
    }

    // Paired bootstrap on holdout deltas.
    const ci = pairedBootstrap(beforeHoldout, afterHoldout, {
      confidence: this.confidence,
      resamples: this.resamples,
      statistic: 'median',
      seed: this.seed,
    })
    const wilcoxon = pairedWilcoxon(beforeHoldout, afterHoldout)

    const evidence: GateEvidence = {
      productiveRuns,
      medianPairedDelta: ci.median,
      pairedCI: { low: ci.low, high: ci.high },
      pairedPValue: wilcoxon.p,
      searchScore: candidateSearchMean,
      holdoutScore: candidateHoldoutMean,
      overfitGap,
      baselineOverfitGap,
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
    if (
      Number.isFinite(overfitGap) &&
      Number.isFinite(baselineOverfitGap) &&
      overfitGap > baselineOverfitGap + this.overfitGapThreshold
    ) {
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

    return {
      promote: true,
      candidateId,
      baselineId,
      evidence,
      reason:
        `promote: paired holdout median Δ=${fmt(ci.median)} ` +
        `CI=[${fmt(ci.low)}, ${fmt(ci.high)}] over ${productiveRuns} pairs; ` +
        `overfit gap candidate=${fmt(overfitGap)} vs baseline=${fmt(baselineOverfitGap)}`,
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

function indexHoldoutByKey(runs: RunRecord[]): Map<string, number> {
  const out = new Map<string, number>()
  for (const r of runs) {
    if (r.splitTag !== 'holdout') continue
    if (r.outcome.holdoutScore === undefined) continue
    out.set(pairKey(r), r.outcome.holdoutScore)
  }
  return out
}

function pairKey(r: RunRecord): string {
  return `${r.experimentId}::${r.seed}`
}

function scores(
  runs: RunRecord[],
  field: 'searchScore' | 'holdoutScore',
  splitFilter: 'search' | 'holdout',
): number[] {
  const out: number[] = []
  for (const r of runs) {
    if (r.splitTag !== splitFilter) continue
    const v = r.outcome[field]
    if (typeof v === 'number' && Number.isFinite(v)) out.push(v)
  }
  return out
}

function mean(xs: number[]): number {
  if (xs.length === 0) return Number.NaN
  return xs.reduce((s, x) => s + x, 0) / xs.length
}

function safeDiff(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b)) return Number.NaN
  return a - b
}

function medianDelta(before: number[], after: number[]): number {
  const ds = before.map((b, i) => after[i]! - b).sort((x, y) => x - y)
  if (ds.length === 0) return 0
  const mid = Math.floor(ds.length / 2)
  return ds.length % 2 === 0 ? (ds[mid - 1]! + ds[mid]!) / 2 : ds[mid]!
}

function fmt(x: number): string {
  if (!Number.isFinite(x)) return String(x)
  return x.toFixed(4)
}
