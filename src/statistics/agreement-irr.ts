import { ValidationError } from '../errors'
import {
  type ContinuousAgreement,
  type ContinuousAgreementOptions,
  continuousAgreement,
} from '../judge-calibration'
import type { DimensionJudgeScore } from '../types'
import { type BootstrapInterval, clusterBootstrap } from './internal'

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
export function interRaterReliability(judgeScores: DimensionJudgeScore[][]): number {
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

export interface CorpusScoreRecord {
  /** Stable identifier for the rated item (scenario, span, turn, …). */
  itemId: string
  /** Identifier for the judge that produced this score. */
  judgeName: string
  /** Dimension name (matches `DimensionJudgeScore.dimension`). */
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
  /** Restrict the audit to these dimensions; default every one in the input. A named absentee throws. */
  dimensions?: string[]
  /** Restrict the audit to these judges; default every one in the input. A named absentee throws. */
  judges?: string[]
}

/**
 * Corpus-wide inter-rater agreement across N items × M judges × D dimensions, the
 * question `interRaterReliability`'s within-item α cannot answer.
 *
 * For each dimension, builds the [n_items][n_judges] matrix of scores
 * (keeping only items every judge rated on that dimension), then runs
 * `continuousAgreement` to get ICC(2,1), κ_w, Pearson, Spearman, and
 * bootstrap CIs. Reports a pooled mean across dimensions as a single
 * "is this judge panel reliable on this corpus?" number. Empty input, fewer than 2 judges or
 * items, a judge without scores on a dimension and duplicate records all throw: a silently
 * shrunk matrix would corrupt the overall metric.
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
    const judgeItemCounts = Object.fromEntries(
      targetJudges.map((j) => [j, byJudge.get(j)?.size ?? 0]),
    )
    const emptyJudges = targetJudges.filter((j) => judgeItemCounts[j] === 0)
    if (emptyJudges.length > 0) {
      throw new ValidationError(
        `corpusInterRaterAgreement: dimension '${dim}' has no scores from judge(s) ${emptyJudges.join(', ')} (counts: ${JSON.stringify(judgeItemCounts)})`,
      )
    }
    // Items rated by *every* requested judge on this dim.
    const sortedItems = targetJudges
      .map((j) => [...byJudge.get(j)!.keys()])
      .reduce((common, ids) => common.filter((x) => ids.includes(x)))
      .sort()
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
 * Convenience adapter for `DimensionJudgeScore[]` data keyed externally by item.
 *
 * Use when you have per-item arrays of `DimensionJudgeScore[]` (e.g. one
 * `ScenarioResult.judgeScores` per scenario) and want corpus-wide
 * agreement without manually flattening. `itemId` must be unique per
 * row of `itemsScores`.
 */
export function corpusInterRaterAgreementFromJudgeScores(
  itemsScores: Array<{ itemId: string; scores: DimensionJudgeScore[] }>,
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

/** Agreement between two raters who each assigned one nominal label per item. */
export interface NominalAgreement {
  /** Items both raters labeled. */
  n: number
  /** Share of items with identical labels. */
  agreement: number
  /**
   * Cohen's κ = (pₒ − pₑ) / (1 − pₑ), with pₑ from each rater's own label
   * marginals. NaN when n = 0, or when both raters used one identical label
   * for every item (pₑ = 1): chance and observed agreement are then the same
   * thing, and no number distinguishes skill from luck.
   */
  kappa: number
  /** Seeded percentile bootstrap of κ over clusters; NaN bounds when no resample has a finite κ. */
  kappaCi: BootstrapInterval
}

export interface NominalAgreementOptions {
  /** Cluster id per pair; pairs sharing one are resampled together. Default: every pair alone. */
  clusters?: readonly string[]
  /** Default 2000. */
  resamples?: number
  seed?: number
}

/**
 * Unweighted Cohen's κ for paired nominal labels. Labels carry no order, so a
 * near miss counts as a miss; use `calibrateJudge` for ordinal scores.
 */
export function nominalAgreement(
  pairs: ReadonlyArray<readonly [string, string]>,
  options: NominalAgreementOptions = {},
): NominalAgreement {
  if (options.clusters && options.clusters.length !== pairs.length) {
    throw new ValidationError('nominalAgreement: one cluster per pair')
  }
  const kappaCi = clusterBootstrap(
    pairs,
    (_, index) => options.clusters?.[index] ?? String(index),
    (sample) => cohenKappa(sample).kappa,
    options,
  )
  return { n: pairs.length, ...cohenKappa(pairs), kappaCi }
}

function cohenKappa(pairs: ReadonlyArray<readonly [string, string]>) {
  const n = pairs.length
  if (n === 0) return { agreement: Number.NaN, kappa: Number.NaN }
  const left = new Map<string, number>()
  const right = new Map<string, number>()
  let same = 0
  for (const [a, b] of pairs) {
    if (typeof a !== 'string' || typeof b !== 'string') {
      throw new ValidationError('nominalAgreement: every label must be a string')
    }
    if (a === b) same += 1
    left.set(a, (left.get(a) ?? 0) + 1)
    right.set(b, (right.get(b) ?? 0) + 1)
  }
  const observed = same / n
  let expected = 0
  for (const [label, count] of left) expected += (count / n) * ((right.get(label) ?? 0) / n)
  const kappa = expected === 1 ? Number.NaN : (observed - expected) / (1 - expected)
  return { agreement: observed, kappa }
}
