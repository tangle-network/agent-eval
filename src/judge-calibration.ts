import { makeRng } from './rng'
/**
 * Judge calibration — measure judge quality against human gold + bias.
 *
 * Workflow:
 *   1. Build a golden set: {itemId, humanScore}[].
 *   2. Run candidate judges; each produces {itemId, score}.
 *   3. `calibrateJudge(golden, candidate)` reports κ + Pearson + MAE.
 *   4. `calibrateJudgeContinuous(golden, candidate)` adds quadratic-weighted
 *      κ over the un-rounded [0,1] scores plus ICC(2,1), Pearson, Spearman,
 *      and bootstrap CIs — use this for fine-grained judges where rounding
 *      to int discards information (e.g. 0.78 vs 0.81 both round to 1 and
 *      look "perfectly agreed" to integer κ).
 *   5. Run bias probes (positional, verbosity, self-preference) to
 *      detect systematic score inflation.
 *   6. For N≥2 judges on the same items, `continuousAgreement(scores)`
 *      reports ICC(2,1) + κ_w + Pearson + Spearman with bootstrap CIs.
 *
 * Returns actionable diagnostics, not a single number. Consumers then
 * decide whether to trust the judge, retrain it, or add a tie-breaker.
 */

export interface GoldenItem {
  itemId: string
  humanScore: number
  /** Optional group used for per-group bias audits (e.g. model-of-output family). */
  group?: string
}

export interface CandidateScore {
  itemId: string
  score: number
  /** Optional — enables positional-bias analysis (did order matter?). */
  positionOfAInput?: 'first' | 'second'
}

export interface CalibrationResult {
  n: number
  pearson: number
  /** Cohen's κ with quadratic weights over integer-rounded scores. */
  kappa: number
  /** Mean absolute error vs human. */
  mae: number
  /** Worst-5 miscalibrations (largest |judge - human|). */
  worstItems: Array<{ itemId: string; judge: number; human: number; delta: number }>
}

export function calibrateJudge(
  golden: GoldenItem[],
  candidate: CandidateScore[],
): CalibrationResult {
  const map = new Map<string, { h: number; j: number }>()
  for (const g of golden) map.set(g.itemId, { h: g.humanScore, j: NaN })
  for (const c of candidate) {
    const entry = map.get(c.itemId)
    if (entry) entry.j = c.score
  }
  const common = [...map.values()].filter((v) => Number.isFinite(v.j))
  const n = common.length
  if (n < 2) {
    return { n, pearson: NaN, kappa: NaN, mae: NaN, worstItems: [] }
  }
  const humans = common.map((c) => c.h)
  const judges = common.map((c) => c.j)
  const pearson = pearsonR(humans, judges)
  const kappa = weightedKappa(humans.map(Math.round), judges.map(Math.round))
  const absDiffs = common.map((c) => Math.abs(c.j - c.h))
  const mae = absDiffs.reduce((a, b) => a + b, 0) / n
  const worst = [...map.entries()]
    .filter(([, v]) => Number.isFinite(v.j))
    .map(([itemId, v]) => ({ itemId, judge: v.j, human: v.h, delta: Math.abs(v.j - v.h) }))
    .sort((a, b) => b.delta - a.delta)
    .slice(0, 5)
  return { n, pearson, kappa, mae, worstItems: worst }
}

export interface PositionalBiasResult {
  /**
   * Score delta (first-position - second-position) averaged across items
   * presented in both positions. Non-zero = positional bias.
   */
  avgDelta: number
  n: number
}

/**
 * Feed the same items to the judge twice with A/B swapped and pass all
 * results here. Items that don't appear in both positions are ignored.
 */
export function positionalBias(scores: CandidateScore[]): PositionalBiasResult {
  const pairs = new Map<string, { first?: number; second?: number }>()
  for (const s of scores) {
    const slot = pairs.get(s.itemId) ?? {}
    if (s.positionOfAInput === 'first') slot.first = s.score
    else if (s.positionOfAInput === 'second') slot.second = s.score
    pairs.set(s.itemId, slot)
  }
  const deltas: number[] = []
  for (const { first, second } of pairs.values()) {
    if (first !== undefined && second !== undefined) deltas.push(first - second)
  }
  if (deltas.length === 0) return { avgDelta: 0, n: 0 }
  return { avgDelta: deltas.reduce((a, b) => a + b, 0) / deltas.length, n: deltas.length }
}

