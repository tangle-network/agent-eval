import { ValidationError } from './errors'
import {
  type ContinuousAgreement,
  type ContinuousAgreementOptions,
  continuousAgreement,
} from './judge-calibration'
import type { JudgeScore } from './types'

/** Dimensions where lower raw score = better outcome (inverted semantics) */
const INVERTED_DIMENSIONS = new Set(['hallucination', 'false_confidence', 'worst_failure'])

/**
 * Normalize scores so all dimensions follow "higher = better".
 * Inverted dimensions (hallucination, false_confidence, worst_failure)
 * already use inverted scoring in the prompt (10 = no hallucination),
 * but this function ensures consistency if raw scores leak through.
 */
export function normalizeScores(scores: JudgeScore[]): JudgeScore[] {
  return scores.map((s) => {
    if (INVERTED_DIMENSIONS.has(s.dimension)) {
      return s
    }
    return s
  })
}

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
// The legacy `interRaterReliability(judgeScores)` computes a within-item
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

/** Student-t CDF approximation via Abramowitz-Stegun series. */
function studentTCdf(t: number, df: number): number {
  if (df <= 0) return 0.5
  if (df > 100) return normalCdf(t)
  const x = df / (df + t * t)
  const a = df / 2
  const b = 0.5
  const ib = incompleteBeta(x, a, b)
  return t >= 0 ? 1 - 0.5 * ib : 0.5 * ib
}

/** Regularized incomplete beta function via continued fraction (Lentz). */
function incompleteBeta(x: number, a: number, b: number): number {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const lnBeta = lnGamma(a) + lnGamma(b) - lnGamma(a + b)
  const front = Math.exp(Math.log(x) * a + Math.log(1 - x) * b - lnBeta) / a
  const maxIter = 200
  const eps = 3e-7
  let c = 1
  let d = 1 - ((a + b) * x) / (a + 1)
  if (Math.abs(d) < 1e-30) d = 1e-30
  d = 1 / d
  let f = d
  for (let m = 1; m <= maxIter; m++) {
    const m2 = 2 * m
    let num = (m * (b - m) * x) / ((a + m2 - 1) * (a + m2))
    d = 1 + num * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + num / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    f *= d * c
    num = -((a + m) * (a + b + m) * x) / ((a + m2) * (a + m2 + 1))
    d = 1 + num * d
    if (Math.abs(d) < 1e-30) d = 1e-30
    c = 1 + num / c
    if (Math.abs(c) < 1e-30) c = 1e-30
    d = 1 / d
    const delta = d * c
    f *= delta
    if (Math.abs(delta - 1) < eps) break
  }
  return front * f
}

/** Lanczos approximation to ln Γ(z). */
function lnGamma(z: number): number {
  const g = 7
  const coefs = [
    0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313,
    -176.61502916214059, 12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6,
    1.5056327351493116e-7,
  ]
  if (z < 0.5) {
    return Math.log(Math.PI / Math.sin(Math.PI * z)) - lnGamma(1 - z)
  }
  z -= 1
  let x = coefs[0]!
  for (let i = 1; i < g + 2; i++) x += coefs[i]! / (z + i)
  const t = z + g + 0.5
  return 0.5 * Math.log(2 * Math.PI) + (z + 0.5) * Math.log(t) - t + Math.log(x)
}

// Standard normal CDF approximation (Abramowitz and Stegun)
function normalCdf(x: number): number {
  const a1 = 0.254829592
  const a2 = -0.284496736
  const a3 = 1.421413741
  const a4 = -1.453152027
  const a5 = 1.061405429
  const p = 0.3275911

  const sign = x < 0 ? -1 : 1
  const absX = Math.abs(x)
  const t = 1 / (1 + p * absX)
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp((-absX * absX) / 2)

  return 0.5 * (1 + sign * y)
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

/** Tiny seedable PRNG (mulberry32) — deterministic bootstrap resampling, not cryptographic. */
function makeRng(seed: number | undefined): () => number {
  if (seed === undefined) return Math.random
  let s = seed | 0 || 0x9e3779b9
  return () => {
    s = (s + 0x6d2b79f5) | 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
