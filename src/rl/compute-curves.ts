/**
 * Test-time compute scaling curves.
 *
 * The test-time-compute frontier paper (Snell et al. 2024) and the
 * subsequent o1-style scaling work both show that LLM-agent capability
 * is a function of the compute budget at inference, not just of the
 * training run. The right way to characterize a candidate is therefore
 * a *curve* — score at compute budgets {1×, 4×, 16×, …} — not a single
 * point.
 *
 * This module ships:
 *
 *   1. The compute-curve harness — `runComputeCurve(runner, budgets)` —
 *      that evaluates one candidate at a sequence of compute budgets
 *      and returns the (compute, score) curve.
 *   2. A best-of-N evaluator — `bestOfN(runner, n, scoreFn)` — the
 *      simplest test-time-compute scaling primitive: sample N
 *      independent rollouts, return the best.
 *   3. A self-consistency evaluator — `selfConsistency(runner, n)` —
 *      the majority-vote variant of best-of-N for tasks with a small
 *      categorical answer space.
 *   4. Pareto-frontier extraction over multiple candidates — given
 *      (candidate, compute, score) tuples, return the set of
 *      candidate-compute combinations that aren't dominated.
 *
 * Caveat: "compute" here is the caller's notion of a compute unit. For
 * agent eval that's typically wall-time × parallelism, or token budget,
 * or LLM-call count. We accept whatever the caller provides; the curve
 * is on whatever axis they pick.
 */

export interface ComputeCurveBudget {
  /** Identifier — for the report. Common: '1x', '4x', '16x'. */
  id: string
  /** Numeric value on the chosen axis (tokens, calls, USD, ms — caller picks). */
  cost: number
  /** Free-form metadata (the caller can carry per-budget config). */
  meta?: Record<string, unknown>
}

export interface ComputeCurvePoint {
  budgetId: string
  cost: number
  score: number
  /** Number of underlying samples used at this budget. */
  samples: number
  /** Optional spread / variance information. */
  std?: number
  /** Any extra metrics the runner returned. */
  metrics?: Record<string, number>
}

export interface ComputeCurve {
  candidateId: string
  points: ComputeCurvePoint[]
  /** Rough exponent fit: score ≈ a + b * log(cost). Useful for "how steep is the curve?" */
  logSlope: number | null
  /** Best (highest-score) point on the curve. */
  best: ComputeCurvePoint
}

export interface RunComputeCurveOptions {
  candidateId: string
  budgets: ComputeCurveBudget[]
  /**
   * Run the candidate at one budget. Returns the realized score plus
   * optional spread + extra metrics.
   */
  runAtBudget: (budget: ComputeCurveBudget) => Promise<{
    score: number
    samples: number
    std?: number
    metrics?: Record<string, number>
  }>
}

export async function runComputeCurve(opts: RunComputeCurveOptions): Promise<ComputeCurve> {
  const points: ComputeCurvePoint[] = []
  for (const budget of opts.budgets) {
    const r = await opts.runAtBudget(budget)
    points.push({
      budgetId: budget.id,
      cost: budget.cost,
      score: r.score,
      samples: r.samples,
      std: r.std,
      metrics: r.metrics,
    })
  }
  const sorted = [...points].sort((a, b) => a.cost - b.cost)
  const logSlope = sorted.length >= 2 ? fitLogSlope(sorted) : null
  const best = points.reduce((a, b) => (b.score > a.score ? b : a))
  return { candidateId: opts.candidateId, points: sorted, logSlope, best }
}

export interface ComputeBestOfNOptions<O> {
  /** Number of independent samples to draw. */
  n: number
  /** Sampler — produces one rollout. */
  sample: (sampleIdx: number) => Promise<O>
  /** Score one rollout. */
  scoreFn: (rollout: O) => Promise<number> | number
}

export interface ComputeBestOfNResult<O> {
  best: O
  bestScore: number
  scores: number[]
  meanScore: number
  /** Index of the best rollout, for diagnostics. */
  bestIndex: number
}

