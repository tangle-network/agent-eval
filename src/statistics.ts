import { ValidationError } from './errors'
import {
  type ContinuousAgreement,
  type ContinuousAgreementOptions,
  continuousAgreement,
} from './judge-calibration'
import { normalCdf } from './math/normal'
import { lnGamma } from './math/special-functions'
import { studentTCdf } from './math/student-t'
import type { JudgeScore } from './types'

/** Identity: dimensions already follow "higher = better" by prompt convention
 *  (inverted dims like hallucination are scored 10 = best at the source). */
export const normalizeScores = (scores: JudgeScore[]): JudgeScore[] => scores

/** Weighted mean — falls back to uniform weights when omitted */
export function weightedMean(scores: { score: number; weight?: number }[]): number {
  if (scores.length === 0) return 0
  let totalWeight = 0
  let weightedSum = 0
  for (const { score, weight } of scores) {
    const w = weight ?? 1
    weightedSum += score * w
    totalWeight += w
  }
  return totalWeight > 0 ? weightedSum / totalWeight : 0
}

/**
 * Percentile bootstrap confidence interval on the mean of `scores`.
 *
 * Descriptive spread. It is not a significance test, and at small n its bounds
 * are anti-conservative in the same way {@link pairedBootstrap}'s are — see
 * {@link BOOTSTRAP_GATE_MIN_N}. With no `seed` the resampling is seeded from
 * the scores themselves, so the interval is reproducible either way.
 */
export function confidenceInterval(
  scores: number[],
  confidence = 0.95,
  opts: { seed?: number; resamples?: number } = {},
): { mean: number; lower: number; upper: number } {
  if (scores.length === 0) return { mean: 0, lower: 0, upper: 0 }
  if (scores.length === 1) return { mean: scores[0]!, lower: scores[0]!, upper: scores[0]! }

  const n = scores.length
  const mean = scores.reduce((a, b) => a + b, 0) / n

  const B = opts.resamples ?? 1000
  const rng = makeRng(opts.seed, scores)
  const bootstrapMeans: number[] = []

  for (let i = 0; i < B; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) {
      sum += scores[Math.floor(rng() * n)]!
    }
    bootstrapMeans.push(sum / n)
  }

  bootstrapMeans.sort((a, b) => a - b)

  const alpha = 1 - confidence
  const lowerIdx = Math.floor((alpha / 2) * B)
  const upperIdx = Math.floor((1 - alpha / 2) * B) - 1

  return {
    mean,
    lower: bootstrapMeans[lowerIdx]!,
    upper: bootstrapMeans[Math.min(upperIdx, B - 1)]!,
  }
}

/**
 * Inter-rater reliability — Krippendorff's α under the squared-difference
 * metric, pooled across dimensions.
 *
 * Each inner array is one judge's scores. Items are matched by position
 * WITHIN a dimension: the k-th score a judge supplies carrying dimension
 * `d` is item k of `d`, and the ratings compared against each other are
 * the ones different judges gave to the same item. Every judge that scores
 * a dimension at all must supply the same number of scores for it —
 * ragged input cannot be aligned into items and throws rather than
 * comparing mismatched items.
 *
 * α = 1 − D_observed / D_expected: D_observed averages the squared
 * difference over within-item judge pairs, D_expected over every pair of
 * ratings irrespective of item. α = 1 is perfect agreement, 0 is chance,
 * negative is systematic disagreement.
 */
export function interRaterReliability(judgeScores: JudgeScore[][]): number {
  if (judgeScores.length < 2) return 1

  // dimension → one score sequence per judge, in that judge's supplied order.
  const perDimension = new Map<string, number[][]>()
  for (let judgeIndex = 0; judgeIndex < judgeScores.length; judgeIndex++) {
    for (const s of judgeScores[judgeIndex]!) {
      let byJudge = perDimension.get(s.dimension)
      if (byJudge === undefined) {
        byJudge = Array.from({ length: judgeScores.length }, () => [] as number[])
        perDimension.set(s.dimension, byJudge)
      }
      byJudge[judgeIndex]!.push(s.score)
    }
  }

  const allValues: number[] = []
  const pairDiffs: number[] = []

  for (const [dimension, byJudge] of perDimension) {
    const scoring = byJudge.filter((scores) => scores.length > 0)
    if (scoring.length < 2) continue
    const itemCount = scoring[0]!.length
    if (scoring.some((scores) => scores.length !== itemCount)) {
      throw new ValidationError(
        `interRaterReliability: dimension '${dimension}' has judges supplying ` +
          `${scoring.map((scores) => scores.length).join('/')} scores — items cannot be aligned`,
      )
    }
    for (let item = 0; item < itemCount; item++) {
      const ratings = scoring.map((scores) => scores[item]!)
      for (const v of ratings) allValues.push(v)
      for (let i = 0; i < ratings.length; i++) {
        for (let j = i + 1; j < ratings.length; j++) {
          pairDiffs.push((ratings[i]! - ratings[j]!) ** 2)
        }
      }
    }
  }

  if (pairDiffs.length === 0 || allValues.length < 2) return 1

  const observedDisagreement = pairDiffs.reduce((a, b) => a + b, 0) / pairDiffs.length

  // Expected disagreement from all possible pairings of values
  let expectedDisagreement = 0
  let expectedCount = 0
  for (let i = 0; i < allValues.length; i++) {
    for (let j = i + 1; j < allValues.length; j++) {
      expectedDisagreement += (allValues[i]! - allValues[j]!) ** 2
      expectedCount++
    }
  }
  expectedDisagreement = expectedCount > 0 ? expectedDisagreement / expectedCount : 0

  if (expectedDisagreement === 0) return 1
  return 1 - observedDisagreement / expectedDisagreement
}

// ── Rank tests: exact by default ─────────────────────────────────────
//
// At 3–10 repetitions per arm the binding constraint on a rank test is
// combinatorial, not numerical. Three versus three admits only 20 splits, so
// the attainable two-sided p-grid starts at 0.1000 and α = 0.05 is out of
// reach at that design; a normal approximation reports 0.0495, a p-value that
// describes no attainable outcome. No better approximation fixes this — adding
// the tie correction moves `[0,0,0]` versus `[1,1,1]` from 0.0495 to 0.0469,
// further from its exact 0.1000, not closer.
//
// So both null distributions are enumerated exactly inside bounded state and
// work budgets, by convolution over the observed midranks (identical to
// enumerating every split / sign pattern, and cheaper), which conditions on the
// realised tie pattern for free. Above those budgets the default is a seeded
// Monte Carlo permutation. The asymptotic path is never chosen automatically,
// and asking for it inside the exact-feasible range throws.
//
// Every result carries `method` and `pFloor` so a downstream gate can SEE the
// discreteness rather than infer it: a gate handed data whose `pFloor` exceeds
// its alpha is underpowered by construction, which is a true statement about
// the experiment, not a false one about the effect.

/** How a rank test's p-value was actually computed. */
export type RankTestMethod = 'exact' | 'permutation' | 'asymptotic'

/**
 * What the caller asks for. `'auto'` selects `'exact'` inside the enumeration
 * threshold and `'permutation'` above it, and never selects `'asymptotic'`.
 */
export type RankTestMethodRequest = 'auto' | 'exact' | 'asymptotic'

export interface RankTestOptions {
  /** Default `'auto'`. `'asymptotic'` inside the exact-feasible range throws. */
  method?: RankTestMethodRequest
  /** Resamples on the Monte Carlo permutation path. Default 100000. */
  permutations?: number
  /** Seed for the permutation path. Omitted ⇒ derived from the data itself, so
   *  the result is reproducible either way. */
  seed?: number
}

/** Maximum dynamic-programming cells used by an exact two-sample rank test. */
export const MANN_WHITNEY_EXACT_MAX_STATES = 8_192
/** Maximum inner-loop transitions used by an exact two-sample rank test. */
export const MANN_WHITNEY_EXACT_MAX_WORK = 250_000
/** Non-zero differences up to which the signed-rank null is enumerated exactly. */
export const WILCOXON_EXACT_MAX_N = 20
/** Resamples used when a rank test falls back to Monte Carlo permutation. */
export const DEFAULT_PERMUTATIONS = 100_000

export interface MannWhitneyResult {
  /** `min(U_a, U_b)` — the conventional reported statistic. */
  u: number
  /** U for sample `a`. Carries the direction of the effect, which `u` discards. */
  uA: number
  /** Two-sided p-value. */
  p: number
  /** How `p` was computed. */
  method: RankTestMethod
  /** Smallest two-sided p this design can produce. `p` can never be below it. */
  pFloor: number
}

/**
 * Mann-Whitney U — two independent samples, no distributional assumption.
 *
 * Exact conditional (permutation) p by default when the dynamic program fits
 * {@link MANN_WHITNEY_EXACT_MAX_STATES} cells and
 * {@link MANN_WHITNEY_EXACT_MAX_WORK} transitions, seeded Monte Carlo
 * permutation above those limits. This keeps imbalanced designs such as 1+24
 * exact without admitting expensive balanced designs merely because they have
 * the same total size. Throws on non-finite input and on `method:
 * 'asymptotic'` where an exact answer is available. Empty input yields `p = 1,
 * pFloor = 1` — no design, no attainable evidence.
 */
