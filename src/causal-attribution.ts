/**
 * Causal attribution via factorial experiments.
 *
 * Run every combination of {model × prompt × scenario × seed}, then
 * decompose observed score variance into main effects + interactions.
 * Moves from correlational "variant B is better" to causal "the model
 * swap accounts for 42% of the lead; the prompt change accounts for 28%;
 * interaction is 30%."
 *
 * Minimal implementation: 2-way factorial (two factors at a time) with
 * main-effect + interaction decomposition via variance of cell means.
 * Consumers run the factorial design themselves (we don't schedule
 * runs); this module consumes the (factorLevels, observedScores)
 * table and does the attribution math.
 */

export interface FactorialCell {
  /** Map factor name → level id. e.g. { model: 'claude', prompt: 'v2' } */
  levels: Record<string, string>
  /** Observed score for this cell (mean over replications if n > 1). */
  score: number
  /** Number of replications averaged to produce `score`. */
  n: number
}

export interface FactorContribution {
  factor: string
  /** Variance attributed to this factor's main effect, as a fraction of total. */
  shareOfVariance: number
  /** Range of cell means across levels of this factor. */
  range: number
}

export interface InteractionContribution {
  factors: [string, string]
  shareOfVariance: number
}

export interface CausalAttributionReport {
  totalVariance: number
  mainEffects: FactorContribution[]
  interactions: InteractionContribution[]
  /** Residual = variance unexplained by main effects + modeled interactions. */
  residualShare: number
  /** Sanity: shares sum to 1 (within fp). */
  sharesSum: number
}

export function causalAttribution(cells: FactorialCell[]): CausalAttributionReport {
  if (cells.length < 4) throw new Error('causalAttribution: need ≥ 4 cells to estimate effects')
  const factors = Object.keys(cells[0].levels)
  if (factors.length < 2) throw new Error('causalAttribution: need ≥ 2 factors')

  const allScores = cells.map((c) => c.score)
  const grandMean = allScores.reduce((a, b) => a + b, 0) / allScores.length
  const totalVariance = allScores.reduce((acc, s) => acc + (s - grandMean) ** 2, 0) / allScores.length
  if (totalVariance === 0) {
    return { totalVariance: 0, mainEffects: factors.map((f) => ({ factor: f, shareOfVariance: 0, range: 0 })), interactions: [], residualShare: 1, sharesSum: 1 }
  }

  // Main effects: variance of cell-mean-by-level, averaged across other factors.
  const mainEffects: FactorContribution[] = factors.map((f) => {
    const byLevel = groupBy(cells, (c) => c.levels[f])
    const means: number[] = []
    for (const arr of byLevel.values()) {
      means.push(arr.reduce((a, c) => a + c.score, 0) / arr.length)
    }
    const mainVariance = means.reduce((acc, m) => acc + (m - grandMean) ** 2, 0) / means.length
    return {
      factor: f,
      shareOfVariance: mainVariance / totalVariance,
      range: Math.max(...means) - Math.min(...means),
    }
  })

  // Pairwise interactions: cell mean by (factor_i, factor_j) vs main effects
  const interactions: InteractionContribution[] = []
  for (let i = 0; i < factors.length; i++) {
    for (let j = i + 1; j < factors.length; j++) {
      const byPair = groupBy(cells, (c) => `${c.levels[factors[i]]}|${c.levels[factors[j]]}`)
      const pairMeans: number[] = []
      for (const arr of byPair.values()) {
        pairMeans.push(arr.reduce((a, c) => a + c.score, 0) / arr.length)
      }
      const pairVariance = pairMeans.reduce((acc, m) => acc + (m - grandMean) ** 2, 0) / pairMeans.length
      const mainI = mainEffects[i].shareOfVariance * totalVariance
      const mainJ = mainEffects[j].shareOfVariance * totalVariance
      const interactionVariance = Math.max(0, pairVariance - mainI - mainJ)
      interactions.push({
        factors: [factors[i], factors[j]],
        shareOfVariance: interactionVariance / totalVariance,
      })
    }
  }

  const mainSum = mainEffects.reduce((a, m) => a + m.shareOfVariance, 0)
  const interactionSum = interactions.reduce((a, m) => a + m.shareOfVariance, 0)
  const residualShare = Math.max(0, 1 - mainSum - interactionSum)
  const sharesSum = mainSum + interactionSum + residualShare
  return { totalVariance, mainEffects, interactions, residualShare, sharesSum }
}

function groupBy<T>(items: T[], key: (t: T) => string): Map<string, T[]> {
  const m = new Map<string, T[]>()
  for (const item of items) {
    const k = key(item)
    const arr = m.get(k) ?? []; arr.push(item); m.set(k, arr)
  }
  return m
}