export interface VerbosityBiasResult {
  /** Pearson correlation between output length and score. Strong positive = verbosity bias. */
  pearson: number
  n: number
}

export function verbosityBias(
  samples: Array<{ outputLen: number; score: number }>,
): VerbosityBiasResult {
  const n = samples.length
  if (n < 3) return { pearson: NaN, n }
  return {
    pearson: pearsonR(
      samples.map((s) => s.outputLen),
      samples.map((s) => s.score),
    ),
    n,
  }
}

export interface SelfPreferenceResult {
  /** Mean judge score when judge's family matches output's family. */
  inFamilyMean: number
  outOfFamilyMean: number
  deltaMean: number
  n: number
}

/**
 * Pass the same scenarios scored with judge-model X grading outputs from
 * model X (in-family) and model Y (out-of-family). Non-zero delta
 * indicates self-preference.
 */
export function selfPreference(
  samples: Array<{ score: number; inFamily: boolean }>,
): SelfPreferenceResult {
  const inF = samples.filter((s) => s.inFamily).map((s) => s.score)
  const outF = samples.filter((s) => !s.inFamily).map((s) => s.score)
  if (inF.length === 0 || outF.length === 0)
    return { inFamilyMean: 0, outOfFamilyMean: 0, deltaMean: 0, n: 0 }
  const inMean = inF.reduce((a, b) => a + b, 0) / inF.length
  const outMean = outF.reduce((a, b) => a + b, 0) / outF.length
  return {
    inFamilyMean: inMean,
    outOfFamilyMean: outMean,
    deltaMean: inMean - outMean,
    n: samples.length,
  }
}

// ── Helpers ──────────────────────────────────────────────────────────

function pearsonR(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return NaN
  const mA = a.reduce((s, v) => s + v, 0) / a.length
  const mB = b.reduce((s, v) => s + v, 0) / b.length
  let num = 0,
    dA = 0,
    dB = 0
  for (let i = 0; i < a.length; i++) {
    const da = a[i]! - mA
    const db = b[i]! - mB
    num += da * db
    dA += da * da
    dB += db * db
  }
  if (dA === 0 || dB === 0) return dA === 0 && dB === 0 ? 1 : 0
  return num / Math.sqrt(dA * dB)
}

/** Quadratic weighted Cohen's κ over bounded integer scores. */
function weightedKappa(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return NaN
  const min = Math.min(...a, ...b)
  const max = Math.max(...a, ...b)
  const K = max - min + 1
  if (K < 2) return 1
  const observed: number[][] = Array.from({ length: K }, () => new Array(K).fill(0))
  const rowMarg = new Array(K).fill(0)
  const colMarg = new Array(K).fill(0)
  for (let i = 0; i < a.length; i++) {
    const ai = a[i]! - min
    const bi = b[i]! - min
    const row = observed[ai]!
    row[bi] = (row[bi] ?? 0) + 1
    rowMarg[ai]++
    colMarg[bi]++
  }
  let num = 0
  let den = 0
  for (let i = 0; i < K; i++) {
    for (let j = 0; j < K; j++) {
      const w = (i - j) ** 2 / (K - 1) ** 2
      const expected = (rowMarg[i] * colMarg[j]) / a.length
      num += w * observed[i]![j]!
      den += w * expected
    }
  }
  if (den === 0) return 1
  return 1 - num / den
}