export function mannWhitneyU(
  a: number[],
  b: number[],
  opts: RankTestOptions = {},
): MannWhitneyResult {
  assertFiniteSample('mannWhitneyU', 'a', a)
  assertFiniteSample('mannWhitneyU', 'b', b)

  const n1 = a.length
  const n2 = b.length
  if (n1 === 0 || n2 === 0) return { u: 0, uA: 0, p: 1, method: 'exact', pFloor: 1 }

  const total = n1 + n2
  const combined = [
    ...a.map((v) => ({ v, fromA: true })),
    ...b.map((v) => ({ v, fromA: false })),
  ].sort((x, y) => x.v - y.v)

  const { midranks, tieTerm } = midranksWithTieTerm(combined.map((entry) => entry.v))
  let rankSumA = 0
  for (let k = 0; k < total; k++) {
    if (combined[k]!.fromA) rankSumA += midranks[k]!
  }

  const uA = rankSumA - (n1 * (n1 + 1)) / 2
  const u = Math.min(uA, n1 * n2 - uA)
  // Midranks are integers or halves, so doubling makes the null convolution
  // integral. U is centred on n₁n₂/2, hence a doubled centre of n₁n₂.
  const doubled = midranks.map((rank) => Math.round(rank * 2))
  const doubledDeviation = Math.abs(2 * uA - n1 * n2)
  const selectedN = Math.min(n1, n2)
  const otherN = total - selectedN
  const exactCost = exactTwoSampleCost(doubled, selectedN)

  const designFloor = exactTwoSampleFloor(doubled, selectedN)
  const method = selectRankTestMethod(
    'mannWhitneyU',
    opts.method ?? 'auto',
    `n1=${n1}, n2=${n2}`,
    exactCost.states <= MANN_WHITNEY_EXACT_MAX_STATES &&
      exactCost.work <= MANN_WHITNEY_EXACT_MAX_WORK,
    designFloor,
    `${MANN_WHITNEY_EXACT_MAX_STATES.toLocaleString('en-US')} states and ` +
      `${MANN_WHITNEY_EXACT_MAX_WORK.toLocaleString('en-US')} transitions`,
  )

  if (method === 'exact') {
    const { p, pFloor } = exactTwoSampleP(doubled, selectedN, otherN, doubledDeviation)
    return { u, uA, p, method, pFloor }
  }

  if (method === 'asymptotic') {
    return {
      u,
      uA,
      p: asymptoticTwoSidedP(doubledDeviation / 2, twoSampleSigma(n1, n2, total, tieTerm)),
      method,
      pFloor: designFloor,
    }
  }

  const permutations = resolvePermutations('mannWhitneyU', opts.permutations)
  const rng = opts.seed === undefined ? makeRng(symmetricTwoSampleSeed(a, b)) : makeRng(opts.seed)
  let atLeastAsExtreme = 0
  const pool = [...doubled]
  for (let iteration = 0; iteration < permutations; iteration++) {
    let doubledRankSum = 0
    for (let k = 0; k < selectedN; k++) {
      const pick = k + Math.floor(rng() * (total - k))
      const swapped = pool[pick]!
      pool[pick] = pool[k]!
      pool[k] = swapped
      doubledRankSum += swapped
    }
    if (
      Math.abs(doubledRankSum - selectedN * (selectedN + 1) - selectedN * otherN) >=
      doubledDeviation
    ) {
      atLeastAsExtreme++
    }
  }
  const pFloor = Math.max(1 / (permutations + 1), designFloor)
  return {
    u,
    uA,
    p: Math.max((1 + atLeastAsExtreme) / (permutations + 1), pFloor),
    method,
    pFloor,
  }
}

/** Partial credit: returns 0-1 ratio of current toward target */
export function partialCredit(current: number, target: number): number {
  if (target <= 0) return 1
  return Math.min(1, Math.max(0, current / target))
}

export interface PairedTTestResult {
  /** Null when the statistic is undefined — see {@link pairedTTest}. */
  t: number | null
  df: number
  /** Null exactly when `t` is null. */
  p: number | null
}

/**
 * Paired t-test — before/after measurements on the SAME items.
 * Pairing removes inter-item variance, giving tighter significance than
 * an unpaired test when comparing prompt v1 vs prompt v2 on identical
 * scenarios.
 *
 * Returns `t = p = null` where the statistic is undefined: fewer than two
 * pairs, or a non-zero constant delta whose observed variance is zero. A
 * constant shift carries no information about the variance it would have to
 * be compared against, so the honest answer is "undefined", not `p = 0` —
 * three observations cannot buy absolute certainty. This is the same contract
 * {@link pairedCohensDz} states for the same condition. An all-zero delta is
 * different: it is a measured null, and returns `t = 0, p = 1`.
 */
