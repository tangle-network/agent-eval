import { makeRng } from '../rng'
/**
 * Sample-efficient adaptation evaluation.
 *
 * For foundation-model-based agents, the load-bearing capability isn't
 * raw end-state performance — it's *how fast the agent reaches that
 * performance from cold start*. The same model with a worse prompt that
 * adapts in 5 demonstrations beats the same model with a better prompt
 * that needs 50. Standard meta-learning eval (Finn et al., MAML, RL² lit)
 * reports an *adaptation curve*: score after k=0, 1, 2, 4, 8, 16, …
 * in-context examples or fine-tune steps.
 *
 * This module ships:
 *
 *   1. `runAdaptationCurve` — given a runner that takes k demonstrations
 *      and returns a score, produce the (k, score) curve.
 *   2. `compareAdaptationCurves` — paired comparison across two policies.
 *      Returns per-k delta with bootstrap CIs and an "area-under-curve"
 *      summary statistic.
 *   3. `firstPassK` — for pass/fail evaluation, the minimum k at which
 *      the policy reliably passes (≥ pass-rate threshold over reps).
 *
 * Use cases:
 *   - Compare two prompt designs that have similar end-state performance
 *     but different in-context efficiency.
 *   - Decide between fine-tuning and prompting based on adaptation cost.
 *   - Detect when a policy "memorizes" k=0 inputs vs. genuinely adapts.
 */

export interface AdaptationRunner<S> {
  /**
   * Runs the policy on `scenario` with `k` demonstrations. Returns a
   * scalar score in [0, 1]. The runner is responsible for any caching;
   * the harness calls it once per (scenario, k, rep) cell.
   */
  run(args: { scenario: S; k: number; rep: number }): Promise<number>
}

export interface RunAdaptationCurveOptions<S> {
  scenarios: S[]
  /** Number-of-shots to evaluate at. Default `[0, 1, 2, 4, 8, 16]`. */
  ks?: number[]
  /** Reps per (scenario, k) cell. Default 3. */
  reps?: number
  runner: AdaptationRunner<S>
  /** Pass-rate threshold for `firstPassK` reporting. Default 0.5. */
  passThreshold?: number
}

export interface AdaptationPoint {
  k: number
  meanScore: number
  passRate: number
  std: number
  n: number
  /** Per-scenario means at this k. */
  perScenario: Array<{ scenarioId: string; meanScore: number; passes: number; total: number }>
}

export interface AdaptationCurve {
  points: AdaptationPoint[]
  /**
   * Smallest `k` at which `passRate ≥ passThreshold`. `null` if no `k`
   * tested reaches it.
   */
  firstPassK: number | null
  /**
   * Area under the (k, meanScore) curve, normalized by max-k. A
   * single-number summary of "how well does this policy adapt from
   * cold-start to fully-conditioned." Higher = better adapter.
   */
  adaptationArea: number
}

export async function runAdaptationCurve<S extends { scenarioId?: string }>(
  opts: RunAdaptationCurveOptions<S>,
): Promise<AdaptationCurve> {
  const ks = opts.ks ?? [0, 1, 2, 4, 8, 16]
  const reps = opts.reps ?? 3
  const passThreshold = opts.passThreshold ?? 0.5
  const sortedKs = [...ks].sort((a, b) => a - b)

  const points: AdaptationPoint[] = []
  for (const k of sortedKs) {
    const perScenario: AdaptationPoint['perScenario'] = []
    const allScores: number[] = []
    let totalPasses = 0
    let totalAttempts = 0
    for (const scenario of opts.scenarios) {
      const sid = scenario.scenarioId ?? `scenario-${opts.scenarios.indexOf(scenario)}`
      const scores: number[] = []
      let passes = 0
      for (let r = 0; r < reps; r++) {
        const score = await opts.runner.run({ scenario, k, rep: r })
        scores.push(score)
        if (score >= passThreshold) passes++
        allScores.push(score)
        if (score >= passThreshold) totalPasses++
        totalAttempts++
      }
      const meanS = scores.reduce((s, v) => s + v, 0) / scores.length
      perScenario.push({ scenarioId: sid, meanScore: meanS, passes, total: scores.length })
    }
    const meanScore = allScores.reduce((s, v) => s + v, 0) / Math.max(1, allScores.length)
    const variance =
      allScores.length < 2
        ? 0
        : allScores.reduce((s, v) => s + (v - meanScore) ** 2, 0) / (allScores.length - 1)
    points.push({
      k,
      meanScore,
      passRate: totalPasses / Math.max(1, totalAttempts),
      std: Math.sqrt(variance),
      n: allScores.length,
      perScenario,
    })
  }

  const firstPassK = points.find((p) => p.passRate >= passThreshold)?.k ?? null
  const maxK = sortedKs[sortedKs.length - 1] ?? 1
  // Trapezoidal area under the (k, meanScore) curve, normalized by k-range.
  let area = 0
  for (let i = 1; i < points.length; i++) {
    const x1 = points[i - 1]!.k
    const x2 = points[i]!.k
    const y1 = points[i - 1]!.meanScore
    const y2 = points[i]!.meanScore
    area += ((y1 + y2) / 2) * (x2 - x1)
  }
  const adaptationArea = maxK === 0 ? 0 : area / maxK

  return { points, firstPassK, adaptationArea }
}