// ── Continuous-value inter-rater agreement ──────────────────────────
//
// `weightedKappa` above quantises to integers. For [0,1] judges that is
// lossy: 0.78 and 0.81 both round to 1 and look identical to integer κ.
// `continuousAgreement` keeps the original magnitudes:
//
//   - κ_w   : Cohen's weighted κ generalised to continuous scores. For two
//             raters, weighted κ = 1 − Σ w_ij·o_ij / Σ w_ij·e_ij collapses
//             into the closed form below when each "category" is the score
//             itself (Janson & Olsson 2001; Cohen 1968 quadratic weights).
//   - ICC   : Intraclass Correlation Coefficient, ICC(2,1) per Shrout &
//             Fleiss (1979) — two-way random effects, absolute agreement,
//             single rater. The right reliability coefficient when judges
//             are a random sample of the judge population.
//   - r, ρ  : Pearson + Spearman for sanity-check. Pearson catches linear
//             association regardless of scale; Spearman catches monotone
//             association regardless of distribution.
//   - CIs   : Bootstrap percentile CIs over items (rows). Bias is preserved
//             because we resample the full row, i.e. a judge's vector
//             stays internally consistent within each bootstrap replicate.
//
// References:
//   - Shrout, P. E. & Fleiss, J. L. (1979). Intraclass correlations: uses
//     in assessing rater reliability. Psychological Bulletin, 86(2), 420.
//   - McGraw, K. O. & Wong, S. P. (1996). Forming inferences about some
//     intraclass correlation coefficients. Psychological Methods, 1, 30.
//   - Janson, H. & Olsson, U. (2001). A measure of agreement for interval
//     or nominal multivariate observations. Educ. Psychol. Meas., 61, 277.

export interface ContinuousAgreement {
  /** Cohen's κ_w with quadratic weights, computed on raw [0,1] scores. */
  weightedKappa: number
  /** ICC(2,1): two-way random effects, absolute agreement, single rater. */
  icc: number
  /** Pearson product-moment correlation (averaged over rater pairs if N>2). */
  pearson: number
  /** Spearman rank correlation (averaged over rater pairs if N>2). */
  spearman: number
  /** 95% bootstrap percentile CIs over items. */
  ci: {
    icc: [number, number]
    weightedKappa: [number, number]
  }
  /** Number of complete items (no NaN across raters). */
  n: number
  /** Number of raters. */
  raters: number
}

export interface ContinuousAgreementOptions {
  /** Bootstrap iterations. Default 1000. Set to 0 to skip CIs (CI = [NaN, NaN]). */
  bootstrap?: number
  /** κ weighting scheme. Default 'quadratic'. */
  weights?: 'linear' | 'quadratic'
  /** PRNG seed for reproducible bootstrap. Default 0xC0FFEE. */
  seed?: number
  /** Confidence level for percentile CI. Default 0.95. */
  ciLevel?: number
}

/**
 * Inter-rater agreement on continuous (typically [0,1]) scores.
 *
 * `scores` has shape [n_items][n_raters]. Rows with any non-finite entry
 * are dropped. Returns NaN metrics if fewer than 2 raters or 2 complete
 * items remain.
 */
export function continuousAgreement(
  scores: number[][],
  opts: ContinuousAgreementOptions = {},
): ContinuousAgreement {
  const bootstrap = opts.bootstrap ?? 1000
  const weights = opts.weights ?? 'quadratic'
  const seed = opts.seed ?? 0xc0ffee
  const ciLevel = opts.ciLevel ?? 0.95

  const matrix = scores.filter((row) => row.length >= 2 && row.every((v) => Number.isFinite(v)))
  const raters = matrix[0]?.length ?? 0
  // All rows must have the same rater count, else drop the offenders.
  const clean = matrix.filter((row) => row.length === raters)
  const nClean = clean.length

  if (nClean < 2 || raters < 2) {
    return {
      weightedKappa: NaN,
      icc: NaN,
      pearson: NaN,
      spearman: NaN,
      ci: { icc: [NaN, NaN], weightedKappa: [NaN, NaN] },
      n: nClean,
      raters,
    }
  }

  const kappa = continuousWeightedKappa(clean, weights)
  const icc = icc21(clean)
  const pearson = avgPairwise(clean, pearsonR)
  const spearman = avgPairwise(clean, spearmanR)

  const ciIcc: [number, number] = [NaN, NaN]
  const ciKappa: [number, number] = [NaN, NaN]
  if (bootstrap > 0) {
    const rng = makeRng(seed)
    const iccs: number[] = []
    const kappas: number[] = []
    for (let b = 0; b < bootstrap; b++) {
      const sample: number[][] = new Array(nClean)
      for (let i = 0; i < nClean; i++) {
        sample[i] = clean[Math.floor(rng() * nClean)]!
      }
      const iccB = icc21(sample)
      const kB = continuousWeightedKappa(sample, weights)
      if (Number.isFinite(iccB)) iccs.push(iccB)
      if (Number.isFinite(kB)) kappas.push(kB)
    }
    const [lo, hi] = percentileBounds(ciLevel)
    if (iccs.length > 0) {
      iccs.sort((a, b) => a - b)
      ciIcc[0] = quantile(iccs, lo)
      ciIcc[1] = quantile(iccs, hi)
    }
    if (kappas.length > 0) {
      kappas.sort((a, b) => a - b)
      ciKappa[0] = quantile(kappas, lo)
      ciKappa[1] = quantile(kappas, hi)
    }
  }

  return {
    weightedKappa: kappa,
    icc,
    pearson,
    spearman,
    ci: { icc: ciIcc, weightedKappa: ciKappa },
    n: nClean,
    raters,
  }
}

