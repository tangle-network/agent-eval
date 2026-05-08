/**
 * Bradley-Terry / Elo tournament evaluation.
 *
 * For multi-candidate sweeps, comparing every candidate's score against
 * a fixed comparator wastes information — the comparator becomes a high-
 * variance reference and rank flips between near-tied middle-rank
 * candidates are dominated by noise. Pairwise tournaments fix this:
 * every (i, j) pair contributes a comparison to a Bradley-Terry MLE that
 * estimates each candidate's strength on a unified scale.
 *
 * For online updating (rolling campaigns where new candidates arrive
 * over time), we also ship classical Elo with configurable K-factor.
 *
 * References:
 *   - Bradley, R. A., Terry, M. E. (1952). Rank analysis of incomplete
 *     block designs. Biometrika, 39(3/4), 324–345.
 *   - Hunter, D. R. (2004). MM algorithms for generalized Bradley-Terry
 *     models. Annals of Statistics, 32(1), 384–406. (The MLE algorithm
 *     used here.)
 *   - Elo, A. E. (1978). The Rating of Chess Players, Past and Present.
 *
 * This is a useful primitive because most LLM-eval communities (Chatbot
 * Arena, AlpacaEval, ELO-style ablation) have converged on pairwise
 * tournament eval as the most sample-efficient and most rank-stable
 * method when you have many candidates.
 */

export interface PairwiseOutcome {
  /** Winner candidate id. */
  winner: string
  /** Loser candidate id. */
  loser: string
  /**
   * Optional draw flag. When true, both candidates get half-credit
   * (Bradley-Terry handles draws as half-wins for each side).
   */
  draw?: boolean
  /**
   * Optional weight — useful if some pairwise comparisons are stronger
   * signals than others (e.g. a paired test with a wider score gap is
   * a more confident comparison). Default 1.
   */
  weight?: number
}

export interface BradleyTerryRating {
  candidateId: string
  /** Latent strength θ ≥ 0 from the BT MLE. */
  strength: number
  /** Log-strength = log(θ) — interpretable on a linear scale. */
  logStrength: number
  /** Number of pairwise comparisons this candidate appears in. */
  n: number
  /** Win count (+ 0.5 per draw). */
  wins: number
}

export interface BradleyTerryFit {
  ratings: BradleyTerryRating[]
  /** Iterations of the MM algorithm before convergence. */
  iterations: number
  /** Final maximum |θ_new - θ_old| / θ_old. */
  finalDelta: number
  converged: boolean
}

/**
 * Bradley-Terry MLE via Hunter's MM algorithm.
 *
 * Iteration: θ_i^new = W_i / Σ_{j ≠ i} N_ij / (θ_i + θ_j)
 *   where W_i = wins by i (+ 0.5 per draw), N_ij = total comparisons.
 *
 * Returns log-strengths normalized so the smallest is 0 (any constant
 * offset is unobservable in BT — only differences are identified).
 */
export function fitBradleyTerry(
  outcomes: PairwiseOutcome[],
  opts: { tolerance?: number; maxIterations?: number; smoothing?: number } = {},
): BradleyTerryFit {
  const tol = opts.tolerance ?? 1e-6
  const maxIter = opts.maxIterations ?? 256
  // Small positive default — Hunter's MM degenerates when a candidate has
  // zero wins (θ → 0 → log → -∞). 0.1 is negligible against real win counts
  // (~1 win / 10 comparisons) and keeps the iteration well-conditioned.
  // Override to 0 if the comparison set is guaranteed strongly connected.
  const smoothing = opts.smoothing ?? 0.1

  const candidates = new Set<string>()
  for (const o of outcomes) { candidates.add(o.winner); candidates.add(o.loser) }
  const ids = [...candidates].sort()
  const idx = new Map(ids.map((id, i) => [id, i]))
  const n = ids.length
  if (n === 0) return { ratings: [], iterations: 0, finalDelta: 0, converged: true }
  if (n === 1) {
    return {
      ratings: [{ candidateId: ids[0]!, strength: 1, logStrength: 0, n: 0, wins: 0 }],
      iterations: 0, finalDelta: 0, converged: true,
    }
  }

  // Build win matrix W[i][j] = (weighted) wins of i over j, plus half for draws.
  // Build comparison matrix N[i][j] = total weighted comparisons between i and j.
  const W: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  const N: number[][] = Array.from({ length: n }, () => new Array<number>(n).fill(0))
  for (const o of outcomes) {
    const i = idx.get(o.winner)!
    const j = idx.get(o.loser)!
    const w = o.weight ?? 1
    if (o.draw) {
      W[i]![j]! += 0.5 * w
      W[j]![i]! += 0.5 * w
    } else {
      W[i]![j]! += w
    }
    N[i]![j]! += w
    N[j]![i]! += w
  }

  // Per-candidate total wins.
  const winsTotal = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) winsTotal[i]! += W[i]![j]!
    winsTotal[i]! += smoothing // tiny smoothing to keep θ positive
  }
  const compsTotal = new Array<number>(n).fill(0)
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) compsTotal[i]! += N[i]![j]!
  }

  // MM iterations.
  let theta = new Array<number>(n).fill(1)
  let iter = 0
  let delta = Infinity
  for (; iter < maxIter; iter++) {
    const newTheta = new Array<number>(n)
    for (let i = 0; i < n; i++) {
      let denom = 0
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        if (N[i]![j]! === 0) continue
        denom += N[i]![j]! / (theta[i]! + theta[j]!)
      }
      newTheta[i] = denom === 0 ? theta[i]! : winsTotal[i]! / denom
    }
    // Normalize so geometric mean = 1 (numerical stability).
    let logSum = 0
    for (let i = 0; i < n; i++) logSum += Math.log(Math.max(1e-300, newTheta[i]!))
    const norm = Math.exp(logSum / n)
    for (let i = 0; i < n; i++) newTheta[i] = newTheta[i]! / norm

    delta = 0
    for (let i = 0; i < n; i++) {
      const d = Math.abs(newTheta[i]! - theta[i]!) / Math.max(1e-12, theta[i]!)
      if (d > delta) delta = d
    }
    theta = newTheta
    if (delta < tol) break
  }

  const minLog = Math.min(...theta.map((t) => Math.log(Math.max(1e-300, t))))
  const ratings: BradleyTerryRating[] = ids.map((id, i) => ({
    candidateId: id,
    strength: theta[i]!,
    logStrength: Math.log(Math.max(1e-300, theta[i]!)) - minLog,
    n: compsTotal[i]!,
    wins: winsTotal[i]! - smoothing,
  }))

  return {
    ratings: ratings.sort((a, b) => b.strength - a.strength),
    iterations: iter,
    finalDelta: delta,
    converged: delta < tol,
  }
}

