/**
 * Adaptive curriculum / active scenario selection.
 *
 * Fixed scenario sets waste sample budget on cells the policy already
 * passes (no information left) and cells the policy never passes (no
 * gradient available either). Active learning over scenarios fixes this
 * by allocating the next sample budget to cells where the policy's
 * outcome is *uncertain* — those carry the most decision-relevant signal.
 *
 * This module ships two complementary strategies:
 *
 *   1. **Variance-based** — score each (variant, scenario) cell by the
 *      empirical variance of past observations. Allocate next-round budget
 *      proportional to variance. Standard active-learning-by-uncertainty
 *      heuristic; works well when the policy is non-deterministic and
 *      cells differ in observation noise.
 *
 *   2. **Bandit-based (Thompson sampling)** — model each (variant,
 *      scenario) cell as a Beta-Bernoulli arm; sample a posterior; pick
 *      cells whose posterior mean is closest to the per-scenario decision
 *      threshold. The right primitive when scenarios are
 *      "pass/fail" rather than continuous, and when promotion gates fire
 *      at a known threshold (e.g., 0.5).
 *
 * The output is a *next-round budget allocation* — a list of (variant,
 * scenario, count) triples. The consumer's matrix runner consumes the
 * allocation, runs those cells, feeds the new observations back. Loop.
 *
 * Out of scope (deliberate): scenario *generation* — that's the
 * adversarial primitive's job. This module allocates over an existing
 * scenario pool.
 */

import type { RunRecord } from '../run-record'

export interface CellObservation {
  variantId: string
  scenarioId: string
  /** Observed score in [0, 1]. */
  score: number
  /** For Bernoulli arms — derive from the score with a threshold if needed. */
  pass?: boolean
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
    const variance = n < 2 ? variancePrior :
      samples.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1) + variancePrior
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

export interface ThompsonCurriculumOptions {
  budget: number
  /**
   * The per-scenario decision threshold. Cells whose posterior mean is
   * closest to this get the most budget — that's where the next observation
   * has the highest information value for the gate decision. Default 0.5.
   */
  decisionThreshold?: number
  /** Beta prior parameters. Default α=β=1 (uniform). */
  priorAlpha?: number
  priorBeta?: number
  /** Seed the Thompson sampler. Default unset (Math.random). */
  seed?: number
}

/**
 * Thompson-sampling-style allocation for pass/fail cells. For each cell:
 *
 *   - Maintain Beta(α + passes, β + failures) posterior on pass-rate
 *   - Allocation weight ∝ exp(-((sampledMean - threshold) / σ)^2):
 *     cells whose sampled posterior straddles the decision boundary get
 *     the most weight; cells already clearly above or below get less.
 *
 * This is the right primitive when promotion gates fire at a known
 * threshold and you want to sharpen the posterior near the boundary.
 */
export function thompsonCurriculum(
  observations: CellObservation[],
  candidateCells: Array<{ variantId: string; scenarioId: string }>,
  opts: ThompsonCurriculumOptions,
): CurriculumAllocation[] {
  const threshold = opts.decisionThreshold ?? 0.5
  const alpha0 = opts.priorAlpha ?? 1
  const beta0 = opts.priorBeta ?? 1
  const rng = makeRng(opts.seed)

  const grouped = new Map<string, { passes: number; failures: number }>()
  for (const o of observations) {
    const k = `${o.variantId}::${o.scenarioId}`
    const cur = grouped.get(k) ?? { passes: 0, failures: 0 }
    const pass = o.pass ?? o.score >= threshold
    if (pass) cur.passes += 1
    else cur.failures += 1
    grouped.set(k, cur)
  }

  const stats = candidateCells.map((c) => {
    const k = `${c.variantId}::${c.scenarioId}`
    const cur = grouped.get(k) ?? { passes: 0, failures: 0 }
    const a = alpha0 + cur.passes
    const b = beta0 + cur.failures
    // Sample a single Beta draw — the Thompson signal.
    const sampled = sampleBeta(a, b, rng)
    const distance = Math.abs(sampled - threshold)
    // Information-near-threshold weight: closer = higher.
    // Use Gaussian-shaped kernel with σ tuned to posterior std.
    const variance = (a * b) / ((a + b) ** 2 * (a + b + 1))
    const sigma = Math.max(0.05, Math.sqrt(variance))
    const weight = Math.exp(-(((distance) / sigma) ** 2))
    return {
      variantId: c.variantId,
      scenarioId: c.scenarioId,
      n: cur.passes + cur.failures,
      sampled,
      sigma,
      weight,
      a, b,
    }
  })

  const totalWeight = stats.reduce((s, c) => s + c.weight, 0)
  return stats.map((c) => {
    const proportional = totalWeight === 0 ? 0 : Math.round((c.weight / totalWeight) * opts.budget)
    return {
      variantId: c.variantId,
      scenarioId: c.scenarioId,
      count: Math.max(0, proportional),
      reason: `Beta(${c.a.toFixed(1)},${c.b.toFixed(1)}) sample=${c.sampled.toFixed(3)} (target ${threshold})`,
    }
  })
}

/** Convenience: extract `CellObservation[]` directly from `RunRecord[]`. */
export function observationsFromRunRecords(
  runs: RunRecord[],
  opts: { passThreshold?: number; useHoldout?: boolean } = {},
): CellObservation[] {
  const threshold = opts.passThreshold ?? 0.5
  const useHoldout = opts.useHoldout ?? true
  const out: CellObservation[] = []
  for (const r of runs) {
    if (!r.scenarioId) continue
    const score = useHoldout
      ? (r.outcome.holdoutScore ?? r.outcome.searchScore)
      : (r.outcome.searchScore ?? r.outcome.holdoutScore)
    if (typeof score !== 'number' || !Number.isFinite(score)) continue
    out.push({
      variantId: r.candidateId,
      scenarioId: r.scenarioId,
      score,
      pass: score >= threshold,
    })
  }
  return out
}

// ── Helpers ──────────────────────────────────────────────────────────────

function makeRng(seed?: number): () => number {
  if (seed === undefined) return Math.random
  let s = seed >>> 0
  return () => {
    s = (s + 0x6D2B79F5) >>> 0
    let t = s
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/**
 * Sample from Beta(α, β) via the Marsaglia–Tsang method using two Gamma
 * variates. Accuracy is good for α, β > 1; we floor the parameters at 1
 * to avoid degenerate cases.
 */
function sampleBeta(alpha: number, beta: number, rng: () => number): number {
  const a = Math.max(1, alpha)
  const b = Math.max(1, beta)
  const x = sampleGamma(a, rng)
  const y = sampleGamma(b, rng)
  return x / (x + y)
}

function sampleGamma(shape: number, rng: () => number): number {
  // Marsaglia–Tsang for shape ≥ 1.
  const d = shape - 1 / 3
  const c = 1 / Math.sqrt(9 * d)
  while (true) {
    let x: number
    let v: number
    do {
      const u1 = rng() || 1e-12
      const u2 = rng() || 1e-12
      // Box-Muller for a normal sample.
      x = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      v = 1 + c * x
    } while (v <= 0)
    v = v * v * v
    const u = rng()
    if (u < 1 - 0.0331 * x ** 4) return d * v
    if (Math.log(u) < 0.5 * x * x + d * (1 - v + Math.log(v))) return d * v
  }
}
