import { ValidationError } from './errors'
import {
  type ContinuousAgreement,
  type ContinuousAgreementOptions,
  continuousAgreement,
} from './judge-calibration'
import { normalCdf } from './math/normal'
import { lnGamma, regularizedIncompleteBeta } from './math/special-functions'
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

/** Bootstrap confidence interval */
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
  const rng = makeRng(opts.seed)
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
 * Inter-rater reliability — simplified Krippendorff's alpha.
 *
 * Each inner array is one judge's scores for all items.
 * All arrays must have the same length (same items scored).
 */
export function interRaterReliability(judgeScores: JudgeScore[][]): number {
  if (judgeScores.length < 2) return 1

  // Group scores by dimension across judges
  const dimensionMap = new Map<string, number[][]>()
  for (const judgeSet of judgeScores) {
    for (const s of judgeSet) {
      if (!dimensionMap.has(s.dimension)) dimensionMap.set(s.dimension, [])
      const arr = dimensionMap.get(s.dimension)!
      if (arr.length === 0 || arr[arr.length - 1]!.length >= judgeScores.length) {
        arr.push([s.score])
      } else {
        arr[arr.length - 1]!.push(s.score)
      }
    }
  }

  // Collect all paired ratings
  const allValues: number[] = []
  const pairDiffs: number[] = []

  for (const items of dimensionMap.values()) {
    for (const ratings of items) {
      if (ratings.length < 2) continue
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

/**
 * Mann-Whitney U test for comparing two independent groups.
 * Returns U statistic and approximate p-value (normal approximation).
 */
export function mannWhitneyU(a: number[], b: number[]): { u: number; p: number } {
  if (a.length === 0 || b.length === 0) return { u: 0, p: 1 }

  const n1 = a.length
  const n2 = b.length

  // Rank all values together
  const combined = [
    ...a.map((v) => ({ v, group: 'a' as const })),
    ...b.map((v) => ({ v, group: 'b' as const })),
  ].sort((x, y) => x.v - y.v)

  // Assign ranks with tie handling
  const ranks: number[] = new Array(combined.length)
  let i = 0
  while (i < combined.length) {
    let j = i
    while (j < combined.length && combined[j]!.v === combined[i]!.v) j++
    const avgRank = (i + 1 + j) / 2
    for (let k = i; k < j; k++) ranks[k] = avgRank
    i = j
  }

  // Sum ranks for group a
  let r1 = 0
  for (let k = 0; k < combined.length; k++) {
    if (combined[k]!.group === 'a') r1 += ranks[k]!
  }

  const u1 = r1 - (n1 * (n1 + 1)) / 2
  const u2 = n1 * n2 - u1
  const u = Math.min(u1, u2)

  // Normal approximation for p-value
  const mu = (n1 * n2) / 2
  const sigma = Math.sqrt((n1 * n2 * (n1 + n2 + 1)) / 12)

  if (sigma === 0) return { u, p: 1 }

  const z = Math.abs(u - mu) / sigma
  // Two-tailed p-value from z-score (approximation)
  const p = 2 * (1 - normalCdf(z))

  return { u, p }
}

/** Partial credit: returns 0-1 ratio of current toward target */
export function partialCredit(current: number, target: number): number {
  if (target <= 0) return 1
  return Math.min(1, Math.max(0, current / target))
}

/**
 * Paired t-test — before/after measurements on the SAME items.
 * Pairing removes inter-item variance, giving tighter significance than
 * an unpaired test when comparing prompt v1 vs prompt v2 on identical
 * scenarios.
 */
export function pairedTTest(
  before: number[],
  after: number[],
): { t: number; df: number; p: number } {
  if (before.length !== after.length) {
    throw new ValidationError(
      `pairedTTest: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  const n = before.length
  if (n < 2) return { t: 0, df: 0, p: 1 }

  const diffs = before.map((b, i) => after[i]! - b)
  const mean = diffs.reduce((a, b) => a + b, 0) / n
  const variance = diffs.reduce((acc, d) => acc + (d - mean) ** 2, 0) / (n - 1)
  const se = Math.sqrt(variance / n)
  if (se === 0) return { t: mean === 0 ? 0 : Infinity, df: n - 1, p: mean === 0 ? 1 : 0 }

  const t = mean / se
  const df = n - 1
  const p = 2 * (1 - studentTCdf(Math.abs(t), df))
  return { t, df, p }
}

/**
 * Wilcoxon signed-rank test — paired non-parametric alternative.
 * Use when the differences aren't normally distributed.
 */
export function wilcoxonSignedRank(before: number[], after: number[]): { w: number; p: number } {
  if (before.length !== after.length) {
    throw new ValidationError(
      `wilcoxonSignedRank: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  const diffs = before.map((b, i) => after[i]! - b).filter((d) => d !== 0)
  const n = diffs.length
  if (n < 6) return { w: 0, p: 1 }

  const absRanks = diffs
    .map((d, i) => ({ abs: Math.abs(d), sign: Math.sign(d), i }))
    .sort((a, b) => a.abs - b.abs)
  const ranks: number[] = new Array(n)
  let i = 0
  while (i < n) {
    let j = i
    while (j < n && absRanks[j]!.abs === absRanks[i]!.abs) j++
    const avg = (i + 1 + j) / 2
    for (let k = i; k < j; k++) ranks[absRanks[k]!.i] = avg
    i = j
  }
  let wPlus = 0
  for (let k = 0; k < n; k++) if (diffs[k]! > 0) wPlus += ranks[k]!

  const mean = (n * (n + 1)) / 4
  const variance = (n * (n + 1) * (2 * n + 1)) / 24
  const z = (wPlus - mean) / Math.sqrt(variance)
  const p = 2 * (1 - normalCdf(Math.abs(z)))
  return { w: wPlus, p }
}

/**
 * Cohen's d — standardized effect size for two independent groups.
 * Positive d means group b has higher mean than group a.
 * Rule of thumb: |d| < 0.2 negligible, 0.2–0.5 small, 0.5–0.8 medium, > 0.8 large.
 */
export function cohensD(a: number[], b: number[]): number {
  if (a.length < 2 || b.length < 2) return 0
  const meanA = a.reduce((x, y) => x + y, 0) / a.length
  const meanB = b.reduce((x, y) => x + y, 0) / b.length
  const varA = a.reduce((acc, x) => acc + (x - meanA) ** 2, 0) / (a.length - 1)
  const varB = b.reduce((acc, x) => acc + (x - meanB) ** 2, 0) / (b.length - 1)
  const pooled = Math.sqrt(
    ((a.length - 1) * varA + (b.length - 1) * varB) / (a.length + b.length - 2),
  )
  if (pooled === 0) return 0
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

/** Bonferroni adjustment: multiply every p-value by the test count, clamp at 1. */
export function bonferroni(
  pValues: number[],
  alpha = 0.05,
): { adjusted: number[]; significant: boolean[] } {
  const k = pValues.length
  const adjusted = pValues.map((p) => Math.min(1, p * k))
  const significant = adjusted.map((p) => p < alpha)
  return { adjusted, significant }
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
  if (!Number.isFinite(alpha) || alpha <= 0 || alpha >= 1) {
    throw new ValidationError(`holm: alpha must be in (0,1), got ${alpha}`)
  }
  for (const [index, pValue] of pValues.entries()) {
    if (!Number.isFinite(pValue) || pValue < 0 || pValue > 1) {
      throw new ValidationError(`holm: pValues[${index}] must be in [0,1], got ${pValue}`)
    }
  }
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
 */
export function benjaminiHochberg(
  pValues: number[],
  fdr = 0.05,
): { qValues: number[]; significant: boolean[] } {
  const n = pValues.length
  if (n === 0) return { qValues: [], significant: [] }
  const indexed = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const q = new Array<number>(n)
  let minRight = 1
  for (let k = n - 1; k >= 0; k--) {
    const rank = k + 1
    const entry = indexed[k]!
    const raw = (entry.p * n) / rank
    const bounded = Math.min(minRight, raw)
    minRight = bounded
    q[entry.i] = Math.min(1, bounded)
  }
  const significant = q.map((v) => v < fdr)
  return { qValues: q, significant }
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
}

export interface PairedBootstrapOptions {
  /** Confidence level. Default 0.95. */
  confidence?: number
  /** Bootstrap resample count. Default 2000. */
  resamples?: number
  /** Statistic to bootstrap. Default 'median'. */
  statistic?: 'median' | 'mean'
  /** Deterministic seed. If omitted, uses Math.random(). */
  seed?: number
}

/**
 * Paired bootstrap on (after − before) deltas. Returns a CI on the chosen
 * statistic (median by default); pairs are resampled with replacement. The
 * lower bound is what the promotion gate checks — `low > threshold` means the
 * gain is real at the confidence level. Throws on unequal sample sizes.
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
  if (n === 0) {
    return { n: 0, median: 0, mean: 0, low: 0, high: 0, confidence, resamples }
  }
  if (n === 1) {
    const d = deltas[0]!
    return { n: 1, median: d, mean: d, low: d, high: d, confidence, resamples }
  }

  const rng = makeRng(opts.seed)
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

/**
 * Are these per-item outcomes binary (every value exactly 0 or 1)?
 *
 * The discriminator a promotion gate needs before choosing a paired statistic.
 * On binary outcomes the paired delta vector lives in {-1, 0, +1} and is
 * normally dominated by zeros (both arms solve, or both arms miss, most items),
 * so its MEDIAN is pinned at exactly 0 no matter how large the real shift in
 * success rate is — and a bootstrap CI on that median collapses to [0, 0].
 * A gate keying on `ci.low > threshold` is then structurally unable to see
 * either a gain or a regression. Detect this shape and switch to the
 * paired-binary estimators ({@link mcnemar}, {@link pairedRiskDifference})
 * instead of silently answering "no" forever.
 *
 * Empty input is NOT binary: there is no evidence of the outcome's shape, and
 * defaulting an empty vector into the binary branch would pick a statistic on
 * no data at all.
 *
 * NOT the right discriminator for a gate. It recognises the literal {0, 1}
 * encoding and nothing else, so a pass/fail dimension emitted on 0-100 — which
 * judges in this codebase do routinely — reads as non-binary, and a single
 * partial-credit score in an otherwise pass/fail vector flips it to false while
 * leaving the median just as blind. Gates want {@link pairedBinaryScale} (any
 * two-point encoding). This predicate remains for callers that specifically
 * mean "literally 0/1".
 */
export function isBinaryOutcomeVector(values: ArrayLike<number>): boolean {
  if (values.length === 0) return false
  for (let i = 0; i < values.length; i++) {
    const v = values[i]!
    if (v !== 0 && v !== 1) return false
  }
  return true
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
 *
 * REPORTING ONLY — do NOT decide a promotion on this interval. The CI is a Wald
 * normal approximation, which badly UNDERCOVERS when only a handful of pairs are
 * discordant: at n = 3 with b = 2, c = 0 it returns [0.133, 1.000], excluding 0,
 * while McNemar's exact test on the same data gives p = 0.50. A gate keying on
 * `lower > 0` would promote noise. Decisions belong to
 * {@link empiricalLikelihoodMeanInterval} (the interval) and
 * {@link signFlipMeanTest} (the test); see their notes for the measured reason.
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

/** A paired binary effect size with an EXACT interval and the exact test that
 *  bounds it — one object so a caller cannot read the estimate without the
 *  significance it is entitled to. */
export interface ExactRiskDifferenceResult {
  /** Total paired observations. */
  n: number
  /** Discordant pairs: treatment-win count. */
  b: number
  /** Discordant pairs: control-win count. */
  c: number
  /** Discordant pairs (b + c) — the only ones carrying information. */
  nDiscordant: number
  /** Paired risk difference p(treatment) − p(control) = (b − c) / n. */
  riskDifference: number
  /** Exact conditional CI lower bound. 0 when there are no discordant pairs. */
  lower: number
  /** Exact conditional CI upper bound. 0 when there are no discordant pairs. */
  upper: number
  /** Confidence level used. */
  confidence: number
  /** McNemar's exact two-sided p-value on the same discordant counts. */
  pValue: number
}

/**
 * Paired risk difference with the EXACT CONDITIONAL interval.
 *
 * VALID AS A TEST OF RD = 0. NOT A CONFIDENCE INTERVAL AT A NONZERO MARGIN, so
 * a gate must not decide `lower > θ` on it for θ ≠ 0. Conditioning on m throws
 * away the sampling variability of m/n itself, and at a nonzero margin that
 * variability is most of the answer. Measured, 2000 replications at the exact
 * boundary (n = 76, P(candidate-only win) = 0, P(baseline-only loss) = 0.05, so
 * the true RD is exactly the margin −0.05, nominal 95%): this interval clears
 * the margin in 44.8% of samples — a decision that is wrong nine times more
 * often than it claims. It does not improve with n: 44.8% again at n = 200.
 * {@link empiricalLikelihoodMeanInterval} is 0.0% / 2.2% on the same two
 * simulations and is what {@link empiricalLikelihoodMeanInterval}'s callers
 * decide on. (Reported by review on PR #457, 2026-07-28; reproduced in
 * `probe/r3-interval-bakeoff.mts`.)
 *
 * Conditional on the number of discordant pairs m = b + c, the treatment-win
 * count b is Binomial(m, π) with π = P(treatment wins | discordant), and the
 * risk difference is an exact reparameterisation: RD = (2π − 1)·m/n. So a
 * Clopper-Pearson exact interval for π maps straight onto RD. This buys the
 * property the Wald interval in {@link pairedRiskDifference} does not have:
 *
 *   **`lower > 0` ⟺ McNemar's exact test rejects at α = 1 − confidence.**
 *
 * Clopper-Pearson excludes π = 0.5 exactly when the two-sided exact binomial
 * test of π = 0.5 rejects, and that test IS {@link mcnemar}'s p-value — so the
 * interval and the test can never disagree, and a gate keyed on `lower` cannot
 * promote what the exact test refuses. The exact p is returned in the same
 * object so the two are impossible to compute apart.
 *
 * The interval is conservative (exact intervals over-cover; conditioning on m
 * discards the concordant pairs' information about m itself). That is the
 * correct direction for a promotion gate: it refuses more often, never less.
 *
 * With m = 0 there are no discordant pairs and π is not identified: the result
 * is the degenerate [0, 0] with p = 1. That is NOT evidence of equivalence —
 * callers must treat a zero-width interval as "cannot decide", not as "no
 * difference". Inputs are paired 0/1 (or boolean) arrays, control first.
 * Throws on unequal lengths.
 */
export function pairedRiskDifferenceExact(
  control: ArrayLike<number | boolean>,
  treatment: ArrayLike<number | boolean>,
  confidence = 0.95,
): ExactRiskDifferenceResult {
  if (control.length !== treatment.length) {
    throw new Error(
      `pairedRiskDifferenceExact: unequal sample sizes (${control.length} vs ${treatment.length})`,
    )
  }
  if (confidence <= 0 || confidence >= 1) {
    throw new Error(`pairedRiskDifferenceExact: confidence must be in (0,1), got ${confidence}`)
  }
  const n = control.length
  if (n === 0) {
    return {
      n: 0,
      b: 0,
      c: 0,
      nDiscordant: 0,
      riskDifference: 0,
      lower: 0,
      upper: 0,
      confidence,
      pValue: 1,
    }
  }
  let b = 0
  let c = 0
  for (let i = 0; i < n; i++) {
    const ctrl = control[i] ? 1 : 0
    const treat = treatment[i] ? 1 : 0
    if (treat === 1 && ctrl === 0) b++
    else if (treat === 0 && ctrl === 1) c++
  }
  const m = b + c
  const riskDifference = (b - c) / n
  const pValue = binomialSignTwoSided(b, c)
  if (m === 0) {
    return { n, b, c, nDiscordant: 0, riskDifference: 0, lower: 0, upper: 0, confidence, pValue }
  }
  const alpha = 1 - confidence
  const piLow = b === 0 ? 0 : betaQuantile(alpha / 2, b, m - b + 1)
  const piHigh = b === m ? 1 : betaQuantile(1 - alpha / 2, b + 1, m - b)
  const scale = m / n
  return {
    n,
    b,
    c,
    nDiscordant: m,
    riskDifference,
    lower: Math.max(-1, (2 * piLow - 1) * scale),
    upper: Math.min(1, (2 * piHigh - 1) * scale),
    confidence,
    pValue,
  }
}

/**
 * A 99.9%-style upper confidence bound on the success rate of a Binomial(n, p)
 * that produced `successes`, via the Chernoff/KL tail bound
 * `P(X ≤ k) ≤ exp(−n·KL(k/n ‖ p))`. Solved for the largest p whose lower tail at
 * `successes` is still above `1 − confidence`.
 *
 * Deliberately arithmetic-only. The obvious route — a Clopper-Pearson bound via
 * {@link regularizedIncompleteBeta} — is unusable here: that continued fraction
 * has no symmetry swap, so at the parameters this needs (a = 1, b = 10000) it
 * UNDERFLOWS AND RETURNS 0 for x ≥ ~0.5 rather than 1, and the inverse then
 * walks the wrong way and answers ~1 for every input. Measured: it turned a
 * clearly-significant Monte-Carlo p of 1e-4 into an upper bound of 1.0, which
 * would have refused every Monte-Carlo promotion. (That defect is real and
 * pre-existing; PR #458 repairs the beta function itself with a cross-checked
 * oracle. This function does not depend on it either way.)
 *
 * The KL bound is a little conservative relative to Clopper-Pearson (0.0527 vs
 * 0.0514 at 450/10000), which is the correct direction for a veto.
 */
function binomialRateUpperBound(successes: number, n: number, confidence: number): number {
  if (n <= 0) return 1
  const q = successes / n
  if (q >= 1) return 1
  const budget = -Math.log(1 - confidence) / n
  const kl = (p: number): number => {
    if (p >= 1) return Number.POSITIVE_INFINITY
    const a = q === 0 ? 0 : q * Math.log(q / p)
    const b = (1 - q) * Math.log((1 - q) / (1 - p))
    return a + b
  }
  let lo = q
  let hi = 1
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (kl(mid) < budget) lo = mid
    else hi = mid
  }
  return Math.min(1, (lo + hi) / 2)
}

/** Inverse regularized incomplete beta by bisection on
 *  {@link regularizedIncompleteBeta},
 *  which is monotone increasing in x. 80 halvings of [0,1] resolve well past the
 *  continued fraction's own ~3e-7 accuracy, so the quantile is as exact as the
 *  CDF it inverts. */
function betaQuantile(p: number, a: number, b: number): number {
  if (p <= 0) return 0
  if (p >= 1) return 1
  let lo = 0
  let hi = 1
  for (let i = 0; i < 80; i++) {
    const mid = (lo + hi) / 2
    if (regularizedIncompleteBeta(mid, a, b) < p) lo = mid
    else hi = mid
  }
  return (lo + hi) / 2
}

/**
 * The common positive level `s` such that EVERY value across both paired arms is
 * exactly 0 or `s` — i.e. the outcome is pass/fail, whatever encoding it arrived
 * in. Returns null when the outcomes are not two-point, when the two arms use
 * different levels, or when no positive value was observed at all (all-zero
 * arms: the level is not identified, and there is nothing to decide anyway).
 *
 * This is the scale-aware successor to {@link isBinaryOutcomeVector}, which only
 * recognises literal {0, 1}. Judges in this codebase emit dimensions on 0-100 as
 * well as [0,1] (see `detectScale` in `campaign/gates/statistical-heldout.ts`),
 * so a pass/fail dimension routinely arrives as {0, 100} and a {0,1}-only test
 * silently sends it down the median path that cannot see it. Any positive level
 * is accepted, not just 1 and 100: for a two-point {0, s} outcome the mean paired
 * delta is exactly s·(b − c)/n, so the binary estimators apply after dividing by
 * s and rescaling the result back into the caller's native units.
 *
 * Non-finite values ⇒ null: an unusable outcome must not be classified as a
 * clean pass/fail shape.
 *
 * DESCRIPTIVE ONLY — NOT a discriminator a decision may branch on. It reads the
 * VALUES, so it is not invariant to adding the same constant to both arms:
 * {0, 1} is recognised and {⅔, 1} — the same evidence shifted by ⅔, and the
 * shape `bench/rung2` actually produces — is not. A gate that routes on it
 * answers differently depending on whether a zero happens to appear in the data.
 * Measured: 4 pairs improving by ⅓ out of 26, threshold 0, all defaults —
 * refused at offset 0, promoted at offsets ⅓, ⅔, 1 and 10, with byte-identical
 * paired deltas in all five (`probe/r3-ground-truth.mts`, D1). Decisions key on
 * the paired DELTAS, which no shift can change: {@link pairedDeltaMagnitude},
 * {@link signFlipMeanTest}, {@link empiricalLikelihoodMeanInterval}.
 */
export function pairedBinaryScale(
  before: ArrayLike<number>,
  after: ArrayLike<number>,
): number | null {
  let level: number | null = null
  for (const arm of [before, after]) {
    for (let i = 0; i < arm.length; i++) {
      const v = arm[i]!
      if (!Number.isFinite(v)) return null
      if (v === 0) continue
      if (v < 0) return null
      if (level === null) level = v
      else if (v !== level) return null
    }
  }
  return level
}

/** Fraction of paired observations whose delta is an exact tie (|after − before|
 *  < 1e-9). Throws on unequal sample sizes; 0 pairs ⇒ 0. */
export function pairedDeltaTieFraction(
  before: ArrayLike<number>,
  after: ArrayLike<number>,
): number {
  if (before.length !== after.length) {
    throw new Error(
      `pairedDeltaTieFraction: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  const n = before.length
  if (n === 0) return 0
  let ties = 0
  for (let i = 0; i < n; i++) {
    if (Math.abs(after[i]! - before[i]!) < 1e-9) ties++
  }
  return ties / n
}

/**
 * A paired delta smaller than this in absolute value counts as an exact tie, and
 * a delta vector whose whole SPREAD is under it carries no variation at all.
 *
 * One constant, shared by every delta-shape routine here and re-exported for the
 * gates, so "tied" cannot come to mean two different things in two places. It
 * has to be a tolerance and not `=== 0`: recomputing the same deltas after
 * adding a constant to both arms perturbs them by ~1e-16, and an exact-zero test
 * turns that float dust into a different verdict — which is the same
 * value-dependence this whole module exists to remove.
 */
export const PAIRED_DELTA_TIE_EPSILON = 1e-9

/**
 * The single magnitude `d > 0` such that every non-tied paired delta is exactly
 * `+d` or `−d`, or null when the non-tied deltas carry more than one magnitude
 * (or there are none, or any value is non-finite).
 *
 * This is the SHIFT-INVARIANT statement of "the outcome is pass/fail". A
 * two-point outcome on levels {a, b} produces deltas in {−(b−a), 0, +(b−a)}
 * whatever `a` is, so {0,1}, {0,100}, {⅔,1} and {10, 10⅓} all return their step
 * and all get identical treatment — which is the property
 * {@link pairedBinaryScale} does not have, because it reads the levels and
 * therefore needs a zero to be present.
 *
 * Nothing ROUTES on this: it is reported as evidence, and it is the condition
 * under which {@link signFlipMeanTest} coincides exactly with McNemar's exact
 * test, so a caller can see why the two p-values agree. Comparison of
 * magnitudes is relative (1e-9), so a delta recomputed after an additive shift
 * still groups with its unshifted self.
 */
export function pairedDeltaMagnitude(
  before: ArrayLike<number>,
  after: ArrayLike<number>,
): number | null {
  if (before.length !== after.length) {
    throw new Error(
      `pairedDeltaMagnitude: unequal sample sizes (${before.length} vs ${after.length})`,
    )
  }
  let magnitude: number | null = null
  for (let i = 0; i < before.length; i++) {
    const b = before[i]!
    const a = after[i]!
    if (!Number.isFinite(b) || !Number.isFinite(a)) return null
    const abs = Math.abs(a - b)
    if (abs < PAIRED_DELTA_TIE_EPSILON) continue
    if (magnitude === null) magnitude = abs
    else if (Math.abs(abs - magnitude) > 1e-9 * Math.max(abs, magnitude)) return null
  }
  return magnitude
}

/** Outcome of {@link signFlipMeanTest}. */
export interface SignFlipTestResult {
  /** Two-sided p-value for H0 "the candidate changed nothing": each paired delta
   *  is as likely to have come out `+δ` as `−δ`. Exact, or a valid Monte-Carlo
   *  p-value — never an asymptotic approximation. */
  pValue: number
  /** The number a DECISION must use. Equal to `pValue` when the test is exact.
   *  When it is Monte-Carlo, a 99.9% upper confidence bound on the true p-value
   *  given the draws — so a verdict is never the luck of the draw landing a hair
   *  under α. Costs a little power within ~0.007 of α and nothing elsewhere. */
  pValueUpperBound: number
  /** `'exact'` = the whole sign-flip distribution was enumerated.
   *  `'monte_carlo'` = estimated from `resamples` sign draws with the
   *  add-one correction, which keeps P(p ≤ α | H0) ≤ α exactly. */
  method: 'exact' | 'monte_carlo'
  /** Sign draws used, or null when exact. */
  resamples: number | null
  /** Pairs where the candidate scored higher / lower / the same. */
  improved: number
  worsened: number
  tied: number
}

/**
 * Exact sign-flip (paired permutation) test on the MEAN paired delta — the
 * significance test a promotion gate can apply to ANY outcome shape.
 *
 * Under "the candidate changed nothing" the sign of each paired delta is
 * exchangeable, so the null distribution of the total Σδ is the 2^m equiprobable
 * sign assignments of the non-tied deltas; the two-sided p is the mass at least
 * as extreme as the observed total. Three properties are why the gate keys on
 * this and not on a shape-specific test:
 *
 *  1. TOTAL. Defined for every real delta vector. There is no shape it declines
 *     to judge, so there is no branch on which a promotion goes unchecked.
 *  2. SHIFT-INVARIANT. It reads only the deltas.
 *  3. IT SUBSUMES McNemar. When every non-tied delta has the same magnitude
 *     (see {@link pairedDeltaMagnitude}) — which is exactly the paired-binary
 *     case on any encoding — the distribution of Σδ is `d·(2B − m)` with
 *     `B ~ Binomial(m, ½)`, so `pValue` equals {@link mcnemar}'s exact p-value
 *     to the last bit. The binary test is a derived special case, not a
 *     separately-maintained branch that a new encoding can miss.
 *
 * Unlike the sign test it weights by magnitude, so a real mean lift carried by a
 * minority of large improvements is not thrown away.
 *
 * Exactness: the null distribution is a convolution of one Binomial per DISTINCT
 * delta magnitude, so it is enumerated exactly whenever the product of
 * (count + 1) over distinct magnitudes fits `maxExactStates` — always, for
 * pass/fail-shaped data at any n. Otherwise `resamples` deterministic sign draws
 * give p = (1 + #{|Σ| ≥ |Σobs|}) / (resamples + 1), which is a valid level-α
 * p-value (Phipson & Smyth 2010), not an approximation to one. `method` says
 * which happened; a caller must not be told "exact" about a number that is not.
 */
export function signFlipMeanTest(
  deltas: ArrayLike<number>,
  opts: { maxExactStates?: number; resamples?: number; seed?: number } = {},
): SignFlipTestResult {
  const maxExactStates = opts.maxExactStates ?? 200_000
  const resamples = opts.resamples ?? 10_000
  let improved = 0
  let worsened = 0
  let tied = 0
  let observed = 0
  let absTotal = 0
  const nonTied: number[] = []
  for (let i = 0; i < deltas.length; i++) {
    const d = deltas[i]!
    if (!Number.isFinite(d)) {
      throw new Error(`signFlipMeanTest: non-finite delta at index ${i}`)
    }
    observed += d
    absTotal += Math.abs(d)
    if (Math.abs(d) < PAIRED_DELTA_TIE_EPSILON) {
      tied++
      continue
    }
    if (d > 0) improved++
    else worsened++
    nonTied.push(Math.abs(d))
  }
  // No non-tied pair carries any signal: the null distribution is the point mass
  // at 0, so nothing is more extreme than the observation. p = 1, refuse.
  if (nonTied.length === 0) {
    return {
      pValue: 1,
      pValueUpperBound: 1,
      method: 'exact',
      resamples: null,
      improved,
      worsened,
      tied,
    }
  }
  // Floating-point slack on "at least as extreme", scaled to the data so it is
  // meaningful on 0-100 dimensions as well as on [0,1] ones.
  const slack = 1e-9 * Math.max(absTotal, 1e-12)
  const target = Math.abs(observed) - slack

  // Distinct magnitudes and their multiplicities. Exact enumeration is a
  // convolution of one Binomial(count, ½) per magnitude.
  const sorted = [...nonTied].sort((a, b) => a - b)
  const magnitudes: Array<{ value: number; count: number }> = []
  for (const abs of sorted) {
    const last = magnitudes[magnitudes.length - 1]
    if (last !== undefined && Math.abs(abs - last.value) <= 1e-9 * Math.max(abs, last.value)) {
      last.count++
    } else {
      magnitudes.push({ value: abs, count: 1 })
    }
  }
  let states = 1
  for (const m of magnitudes) {
    states *= m.count + 1
    if (states > maxExactStates) break
  }

  if (states <= maxExactStates) {
    // Exact: distribution over Σ = Σ_j d_j (2·B_j − m_j).
    let dist = new Map<number, number>([[0, 1]])
    for (const { value, count } of magnitudes) {
      const next = new Map<number, number>()
      const logHalf = count * Math.log(0.5)
      for (let k = 0; k <= count; k++) {
        const weight = Math.exp(
          lnGamma(count + 1) - lnGamma(k + 1) - lnGamma(count - k + 1) + logHalf,
        )
        const shift = value * (2 * k - count)
        for (const [sum, prob] of dist) {
          const key = sum + shift
          next.set(key, (next.get(key) ?? 0) + prob * weight)
        }
      }
      dist = next
    }
    let p = 0
    for (const [sum, prob] of dist) {
      if (Math.abs(sum) >= target) p += prob
    }
    const exactP = Math.min(1, Math.max(0, p))
    return {
      pValue: exactP,
      pValueUpperBound: exactP,
      method: 'exact',
      resamples: null,
      improved,
      worsened,
      tied,
    }
  }

  // Monte-Carlo sign flips. The seed is fixed by default: a promotion verdict
  // must be reproducible from the data alone, never a function of when it ran.
  const rng = mulberry32(opts.seed ?? 0x5f1de5)
  let atLeastAsExtreme = 0
  for (let r = 0; r < resamples; r++) {
    let sum = 0
    for (const abs of nonTied) sum += rng() < 0.5 ? abs : -abs
    if (Math.abs(sum) >= target) atLeastAsExtreme++
  }
  return {
    pValue: (1 + atLeastAsExtreme) / (resamples + 1),
    // The draws are a sample, so the point estimate can sit a hair under α by
    // luck. A decision uses the 99.9% upper bound on the true p-value instead,
    // which turns "the RNG was kind" into "refuse".
    pValueUpperBound: binomialRateUpperBound(atLeastAsExtreme, resamples, 0.999),
    method: 'monte_carlo',
    resamples,
    improved,
    worsened,
    tied,
  }
}

/** An interval for the mean, and whether the method could be applied at all. */
export interface MeanIntervalResult {
  /** Lower/upper confidence bounds, or null when the method does not apply. */
  low: number | null
  high: number | null
  confidence: number
}

/**
 * Empirical-likelihood confidence interval for the MEAN paired delta (Owen
 * 1988) — the interval a promotion gate decides on at ANY margin.
 *
 * The nonparametric analogue of a score interval: for each candidate mean μ it
 * reweights the observed deltas to the multinomial closest to uniform whose mean
 * is μ, and keeps every μ whose −2 log likelihood ratio is under χ²₁. That makes
 * it shape-free (no notion of "binary" appears) and shift-invariant (it reads
 * only the deltas), and — unlike a conditional exact interval — it never
 * discards the sampling variability of how MANY pairs moved, which is what makes
 * a nonzero margin decidable at all.
 *
 * Measured type-I error at the exact boundary, nominal 95%, true effect equal to
 * the margin (2000 replications, `probe/r3-el.mts`):
 *
 * | shape                                    | this | percentile bootstrap | exact conditional |
 * |------------------------------------------|------|----------------------|-------------------|
 * | n=76 pass/fail, margin −0.05             | 0.0% | 7.8%                 | 44.8%             |
 * | n=200 pass/fail, margin −0.05            | 2.2% | 2.4%                 | 44.8%             |
 * | n=76 two loss magnitudes, margin −0.05   | 0.0% | 10.7%                | 63.1%             |
 * | n=300 two loss magnitudes, margin −0.05  | 3.3% | 4.1%                 | 84.4%             |
 *
 * IT IS NOT A SIGNIFICANCE TEST AT MARGIN 0 ON SPARSE DATA — measured 22.8%
 * type-I at n = 26 with 2% wins and 2% losses, where the convex hull holds only
 * a handful of non-tied deltas. That is why a gate pairs it with
 * {@link signFlipMeanTest}, which is exact on precisely that regime; neither is
 * sufficient alone and both are cheap.
 *
 * `low`/`high` are null when the method does not apply — every delta identical,
 * so the convex hull is a point and the likelihood ratio is degenerate. A caller
 * must treat that as "cannot decide", never as a zero-width certainty.
 */
export function empiricalLikelihoodMeanInterval(
  deltas: ArrayLike<number>,
  confidence = 0.95,
): MeanIntervalResult {
  if (confidence <= 0 || confidence >= 1) {
    throw new Error(
      `empiricalLikelihoodMeanInterval: confidence must be in (0,1), got ${confidence}`,
    )
  }
  const n = deltas.length
  if (n === 0) return { low: null, high: null, confidence }
  const xs: number[] = []
  let min = Number.POSITIVE_INFINITY
  let max = Number.NEGATIVE_INFINITY
  let sum = 0
  for (let i = 0; i < n; i++) {
    const d = deltas[i]!
    if (!Number.isFinite(d)) return { low: null, high: null, confidence }
    xs.push(d)
    sum += d
    if (d < min) min = d
    if (d > max) max = d
  }
  // Degenerate support: the convex hull is a point (or float dust away from
  // one), so there is no interval to report and certainly no certainty to claim
  // from it. Tolerant rather than exact so an additive shift cannot flip it.
  if (!(max - min > PAIRED_DELTA_TIE_EPSILON)) return { low: null, high: null, confidence }
  const mean = sum / n
  // χ²₁ critical value = z², and zQuantile is already the module's normal inverse.
  const critical = zQuantile(1 - (1 - confidence) / 2) ** 2

  /** −2 log empirical likelihood ratio for H0: mean = mu. */
  const statistic = (mu: number): number => {
    let zMin = Number.POSITIVE_INFINITY
    let zMax = Number.NEGATIVE_INFINITY
    for (const x of xs) {
      const z = x - mu
      if (z < zMin) zMin = z
      if (z > zMax) zMax = z
    }
    // mu outside the convex hull of the data: no reweighting attains it.
    if (!(zMin < 0 && zMax > 0)) return Number.POSITIVE_INFINITY
    // g(λ) = Σ z/(1+λz) is strictly decreasing with one root in this bracket.
    let lo = -1 / zMax
    let hi = -1 / zMin
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2
      let g = 0
      for (const x of xs) {
        const z = x - mu
        const denom = 1 + mid * z
        if (denom <= 0) {
          g = Number.NaN
          break
        }
        g += z / denom
      }
      if (Number.isNaN(g)) hi = mid
      else if (g > 0) lo = mid
      else hi = mid
    }
    const lambda = (lo + hi) / 2
    let acc = 0
    for (const x of xs) {
      const denom = 1 + lambda * (x - mu)
      if (!(denom > 0)) return Number.POSITIVE_INFINITY
      acc += Math.log(denom)
    }
    return 2 * acc
  }

  /** Bisect between a rejected end and the (always accepted) sample mean. */
  const boundary = (rejected: number): number => {
    let lo = rejected
    let hi = mean
    for (let i = 0; i < 100; i++) {
      const mid = (lo + hi) / 2
      if (statistic(mid) > critical) lo = mid
      else hi = mid
    }
    return (lo + hi) / 2
  }

  return { low: boundary(min), high: boundary(max), confidence }
}

/**
 * The paired-delta statistic a DECISION is computed on, package-wide.
 *
 * The mean paired delta is the estimator that answers the question a promotion
 * gate asks — "by how much did the candidate move the score" — in the caller's
 * own units, and it equals the aggregate lift everyone quotes. The MEDIAN
 * answers a different question and loses the answer to this one in every regime
 * eval data actually lands in:
 *   - TWO-POINT (pass/fail) outcomes on any encoding: the delta vector lives in
 *     {−s, 0, +s} dominated by zeros, so the median and its whole bootstrap CI
 *     are pinned at exactly 0 however large the shift.
 *   - TIE-DOMINATED outcomes: at half the pairs tied the sample median is 0 by
 *     construction, and `ci.low > threshold` then answers "no" forever at a
 *     non-negative threshold and "yes" forever at a negative one.
 *   - LOW-CARDINALITY outcomes, even well below half ties: judge dimensions on
 *     integer 0-100, and block scores like {⅔, 1} from averaging pass/fail
 *     leaves, put the median on a coarse lattice whose bootstrap percentiles
 *     land on atoms. Measured: 26 blocks of 3 pass/fail leaves carrying a real
 *     +12.8pp lift, only 23% of pairs tied, gives a median CI of [0, 0.333] —
 *     lower bound exactly 0, so a gate at threshold 0 refuses a real lift.
 * That last case is why there is no tie-fraction threshold here: any cutoff on
 * ties leaves the lattice case open on the other side of it.
 *
 * `heldoutSignificance` has defaulted to the mean since #316 for the same
 * reason. The median remains available per call site for callers who
 * specifically want outlier robustness and accept the blindness.
 */
export const DECISION_PAIRED_DELTA_STATISTIC: 'mean' = 'mean'

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

function makeRng(seed: number | undefined): () => number {
  if (seed === undefined) return Math.random
  return mulberry32(seed)
}

/** Tiny seedable PRNG (mulberry32) — deterministic resampling/shuffling, not
 *  cryptographic. Exported so e-process shuffles and bootstrap resampling
 *  share ONE PRNG implementation; a seed is REQUIRED (unseeded randomness in
 *  gate verdicts is non-reproducible by construction). */
export function mulberry32(seed: number): () => number {
  let s = seed | 0 || 0x9e3779b9
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