/**
 * Online Elo updates. Use when comparisons arrive over time and you want
 * a running rating without re-fitting the full BT MLE on every update.
 *
 * Initialize ratings to `defaultRating` (1500 by default). Each call to
 * `applyEloUpdate` mutates the map in place and returns the deltas so
 * the caller can log per-comparison rating changes.
 */
export interface EloOptions {
  /** Default rating for unseen candidates. Default 1500. */
  defaultRating?: number
  /** K-factor controls the step size. Default 32 (FIDE-ish). */
  kFactor?: number
}

export function applyEloUpdate(
  ratings: Map<string, number>,
  outcome: PairwiseOutcome,
  opts: EloOptions = {},
): { winnerDelta: number; loserDelta: number } {
  const defaultRating = opts.defaultRating ?? 1500
  const k = opts.kFactor ?? 32

  const rW = ratings.get(outcome.winner) ?? defaultRating
  const rL = ratings.get(outcome.loser) ?? defaultRating

  const expectedW = 1 / (1 + Math.pow(10, (rL - rW) / 400))
  const scoreW = outcome.draw ? 0.5 : 1
  const scoreL = outcome.draw ? 0.5 : 0
  const w = outcome.weight ?? 1

  const winnerDelta = k * w * (scoreW - expectedW)
  const loserDelta = k * w * (scoreL - (1 - expectedW))

  ratings.set(outcome.winner, rW + winnerDelta)
  ratings.set(outcome.loser, rL + loserDelta)

  return { winnerDelta, loserDelta }
}

/**
 * Build pairwise outcomes from the campaign artifact: for every scenario
 * shared by two candidates, the higher-scoring run wins. Useful when you
 * want a tournament view of an existing campaign without an additional
 * pairwise judge call.
 */
export interface BuildPairwiseFromCampaignInput {
  runs: Array<{
    candidateId: string
    /** Stable identifier for the matching unit (typically scenarioId). */
    matchKey: string
    score: number
  }>
  /**
   * Tied-score margin. Below this, the comparison is a draw. Default 0
   * (no ties).
   */
  drawMargin?: number
}

export function buildPairwiseFromCampaign(input: BuildPairwiseFromCampaignInput): PairwiseOutcome[] {
  const drawMargin = input.drawMargin ?? 0
  const byKey = new Map<string, Array<{ candidateId: string; score: number }>>()
  for (const r of input.runs) {
    const arr = byKey.get(r.matchKey) ?? []
    arr.push({ candidateId: r.candidateId, score: r.score })
    byKey.set(r.matchKey, arr)
  }
  const outcomes: PairwiseOutcome[] = []
  for (const arr of byKey.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]!
        const b = arr[j]!
        if (a.candidateId === b.candidateId) continue
        const margin = Math.abs(a.score - b.score)
        if (margin <= drawMargin) {
          outcomes.push({ winner: a.candidateId, loser: b.candidateId, draw: true, weight: 1 })
        } else {
          const [winner, loser] = a.score > b.score ? [a, b] : [b, a]
          outcomes.push({ winner: winner.candidateId, loser: loser.candidateId, weight: margin })
        }
      }
    }
  }
  return outcomes
}