export interface ContinuousCalibrationResult extends CalibrationResult {
  /** Cohen's κ_w computed on raw (un-rounded) scores. */
  weightedKappaContinuous: number
  /** ICC(2,1) treating golden + candidate as two raters. */
  icc: number
  spearman: number
  ci: {
    icc: [number, number]
    weightedKappa: [number, number]
  }
}

/**
 * Drop-in superset of `calibrateJudge` that adds continuous-value
 * agreement metrics. The old fields (n, pearson, kappa, mae, worstItems)
 * are preserved unchanged so existing callers continue to work.
 */
export function calibrateJudgeContinuous(
  golden: GoldenItem[],
  candidate: CandidateScore[],
  opts: ContinuousAgreementOptions = {},
): ContinuousCalibrationResult {
  const base = calibrateJudge(golden, candidate)
  const map = new Map<string, { h: number; j: number }>()
  for (const g of golden) map.set(g.itemId, { h: g.humanScore, j: NaN })
  for (const c of candidate) {
    const entry = map.get(c.itemId)
    if (entry) entry.j = c.score
  }
  const rows: number[][] = []
  for (const v of map.values()) {
    if (Number.isFinite(v.j)) rows.push([v.h, v.j])
  }
  const agreement = continuousAgreement(rows, opts)
  return {
    ...base,
    weightedKappaContinuous: agreement.weightedKappa,
    icc: agreement.icc,
    spearman: agreement.spearman,
    ci: agreement.ci,
  }
}

// ── Continuous-agreement internals ──────────────────────────────────

/**
 * Quadratic-weighted κ on continuous scores. With weights w(x,y) = (x-y)^2
 * (or |x-y| for linear) the formula collapses to:
 *
 *   κ_w = 1 − E_obs[w] / E_exp[w]
 *
 * where E_obs averages w over paired (a_i, b_i) and E_exp averages w over
 * the independent product distribution (sum_{i,j} w(a_i, b_j) / n^2).
 * The normalisation by (max-min)^2 in the integer version cancels in the
 * ratio, so we don't need it here. Generalises to N raters by averaging κ_w
 * over all rater pairs (mean pairwise weighted agreement).
 */
function continuousWeightedKappa(rows: number[][], scheme: 'linear' | 'quadratic'): number {
  if (rows.length === 0) return NaN
  const raters = rows[0]!.length
  if (raters < 2) return NaN
  const wFn =
    scheme === 'linear'
      ? (x: number, y: number) => Math.abs(x - y)
      : (x: number, y: number) => (x - y) ** 2
  let sum = 0
  let pairs = 0
  for (let r1 = 0; r1 < raters; r1++) {
    for (let r2 = r1 + 1; r2 < raters; r2++) {
      const a = rows.map((row) => row[r1]!)
      const b = rows.map((row) => row[r2]!)
      const n = a.length
      let obs = 0
      for (let i = 0; i < n; i++) obs += wFn(a[i]!, b[i]!)
      obs /= n
      // Expected under independence: average of w over all i,j cross pairs.
      let exp = 0
      for (let i = 0; i < n; i++) {
        for (let j = 0; j < n; j++) exp += wFn(a[i]!, b[j]!)
      }
      exp /= n * n
      if (exp === 0) {
        // Degenerate: at least one rater is constant. Convention: perfect
        // agreement iff observed disagreement is also zero, else 0.
        sum += obs === 0 ? 1 : 0
      } else {
        sum += 1 - obs / exp
      }
      pairs++
    }
  }
  return pairs === 0 ? NaN : sum / pairs
}

