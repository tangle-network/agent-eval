/** Equal-budget optimization followed by final measurements and paired method comparisons. */

import { mapConcurrent } from '../../concurrency'
import { createCampaignEvidenceReceipt } from '../../experiment/campaign-evidence'
import {
  defineEvaluationClaim,
  type EvaluationUnitSummary,
  summarizeEvaluationUnits,
} from '../../experiment/claim'
import type { EvidenceReceipt } from '../../experiment/evidence-receipt'
import { decidePairedPromotion } from '../../paired-promotion-decision'
import { mean as arithmeticMean } from '../../statistics/mean'
import { assertCompleteCampaign } from '../coverage'
import {
  assertIndependentEvaluationSplit,
  captureFinalEvidencePolicy,
  evaluationUnitMap,
  exposeFinalEvidence,
  reserveFinalEvidence,
} from '../final-evidence'
import { captureJudge } from '../judge-snapshot'
import { combineComparisonCosts, costFromLedgerSummary } from '../optimization-cost'
import { executeOptimizationMethod } from '../optimization-method'
import { runCampaign } from '../run-campaign'
import { resolveRunDir } from '../run-dir'
import { campaignBreakdown } from '../score-utils'
import { assertSearchHistoryAdmissionOptions } from '../search-history-receipt'
import { createRunCostLedger, fsCampaignStorage } from '../storage'
import { surfaceContentHash } from '../surface-identity'
import type { CampaignResult, MutableSurface, Scenario } from '../types'
import {
  assertComparisonControls,
  assertComparisonPartitions,
  assertConfidence,
  assertOptimizationMethods,
  assertReportedCostWithinCeiling,
  createOptimizationMethodInput,
  finalCostPhase,
  finalDispatchRef,
  minimumBootstrapResamples,
  slug,
} from './optimization-comparison-input'
import type {
  CompareOptimizationMethodsOptions,
  OptimizationMethodComparison,
  OptimizationMethodPairwise,
  OptimizationMethodScore,
} from './optimization-method-types'

/**
 * Compare complete optimization methods on disjoint train, selection, and final test data.
 */
