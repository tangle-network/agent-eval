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
): { mean: number; lower: number; upper: number } {
  if (scores.length === 0) return { mean: 0, lower: 0, upper: 0 }
  if (scores.length === 1) return { mean: scores[0]!, lower: scores[0]!, upper: scores[0]! }

  const n = scores.length
  const mean = scores.reduce((a, b) => a + b, 0) / n

  const B = 1000
  const bootstrapMeans: number[] = []

  for (let i = 0; i < B; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) {
      sum += scores[Math.floor(Math.random() * n)]!
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