/** The simplest test-time scaling primitive. */
export async function bestOfN<O>(opts: ComputeBestOfNOptions<O>): Promise<ComputeBestOfNResult<O>> {
  if (opts.n <= 0) throw new Error('bestOfN: n must be > 0')
  const rollouts: O[] = []
  const scores: number[] = []
  for (let i = 0; i < opts.n; i++) {
    const r = await opts.sample(i)
    rollouts.push(r)
    scores.push(await opts.scoreFn(r))
  }
  let bestIndex = 0
  for (let i = 1; i < scores.length; i++) if (scores[i]! > scores[bestIndex]!) bestIndex = i
  const meanScore = scores.reduce((s, x) => s + x, 0) / scores.length
  return {
    best: rollouts[bestIndex]!,
    bestScore: scores[bestIndex]!,
    scores,
    meanScore,
    bestIndex,
  }
}

export interface SelfConsistencyOptions<O> {
  n: number
  sample: (sampleIdx: number) => Promise<O>
  /** Extract the canonical answer key (string) from a rollout. */
  answerKey: (rollout: O) => string
}

export interface SelfConsistencyResult<O> {
  /** Modal answer (the majority vote). */
  answer: string
  /** Fraction of samples voting for the modal answer in [0, 1]. */
  agreement: number
  /** Histogram of all answers. */
  histogram: Record<string, number>
  /** A representative rollout that voted for the modal answer. */
  representative: O
  /** All rollouts. */
  rollouts: O[]
}

/**
 * Self-consistency / majority-vote test-time scaling. For tasks with a
 * small categorical answer space (math problems, multiple choice).
 */
export async function selfConsistency<O>(
  opts: SelfConsistencyOptions<O>,
): Promise<SelfConsistencyResult<O>> {
  if (opts.n <= 0) throw new Error('selfConsistency: n must be > 0')
  const rollouts: O[] = []
  const histogram: Record<string, number> = {}
  for (let i = 0; i < opts.n; i++) {
    const r = await opts.sample(i)
    rollouts.push(r)
    const key = opts.answerKey(r)
    histogram[key] = (histogram[key] ?? 0) + 1
  }
  let answer = ''
  let max = -1
  for (const [k, v] of Object.entries(histogram)) {
    if (v > max) {
      max = v
      answer = k
    }
  }
  const representative = rollouts.find((r) => opts.answerKey(r) === answer) ?? rollouts[0]!
  return {
    answer,
    agreement: max / opts.n,
    histogram,
    representative,
    rollouts,
  }
}

/**
 * Pareto frontier over (candidate, compute, score) tuples. A point is on
 * the frontier iff no other point dominates it in both score (higher
 * better) and cost (lower better). Returns the frontier sorted ascending
 * by cost.
 */
export interface ParetoPointInput {
  candidateId: string
  budgetId: string
  cost: number
  score: number
}

export function paretoFrontier(points: ParetoPointInput[]): ParetoPointInput[] {
  const onFrontier: ParetoPointInput[] = []
  for (const p of points) {
    const dominated = points.some(
      (q) =>
        q !== p && q.cost <= p.cost && q.score >= p.score && (q.cost < p.cost || q.score > p.score),
    )
    if (!dominated) onFrontier.push(p)
  }
  return onFrontier.sort((a, b) => a.cost - b.cost)
}

// ── Helpers ──────────────────────────────────────────────────────────────

function fitLogSlope(points: ComputeCurvePoint[]): number {
  // OLS slope of score on log(cost). Used as a single-number summary of
  // how much marginal compute helps. Positive = score improves with
  // compute; near-zero = capability ceiling reached.
  const xs = points.map((p) => Math.log(Math.max(1e-12, p.cost)))
  const ys = points.map((p) => p.score)
  const n = xs.length
  const mx = xs.reduce((s, x) => s + x, 0) / n
  const my = ys.reduce((s, y) => s + y, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my)
    den += (xs[i]! - mx) ** 2
  }
  return den === 0 ? 0 : num / den
}