export interface CompareCurvesResult {
  perK: Array<{
    k: number
    deltaMean: number
    aLow: number
    aHigh: number
    bLow: number
    bHigh: number
  }>
  areaDelta: number
  firstPassKDelta: number | null
  /** Verdict: 'a_better' | 'b_better' | 'similar'. */
  verdict: 'a_better' | 'b_better' | 'similar'
  /** Rationale, ready to render. */
  rationale: string
}

/**
 * Paired comparison of two adaptation curves. Per-k deltas with 95%
 * bootstrap CIs (constructed from each curve's `perScenario` per-k means
 * — the bootstrap unit is the scenario, not the rep).
 */
export function compareAdaptationCurves(
  a: AdaptationCurve,
  b: AdaptationCurve,
  opts: { confidence?: number; bootstrapResamples?: number; seed?: number } = {},
): CompareCurvesResult {
  const conf = opts.confidence ?? 0.95
  const resamples = opts.bootstrapResamples ?? 500
  const rng = makeRng(opts.seed)

  const perK: CompareCurvesResult['perK'] = []
  for (const ap of a.points) {
    const bp = b.points.find((p) => p.k === ap.k)
    if (!bp) continue
    const aMeans = ap.perScenario.map((s) => s.meanScore)
    const bMeans = bp.perScenario.map((s) => s.meanScore)
    const aCi = bootstrapMeanCi(aMeans, resamples, conf, rng)
    const bCi = bootstrapMeanCi(bMeans, resamples, conf, rng)
    perK.push({
      k: ap.k,
      deltaMean: ap.meanScore - bp.meanScore,
      aLow: aCi.low,
      aHigh: aCi.high,
      bLow: bCi.low,
      bHigh: bCi.high,
    })
  }

  const areaDelta = a.adaptationArea - b.adaptationArea
  const firstPassKDelta =
    a.firstPassK !== null && b.firstPassK !== null
      ? b.firstPassK - a.firstPassK // smaller k for a means a adapts faster (positive delta)
      : null

  // Composite verdict: positive area delta + most per-k deltas in same
  // direction → that side wins. Within ε of zero on both → similar.
  const meanDelta = perK.reduce((s, p) => s + p.deltaMean, 0) / Math.max(1, perK.length)
  let verdict: CompareCurvesResult['verdict']
  if (Math.abs(meanDelta) < 0.02 && Math.abs(areaDelta) < 0.02) verdict = 'similar'
  else if (meanDelta > 0 && areaDelta > 0) verdict = 'a_better'
  else if (meanDelta < 0 && areaDelta < 0) verdict = 'b_better'
  else verdict = 'similar'

  const rationale =
    `mean per-k delta=${meanDelta.toFixed(3)}, area delta=${areaDelta.toFixed(3)}` +
    (firstPassKDelta !== null ? `, first-pass-k delta=${firstPassKDelta}` : '')

  return { perK, areaDelta, firstPassKDelta, verdict, rationale }
}

/** First k at which the curve's per-scenario pass rate reliably hits the threshold. */
export function firstPassK(curve: AdaptationCurve, threshold = 0.5): number | null {
  return curve.points.find((p) => p.passRate >= threshold)?.k ?? null
}

// ── Helpers ──────────────────────────────────────────────────────────────


function bootstrapMeanCi(
  xs: number[],
  resamples: number,
  confidence: number,
  rng: () => number,
): { low: number; high: number } {
  if (xs.length < 2) return { low: xs[0] ?? 0, high: xs[0] ?? 0 }
  const samples = new Array<number>(resamples)
  for (let b = 0; b < resamples; b++) {
    let sum = 0
    for (let i = 0; i < xs.length; i++) sum += xs[Math.floor(rng() * xs.length)]!
    samples[b] = sum / xs.length
  }
  samples.sort((a, b) => a - b)
  const alpha = 1 - confidence
  return {
    low: samples[Math.floor((alpha / 2) * resamples)]!,
    high: samples[Math.min(resamples - 1, Math.ceil((1 - alpha / 2) * resamples) - 1)]!,
  }
}