export async function compareOptimizationMethods<TScenario extends Scenario, TArtifact>(
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
): Promise<OptimizationMethodComparison> {
  opts = {
    ...opts,
    methods: opts.methods.map((method) => ({ ...method })),
    trainScenarios: structuredClone(opts.trainScenarios),
    selectionScenarios: structuredClone(opts.selectionScenarios),
    testScenarios: structuredClone(opts.testScenarios),
    judges: opts.judges.map(captureJudge),
    claim: opts.claim && defineEvaluationClaim(opts.claim),
    finalEvidence: opts.finalEvidence && captureFinalEvidencePolicy(opts.finalEvidence),
  }
  assertOptimizationMethods(opts.methods)
  assertComparisonPartitions(opts)
  const searchHistoryPolicy = opts.searchHistoryPolicy ?? 'allow-missing'
  assertSearchHistoryAdmissionOptions(opts)
  const seed = opts.seed ?? 42
  const confidence = opts.confidence ?? 0.95
  assertConfidence(confidence)
  const optimizationConcurrency = opts.optimizationConcurrency ?? 1
  const comparisonCount = (opts.methods.length * (opts.methods.length + 1)) / 2
  const intervalConfidence = 1 - (1 - confidence) / comparisonCount
  const minimumResamples = minimumBootstrapResamples(confidence, comparisonCount)
  const resamples = opts.resamples ?? Math.max(2000, minimumResamples)
  assertComparisonControls(opts, seed, resamples, confidence)
  const evidence = opts.evidence === undefined ? undefined : structuredClone(opts.evidence)
  const evidenceBySurface = new Map<string, EvidenceReceipt>()
  const storage = opts.storage ?? fsCampaignStorage()
  const resolvedRunDir = resolveRunDir(opts.runDir, opts.repo)
  const baselineSurface = structuredClone(opts.baselineSurface)
  const costLedger =
    opts.costLedger ??
    createRunCostLedger({
      storage,
      runDir: `${resolvedRunDir}/cost`,
      costCeilingUsd: opts.costCeiling,
    })

  const scoreOnTest = async (
    surface: MutableSurface,
    tag: string,
    costPhase: string,
  ): Promise<Record<string, number>> => {
    const measuredSurface = structuredClone(surface)
    const campaign: CampaignResult<TArtifact, TScenario> = await runCampaign<TScenario, TArtifact>({
      ...opts,
      storage,
      costLedger,
      costPhase,
      scenarios: opts.testScenarios.map((scenario) => structuredClone(scenario)),
      dispatch: (scenario, ctx) =>
        opts.dispatchWithSurface(structuredClone(measuredSurface), scenario, ctx),
      dispatchRef: finalDispatchRef(opts, measuredSurface),
      runDir: `${resolvedRunDir}/${tag}`,
    })
    assertCompleteCampaign(
      campaign,
      opts.testScenarios,
      opts.reps ?? 1,
      true,
      `compareOptimizationMethods: ${tag} final comparison`,
    )
    if (evidence)
      evidenceBySurface.set(
        surfaceContentHash(measuredSurface),
        createCampaignEvidenceReceipt({ campaign, surface: measuredSurface, context: evidence }),
      )
    const byScenario: Record<string, number> = {}
    for (const { scenarioId, composite } of campaignBreakdown(campaign).scenarios) {
      byScenario[scenarioId] = composite
    }
    return byScenario
  }

  // Every surface must have a score for every designed test scenario. Filling a
  // missing score with zero would change the comparison instead of reporting a failed run.
  const scenarioIds = opts.testScenarios.map((s) => s.id).sort()
  const unitByScenario = opts.claim
    ? evaluationUnitMap(opts.claim, opts.testScenarios)
    : new Map(scenarioIds.map((id) => [id, id]))
  const units: EvaluationUnitSummary = opts.claim
    ? summarizeEvaluationUnits(opts.claim, opts.testScenarios)
    : {
        observations: scenarioIds.length,
        independentUnits: scenarioIds.length,
        units: scenarioIds.map((id) => ({ id, observations: 1 })),
      }
  const aggregateUnits = (arr: number[]): number[] => {
    const values = new Map<string, number[]>()
    scenarioIds.forEach((id, index) => {
      const unitId = unitByScenario.get(id)!
      const bucket = values.get(unitId) ?? []
      bucket.push(arr[index]!)
      values.set(unitId, bucket)
    })
    return units.units.map((unit) => mean(values.get(unit.id)!))
  }
  const decisionOptions = {
    seed,
    resamples,
    confidence: intervalConfidence,
    threshold: opts.claim?.minimumEffect ?? 0,
  }
  const align = (byScenario: Record<string, number>, label: string): number[] => {
    const missing = scenarioIds.filter((id) => !(id in byScenario))
    if (missing.length > 0) {
      throw new Error(
        `compareOptimizationMethods: ${label} produced no test score for scenario(s) [${missing.join(
          ', ',
        )}]. A cell failed or its judges returned nothing. Fix the dispatch or judge; the comparison will not replace missing scores with zero.`,
      )
    }
    return scenarioIds.map((id) => byScenario[id]!)
  }

  // Finish every method before the first final-test call. Each method gets
  // independent scenario values so one method cannot mutate another's input.
  if (opts.claim?.generalization === 'new-units') {
    assertIndependentEvaluationSplit(opts.claim, opts.testScenarios, [
      ...opts.trainScenarios,
      ...opts.selectionScenarios,
    ])
  }
  if (opts.finalEvidence) {
    await reserveFinalEvidence(opts.finalEvidence, opts.claim, opts.testScenarios, [
      ...opts.trainScenarios,
      ...opts.selectionScenarios,
    ])
  }
  const optimizationOwner = new AbortController()
  const optimized = await mapConcurrent(opts.methods, optimizationConcurrency, async (method) => {
    try {
      const {
        selected: out,
        cost,
        history: searchHistoryCoverage,
      } = await executeOptimizationMethod({
        method,
        input: createOptimizationMethodInput(
          opts,
          method.name,
          resolvedRunDir,
          seed,
          baselineSurface,
          costLedger,
          optimizationOwner.signal,
        ),
        storage,
        searchHistoryPolicy: opts.searchHistoryPolicy,
        searchHistoryVerification: opts.searchHistoryVerification,
      })
      const winnerSurface = out.winnerSurface
      return {
        name: method.name,
        winnerSurface,
        cost,
        ...(out.durationMs === undefined ? {} : { durationMs: out.durationMs }),
        ...(out.composition === undefined ? {} : { composition: out.composition }),
        ...(out.provenance === undefined ? {} : { provenance: out.provenance }),
        searchHistoryCoverage,
      }
    } catch (error) {
      if (!optimizationOwner.signal.aborted) optimizationOwner.abort(error)
      throw error
    }
  })
  assertReportedCostWithinCeiling(
    combineComparisonCosts(
      optimized.map((result) => ({
        label: `method '${result.name}'`,
        cost: result.cost,
      })),
    ).totalCostUsd,
    opts.costCeiling,
    'optimization',
  )
  const testCostPhase = finalCostPhase(opts, baselineSurface, optimized, seed)
  const finalEvidence = opts.finalEvidence
    ? await exposeFinalEvidence(opts.finalEvidence, opts.claim, opts.testScenarios, [
        baselineSurface,
        ...optimized.map((method) => method.winnerSurface),
      ])
    : undefined
  // Reuse one final-test measurement for identical surfaces. This avoids duplicate
  // spend and prevents model variance from inventing a difference between equal inputs.
  const baselineArr = align(
    await scoreOnTest(baselineSurface, 'test/baseline', testCostPhase),
    'baseline',
  )
  const testScoresBySurface = new Map([[surfaceContentHash(baselineSurface), baselineArr]])
  const winners: Array<(typeof optimized)[number] & { arr: number[] }> = []
  for (const winner of optimized) {
    const surfaceKey = surfaceContentHash(winner.winnerSurface)
    let arr = testScoresBySurface.get(surfaceKey)
    if (!arr) {
      const byScenario = await scoreOnTest(
        winner.winnerSurface,
        `test/methods/${slug(winner.name)}`,
        testCostPhase,
      )
      arr = align(byScenario, `method "${winner.name}"`)
      testScoresBySurface.set(surfaceKey, arr)
    }
    winners.push({
      ...winner,
      arr,
    })
  }

  const scores: OptimizationMethodScore[] = winners.map((w) => {
    const baselineUnits = aggregateUnits(baselineArr)
    const winnerUnits = aggregateUnits(w.arr)
    const decision = decidePairedPromotion(baselineUnits, winnerUnits, decisionOptions)
    const score: OptimizationMethodScore = {
      name: w.name,
      baselineComposite: mean(baselineUnits),
      winnerComposite: mean(winnerUnits),
      lift: decision.delta,
      liftCi: { low: decision.low, high: decision.high },
      decision,
      optimizationCost: w.cost,
      scenarioScores: scenarioIds.map((scenarioId, index) => ({
        scenarioId,
        baselineComposite: baselineArr[index]!,
        winnerComposite: w.arr[index]!,
        lift: w.arr[index]! - baselineArr[index]!,
      })),
      unitScores: units.units.map((unit, index) => ({
        unitId: unit.id,
        scenarios: unit.observations,
        baselineComposite: baselineUnits[index]!,
        winnerComposite: winnerUnits[index]!,
        lift: winnerUnits[index]! - baselineUnits[index]!,
      })),
      winnerSurface: structuredClone(w.winnerSurface),
      rank: 0,
    }
    if (evidence) {
      const baseline = evidenceBySurface.get(surfaceContentHash(baselineSurface))
      const winner = evidenceBySurface.get(surfaceContentHash(w.winnerSurface))
      if (!baseline || !winner) throw new Error('final measurement evidence is missing')
      score.evidence = { baseline, winner }
    }
    if (w.composition !== undefined) score.composition = structuredClone(w.composition)
    if (w.durationMs !== undefined) score.durationMs = w.durationMs
    if (w.provenance !== undefined) score.provenance = structuredClone(w.provenance)
    return score
  })
  scores.sort((a, b) => b.lift - a.lift)
  // Cost orders an equal-lift group only when every method in that group has
  // complete accounting. Otherwise declaration order remains deterministic.
  for (let start = 0; start < scores.length; ) {
    let end = start + 1
    while (end < scores.length && scores[end]!.lift === scores[start]!.lift) end += 1
    const tied = scores.slice(start, end)
    if (tied.every((score) => score.optimizationCost.accountingComplete)) {
      tied.sort((a, b) => a.optimizationCost.totalCostUsd - b.optimizationCost.totalCostUsd)
      scores.splice(start, tied.length, ...tied)
    }
    start = end
  }
  scores.forEach((s, i) => {
    s.rank = i + 1
  })
  const best = scores[0]!

  const byName = new Map(winners.map((w) => [w.name, w]))
  const bestArr = aggregateUnits(byName.get(best.name)!.arr)
  const pairwise: OptimizationMethodPairwise[] = scores.slice(1).map((other) => {
    const otherArr = aggregateUnits(byName.get(other.name)!.arr)
    // before = other, after = best ⇒ delta = best − other on the test set.
    const decision = decidePairedPromotion(otherArr, bestArr, decisionOptions)
    const reverse = decidePairedPromotion(bestArr, otherArr, decisionOptions)
    const favored = decision.promote ? best.name : reverse.promote ? other.name : null
    return {
      a: best.name,
      b: other.name,
      deltaMean: decision.delta,
      low: decision.low,
      high: decision.high,
      favored,
      decision,
    }
  })

  const optimizationCost = combineComparisonCosts(
    scores.map((score) => ({ label: `method '${score.name}'`, cost: score.optimizationCost })),
  )
  const testCost = costFromLedgerSummary(costLedger.summary({ phase: testCostPhase }))
  const totalCost = combineComparisonCosts([
    { label: 'optimization', cost: optimizationCost },
    { label: 'final test', cost: testCost },
  ])
  assertReportedCostWithinCeiling(totalCost.totalCostUsd, opts.costCeiling, 'total')
  return {
    scores,
    best,
    pairwise,
    testScenarioIds: scenarioIds,
    units,
    observationUnit: opts.claim ? 'registered' : 'scenario',
    pairedCellN: scenarioIds.length * (opts.reps ?? 1),
    ...(opts.claim ? { claim: opts.claim } : {}),
    ...(finalEvidence ? { finalEvidence } : {}),
    optimizationCost,
    testCost,
    totalCost,
    confidence,
    intervalConfidence,
    comparisonCount,
    seed,
    resamples,
    reps: opts.reps ?? 1,
    searchHistory: Object.freeze({
      policy: searchHistoryPolicy,
      allComplete: optimized.every((result) => result.searchHistoryCoverage.status === 'complete'),
      producers: Object.freeze(optimized.map((result) => result.searchHistoryCoverage)),
    }),
  }
}

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : arithmeticMean(xs)
}
