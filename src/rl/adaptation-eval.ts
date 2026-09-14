/**
 * Sample-efficient adaptation evaluation.
 *
 * An adaptation curve records scores after k demonstrations or training steps.
 * Comparison pairs the same scenarios and resamples their whole curves.
 * The normalized area summarizes performance over the observed k range.
 * A first-pass k is descriptive and carries no separate reliability claim.
 */

import { ValidationError } from '../errors'
import { decidePairedPromotion, type PairedPromotionDecision } from '../paired-promotion-decision'
import { type PairedBootstrapResult, pairedBootstrap } from '../statistics'

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
  /** Score threshold for a pass and pass-rate threshold for firstPassK. Default 0.5. */
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
   * Trapezoidal area over the observed k intervals, divided by max-k.
   * No performance is inferred below the first observed k.
   */
  adaptationArea: number
}

export async function runAdaptationCurve<S extends { scenarioId: string }>(
  opts: RunAdaptationCurveOptions<S>,
): Promise<AdaptationCurve> {
  const ks = opts.ks ?? [0, 1, 2, 4, 8, 16]
  const reps = opts.reps ?? 3
  const passThreshold = opts.passThreshold ?? 0.5
  assertKs(ks, 'runAdaptationCurve')
  assertScenarioIds(opts.scenarios, 'runAdaptationCurve')
  if (!Number.isInteger(reps) || reps < 1) {
    throw new ValidationError('runAdaptationCurve: reps must be a positive integer')
  }
  if (!Number.isFinite(passThreshold) || passThreshold < 0 || passThreshold > 1) {
    throw new ValidationError('runAdaptationCurve: passThreshold must be in [0,1]')
  }
  const sortedKs = [...ks].sort((a, b) => a - b)

  const points: AdaptationPoint[] = []
  for (const k of sortedKs) {
    const perScenario: AdaptationPoint['perScenario'] = []
    const allScores: number[] = []
    let totalPasses = 0
    let totalAttempts = 0
    for (const scenario of opts.scenarios) {
      const sid = scenario.scenarioId
      const scores: number[] = []
      let passes = 0
      for (let r = 0; r < reps; r++) {
        const score = await opts.runner.run({ scenario, k, rep: r })
        assertScore(score, `runAdaptationCurve: scenario '${sid}', k=${k}, rep=${r}`)
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
  // Only observed intervals contribute; an unmeasured prefix is not extrapolated.
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
    /** Paired A − B score differences; intervals are descriptive across k. */
    delta: PairedBootstrapResult
  }>
  /** Descriptive paired A − B areas, computed within each scenario before resampling. */
  areaDelta: PairedBootstrapResult
  /** Decisions from the shared paired inference rules; intervals may differ from the bootstrap. */
  aImprovement: PairedPromotionDecision
  bImprovement: PairedPromotionDecision
  /** Independent sampling units; repetitions never increase this count. */
  scenarioIds: string[]
  /** Only the area decisions determine direction. Inconclusive does not mean equivalent. */
  verdict: 'a_better' | 'b_better' | 'inconclusive' | 'insufficient_evidence'
  /** Rationale, ready to render. */
  rationale: string
}

/**
 * Compare identical scenario cohorts on identical k grids, paired by scenarioId.
 * Missing pairs, duplicate identities, and cohort changes across k are refused.
 * The bootstrap resamples whole scenarios, preserving dependence across k.
 * Per-k intervals describe the curve; shared paired area decisions determine the verdict.
 * Bootstrap eligibility is necessary but does not establish scenario independence.
 */
export function compareAdaptationCurves(
  a: AdaptationCurve,
  b: AdaptationCurve,
  opts: {
    confidence?: number
    bootstrapResamples?: number
    seed?: number
    /** Minimum worthwhile difference in normalized area. Default 0. */
    minimumEffect?: number
  } = {},
): CompareCurvesResult {
  const confidence = opts.confidence ?? 0.95
  const resamples = opts.bootstrapResamples ?? 2000
  const minimumEffect = opts.minimumEffect ?? 0
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new ValidationError('compareAdaptationCurves: confidence must be in (0,1)')
  }
  if (!Number.isInteger(resamples) || resamples < 1) {
    throw new ValidationError(
      'compareAdaptationCurves: bootstrapResamples must be a positive integer',
    )
  }
  if (!Number.isFinite(minimumEffect) || minimumEffect < 0 || minimumEffect > 1) {
    throw new ValidationError('compareAdaptationCurves: minimumEffect must be in [0,1]')
  }
  const aPoints = indexCurve(a, 'A')
  const bPoints = indexCurve(b, 'B')
  const ks = [...aPoints.keys()].sort((x, y) => x - y)
  const missingInA = [...bPoints.keys()].filter((k) => !aPoints.has(k))
  const missingInB = ks.filter((k) => !bPoints.has(k))
  if (missingInA.length > 0 || missingInB.length > 0) {
    throw new ValidationError(
      `compareAdaptationCurves: k grids differ; missing in A=[${missingInA}], missing in B=[${missingInB}]`,
    )
  }
  const scenarioIds = [...aPoints.get(ks[0]!)!.keys()].sort()
  const expectedIds = new Set(scenarioIds)
  for (const [arm, points] of [
    ['A', aPoints],
    ['B', bPoints],
  ] as const) {
    for (const [k, cells] of points) {
      const missing = scenarioIds.filter((id) => !cells.has(id))
      const extra = [...cells.keys()].filter((id) => !expectedIds.has(id))
      if (missing.length > 0 || extra.length > 0) {
        throw new ValidationError(
          `compareAdaptationCurves: scenario pairs differ in ${arm} at k=${k}; missing=[${missing}], unexpected=[${extra}]`,
        )
      }
    }
  }
  const bootstrapOptions = { confidence, resamples, statistic: 'mean' as const, seed: opts.seed }
  const perK = ks.map((k) => ({
    k,
    delta: pairedBootstrap(
      scenarioIds.map((id) => bPoints.get(k)!.get(id)!),
      scenarioIds.map((id) => aPoints.get(k)!.get(id)!),
      bootstrapOptions,
    ),
  }))
  const aAreas = scenarioIds.map((id) => scenarioArea(ks, aPoints, id))
  const bAreas = scenarioIds.map((id) => scenarioArea(ks, bPoints, id))
  const decisionOptions = {
    ...bootstrapOptions,
    threshold: minimumEffect,
  }
  const aImprovement = decidePairedPromotion(bAreas, aAreas, decisionOptions)
  const bImprovement = decidePairedPromotion(aAreas, bAreas, decisionOptions)
  const areaDelta = aImprovement.bootstrap ?? pairedBootstrap(bAreas, aAreas, bootstrapOptions)
  let verdict: CompareCurvesResult['verdict']
  if (!aImprovement.sufficient || ks.length < 2) verdict = 'insufficient_evidence'
  else if (aImprovement.promote) verdict = 'a_better'
  else if (bImprovement.promote) verdict = 'b_better'
  else verdict = 'inconclusive'

  const rationale =
    `paired scenarios=${scenarioIds.length}, area delta=${areaDelta.mean.toFixed(3)}, ` +
    `${confidence * 100}% ${aImprovement.statistic} interval=[${aImprovement.low.toFixed(3)}, ${aImprovement.high.toFixed(3)}], ` +
    `minimum effect=${minimumEffect}; ${verdict}`

  return { perK, areaDelta, aImprovement, bImprovement, scenarioIds, verdict, rationale }
}

/** First observed k whose pass rate reaches the threshold; this is a descriptive summary. */
export function firstPassK(curve: AdaptationCurve, threshold = 0.5): number | null {
  return curve.points.find((p) => p.passRate >= threshold)?.k ?? null
}

// ── Helpers ──────────────────────────────────────────────────────────────

function assertKs(ks: number[], where: string): void {
  if (ks.length === 0 || ks.some((k) => !Number.isInteger(k) || k < 0)) {
    throw new ValidationError(`${where}: ks must contain nonnegative integers`)
  }
  if (new Set(ks).size !== ks.length) {
    throw new ValidationError(`${where}: duplicate k values`)
  }
}

function assertScenarioIds(cells: Array<{ scenarioId: string }>, where: string): void {
  if (cells.length === 0 || cells.some((cell) => !cell.scenarioId?.trim())) {
    throw new ValidationError(`${where}: scenarios must have explicit nonempty scenarioId values`)
  }
  const seen = new Set<string>()
  for (const { scenarioId } of cells) {
    if (seen.has(scenarioId))
      throw new ValidationError(`${where}: duplicate scenarioId '${scenarioId}'`)
    seen.add(scenarioId)
  }
}

function assertScore(score: number, where: string): void {
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    throw new ValidationError(`${where}: score must be finite and in [0,1], got ${score}`)
  }
}

function indexCurve(curve: AdaptationCurve, arm: string): Map<number, Map<string, number>> {
  const where = `compareAdaptationCurves: ${arm}`
  assertKs(
    curve.points.map((point) => point.k),
    where,
  )
  return new Map(
    curve.points.map((point) => {
      assertScenarioIds(point.perScenario, `${where} at k=${point.k}`)
      return [
        point.k,
        new Map(
          point.perScenario.map((cell) => {
            assertScore(cell.meanScore, `${where}: '${cell.scenarioId}' at k=${point.k}`)
            return [cell.scenarioId, cell.meanScore]
          }),
        ),
      ]
    }),
  )
}

function scenarioArea(ks: number[], points: Map<number, Map<string, number>>, id: string): number {
  let area = 0
  for (let i = 1; i < ks.length; i++) {
    const left = ks[i - 1]!
    const right = ks[i]!
    area += ((points.get(left)!.get(id)! + points.get(right)!.get(id)!) * (right - left)) / 2
  }
  const maxK = ks[ks.length - 1]!
  return maxK === 0 ? 0 : area / maxK
}
