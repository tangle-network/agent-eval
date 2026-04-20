import type { JudgeScore } from './types'

/** Dimensions where lower raw score = better outcome (inverted semantics) */
const INVERTED_DIMENSIONS = new Set([
  'hallucination',
  'false_confidence',
  'worst_failure',
])

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
  if (scores.length === 1) return { mean: scores[0], lower: scores[0], upper: scores[0] }

  const n = scores.length
  const mean = scores.reduce((a, b) => a + b, 0) / n

  const B = 1000
  const bootstrapMeans: number[] = []

  for (let i = 0; i < B; i++) {
    let sum = 0
    for (let j = 0; j < n; j++) {
      sum += scores[Math.floor(Math.random() * n)]
    }
    bootstrapMeans.push(sum / n)
  }

  bootstrapMeans.sort((a, b) => a - b)

  const alpha = 1 - confidence
  const lowerIdx = Math.floor((alpha / 2) * B)
  const upperIdx = Math.floor((1 - alpha / 2) * B) - 1

  return {
    mean,
    lower: bootstrapMeans[lowerIdx],
    upper: bootstrapMeans[Math.min(upperIdx, B - 1)],
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
      if (arr.length === 0 || arr[arr.length - 1].length >= judgeScores.length) {
        arr.push([s.score])
      } else {
        arr[arr.length - 1].push(s.score)
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
          pairDiffs.push((ratings[i] - ratings[j]) ** 2)
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
      expectedDisagreement += (allValues[i] - allValues[j]) ** 2
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
    while (j < combined.length && combined[j].v === combined[i].v) j++
    const avgRank = (i + 1 + j) / 2
    for (let k = i; k < j; k++) ranks[k] = avgRank
    i = j
  }

  // Sum ranks for group a
  let r1 = 0
  for (let k = 0; k < combined.length; k++) {
    if (combined[k].group === 'a') r1 += ranks[k]
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
  const y = 1 - ((((a5 * t + a4) * t + a3) * t + a2) * t + a1) * t * Math.exp(-absX * absX / 2)

  return 0.5 * (1 + sign * y)
}