export function pairedTTest(before: number[], after: number[]): PairedTTestResult {
  if (before.length !== after.length) {
    throw new ValidationError(
      `pairedTTest: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  assertFiniteSample('pairedTTest', 'before', before)
  assertFiniteSample('pairedTTest', 'after', after)
  const n = before.length
  if (n < 2) return { t: null, df: 0, p: null }

  const diffs = before.map((b, i) => after[i]! - b)
  const mean = diffs.reduce((a, b) => a + b, 0) / n
  const variance = diffs.reduce((acc, d) => acc + (d - mean) ** 2, 0) / (n - 1)
  const se = Math.sqrt(variance / n)
  if (se === 0) {
    return mean === 0 ? { t: 0, df: n - 1, p: 1 } : { t: null, df: n - 1, p: null }
  }

  const t = mean / se
  const df = n - 1
  const p = 2 * (1 - studentTCdf(Math.abs(t), df))
  return { t, df, p }
}

export interface WilcoxonSignedRankResult {
  /** W⁺, the rank sum of the positive differences. (scipy reports
   *  `min(W⁺, W⁻)`; compare statistics only after converting.) */
  w: number
  /** Two-sided p-value. */
  p: number
  /** How `p` was computed. */
  method: RankTestMethod
  /** Smallest two-sided p this design can produce. */
  pFloor: number
  /** Non-zero differences — zero differences are dropped and carry no rank. */
  nNonZero: number
}

/**
 * Wilcoxon signed-rank — paired, no distributional assumption on the deltas.
 *
 * Exact conditional (sign-flip) p by default at `n ≤
 * {@link WILCOXON_EXACT_MAX_N}` non-zero differences, seeded Monte Carlo
 * permutation above it. Throws on non-finite input and on `method:
 * 'asymptotic'` where an exact answer is available.
 *
 * `n` is the count of NON-ZERO differences: exact ties are dropped before
 * ranking, so a run of tied pairs shrinks the design and raises `pFloor`.
 * All-tied input yields `p = 1, pFloor = 1` — no attainable evidence, which
 * `pFloor` states rather than leaving `p = 1` to be read as a measured null.
 */
export function wilcoxonSignedRank(
  before: number[],
  after: number[],
  opts: RankTestOptions = {},
): WilcoxonSignedRankResult {
  if (before.length !== after.length) {
    throw new ValidationError(
      `wilcoxonSignedRank: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  assertFiniteSample('wilcoxonSignedRank', 'before', before)
  assertFiniteSample('wilcoxonSignedRank', 'after', after)

  const diffs = before.map((b, i) => after[i]! - b).filter((d) => d !== 0)
  const n = diffs.length
  if (n === 0) return { w: 0, p: 1, method: 'exact', pFloor: 1, nNonZero: 0 }

  const order = diffs.map((d, i) => ({ abs: Math.abs(d), i })).sort((x, y) => x.abs - y.abs)
  const { midranks, tieTerm } = midranksWithTieTerm(order.map((entry) => entry.abs))
  const ranks: number[] = new Array(n)
  for (let k = 0; k < n; k++) ranks[order[k]!.i] = midranks[k]!

  let wPlus = 0
  for (let k = 0; k < n; k++) if (diffs[k]! > 0) wPlus += ranks[k]!

  // Midranks are integers or halves; doubling makes the convolution integral.
  // Σ midranks = n(n+1)/2 whatever the tie pattern, so E[W⁺] = n(n+1)/4 and
  // the doubled centre is n(n+1)/2.
  const doubled = midranks.map((rank) => Math.round(rank * 2))
  const doubledDeviation = Math.abs(2 * wPlus - (n * (n + 1)) / 2)

  const designFloor = Math.min(1, 2 ** (1 - n))
  const method = selectRankTestMethod(
    'wilcoxonSignedRank',
    opts.method ?? 'auto',
    `n=${n} non-zero differences`,
    n <= WILCOXON_EXACT_MAX_N,
    designFloor,
    `${WILCOXON_EXACT_MAX_N} non-zero differences`,
  )

  if (method === 'exact') {
    const { p, pFloor } = exactSignedRankP(doubled, doubledDeviation)
    return { w: wPlus, p, method, pFloor, nNonZero: n }
  }

  if (method === 'asymptotic') {
    const variance = (n * (n + 1) * (2 * n + 1)) / 24 - tieTerm / 48
    return {
      w: wPlus,
      p: asymptoticTwoSidedP(doubledDeviation / 2, Math.sqrt(variance)),
      method,
      pFloor: designFloor,
      nNonZero: n,
    }
  }

  const permutations = resolvePermutations('wilcoxonSignedRank', opts.permutations)
  const rng = makeRng(opts.seed, before, after)
  const doubledCentre = (n * (n + 1)) / 2
  let atLeastAsExtreme = 0
  for (let iteration = 0; iteration < permutations; iteration++) {
    let doubledWPlus = 0
    for (let k = 0; k < n; k++) if (rng() < 0.5) doubledWPlus += doubled[k]!
    if (Math.abs(doubledWPlus - doubledCentre) >= doubledDeviation) atLeastAsExtreme++
  }
  return {
    w: wPlus,
    p: (1 + atLeastAsExtreme) / (permutations + 1),
    method,
    pFloor: Math.max(1 / (permutations + 1), designFloor),
    nNonZero: n,
  }
}

/**
 * Cohen's d — standardized effect size for two independent groups.
 * Positive d means group b has higher mean than group a.
 * Rule of thumb: |d| < 0.2 negligible, 0.2–0.5 small, 0.5–0.8 medium, > 0.8 large.
 *
 * Returns null where the standardized effect is undefined: fewer than two
 * observations in either group, or a zero pooled standard deviation with
 * unequal means. Null is NOT "no effect" — zero within-group spread across a
 * real mean gap is an unbounded effect, the opposite of negligible. Equal
 * means with zero spread is a genuine 0. Same contract as
 * {@link pairedCohensDz}.
 */
export function cohensD(a: number[], b: number[]): number | null {
  if (a.length < 2 || b.length < 2) return null
  const meanA = a.reduce((x, y) => x + y, 0) / a.length
  const meanB = b.reduce((x, y) => x + y, 0) / b.length
  const varA = a.reduce((acc, x) => acc + (x - meanA) ** 2, 0) / (a.length - 1)
  const varB = b.reduce((acc, x) => acc + (x - meanB) ** 2, 0) / (b.length - 1)
  const pooled = Math.sqrt(
    ((a.length - 1) * varA + (b.length - 1) * varB) / (a.length + b.length - 2),
  )
  if (pooled === 0) return meanB === meanA ? 0 : null
  return (meanB - meanA) / pooled
}

/**
 * Cohen's dz for paired observations: mean(after - before) divided by the
 * sample standard deviation of those within-pair deltas.
 *
 * Returns null when fewer than two pairs exist or a non-zero constant delta
 * has zero observed variance. In that case the standardized effect is
 * undefined, not an arbitrarily large finite number.
 */
export function pairedCohensDz(before: number[], after: number[]): number | null {
  if (before.length !== after.length) {
    throw new ValidationError(
      `pairedCohensDz: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  if (before.length < 2) return null
  const deltas = before.map((value, index) => after[index]! - value)
  if (deltas.some((value) => !Number.isFinite(value))) {
    throw new ValidationError('pairedCohensDz: all paired values must be finite')
  }
  const meanDelta = deltas.reduce((sum, value) => sum + value, 0) / deltas.length
  const variance =
    deltas.reduce((sum, value) => sum + (value - meanDelta) ** 2, 0) / (deltas.length - 1)
  const standardDeviation = Math.sqrt(variance)
  const scale = Math.max(1, Math.abs(meanDelta), ...deltas.map(Math.abs))
  if (standardDeviation <= Number.EPSILON * scale) return meanDelta === 0 ? 0 : null
  return meanDelta / standardDeviation
}

export type CliffsMagnitude = 'negligible' | 'small' | 'medium' | 'large'

/**
 * Cliff's delta — a non-parametric effect size for two independent samples.
 * `δ = (#(after > before) − #(after < before)) / (n_before · n_after)`,
 * ranging [-1, 1]. Positive ⇒ `after` tends to exceed `before` (improvement).
 *
 * Distribution-free counterpart to Cohen's d: no normality assumption, robust
 * to the bounded/skewed score distributions judges produce. Pairs with
 * `pairedBootstrap` / `wilcoxonSignedRank` for the non-parametric reporting
 * path. Returns 0 when either sample is empty.
 */
export function cliffsDelta(before: number[], after: number[]): number {
  const n = before.length * after.length
  if (n === 0) return 0
  let dominance = 0
  for (const a of after) {
    for (const b of before) {
      if (a > b) dominance += 1
      else if (a < b) dominance -= 1
    }
  }
  return dominance / n
}

/**
 * Map a Cliff's delta to a qualitative magnitude using the standard
 * Romano et al. thresholds (|δ|): <0.147 negligible, <0.33 small,
 * <0.474 medium, else large.
 */
export function interpretCliffs(delta: number): CliffsMagnitude {
  const d = Math.abs(delta)
  if (d < 0.147) return 'negligible'
  if (d < 0.33) return 'small'
  if (d < 0.474) return 'medium'
  return 'large'
}

// ── Correlation (Pearson / Spearman) ─────────────────────────────────
//
// The single source for linear (Pearson) and rank (Spearman) correlation.
// Edge-case contract is explicit so every caller agrees on what a
// degenerate input means:
//   - length mismatch or n < 2  → NaN   (correlation is undefined; not 0)
//   - both series constant      → 1     (degenerate perfect agreement)
//   - exactly one series constant → 0   (no covariation to detect)
// Returning NaN for n < 2 (rather than 0) keeps "not enough data" distinct
// from "measured zero correlation", which a 0 would silently conflate.

/**
 * Average-rank-with-ties transform (1-indexed). Tied values receive the mean
 * of the ranks they span, the standard correction for Spearman's ρ.
 */
export function ranks(xs: number[]): number[] {
  const indexed = xs.map((v, i) => ({ v, i })).sort((a, b) => a.v - b.v)
  const r = new Array<number>(xs.length)
  let i = 0
  while (i < indexed.length) {
    let j = i
    while (j + 1 < indexed.length && indexed[j + 1]!.v === indexed[i]!.v) j++
    const avg = (i + j) / 2 + 1
    for (let k = i; k <= j; k++) r[indexed[k]!.i] = avg
    i = j + 1
  }
  return r
}

/**
 * Pearson product-moment correlation coefficient r ∈ [-1, 1] between two
 * equal-length series. See the edge-case contract above: NaN for n < 2 or
 * unequal lengths, 1 when both series are constant, 0 when exactly one is.
 */
export function pearsonR(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return Number.NaN
  const n = a.length
  const meanA = a.reduce((s, v) => s + v, 0) / n
  const meanB = b.reduce((s, v) => s + v, 0) / n
  let num = 0
  let varA = 0
  let varB = 0
  for (let i = 0; i < n; i++) {
    const da = a[i]! - meanA
    const db = b[i]! - meanB
    num += da * db
    varA += da * da
    varB += db * db
  }
  if (varA === 0 || varB === 0) return varA === 0 && varB === 0 ? 1 : 0
  return num / Math.sqrt(varA * varB)
}

/**
 * Spearman's rank correlation ρ — Pearson over the average-rank-with-ties
 * transform of each series. Same edge-case contract as {@link pearsonR}.
 */
export function spearmanR(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length < 2) return Number.NaN
  return pearsonR(ranks(a), ranks(b))
}

export interface WeightedCompositeInput {
  /** Per-dimension scores (typically 0..1). */
  dims: Record<string, number>
  /** Weight per dimension. Every weighted dimension MUST be present in
   *  `dims` — a weight for an absent dimension is a config error and throws,
   *  because silently dropping it would renormalise the composite onto a
   *  different denominator than intended. */
  weights: Record<string, number>
  /** Optional pass threshold; when set, the result reports `pass`. */
  threshold?: number
}

export interface WeightedCompositeResult {
  composite: number
  pass?: boolean
}

/**
 * Weighted composite over judge dimensions: `Σ(score_d · w_d) / Σ(w_d)` across
 * the weighted dimensions. The canonical replacement for the per-consumer
 * hand-rolled composite math (tax/legal/creative/gtm each ship a copy).
 *
 * Fail-loud: throws if a weighted dimension is missing from `dims`, if any
 * weight is negative, or if the weights sum to 0 — none of which can produce
 * a meaningful composite.
 */
export function weightedComposite(input: WeightedCompositeInput): WeightedCompositeResult {
  const entries = Object.entries(input.weights)
  if (entries.length === 0) {
    throw new Error('weightedComposite: `weights` is empty — nothing to combine')
  }
  let weightedSum = 0
  let weightTotal = 0
  for (const [dim, weight] of entries) {
    if (weight < 0) {
      throw new Error(`weightedComposite: weight for '${dim}' is negative (${weight})`)
    }
    if (!(dim in input.dims)) {
      throw new Error(
        `weightedComposite: weighted dimension '${dim}' is absent from \`dims\` — ` +
          'refusing to renormalise onto a different denominator',
      )
    }
    weightedSum += input.dims[dim]! * weight
    weightTotal += weight
  }
  if (weightTotal === 0) {
    throw new Error('weightedComposite: weights sum to 0 — composite is undefined')
  }
  const composite = weightedSum / weightTotal
  return input.threshold === undefined
    ? { composite }
    : { composite, pass: composite >= input.threshold }
}

// ── Corpus-wide inter-rater agreement ──────────────────────────────
//
// `interRaterReliability(judgeScores)` computes a within-item
// Krippendorff α — multiple judges score *the same item* and we ask
// "how much do their scores agree on that item?" Useful for a single
// scenario, but it cannot answer "how reliable are these judges across
// the whole evaluation corpus?"
//
// `corpusInterRaterAgreement` does the corpus-wide question properly.
// Inputs are flat per-(item, judge, dimension) score records. For each
// dimension we pivot to a complete [n_items × n_judges] matrix and feed
// it to the ICC(2,1) + κ_w machinery already validated in
// `judge-calibration.ts`. An overall pooled metric averages the
// per-dimension ICC/κ across dimensions.

export interface CorpusScoreRecord {
  /** Stable identifier for the rated item (scenario, span, turn, …). */
  itemId: string
  /** Identifier for the judge that produced this score. */
  judgeName: string
  /** Dimension name (matches `JudgeScore.dimension`). */
  dimension: string
  /** Numeric score; must be finite. */
  score: number
}

export interface CorpusAgreementPerDimension extends ContinuousAgreement {
  dimension: string
  /** Item IDs that contributed to this dimension's matrix (every judge scored them). */
  itemIds: string[]
  /** Judge IDs that contributed to this dimension's matrix. */
  judgeIds: string[]
}

export interface CorpusAgreementReport {
  /** Per-dimension ICC(2,1) + κ_w + Pearson + Spearman + bootstrap CIs. */
  perDimension: CorpusAgreementPerDimension[]
  /** Mean ICC across dimensions (NaN if no dimension yielded a finite ICC). */
  overallIcc: number
  /** Mean weighted κ across dimensions (NaN if none finite). */
  overallWeightedKappa: number
  /** Dimensions evaluated (sorted). */
  dimensions: string[]
  /** Judges seen across the corpus (sorted). */
  judgeIds: string[]
}

export interface CorpusAgreementOptions extends ContinuousAgreementOptions {
  /**
   * Restrict the audit to these dimensions. Default = every dimension
   * that appears in the input. A dimension named here but absent from
   * the input throws — silent omission would corrupt the overall metric.
   */
  dimensions?: string[]
  /**
   * Restrict the audit to these judges. Default = every judge that
   * appears in the input. A judge named here but absent from a
   * dimension throws (see "fail loud" below).
   */
  judges?: string[]
}

/**
 * Corpus-wide inter-rater agreement across N items × M judges × D dimensions.
 *
 * For each dimension, builds the [n_items][n_judges] matrix of scores
 * (keeping only items every judge rated on that dimension), then runs
 * `continuousAgreement` to get ICC(2,1), κ_w, Pearson, Spearman, and
 * bootstrap CIs. Reports a pooled mean across dimensions as a single
 * "is this judge panel reliable on this corpus?" number.
 *
 * Fail-loud contract:
 *   - Empty input throws.
 *   - Fewer than 2 judges or fewer than 2 items per dimension throws.
 *   - A judge present in some dimensions but with zero scored items on
 *     another dimension throws (would silently shrink the matrix).
 *   - Duplicate (itemId, judgeName, dimension) records throw.
 */
export function corpusInterRaterAgreement(
  records: CorpusScoreRecord[],
  opts: CorpusAgreementOptions = {},
): CorpusAgreementReport {
  if (records.length === 0) {
    throw new ValidationError('corpusInterRaterAgreement: no score records supplied')
  }

  const judgesSeen = new Set<string>()
  const dimsSeen = new Set<string>()
  // dimension → judge → itemId → score
  const grid = new Map<string, Map<string, Map<string, number>>>()

  for (const r of records) {
    if (!Number.isFinite(r.score)) {
      throw new ValidationError(
        `corpusInterRaterAgreement: non-finite score for (item=${r.itemId}, judge=${r.judgeName}, dim=${r.dimension})`,
      )
    }
    judgesSeen.add(r.judgeName)
    dimsSeen.add(r.dimension)
    const byJudge = grid.get(r.dimension) ?? new Map<string, Map<string, number>>()
    const byItem = byJudge.get(r.judgeName) ?? new Map<string, number>()
    if (byItem.has(r.itemId)) {
      throw new ValidationError(
        `corpusInterRaterAgreement: duplicate record for (item=${r.itemId}, judge=${r.judgeName}, dim=${r.dimension})`,
      )
    }
    byItem.set(r.itemId, r.score)
    byJudge.set(r.judgeName, byItem)
    grid.set(r.dimension, byJudge)
  }

  const targetDims = opts.dimensions ?? [...dimsSeen].sort()
  for (const d of targetDims) {
    if (!dimsSeen.has(d)) {
      throw new ValidationError(
        `corpusInterRaterAgreement: dimension '${d}' was requested but no records carry it`,
      )
    }
  }
  const targetJudges = opts.judges ? [...opts.judges] : [...judgesSeen].sort()
  for (const j of targetJudges) {
    if (!judgesSeen.has(j)) {
      throw new ValidationError(
        `corpusInterRaterAgreement: judge '${j}' was requested but produced no records`,
      )
    }
  }
  if (targetJudges.length < 2) {
    throw new ValidationError(
      `corpusInterRaterAgreement: need ≥2 judges, got ${targetJudges.length}`,
    )
  }

  const perDimension: CorpusAgreementPerDimension[] = []
  const iccs: number[] = []
  const kappas: number[] = []

  for (const dim of targetDims) {
    const byJudge = grid.get(dim)!
    // Fail loud: every requested judge must have scored ≥1 item on this dim.
    const judgeItemCounts: Record<string, number> = {}
    for (const j of targetJudges) {
      const m = byJudge.get(j)
      judgeItemCounts[j] = m?.size ?? 0
    }
    const emptyJudges = targetJudges.filter((j) => judgeItemCounts[j] === 0)
    if (emptyJudges.length > 0) {
      throw new ValidationError(
        `corpusInterRaterAgreement: dimension '${dim}' has no scores from judge(s) ${emptyJudges.join(', ')} (counts: ${JSON.stringify(judgeItemCounts)})`,
      )
    }

    // Items rated by *every* requested judge on this dim.
    let commonItems: Set<string> | null = null
    for (const j of targetJudges) {
      const ids = new Set(byJudge.get(j)!.keys())
      if (commonItems === null) {
        commonItems = ids
      } else {
        const prev: Set<string> = commonItems
        commonItems = new Set([...prev].filter((x) => ids.has(x)))
      }
    }
    const sortedItems = [...(commonItems ?? new Set<string>())].sort()
    if (sortedItems.length < 2) {
      throw new ValidationError(
        `corpusInterRaterAgreement: dimension '${dim}' has ${sortedItems.length} item(s) rated by all ${targetJudges.length} judges (need ≥2)`,
      )
    }

    const matrix: number[][] = sortedItems.map((itemId) =>
      targetJudges.map((j) => byJudge.get(j)!.get(itemId)!),
    )
    const agreement = continuousAgreement(matrix, opts)
    perDimension.push({
      ...agreement,
      dimension: dim,
      itemIds: sortedItems,
      judgeIds: [...targetJudges],
    })
    if (Number.isFinite(agreement.icc)) iccs.push(agreement.icc)
    if (Number.isFinite(agreement.weightedKappa)) kappas.push(agreement.weightedKappa)
  }

  const mean = (xs: number[]) =>
    xs.length === 0 ? Number.NaN : xs.reduce((a, b) => a + b, 0) / xs.length
  return {
    perDimension,
    overallIcc: mean(iccs),
    overallWeightedKappa: mean(kappas),
    dimensions: targetDims,
    judgeIds: targetJudges,
  }
}

/**
 * Convenience adapter for `JudgeScore[]` data keyed externally by item.
 *
 * Use when you have per-item arrays of `JudgeScore[]` (e.g. one
 * `ScenarioResult.judgeScores` per scenario) and want corpus-wide
 * agreement without manually flattening. `itemId` must be unique per
 * row of `itemsScores`.
 */
export function corpusInterRaterAgreementFromJudgeScores(
  itemsScores: Array<{ itemId: string; scores: JudgeScore[] }>,
  opts: CorpusAgreementOptions = {},
): CorpusAgreementReport {
  const records: CorpusScoreRecord[] = []
  const seen = new Set<string>()
  for (const { itemId, scores } of itemsScores) {
    if (seen.has(itemId)) {
      throw new ValidationError(
        `corpusInterRaterAgreementFromJudgeScores: duplicate itemId '${itemId}'`,
      )
    }
    seen.add(itemId)
    for (const s of scores) {
      records.push({
        itemId,
        judgeName: s.judgeName,
        dimension: s.dimension,
        score: s.score,
      })
    }
  }
  return corpusInterRaterAgreement(records, opts)
}

// ── Power analysis + multiple-comparison correction ──────────────────

/**
 * Required N per arm for a two-sample comparison at target effect size,
 * alpha, and power. Normal-approximation formula:
 *   n = 2 * ( (z_{1-α/2} + z_{1-β}) / d )^2
 * where d is Cohen's d. Returns Infinity for effect ≤ 0.
 */
export function requiredSampleSize(opts: {
  effect: number
  alpha?: number
  power?: number
  twoSided?: boolean
}): number {
  const effect = opts.effect
  if (!Number.isFinite(effect) || effect <= 0) return Infinity
  const alpha = opts.alpha ?? 0.05
  const power = opts.power ?? 0.8
  const twoSided = opts.twoSided ?? true
  const zAlpha = zQuantile(twoSided ? 1 - alpha / 2 : 1 - alpha)
  const zBeta = zQuantile(power)
  const n = 2 * ((zAlpha + zBeta) / effect) ** 2
  return Math.ceil(n)
}

/**
 * Required number of paired observations for a target Cohen's dz.
 * Unlike the independent-groups formula, this has no two-arm factor of two.
 *
 * Normal quantiles with no t correction, so treat the result as a LOWER bound:
 * it returns 32 where the exact t-based answer is 34 at dz = 0.5, and 13 where
 * it is 15 at dz = 0.8 — a 6–13 % shortfall precisely in the range a caller
 * consults to decide whether 3–10 repetitions suffice.
 */
export function requiredPairedSampleSize(opts: {
  effect: number
  alpha?: number
  power?: number
  twoSided?: boolean
}): number {
  const effect = opts.effect
  if (!Number.isFinite(effect) || effect <= 0) return Infinity
  const alpha = opts.alpha ?? 0.05
  const power = opts.power ?? 0.8
  const twoSided = opts.twoSided ?? true
  const zAlpha = zQuantile(twoSided ? 1 - alpha / 2 : 1 - alpha)
  const zBeta = zQuantile(power)
  return Math.ceil(((zAlpha + zBeta) / effect) ** 2)
}

/**
 * Minimum detectable paired effect (standardised units) for a target paired
 * sample size: d_min = (z_{1-α/2} + z_β) / sqrt(n_paired). Multiply by
 * sd(deltas) for score units; treat as a lower bound — Wilcoxon and bootstrap
 * have asymptotic relative efficiency below 1 vs the t-test on heavy tails.
 */
export function pairedMde(opts: {
  nPaired: number
  alpha?: number
  power?: number
  twoSided?: boolean
}): number {
  if (!Number.isFinite(opts.nPaired) || opts.nPaired <= 0) return Infinity
  const alpha = opts.alpha ?? 0.05
  const power = opts.power ?? 0.8
  const twoSided = opts.twoSided ?? true
  const zAlpha = zQuantile(twoSided ? 1 - alpha / 2 : 1 - alpha)
  const zBeta = zQuantile(power)
  return (zAlpha + zBeta) / Math.sqrt(opts.nPaired)
}

/**
 * Number of paired observations needed for a McNemar test to reach a target
 * power — the pre-registration companion to {@link mcnemar}. Parametrised by the
 * expected discordant-cell probabilities `p10` (P[treatment wins on a pair]) and
 * `p01` (P[control wins]); concordant pairs carry no information, so the count
 * is driven entirely by the discordant rate. Lachin's (1992) asymptotic normal
 * approximation: with discordant rate `pDisc = p10 + p01` and marginal effect
 * `δ = p10 − p01`,
 *   n = ( z_{1-α/2}·√pDisc + z_{1-β}·√(pDisc − δ²) )² / δ².
 * Returns Infinity when there is no effect (p10 === p01). Asymptotic — at the
 * tiny discordant counts where the exact {@link mcnemar} differs from the normal
 * approximation, treat the result as a lower bound and prefer the discordant-pair
 * floor.
 */
export function mcnemarRequiredN(opts: {
  p10: number
  p01: number
  alpha?: number
  power?: number
  twoSided?: boolean
}): number {
  const { p10, p01 } = opts
  if (p10 < 0 || p01 < 0 || p10 + p01 > 1) {
    throw new Error(`mcnemarRequiredN: require p10,p01 ≥ 0 and p10+p01 ≤ 1 (got ${p10}, ${p01})`)
  }
  const delta = p10 - p01
  if (delta === 0) return Infinity
  const alpha = opts.alpha ?? 0.05
  const power = opts.power ?? 0.8
  const twoSided = opts.twoSided ?? true
  const pDisc = p10 + p01
  const zAlpha = zQuantile(twoSided ? 1 - alpha / 2 : 1 - alpha)
  const zBeta = zQuantile(power)
  const n =
    (zAlpha * Math.sqrt(pDisc) + zBeta * Math.sqrt(Math.max(0, pDisc - delta * delta))) ** 2 /
    (delta * delta)
  return Math.ceil(n)
}

/**
 * Power of a McNemar test at a given number of paired observations, the inverse
 * of {@link mcnemarRequiredN} (same Lachin asymptotic model, same parameters).
 * Returns a value in [0, 1]; equals `alpha` when there is no effect.
 */
export function mcnemarPower(opts: {
  p10: number
  p01: number
  nPairs: number
  alpha?: number
  twoSided?: boolean
}): number {
  const { p10, p01, nPairs } = opts
  if (p10 < 0 || p01 < 0 || p10 + p01 > 1) {
    throw new Error(`mcnemarPower: require p10,p01 ≥ 0 and p10+p01 ≤ 1 (got ${p10}, ${p01})`)
  }
  const alpha = opts.alpha ?? 0.05
  const twoSided = opts.twoSided ?? true
  const delta = p10 - p01
  if (delta === 0 || nPairs <= 0) return alpha
  const pDisc = p10 + p01
  const zAlpha = zQuantile(twoSided ? 1 - alpha / 2 : 1 - alpha)
  const denom = Math.sqrt(Math.max(1e-12, pDisc - delta * delta))
  const zBeta = (Math.sqrt(nPairs) * Math.abs(delta) - zAlpha * Math.sqrt(pDisc)) / denom
  return Math.min(1, Math.max(0, normalCdf(zBeta)))
}

/**
 * Bonferroni adjustment: multiply every p-value by the test count, clamp at 1.
 *
 * Rejects at `p_adjusted ≤ alpha` — the boundary is inclusive, matching
 * {@link holm}, which uniformly dominates this correction and must therefore
 * never reject less. Validates its inputs on the same terms.
 */
export function bonferroni(
  pValues: readonly number[],
  alpha = 0.05,
): { adjusted: number[]; significant: boolean[] } {
  assertAlpha('bonferroni', 'alpha', alpha)
  assertPValues('bonferroni', pValues)
  const k = pValues.length
  const adjusted = pValues.map((p) => Math.min(1, p * k))
  return { adjusted, significant: adjusted.map((p) => p <= alpha) }
}

/**
 * Holm step-down family-wise error adjustment.
 *
 * P-values are sorted from smallest to largest, multiplied by their remaining
 * hypothesis count, and made monotonically non-decreasing before being mapped
 * back to input order. This uniformly dominates plain Bonferroni while keeping
 * strong family-wise error control under arbitrary dependence.
 */
export function holm(
  pValues: readonly number[],
  alpha = 0.05,
): { adjusted: number[]; significant: boolean[] } {
  assertAlpha('holm', 'alpha', alpha)
  assertPValues('holm', pValues)
  const count = pValues.length
  if (count === 0) return { adjusted: [], significant: [] }

  const ordered = pValues
    .map((pValue, index) => ({ pValue, index }))
    .sort((a, b) => a.pValue - b.pValue || a.index - b.index)
  const adjusted = new Array<number>(count)
  let previous = 0
  for (let rank = 0; rank < count; rank++) {
    const entry = ordered[rank]!
    const stepAdjusted = Math.min(1, entry.pValue * (count - rank))
    previous = Math.max(previous, stepAdjusted)
    adjusted[entry.index] = previous
  }
  // Holm's rejection rule is inclusive at the adjusted alpha boundary.
  return { adjusted, significant: adjusted.map((pValue) => pValue <= alpha) }
}

/**
 * Benjamini–Hochberg false discovery rate. Returns adjusted q-values and
 * significance at the target FDR; handles ties and preserves q monotonicity.
 *
 * Rejects at `q ≤ fdr` — the BH rule is inclusive at the boundary, so an
 * exactly-`fdr` q-value is a discovery.
 */
export function benjaminiHochberg(
  pValues: readonly number[],
  fdr = 0.05,
): { qValues: number[]; significant: boolean[] } {
  assertAlpha('benjaminiHochberg', 'fdr', fdr)
  assertPValues('benjaminiHochberg', pValues)
  const n = pValues.length
  if (n === 0) return { qValues: [], significant: [] }
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const q = new Array<number>(n)
  let minRight = 1
  for (let k = n - 1; k >= 0; k--) {
    const rank = k + 1
    const entry = indexed[k]!
    // (n/rank)·p, not (p·n)/rank: the latter lands one ULP above `fdr` at an
    // exact boundary (p = 0.05, n = 3, rank = 3 gives 0.05000000000000001),
    // which silently turns a discovery into a non-discovery. This is R's
    // `p.adjust(method = "BH")` formulation.
    const raw = (n / rank) * entry.p
    const bounded = Math.min(minRight, raw)
    minRight = bounded
    q[entry.i] = Math.min(1, bounded)
  }
  return { qValues: q, significant: q.map((v) => v <= fdr) }
}

function assertAlpha(fn: string, label: string, value: number): void {
  if (!Number.isFinite(value) || value <= 0 || value >= 1) {
    throw new ValidationError(`${fn}: ${label} must be in (0,1), got ${value}`)
  }
}

function assertPValues(fn: string, pValues: readonly number[]): void {
  for (const [index, pValue] of pValues.entries()) {
    if (!Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
      throw new ValidationError(`${fn}: pValues[${index}] must be in [0,1], got ${pValue}`)
    }
  }
}

// ── Paired bootstrap (promotion-gate effect size) ────────────────────

export interface PairedBootstrapResult {
  /** Number of paired observations. */
  n: number
  /** Median of paired deltas (after − before). */
  median: number
  /** Mean of paired deltas. */
  mean: number
  /** Lower bound of the bootstrap CI on the chosen statistic. */
  low: number
  /** Upper bound of the bootstrap CI on the chosen statistic. */
  high: number
  /** Confidence level used (e.g. 0.95). */
  confidence: number
  /** Number of bootstrap resamples used. */
  resamples: number
  /** False below {@link BOOTSTRAP_GATE_MIN_N}. See {@link pairedBootstrap}. */
  gateEligible: boolean
}

/**
 * Pairs below which a percentile bootstrap interval is descriptive spread only.
 *
 * `P(low > 0)` under a true null, against a nominal 2.5 %, measured over 4000
 * seeded trials: 13.53 % at n = 3, 3.52 % at n = 10, 3.10 % at n = 20 on the
 * median; 13.85 %, 4.90 %, 3.80 % on the mean. This is intrinsic to resampling
 * three points, not an implementation error — scipy's BCa gives 16.0 % on the
 * same n = 3 data — so no change to the estimator moves it. Below this floor
 * the decision belongs to the exact sign test or exact signed-rank test.
 */
export const BOOTSTRAP_GATE_MIN_N = 20

export interface PairedBootstrapOptions {
  /** Confidence level. Default 0.95. */
  confidence?: number
  /** Bootstrap resample count. Default 2000. */
  resamples?: number
  /** Statistic to bootstrap. Default 'median'. */
  statistic?: 'median' | 'mean'
  /** Deterministic seed. If omitted, derived from the deltas so the interval
   *  is reproducible regardless. */
  seed?: number
}

/**
 * Paired bootstrap on (after − before) deltas. Returns a CI on the chosen
 * statistic (median by default); pairs are resampled with replacement. Throws
 * on unequal sample sizes.
 *
 * `low > threshold` carries the stated confidence ONLY at `n ≥
 * {@link BOOTSTRAP_GATE_MIN_N}`, which `gateEligible` reports. Below it the
 * check fires under a true null several times more often than nominal, so the
 * interval is descriptive spread and a promotion must not turn on it.
 */
export function pairedBootstrap(
  before: number[],
  after: number[],
  opts: PairedBootstrapOptions = {},
): PairedBootstrapResult {
  if (before.length !== after.length) {
    throw new Error(`pairedBootstrap: unequal sample sizes (${before.length} vs ${after.length})`)
  }
  const confidence = opts.confidence ?? 0.95
  const resamples = opts.resamples ?? 2000
  const statistic = opts.statistic ?? 'median'
  if (confidence <= 0 || confidence >= 1) {
    throw new Error(`pairedBootstrap: confidence must be in (0,1), got ${confidence}`)
  }

  const n = before.length
  const deltas = before.map((b, i) => after[i]! - b)
  const gateEligible = n >= BOOTSTRAP_GATE_MIN_N
  if (n === 0) {
    return { n: 0, median: 0, mean: 0, low: 0, high: 0, confidence, resamples, gateEligible }
  }
  if (n === 1) {
    const d = deltas[0]!
    return { n: 1, median: d, mean: d, low: d, high: d, confidence, resamples, gateEligible }
  }

  const rng = makeRng(opts.seed, deltas)
  const samples = new Array<number>(resamples)
  for (let b = 0; b < resamples; b++) {
    if (statistic === 'mean') {
      let sum = 0
      for (let k = 0; k < n; k++) {
        sum += deltas[Math.floor(rng() * n)]!
      }
      samples[b] = sum / n
    } else {
      const acc = new Array<number>(n)
      for (let k = 0; k < n; k++) {
        acc[k] = deltas[Math.floor(rng() * n)]!
      }
      samples[b] = medianInPlace(acc)
    }
  }
  samples.sort((a, b) => a - b)

  const alpha = 1 - confidence
  const lowIdx = Math.floor((alpha / 2) * resamples)
  const highIdx = Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1)

  return {
    n,
    median: medianInPlace([...deltas]),
    mean: deltas.reduce((s, x) => s + x, 0) / n,
    low: samples[lowIdx]!,
    high: samples[Math.max(highIdx, lowIdx)]!,
    confidence,
    resamples,
    gateEligible,
  }
}

/** Pre-registered direction for a one-sided paired sign test. */
export type SignTestAlternative = 'greater' | 'less'

/** Exact one-sided sign-test result for paired numeric differences. */
export interface PairedSignTestResult {
  /** Total supplied differences, including zero ties. */
  n: number
  /** Strictly positive differences. */
  positive: number
  /** Strictly negative differences. */
  negative: number
  /** Zero differences excluded from the binomial test. */
  ties: number
  /** Non-zero differences used by the binomial test. */
  nNonTies: number
  /** Direction of the pre-registered alternative hypothesis. */
  alternative: SignTestAlternative
  /** Exact one-sided p-value under P(positive) = P(negative) = 0.5. */
  pValue: number
}

/**
 * Exact one-sided sign test over paired differences.
 *
 * Pass `after[i] - before[i]` for each matched item. `alternative = 'greater'`
 * tests whether positive signs are more likely than negative signs and returns
 * `P(Binomial(nNonTies, 0.5) >= positive)`. `alternative = 'less'` treats
 * negative signs as successes instead. With a continuous difference
 * distribution this is the usual directional median test. Exact zero
 * differences are ties and do not enter the binomial denominator. All-tie and
 * empty inputs return p = 1. Every input difference must be finite, and the
 * direction must be chosen explicitly so a caller cannot select it after
 * seeing the signs.
 */
export function pairedSignTest(
  differences: readonly number[],
  alternative: SignTestAlternative,
): PairedSignTestResult {
  if (alternative !== 'greater' && alternative !== 'less') {
    throw new ValidationError(
      `pairedSignTest: alternative must be 'greater' or 'less', got ${alternative}`,
    )
  }

  let positive = 0
  let negative = 0
  let ties = 0
  for (let i = 0; i < differences.length; i++) {
    const difference = differences[i]!
    if (!Number.isFinite(difference)) {
      throw new ValidationError(
        `pairedSignTest: difference at index ${i} must be finite, got ${difference}`,
      )
    }
    if (difference > 0) positive++
    else if (difference < 0) negative++
    else ties++
  }

  const nNonTies = positive + negative
  const successes = alternative === 'greater' ? positive : negative
  return {
    n: differences.length,
    positive,
    negative,
    ties,
    nNonTies,
    alternative,
    pValue: binomialHalfUpperTail(successes, nNonTies),
  }
}

// ── Binomial proportion + paired-binary + coding-eval estimators ─────
//
// The paired family above (pairedBootstrap/pairedTTest/wilcoxonSignedRank)
// operates on continuous scores. Pass/fail A/B comparisons — "does treatment
// X raise the success RATE vs control" — are binary and paired, so they need
// their own correct estimators: McNemar for significance (only the discordant
// pairs carry signal), the paired risk difference for effect size, Wilson for
// a single-arm proportion CI, and pass@k for the standard k-sample coding-eval
// metric. The normal approximation is wrong for proportions near 0/1 and for
// the small discordant counts typical of eval runs, so these are exact /
// Wilson-based, not Wald.

/** A binomial proportion estimate with a confidence interval. */
export interface ProportionInterval {
  /** Point estimate successes / n (0 when n = 0). */
  estimate: number
  /** Lower bound, clamped to [0, 1]. */
  lower: number
  /** Upper bound, clamped to [0, 1]. */
  upper: number
}

/**
 * Wilson score interval for a binomial proportion. Correct at small n and near
 * 0/1, where the normal (Wald) approximation produces bounds outside [0, 1] and
 * understates coverage. Use this for any pass-rate / hit-rate / realness-rate
 * CI — the continuous `confidenceInterval` assumes the wrong distribution for a
 * proportion. `n = 0 ⇒ {0, 0, 0}`.
 */
export function wilson(successes: number, n: number, confidence = 0.95): ProportionInterval {
  if (n <= 0) return { estimate: 0, lower: 0, upper: 0 }
  if (successes < 0 || successes > n) {
    throw new Error(`wilson: successes (${successes}) must be in [0, ${n}]`)
  }
  const z = zQuantile(1 - (1 - confidence) / 2)
  const p = successes / n
  const z2 = z * z
  const denom = 1 + z2 / n
  const center = (p + z2 / (2 * n)) / denom
  const half = (z * Math.sqrt((p * (1 - p) + z2 / (4 * n)) / n)) / denom
  return {
    estimate: p,
    lower: Math.max(0, center - half),
    upper: Math.min(1, center + half),
  }
}

/** Result of a McNemar paired-binary significance test. */
export interface McNemarResult {
  /** Total paired observations. */
  n: number
  /** Discordant pairs (b + c) — the only ones that carry signal. */
  nDiscordant: number
  /** Pairs where treatment succeeded and control failed ("newly correct"). */
  b: number
  /** Pairs where control succeeded and treatment failed ("newly wrong"). */
  c: number
  /** Continuity-corrected chi-square statistic (reference; exact p drives the call). */
  statistic: number
  /** Two-sided p-value. Exact (binomial sign test on discordant pairs). */
  pValue: number
}

/**
 * McNemar's test for paired binary outcomes — the correct significance test for
 * "does treatment change the success rate vs control on the SAME items". Only
 * discordant pairs (one arm right, the other wrong) carry information; concordant
 * pairs are uninformative, so a paired t-test / two-proportion z-test on the raw
 * rates is wrong here. The p-value is exact: under H0 the b "treatment-wins" are
 * Binomial(b + c, 0.5), so the two-sided p is the doubled binomial tail — correct
 * at the small discordant counts typical of eval runs (no continuity-corrected
 * chi-square approximation needed, though it is returned as `statistic` for
 * reference). Inputs are paired 0/1 (or boolean) arrays, control first to match
 * the module's (before, after) convention. Throws on unequal lengths.
 */
export function mcnemar(
  control: ArrayLike<number | boolean>,
  treatment: ArrayLike<number | boolean>,
): McNemarResult {
  if (control.length !== treatment.length) {
    throw new Error(`mcnemar: unequal sample sizes (${control.length} vs ${treatment.length})`)
  }
  const n = control.length
  let b = 0 // treatment 1, control 0
  let c = 0 // treatment 0, control 1
  for (let i = 0; i < n; i++) {
    const ctrl = control[i] ? 1 : 0
    const treat = treatment[i] ? 1 : 0
    if (treat === 1 && ctrl === 0) b++
    else if (treat === 0 && ctrl === 1) c++
  }
  const nDiscordant = b + c
  const statistic = nDiscordant === 0 ? 0 : (Math.abs(b - c) - 1) ** 2 / nDiscordant
  return { n, nDiscordant, b, c, statistic, pValue: binomialSignTwoSided(b, c) }
}

/** A paired binary effect size (treatment rate − control rate) with a CI. */
export interface RiskDifferenceResult {
  /** Total paired observations. */
  n: number
  /** Discordant pairs: treatment-win count. */
  b: number
  /** Discordant pairs: control-win count. */
  c: number
  /** Paired risk difference p(treatment) − p(control) = (b − c) / n. */
  riskDifference: number
  /** Lower bound of the CI, clamped to [-1, 1]. */
  lower: number
  /** Upper bound of the CI, clamped to [-1, 1]. */
  upper: number
  /** Confidence level used. */
  confidence: number
}

/**
 * Paired risk difference (the effect-size companion to {@link mcnemar}): the
 * change in success rate p(treatment) − p(control) on matched items, which for
 * paired binary data equals (b − c) / n. The CI uses the paired variance from
 * the discordant counts, not the independent-samples formula (which overstates
 * the interval by ignoring the pairing). Inputs are paired 0/1 (or boolean)
 * arrays, control first. Throws on unequal lengths.
 */
export function pairedRiskDifference(
  control: ArrayLike<number | boolean>,
  treatment: ArrayLike<number | boolean>,
  confidence = 0.95,
): RiskDifferenceResult {
  if (control.length !== treatment.length) {
    throw new Error(
      `pairedRiskDifference: unequal sample sizes (${control.length} vs ${treatment.length})`,
    )
  }
  const n = control.length
  if (n === 0) return { n: 0, b: 0, c: 0, riskDifference: 0, lower: 0, upper: 0, confidence }
  let b = 0
  let c = 0
  for (let i = 0; i < n; i++) {
    const ctrl = control[i] ? 1 : 0
    const treat = treatment[i] ? 1 : 0
    if (treat === 1 && ctrl === 0) b++
    else if (treat === 0 && ctrl === 1) c++
  }
  const rd = (b - c) / n
  const variance = (b + c - (b - c) ** 2 / n) / (n * n)
  const z = zQuantile(1 - (1 - confidence) / 2)
  const half = z * Math.sqrt(Math.max(0, variance))
  return {
    n,
    b,
    c,
    riskDifference: rd,
    lower: Math.max(-1, rd - half),
    upper: Math.min(1, rd + half),
    confidence,
  }
}

/**
 * Unbiased pass@k for code generation (Chen et al. 2021, "Evaluating Large
 * Language Models Trained on Code"). Given `n` independent samples for one
 * problem of which `c` pass, the probability that at least one of a random k of
 * them passes is 1 − C(n−c, k) / C(n, k). Estimating pass@k as "did any of the
 * first k pass" is biased high at small n; this is the variance-reduced estimator
 * averaged implicitly over all k-subsets. Average the per-problem values across
 * the suite for the corpus pass@k. Computed in the numerically stable product
 * form. Requires 1 ≤ k ≤ n and 0 ≤ c ≤ n.
 */
export function passAtK(n: number, c: number, k: number): number {
  if (!Number.isInteger(n) || !Number.isInteger(c) || !Number.isInteger(k)) {
    throw new Error(`passAtK: n, c, k must be integers (got n=${n}, c=${c}, k=${k})`)
  }
  if (k < 1 || k > n || c < 0 || c > n) {
    throw new Error(`passAtK: require 1 ≤ k ≤ n and 0 ≤ c ≤ n (got n=${n}, c=${c}, k=${k})`)
  }
  if (n - c < k) return 1
  let prob = 1
  for (let i = n - c + 1; i <= n; i++) prob *= 1 - k / i
  return 1 - prob
}

/**
 * Two-sided exact p-value for b successes out of (b + c) Bernoulli(0.5) trials —
 * the exact-binomial core of {@link mcnemar}. `min(1, 2·P(X ≤ min(b,c)))`. No
 * discordant pairs ⇒ no evidence ⇒ p = 1. Summed in log space (lnGamma) so it
 * stays exact at large discordant counts without overflow.
 */
function binomialSignTwoSided(b: number, c: number): number {
  const nd = b + c
  if (nd === 0) return 1
  return Math.min(1, 2 * binomialHalfLowerTail(Math.min(b, c), nd))
}

/** P(X >= successes) for X ~ Binomial(n, 0.5). */
function binomialHalfUpperTail(successes: number, n: number): number {
  if (successes <= 0) return 1
  if (successes > n) return 0

  // Use the smaller side of the distribution. For lower thresholds the
  // complement sums at most half the mass; for upper thresholds symmetry
  // maps the upper tail to a lower tail without subtraction.
  if (successes <= n / 2) {
    return Math.max(0, 1 - binomialHalfLowerTail(successes - 1, n))
  }
  return binomialHalfLowerTail(n - successes, n)
}

/** P(X <= maxSuccesses) for X ~ Binomial(n, 0.5), accumulated in log space. */
function binomialHalfLowerTail(maxSuccesses: number, n: number): number {
  if (maxSuccesses < 0) return 0
  if (maxSuccesses >= n) return 1
  if (maxSuccesses === 0) return 2 ** -n

  const logHalfN = n * Math.log(0.5)
  let logTail = Number.NEGATIVE_INFINITY
  for (let i = 0; i <= maxSuccesses; i++) {
    const logChoose = lnGamma(n + 1) - lnGamma(i + 1) - lnGamma(n - i + 1)
    logTail = logAddExp(logTail, logChoose + logHalfN)
  }
  return Math.min(1, Math.exp(logTail))
}

function logAddExp(a: number, b: number): number {
  if (a === Number.NEGATIVE_INFINITY) return b
  if (b === Number.NEGATIVE_INFINITY) return a
  const max = Math.max(a, b)
  const min = Math.min(a, b)
  return max + Math.log1p(Math.exp(min - max))
}

// ── Anytime-valid e-process (betting test-martingale) ────────────────

export interface EProcessOptions {
  /** Type-I error budget. The process decides when wealth ≥ 1/alpha
   *  (Ville's inequality). Default 0.05. */
  alpha?: number
  /** Truncation bound on the predictable bet λ ∈ [0, maxBet]. Must satisfy
   *  maxBet < 1/nullMean so every wealth factor stays strictly positive.
   *  Default 0.5. */
  maxBet?: number
  /** The null boundary m₀ for H0: E[x] ≤ m₀ on x ∈ [0,1]. Default 0.5
   *  (the paired-delta encoding x = (d+1)/2 maps "no effect" to 1/2).
   *  A pre-registered minEffect shifts this — see `sequentialPairedGate`. */
  nullMean?: number
}

export interface EProcessStep {
  /** Current wealth W_n — the e-value against H0 after n observations. */
  wealth: number
  /** Observations consumed so far. */
  n: number
  /** True from the first n where W_n ≥ 1/alpha onward (sticky). */
  decided: boolean
}

export interface EProcessState extends EProcessStep {
  alpha: number
  maxBet: number
  nullMean: number
  /** The decision boundary 1/alpha. */
  threshold: number
  /** Observation count at the first threshold crossing; undefined until decided. */
  decidedAtN?: number
}

export interface EProcess {
  /** Consume one observation x ∈ [0,1]. Throws on non-finite / out-of-range
   *  input — a silent clamp would corrupt the type-I guarantee. */
  update(x: number): EProcessStep
  state(): EProcessState
}

/**
 * Betting test-martingale for bounded observations — the e-process core of
 * anytime-valid sequential testing (Waudby-Smith & Ramdas, "Estimating means
 * of bounded random variables by betting", JRSS-B 2024).
 *
 * Observations x_i ∈ [0,1]; H0: E[x] ≤ m₀ (`nullMean`, default 1/2). Wealth
 *
 *   W_t = Π_{i≤t} (1 + λ_i (x_i − m₀)),  W_0 = 1
 *
 * with the truncated GROW-style plug-in bet computed from PRIOR observations:
 *
 *   λ_i = clamp((μ̂_{i−1} − m₀) / (σ̂²_{i−1} + (μ̂_{i−1} − m₀)²), 0, maxBet)
 *
 * where μ̂/σ̂² are the shrunk running estimates μ̂_t = (1/2 + Σx_i)/(t+1),
 * σ̂²_t = (1/4 + Σ(x_i − μ̂_i)²)/(t+1).
 *
 * PREDICTABILITY INVARIANT (load-bearing): λ_i is a function of x_1..x_{i−1}
 * ONLY — it may never see x_i. With λ_i ≥ 0 predictable, each factor has
 * E[1 + λ_i(x_i − m₀) | past] ≤ 1 under H0, so W is a nonnegative
 * supermartingale and Ville's inequality gives P(∃t: W_t ≥ 1/α) ≤ α — the
 * type-I guarantee holds at ANY data-dependent stopping time. λ_1 is always 0
 * (no prior evidence), so the first observation never moves wealth.
 *
 * `decided` latches at the first crossing W_t ≥ 1/α and never un-latches;
 * wealth keeps updating after the crossing (the e-process remains valid), but
 * the decision time is the first crossing.
 */
export function eProcess(opts: EProcessOptions = {}): EProcess {
  const alpha = opts.alpha ?? 0.05
  const maxBet = opts.maxBet ?? 0.5
  const nullMean = opts.nullMean ?? 0.5
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new ValidationError(`eProcess: alpha must be in (0,1), got ${alpha}`)
  }
  if (!Number.isFinite(nullMean) || nullMean <= 0 || nullMean >= 1) {
    throw new ValidationError(`eProcess: nullMean must be in (0,1), got ${nullMean}`)
  }
  if (!Number.isFinite(maxBet) || maxBet <= 0 || maxBet >= 1 / nullMean) {
    throw new ValidationError(
      `eProcess: maxBet must be in (0, 1/nullMean=${(1 / nullMean).toFixed(4)}) so wealth ` +
        `factors stay positive, got ${maxBet}`,
    )
  }
  const threshold = 1 / alpha
  let wealth = 1
  let n = 0
  let decided = false
  let decidedAtN: number | undefined
  // Running sums over observations consumed so far — read BEFORE folding in
  // the next x, so every bet is predictable.
  let sumX = 0
  let varSum = 0
  return {
    update(x: number): EProcessStep {
      if (typeof x !== 'number' || !Number.isFinite(x) || x < 0 || x > 1) {
        throw new ValidationError(
          `eProcess: observation must be a finite number in [0,1], got ${x}`,
        )
      }
      // λ from prior observations ONLY — x has not touched sumX/varSum yet.
      const muPrev = (0.5 + sumX) / (n + 1)
      const varPrev = (0.25 + varSum) / (n + 1)
      const edge = muPrev - nullMean
      const lambda = Math.min(maxBet, Math.max(0, edge / (varPrev + edge * edge)))
      wealth *= 1 + lambda * (x - nullMean)
      n += 1
      sumX += x
      const muNow = (0.5 + sumX) / (n + 1)
      varSum += (x - muNow) ** 2
      if (!decided && wealth >= threshold) {
        decided = true
        decidedAtN = n
      }
      return { wealth, n, decided }
    },
    state(): EProcessState {
      return { wealth, n, decided, alpha, maxBet, nullMean, threshold, decidedAtN }
    },
  }
}

// ── private rank-test helpers ────────────────────────────────────────

/** Every rank test refuses non-finite input. Beyond the arithmetic being
 *  undefined, the tie-grouping scan compares values with `===`, and
 *  `NaN === NaN` is false, so a NaN would leave the group boundary unable to
 *  advance and spin the loop forever. */
function assertFiniteSample(fn: string, label: string, xs: readonly number[]): void {
  for (let i = 0; i < xs.length; i++) {
    if (!Number.isFinite(xs[i])) {
      throw new ValidationError(`${fn}: ${label}[${i}] must be finite, got ${xs[i]}`)
    }
  }
}

/**
 * Average ranks over an ASCENDING-sorted array, plus `Σ(t³ − t)` over tie
 * groups of size `t` — the correction term both asymptotic rank-test variances
 * need.
 */
function midranksWithTieTerm(sorted: readonly number[]): { midranks: number[]; tieTerm: number } {
  const midranks = new Array<number>(sorted.length)
  let tieTerm = 0
  let i = 0
  while (i < sorted.length) {
    let j = i
    while (j < sorted.length && sorted[j] === sorted[i]) j++
    const average = (i + 1 + j) / 2
    for (let k = i; k < j; k++) midranks[k] = average
    const groupSize = j - i
    if (groupSize > 1) tieTerm += groupSize ** 3 - groupSize
    i = j
  }
  return { midranks, tieTerm }
}

function selectRankTestMethod(
  fn: string,
  request: RankTestMethodRequest,
  design: string,
  exactFeasible: boolean,
  designFloor: number,
  threshold: string,
): RankTestMethod {
  if (request === 'auto') return exactFeasible ? 'exact' : 'permutation'
  if (request === 'exact') {
    if (exactFeasible) return 'exact'
    throw new ValidationError(
      `${fn}: method 'exact' is out of range at ${design} — enumeration is bounded by ` +
        `${threshold}. Use 'auto' for the seeded Monte Carlo permutation, which converges ` +
        'to the same answer.',
    )
  }
  if (exactFeasible) {
    throw new ValidationError(
      `${fn}: method 'asymptotic' is refused at ${design} — the exact p-grid at this design ` +
        `starts at ${formatProbability(designFloor)}, so an asymptotic p below it describes no ` +
        `attainable outcome. Use method 'exact' (the default) or add repetitions past ` +
        `${threshold}.`,
    )
  }
  return 'asymptotic'
}

function resolvePermutations(fn: string, permutations: number | undefined): number {
  if (permutations === undefined) return DEFAULT_PERMUTATIONS
  if (!Number.isInteger(permutations) || permutations < 1) {
    throw new ValidationError(`${fn}: permutations must be a positive integer, got ${permutations}`)
  }
  return permutations
}

/** Two-sided normal-approximation tail with the continuity correction. */
function asymptoticTwoSidedP(deviation: number, sigma: number): number {
  if (!(sigma > 0)) return 1
  return Math.min(1, 2 * (1 - normalCdf(Math.max(0, deviation - 0.5) / sigma)))
}

/** SD of U under the permutation null, corrected for the realised ties. The
 *  tie term reduces (N+1) and reaches it exactly when every value is tied, so
 *  the variance floors at 0 rather than going negative. */
function twoSampleSigma(n1: number, n2: number, total: number, tieTerm: number): number {
  if (total < 2) return 0
  const variance = ((n1 * n2) / 12) * (total + 1 - tieTerm / (total * (total - 1)))
  return Math.sqrt(Math.max(0, variance))
}

function logChoose(n: number, k: number): number {
  return lnGamma(n + 1) - lnGamma(k + 1) - lnGamma(n - k + 1)
}

function formatProbability(value: number): string {
  return value >= 1e-4 || value === 0 ? value.toFixed(4) : value.toExponential(3)
}

/**
 * Exact DP allocation and loop count for this observed rank vector.
 *
 * The smaller arm is sufficient because selecting its complement produces the
 * same two-sided U deviation while using fewer rows in the state table.
 */
function exactTwoSampleCost(
  doubledRanks: readonly number[],
  selectedN: number,
): { states: number; work: number } {
  const maxSum = doubledRanks.reduce((sum, rank) => sum + rank, 0)
  let work = 0
  for (let placed = 0; placed < doubledRanks.length; placed++) {
    work += Math.min(selectedN, placed + 1) * (maxSum - doubledRanks[placed]! + 1)
  }
  return {
    states: (selectedN + 1) * (maxSum + 1),
    work,
  }
}

/**
 * Smallest attainable two-sided p under the observed ties.
 *
 * Only subsets with the minimum or maximum rank sum can attain the largest
 * deviation. Their multiplicity is the number of ways to choose within the
 * tie group at each boundary, so this calculation is exact without allocating
 * the full null distribution.
 */
function exactTwoSampleFloor(doubledRanks: readonly number[], selectedN: number): number {
  const total = doubledRanks.length
  const otherN = total - selectedN
  const minimumSum = doubledRanks.slice(0, selectedN).reduce((sum, rank) => sum + rank, 0)
  const maximumSum = doubledRanks.slice(total - selectedN).reduce((sum, rank) => sum + rank, 0)
  if (minimumSum === maximumSum) return 1

  const centre = selectedN * (selectedN + 1) + selectedN * otherN
  const minimumDeviation = Math.abs(minimumSum - centre)
  const maximumDeviation = Math.abs(maximumSum - centre)
  const totalLogWays = logChoose(total, selectedN)
  const minimumMass = Math.exp(
    logExtremeSubsetWays(doubledRanks, selectedN, 'minimum') - totalLogWays,
  )
  const maximumMass = Math.exp(
    logExtremeSubsetWays(doubledRanks, selectedN, 'maximum') - totalLogWays,
  )

  if (minimumDeviation > maximumDeviation) return minimumMass
  if (maximumDeviation > minimumDeviation) return maximumMass
  return Math.min(1, minimumMass + maximumMass)
}

function logExtremeSubsetWays(
  sortedRanks: readonly number[],
  selectedN: number,
  side: 'minimum' | 'maximum',
): number {
  const boundaryIndex = side === 'minimum' ? selectedN - 1 : sortedRanks.length - selectedN
  const boundary = sortedRanks[boundaryIndex]!
  let first = boundaryIndex
  let afterLast = boundaryIndex + 1
  while (first > 0 && sortedRanks[first - 1] === boundary) first--
  while (afterLast < sortedRanks.length && sortedRanks[afterLast] === boundary) afterLast++

  const tieSize = afterLast - first
  const fixed = side === 'minimum' ? first : sortedRanks.length - afterLast
  return logChoose(tieSize, selectedN - fixed)
}

/**
 * Exact conditional two-sided p for the two-sample rank test.
 *
 * Convolves the observed doubled midranks into the null distribution of group
 * a's rank sum over every `C(n₁+n₂, n₁)` split — identical to enumerating the
 * splits, but `O(N·n₁·ΣR)` instead of `O(C(N,n₁)·n₁n₂)`. Conditioning on the
 * realised multiset makes the tie handling exact rather than a correction.
 *
 * The null is symmetric about `n₁n₂/2` (negating every value maps `U → n₁n₂ −
 * U` and permutes the split set onto itself), so the two-sided p is the mass
 * at least as far from the centre as the observation.
 */
function exactTwoSampleP(
  doubledRanks: readonly number[],
  n1: number,
  n2: number,
  doubledDeviation: number,
): { p: number; pFloor: number } {
  const maxSum = doubledRanks.reduce((sum, rank) => sum + rank, 0)
  const width = maxSum + 1
  // ways[k][s] = number of size-k subsets whose doubled rank sum is s.
  const ways: Float64Array[] = Array.from({ length: n1 + 1 }, () => new Float64Array(width))
  ways[0]![0] = 1
  let placed = 0
  for (const rank of doubledRanks) {
    for (let k = Math.min(n1, placed + 1); k >= 1; k--) {
      const from = ways[k - 1]!
      const into = ways[k]!
      for (let sum = maxSum - rank; sum >= 0; sum--) {
        const count = from[sum]!
        if (count !== 0) into[sum + rank]! += count
      }
    }
    placed++
  }

  // U = rankSum − n₁(n₁+1)/2, so doubled U = s − n₁(n₁+1), and the doubled
  // centre 2·(n₁n₂/2) is n₁n₂.
  const shift = n1 * (n1 + 1) + n1 * n2
  const chosen = ways[n1]!
  let totalWays = 0
  let extremeWays = 0
  let tailWays = 0
  let maxDeviation = -1
  for (let sum = 0; sum < width; sum++) {
    const count = chosen[sum]!
    if (count === 0) continue
    totalWays += count
    const deviation = Math.abs(sum - shift)
    if (deviation >= doubledDeviation) tailWays += count
    if (deviation > maxDeviation) {
      maxDeviation = deviation
      extremeWays = count
    } else if (deviation === maxDeviation) {
      extremeWays += count
    }
  }
  return { p: tailWays / totalWays, pFloor: extremeWays / totalWays }
}

/**
 * Exact conditional two-sided p for the paired signed-rank test.
 *
 * Convolves the observed doubled absolute midranks over all `2ⁿ` sign
 * assignments in `O(n·ΣR)`. Probabilities rather than counts keep `2ⁿ` off the
 * arithmetic. The null is symmetric about `n(n+1)/4`.
 */
function exactSignedRankP(
  doubledRanks: readonly number[],
  doubledDeviation: number,
): { p: number; pFloor: number } {
  const maxSum = doubledRanks.reduce((sum, rank) => sum + rank, 0)
  const width = maxSum + 1
  let mass = new Float64Array(width)
  mass[0] = 1
  for (const rank of doubledRanks) {
    const next = new Float64Array(width)
    for (let sum = 0; sum < width; sum++) {
      const probability = mass[sum]!
      if (probability === 0) continue
      next[sum]! += probability * 0.5
      next[sum + rank]! += probability * 0.5
    }
    mass = next
  }

  const centre = maxSum / 2
  let tail = 0
  let extreme = 0
  let maxDeviation = -1
  for (let sum = 0; sum < width; sum++) {
    const probability = mass[sum]!
    if (probability === 0) continue
    const deviation = Math.abs(sum - centre)
    if (deviation >= doubledDeviation) tail += probability
    if (deviation > maxDeviation) {
      maxDeviation = deviation
      extreme = probability
    } else if (deviation === maxDeviation) {
      extreme += probability
    }
  }
  return { p: Math.min(1, tail), pFloor: Math.min(1, extreme) }
}

// ── private stats helpers ────────────────────────────────────────────

/** Standard-normal inverse CDF (Acklam approximation). */
function zQuantile(p: number): number {
  if (p <= 0 || p >= 1) {
    if (p === 0) return -Infinity
    if (p === 1) return Infinity
    return NaN
  }
  const a = [
    -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2, 1.38357751867269e2,
    -3.066479806614716e1, 2.506628277459239,
  ]
  const b = [
    -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2, 6.680131188771972e1,
    -1.328068155288572e1,
  ]
  const c = [
    -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838, -2.549732539343734,
    4.374664141464968, 2.938163982698783,
  ]
  const d = [7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996, 3.754408661907416]
  const pLow = 0.02425
  const pHigh = 1 - pLow
  let q: number
  let r: number
  if (p < pLow) {
    q = Math.sqrt(-2 * Math.log(p))
    return (
      (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
      ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
    )
  }
  if (p <= pHigh) {
    q = p - 0.5
    r = q * q
    return (
      ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) /
      (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1)
    )
  }
  q = Math.sqrt(-2 * Math.log(1 - p))
  return (
    -(((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) /
    ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1)
  )
}

function medianInPlace(xs: number[]): number {
  if (xs.length === 0) return 0
  xs.sort((a, b) => a - b)
  const mid = Math.floor(xs.length / 2)
  return xs.length % 2 === 0 ? (xs[mid - 1]! + xs[mid]!) / 2 : xs[mid]!
}

/**
 * PRNG for every resampling path in this module.
 *
 * With no caller seed the seed is DERIVED FROM THE DATA rather than taken from
 * `Math.random`, so re-running the same input reproduces the same interval —
 * a gate verdict that cannot be re-derived is not evidence. Distinct data
 * still gets a distinct stream. Same pattern as `promotion-gate.ts`.
 */
function makeRng(
  seed: number | undefined,
  ...series: readonly (readonly number[])[]
): () => number {
  return mulberry32(seed ?? seedFromData(series))
}

/** FNV-1a over the IEEE-754 bytes of every observation. */
function seedFromData(series: readonly (readonly number[])[]): number {
  const view = new DataView(new ArrayBuffer(8))
  let hash = 0x811c9dc5
  for (const xs of series) {
    for (const x of xs) {
      view.setFloat64(0, x)
      for (let byte = 0; byte < 8; byte++) {
        hash = Math.imul(hash ^ view.getUint8(byte), 0x01000193)
      }
    }
    // Separator, so ([1],[2]) and ([1,2],[]) do not collide.
    hash = Math.imul(hash ^ 0xff, 0x01000193)
  }
  return hash | 0
}

/** Order-independent seed for a symmetric two-sample statistic. */
function symmetricTwoSampleSeed(a: readonly number[], b: readonly number[]): number {
  const sortedA = [...a].sort((left, right) => left - right)
  const sortedB = [...b].sort((left, right) => left - right)
  const forward = seedFromData([sortedA, sortedB]) >>> 0
  const reversed = seedFromData([sortedB, sortedA]) >>> 0
  return Math.min(forward, reversed)
}

/** Tiny seedable PRNG (mulberry32) — deterministic resampling/shuffling, not
 *  cryptographic. Exported so e-process shuffles and bootstrap resampling
 *  share ONE PRNG implementation. Every distinct 32-bit seed gives a distinct
 *  stream, including 0. */
export function mulberry32(seed: number): () => number {
  if (!Number.isFinite(seed)) {
    throw new ValidationError(`mulberry32: seed must be a finite number, got ${seed}`)
  }
  let s = seed | 0
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
