/**
 * Adaptive curriculum: active scenario selection by variance.
 *
 * Fixed scenario sets waste sample budget on cells whose outcome is already
 * settled. `varianceBasedCurriculum` scores each (variant, scenario) cell by
 * the empirical variance of past observations and allocates the next round's
 * budget toward the noisy and under-sampled cells. The output is a next-round
 * allocation, a list of (variant, scenario, count) triples, which the
 * consumer runs and feeds back.
 *
 * Choosing which search node to expand is not a curriculum; it belongs to the
 * search policy (`aide` draws parents by Thompson sampling over each node's
 * posterior, in `campaign/search-policy.ts`). Scenario generation belongs to
 * the adversarial primitive.
 */

export interface CellObservation {
  variantId: string
  scenarioId: string
  /** Observed score in [0, 1]. */
  score: number
}

export interface CurriculumAllocation {
  variantId: string
  scenarioId: string
  /** How many additional reps to run on this cell. */
  count: number
  /** Strategy-specific reason for the allocation. */
  reason: string
}

export interface VarianceCurriculumOptions {
  /** Total reps to allocate across all cells. */
  budget: number
  /**
   * Smoothing prior on variance — keeps the allocator from concentrating
   * on a cell with one observation just because its 1-sample variance is
   * 0. Default 0.05.
   */
  variancePrior?: number
  /**
   * Minimum reps per cell — even when the variance estimate is low, give
   * every cell at least this many. Default 1.
   */
  floorPerCell?: number
}

/**
 * Variance-proportional allocation. For each cell, estimate variance from
 * past observations + a prior, then allocate the budget proportional to
 * (sqrt(variance) + 1/sqrt(n)) — a classical optimal-allocation rule
 * (Neyman 1934) that balances "explore noisy cells" with "explore
 * under-sampled cells."
 */
export function varianceBasedCurriculum(
  observations: CellObservation[],
  candidateCells: Array<{ variantId: string; scenarioId: string }>,
  opts: VarianceCurriculumOptions,
): CurriculumAllocation[] {
  const variancePrior = opts.variancePrior ?? 0.05
  const floor = opts.floorPerCell ?? 1
  const budget = opts.budget

  const grouped = new Map<string, number[]>()
  for (const o of observations) {
    const k = `${o.variantId}::${o.scenarioId}`
    const arr = grouped.get(k) ?? []
    arr.push(o.score)
    grouped.set(k, arr)
  }

  const cellStats = candidateCells.map((c) => {
    const k = `${c.variantId}::${c.scenarioId}`
    const samples = grouped.get(k) ?? []
    const n = samples.length
    const mean = n === 0 ? 0.5 : samples.reduce((s, v) => s + v, 0) / n
    const variance =
      n < 2
        ? variancePrior
        : samples.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) + variancePrior
    // Neyman optimal allocation: weight ∝ √variance; add √(1/n) to break
    // ties toward under-sampled cells.
    const weight = Math.sqrt(variance) + 1 / Math.sqrt(Math.max(1, n))
    return { variantId: c.variantId, scenarioId: c.scenarioId, n, mean, variance, weight }
  })

  // Reserve floor*N for the floor; allocate the rest proportional to weight.
  const floorTotal = floor * cellStats.length
  if (floorTotal >= budget) {
    const each = Math.max(1, Math.floor(budget / Math.max(1, cellStats.length)))
    return cellStats.map((c) => ({
      variantId: c.variantId,
      scenarioId: c.scenarioId,
      count: each,
      reason: `floor allocation (budget tight; n=${c.n})`,
    }))
  }
  const remaining = budget - floorTotal
  const totalWeight = cellStats.reduce((s, c) => s + c.weight, 0)
  return cellStats.map((c) => {
    const proportional = totalWeight === 0 ? 0 : Math.round((c.weight / totalWeight) * remaining)
    return {
      variantId: c.variantId,
      scenarioId: c.scenarioId,
      count: floor + proportional,
      reason: `variance ${c.variance.toFixed(3)} (n=${c.n}, mean=${c.mean.toFixed(3)})`,
    }
  })
}