/**
 * ICC(2,1) — two-way random effects, absolute agreement, single rater.
 *
 *   ICC(2,1) = (MSR − MSE) / (MSR + (k−1)·MSE + k·(MSC − MSE)/n)
 *
 * where MSR = between-rows MS, MSC = between-columns MS, MSE = residual MS,
 * n = rows (items), k = columns (raters).
 */
function icc21(rows: number[][]): number {
  const n = rows.length
  if (n < 2) return NaN
  const k = rows[0]!.length
  if (k < 2) return NaN

  // Row means.
  const rowMeans = rows.map((row) => row.reduce((s, v) => s + v, 0) / k)
  // Column means.
  const colMeans = new Array(k).fill(0)
  for (let j = 0; j < k; j++) {
    let s = 0
    for (let i = 0; i < n; i++) s += rows[i]![j]!
    colMeans[j] = s / n
  }
  // Grand mean.
  let grand = 0
  for (let i = 0; i < n; i++) grand += rowMeans[i]!
  grand /= n

  let ssR = 0
  for (let i = 0; i < n; i++) ssR += (rowMeans[i]! - grand) ** 2
  ssR *= k
  let ssC = 0
  for (let j = 0; j < k; j++) ssC += (colMeans[j]! - grand) ** 2
  ssC *= n
  let ssT = 0
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < k; j++) ssT += (rows[i]![j]! - grand) ** 2
  }
  const ssE = ssT - ssR - ssC

  const dfR = n - 1
  const dfC = k - 1
  const dfE = (n - 1) * (k - 1)
  const msR = ssR / dfR
  const msC = ssC / dfC
  const msE = dfE > 0 ? ssE / dfE : 0

  const denom = msR + (k - 1) * msE + (k * (msC - msE)) / n
  if (denom === 0) {
    // Degenerate (all values equal): convention = 1 if rows identical,
    // else 0. Identical rows ⇒ msR = 0 too, so msR − msE near 0.
    return msR === 0 && msE === 0 ? 1 : 0
  }
  return (msR - msE) / denom
}

/** Average pairwise statistic over all rater pairs. */
function avgPairwise(rows: number[][], fn: (a: number[], b: number[]) => number): number {
  const k = rows[0]?.length ?? 0
  if (k < 2) return NaN
  let sum = 0
  let pairs = 0
  for (let i = 0; i < k; i++) {
    for (let j = i + 1; j < k; j++) {
      const a = rows.map((row) => row[i]!)
      const b = rows.map((row) => row[j]!)
      const r = fn(a, b)
      if (Number.isFinite(r)) {
        sum += r
        pairs++
      }
    }
  }
  return pairs === 0 ? NaN : sum / pairs
}

/** Spearman rank correlation. Ties get average ranks. */
function spearmanR(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return NaN
  return pearsonR(rankWithTies(a), rankWithTies(b))
}

function rankWithTies(xs: number[]): number[] {
  const n = xs.length
  const indexed = xs.map((v, i) => ({ v, i }))
  indexed.sort((x, y) => x.v - y.v)
  const ranks = new Array(n).fill(0)
  let i = 0
  while (i < n) {
    let j = i
    while (j + 1 < n && indexed[j + 1]!.v === indexed[i]!.v) j++
    // Average rank for ties (ranks are 1-indexed).
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) ranks[indexed[k]!.i] = avg
    i = j + 1
  }
  return ranks
}

/** Seeded PRNG — Mulberry32. Deterministic across platforms. */

function percentileBounds(ciLevel: number): [number, number] {
  const tail = (1 - ciLevel) / 2
  return [tail, 1 - tail]
}

/** Linear-interpolated quantile of a pre-sorted ascending array. */
function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  if (sorted.length === 1) return sorted[0]!
  const pos = q * (sorted.length - 1)
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  if (lo === hi) return sorted[lo]!
  const frac = pos - lo
  return sorted[lo]! * (1 - frac) + sorted[hi]! * frac
}
