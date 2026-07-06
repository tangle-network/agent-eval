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

import { type PairedBootstrapResult, pairedBootstrap } from '../../statistics'
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
      const v = select(s)
      if (typeof v === 'number' && Number.isFinite(v)) vals.push(v)
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
    // Only pair when BOTH sides produced the scalar (a dimension absent on one
    // side would otherwise create an unpaired observation).
    if (b === undefined || a === undefined) continue
    before.push(b)
    after.push(a)
    cellIds.push(cellId)
  }
  return { before, after, cellIds }
}

export interface HeldoutSignificance {
  paired: PairedHoldout
  /** The bootstrap the ship decision keys on — of the MEAN paired delta by
   *  default (see the tie note on `heldoutSignificance`). */
  bootstrap: PairedBootstrapResult
  /** The MEDIAN paired-delta bootstrap, reported as a diagnostic. When many
   *  scenarios are tied (both sides solve them), the median is pinned near 0
   *  regardless of the mean lift — comparing the two exposes tie-domination. */
  medianBootstrap: PairedBootstrapResult
  /** Fraction of paired observations that are exact ties (|delta| < 1e-9). A
   *  high tie fraction is WHY a median-based gate would have missed a real lift;
   *  it is the observability the tie fix adds. */
  tieFraction: number
  /** n paired observations. */
  n: number
  /** True iff n >= minProductiveRuns AND the CI lower bound clears the threshold. */
  significant: boolean
  /** Set when n < minProductiveRuns — too little evidence to claim significance. */
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

/** Significance of the held-out composite lift: ship only when the paired
 *  bootstrap CI lower bound on (candidate − baseline) exceeds `deltaThreshold`
 *  (default 0 ⇒ "confidently positive"). Below `minProductiveRuns` paired
 *  observations there is not enough evidence to claim significance → not
 *  significant (`fewRuns`). Interpret `deltaThreshold` in the judge's native
 *  composite scale. */
export function heldoutSignificance(
  paired: PairedHoldout,
  opts: HeldoutSignificanceOptions = {},
): HeldoutSignificance {
  const deltaThreshold = opts.deltaThreshold ?? 0
  const minProductiveRuns = opts.minProductiveRuns ?? 3
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
  const bootstrap = pairedBootstrap(paired.before, paired.after, {
    confidence,
    resamples,
    statistic,
    seed,
  })
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
  const fewRuns = n < minProductiveRuns
  const significant = !fewRuns && bootstrap.low > deltaThreshold
  return { paired, bootstrap, medianBootstrap, tieFraction, n, significant, fewRuns }
}

export interface DimensionRegression {
  dimension: string
  bootstrap: PairedBootstrapResult
  /** True iff the CI lower bound on (candidate − baseline) is below −tolerance:
   *  the candidate may have regressed this dimension by more than tolerance. */
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
 *  is omitted it auto-scales: 0.05 on [0,1], 5 on 0-100. */
export function dimensionRegressions(
  candidate: Map<string, Record<string, JudgeScore>>,
  baseline: Map<string, Record<string, JudgeScore>>,
  scenarioIds: Set<string>,
  criticalDimensions: string[],
  opts: { tolerance?: number; confidence?: number; resamples?: number; seed?: number } = {},
): DimensionRegression[] {
  const out: DimensionRegression[] = []
  for (const dim of criticalDimensions) {
    const paired = pairHoldout(candidate, baseline, scenarioIds, (s) => s.dimensions[dim])
    if (paired.before.length === 0) continue // dimension not scored on this judge
    const tolerance = opts.tolerance ?? 0.05 * detectScale([...paired.before, ...paired.after])
    const bootstrap = pairedBootstrap(paired.before, paired.after, {
      confidence: opts.confidence ?? 0.95,
      resamples: opts.resamples ?? 2000,
      statistic: 'median',
      seed: opts.seed ?? 1337,
    })
    out.push({
      dimension: dim,
      bootstrap,
      regressed: bootstrap.low < -tolerance,
      tolerance,
      n: paired.before.length,
    })
  }
  return out
}
