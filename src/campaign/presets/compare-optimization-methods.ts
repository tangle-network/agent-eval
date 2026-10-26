/**
 * Compare optimization methods on shared train, selection, and test data.
 * Optimizers receive only train and selection data. After every optimizer
 * finishes, their selected surfaces are measured on the same untouched test
 * data and compared with paired confidence intervals.
 */

/** Optimization method inputs, provenance, results, and comparison contracts. */

/** Equal-budget optimization followed by final measurements and paired method comparisons. */

/** Comparison admission, disjoint partitions, and isolated method/final measurement inputs. */

import { combineAbortSignals } from '../../abort-signal'
import { mapConcurrent } from '../../concurrency'
import type { CostLedgerHandle } from '../../cost-ledger'
import {
  type CampaignEvidenceContext,
  createCampaignEvidenceReceipt,
} from '../../experiment/campaign-evidence'
import {
  defineEvaluationClaim,
  type EvaluationClaim,
  type EvaluationUnitSummary,
  summarizeEvaluationUnits,
} from '../../experiment/claim'
import type { EvidenceReceipt } from '../../experiment/evidence-receipt'
import {
  decidePairedPromotion,
  type PairedPromotionDecision,
} from '../../paired-promotion-decision'
import { meanOrZero } from '../../statistics/mean'
import { contentHash } from '../../verdict-cache'
import { assertCampaignDesign, assertCompleteCampaign } from '../coverage'
import {
  assertIndependentEvaluationSplit,
  captureFinalEvidencePolicy,
  evaluationUnitMap,
  exposeFinalEvidence,
  type FinalEvidencePolicy,
  type FinalEvidenceUse,
  reserveFinalEvidence,
} from '../final-evidence'
import { captureJudge } from '../judge-snapshot'
import {
  type ComparisonCost,
  combineComparisonCosts,
  costFromLedgerSummary,
} from '../optimization-cost'
import {
  executeOptimizationMethod,
  type OptimizationMethod,
  type OptimizationMethodComposition,
  type OptimizationMethodInput,
  type OptimizationMethodProvenance,
  type OptimizationMethodRunOptions,
} from '../optimization-method'
import { type RunCampaignOptions, runCampaign } from '../run-campaign'
import { resolveRunDir } from '../run-dir'
import { campaignBreakdown } from '../score-utils'
import {
  assertSearchHistoryAdmissionOptions,
  type SearchHistoryAdmissionOptions,
  type SearchHistoryCoverage,
} from '../search-history-receipt'
import { createRunCostLedger, fsCampaignStorage } from '../storage'
import { surfaceContentHash } from '../surface-identity'
import type {
  CampaignResult,
  DispatchContext,
  JudgeConfig,
  MutableSurface,
  Scenario,
} from '../types'
import {
  assertComparisonControls,
  assertConfidence,
  minimumBootstrapResamples,
} from './comparison-controls'

export interface OptimizationMethodScore {
  evidence?: { baseline: EvidenceReceipt; winner: EvidenceReceipt }
  name: string
  /** Mean final-test composite of the baseline (identical across methods). */
  baselineComposite: number
  /** Mean final-test composite of this method's selected surface. */
  winnerComposite: number
  /** Mean final-test lift across independent units (winner minus baseline). */
  lift: number
  /** Deciding interval, adjusted for every registered contrast. */
  liftCi: { low: number; high: number }
  decision: PairedPromotionDecision
  /** Search spend reconciled with recorded method calls. Excludes final test scoring. */
  optimizationCost: ComparisonCost
  /** Optimization duration reported by the method. Excludes final test scoring. */
  durationMs?: number
  /** Exact external implementation and run identity, when reported by the method. */
  provenance?: OptimizationMethodProvenance
  /** Paired final-test values used to compute lift and its interval. */
  scenarioScores: Array<{
    scenarioId: string
    baselineComposite: number
    winnerComposite: number
    lift: number
  }>
  /** Scenario means averaged within each registered source unit before inference. */
  unitScores: Array<{
    unitId: string
    scenarios: number
    baselineComposite: number
    winnerComposite: number
    lift: number
  }>
  winnerSurface: MutableSurface
  composition?: OptimizationMethodComposition
  /** 1-based, by descending lift. */
  rank: number
}

export interface OptimizationMethodPairwise {
  /** Higher-ranked method. */
  a: string
  b: string
  /** Mean final-test delta across independent units (a − b). */
  deltaMean: number
  low: number
  high: number
  /** Favored only when the full paired decision clears the registered effect; null is inconclusive. */
  favored: string | null
  decision: PairedPromotionDecision
}

export interface OptimizationMethodComparison {
  claim?: EvaluationClaim
  finalEvidence?: FinalEvidenceUse
  /** Sorted by descending lift; `rank` set accordingly. */
  scores: OptimizationMethodScore[]
  best: OptimizationMethodScore
  /** Best observed method versus each alternative, with simultaneous paired decisions. */
  pairwise: OptimizationMethodPairwise[]
  testScenarioIds: string[]
  units: EvaluationUnitSummary
  observationUnit: 'scenario' | 'registered'
  /** Complete scenario-replicate pairs per contrast, before unit aggregation. */
  pairedCellN: number
  /** Sum of method reports reconciled against each method's recorded calls. */
  optimizationCost: ComparisonCost
  /** Baseline and distinct winner scoring on the final test partition. */
  testCost: ComparisonCost
  /** Optimization plus final test scoring. */
  totalCost: ComparisonCost
  /** Caller-requested simultaneous coverage across all reported contrasts. */
  confidence: number
  /** Bonferroni-adjusted confidence used for each bootstrap interval. */
  intervalConfidence: number
  /** Method-vs-baseline plus all possible method-vs-method contrasts. */
  comparisonCount: number
  /** Deterministic bootstrap and campaign seed. */
  seed: number
  /** Bootstrap draws used for each interval. */
  resamples: number
  /** Agent runs averaged within each test scenario before resampling scenarios. */
  reps: number
  /** Coverage of every method's canonical search history. */
  searchHistory: SearchHistoryCoverage
}

export interface CompareOptimizationMethodsOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch' | 'judges' | 'scenarios'>,
    SearchHistoryAdmissionOptions {
  /** Explicit caller authority and environment for receipts over actual final measurements. */
  evidence?: CampaignEvidenceContext
  claim?: EvaluationClaim
  finalEvidence?: FinalEvidencePolicy
  methods: OptimizationMethod<TScenario, TArtifact>[]
  baselineSurface: MutableSurface
  /** Evidence used by every optimizer to author or fit candidates. */
  trainScenarios: TScenario[]
  /** Candidate acceptance, early-stopping, and optimizer-selection data. */
  selectionScenarios: TScenario[]
  /** Untouched final comparison data. Never passed to an optimization method. */
  testScenarios: TScenario[]
  /** Scores a surface on a scenario. The methods and final test share this function. */
  dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: DispatchContext,
  ) => Promise<TArtifact>
  judges: JudgeConfig<TArtifact, TScenario>[]
  /** Bootstrap resamples for the lift intervals. Default is at least 2000 and
   *  rises when the requested simultaneous confidence needs finer tails. */
  resamples?: number
  /** Shared defaults for each method's train and selection campaigns. */
  optimizationRunOptions?: OptimizationMethodRunOptions<TScenario, TArtifact>
  /** Number of optimization methods to run concurrently. Default 1. */
  optimizationConcurrency?: number
  /** Simultaneous confidence across method-vs-baseline and method-vs-method contrasts.
   *  Each bootstrap interval is Bonferroni-adjusted. Default 0.95. */
  confidence?: number
  /** Shared spend limit across every method's optimizer and evaluation calls plus final scoring. */
  costCeiling?: number
}

/**
 * Compare complete optimization methods on disjoint train, selection, and final test data.
 */
export async function compareOptimizationMethods<TScenario extends Scenario, TArtifact>(
  rawOpts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
): Promise<OptimizationMethodComparison> {
  const s0 = normalizeComparisonOptions({ rawOpts })
  const s1 = await finalTestScoring(s0)
  const s2 = await optimizeAllMethods(s1)
  const s3 = await reserveTestMeasurement(s2)
  const s4 = await measureWinners(s3)
  const s5 = scoreMethods(s4)
  const s6 = pairwiseAgainstBest(s5)
  return comparisonResult(s6)
}

/** The captured options, the derived statistics settings, the run directory and the cost ledger. */
function normalizeComparisonOptions<TScenario extends Scenario, TArtifact>(prev: {
  rawOpts: CompareOptimizationMethodsOptions<TScenario, TArtifact>
}) {
  const { rawOpts } = prev
  const opts = {
    ...rawOpts,
    methods: rawOpts.methods.map((method) => ({ ...method })),
    trainScenarios: structuredClone(rawOpts.trainScenarios),
    selectionScenarios: structuredClone(rawOpts.selectionScenarios),
    testScenarios: structuredClone(rawOpts.testScenarios),
    judges: rawOpts.judges.map(captureJudge),
    claim: rawOpts.claim && defineEvaluationClaim(rawOpts.claim),
    finalEvidence: rawOpts.finalEvidence && captureFinalEvidencePolicy(rawOpts.finalEvidence),
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

  return {
    ...prev,
    opts,
    searchHistoryPolicy,
    seed,
    confidence,
    optimizationConcurrency,
    comparisonCount,
    intervalConfidence,
    minimumResamples,
    resamples,
    evidence,
    evidenceBySurface,
    storage,
    resolvedRunDir,
    baselineSurface,
    costLedger,
  }
}

/** Scoring a surface on the final test set, and aligning the scores to the designed scenarios. */
async function finalTestScoring<TScenario extends Scenario, TArtifact>(
  prev: Awaited<ReturnType<typeof normalizeComparisonOptions<TScenario, TArtifact>>>,
) {
  const {
    opts,
    seed,
    intervalConfidence,
    resamples,
    evidence,
    evidenceBySurface,
    storage,
    resolvedRunDir,
    costLedger,
  } = prev
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
      dispatchRef: `compareOptimizationMethods:${callerDispatchRef(opts)}:${surfaceContentHash(measuredSurface)}`,
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
    return units.units.map((unit) => meanOrZero(values.get(unit.id)!))
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

  return {
    ...prev,
    scoreOnTest,
    scenarioIds,
    unitByScenario,
    units,
    aggregateUnits,
    decisionOptions,
    align,
  }
}

/** Reserve final evidence, then finish every method before the first final-test call. */
async function optimizeAllMethods<TScenario extends Scenario, TArtifact>(
  prev: Awaited<ReturnType<typeof finalTestScoring<TScenario, TArtifact>>>,
) {
  const {
    opts,
    seed,
    optimizationConcurrency,
    storage,
    resolvedRunDir,
    baselineSurface,
    costLedger,
  } = prev
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
  return { ...prev, optimizationOwner, optimized }
}

/** The identity of the final test and the exposure of its evidence. */
async function reserveTestMeasurement<TScenario extends Scenario, TArtifact>(
  prev: Awaited<ReturnType<typeof optimizeAllMethods<TScenario, TArtifact>>>,
) {
  const { opts, seed, baselineSurface, optimized } = prev
  const testCostIdentity = contentHash({
    baseline: surfaceContentHash(baselineSurface),
    winners: optimized.map((winner) => ({
      name: winner.name,
      surface: surfaceContentHash(winner.winnerSurface),
    })),
    testScenarios: opts.testScenarios,
    judges: opts.judges.map((judge) => ({
      name: judge.name,
      dimensions: judge.dimensions,
      version:
        judge.judgeVersion ??
        contentHash({
          score: judge.score.toString(),
          appliesTo: judge.appliesTo?.toString() ?? null,
        }),
    })),
    dispatch: callerDispatchRef(opts),
    seed,
    reps: opts.reps ?? 1,
  })
  const testCostPhase = `compareOptimizationMethods.test:${testCostIdentity}`
  const finalEvidence = opts.finalEvidence
    ? await exposeFinalEvidence(opts.finalEvidence, opts.claim, opts.testScenarios, [
        baselineSurface,
        ...optimized.map((method) => method.winnerSurface),
      ])
    : undefined
  return { ...prev, testCostIdentity, testCostPhase, finalEvidence }
}

/** One final-test measurement per distinct surface. */
async function measureWinners<TScenario extends Scenario, TArtifact>(
  prev: Awaited<ReturnType<typeof reserveTestMeasurement<TScenario, TArtifact>>>,
) {
  const { baselineSurface, scoreOnTest, align, optimized, testCostPhase } = prev
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

  return { ...prev, baselineArr, testScoresBySurface, winners }
}

/** Per-method scores, ranked by lift with cost breaking complete ties. */
function scoreMethods<TScenario extends Scenario, TArtifact>(
  prev: Awaited<ReturnType<typeof measureWinners<TScenario, TArtifact>>>,
) {
  const {
    evidence,
    evidenceBySurface,
    baselineSurface,
    scenarioIds,
    units,
    aggregateUnits,
    decisionOptions,
    baselineArr,
    winners,
  } = prev
  const scores: OptimizationMethodScore[] = winners.map((w) => {
    const baselineUnits = aggregateUnits(baselineArr)
    const winnerUnits = aggregateUnits(w.arr)
    const decision = decidePairedPromotion(baselineUnits, winnerUnits, decisionOptions)
    const score: OptimizationMethodScore = {
      name: w.name,
      baselineComposite: meanOrZero(baselineUnits),
      winnerComposite: meanOrZero(winnerUnits),
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

  return { ...prev, scores, best }
}

/** The best method against every other, in both directions. */
function pairwiseAgainstBest<TScenario extends Scenario, TArtifact>(
  prev: Awaited<ReturnType<typeof scoreMethods<TScenario, TArtifact>>>,
) {
  const { aggregateUnits, decisionOptions, winners, scores, best } = prev
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

  return { ...prev, byName, bestArr, pairwise }
}

/** Total cost against the ceiling, then the comparison record. */
function comparisonResult<TScenario extends Scenario, TArtifact>(
  prev: Awaited<ReturnType<typeof pairwiseAgainstBest<TScenario, TArtifact>>>,
): OptimizationMethodComparison {
  const {
    opts,
    searchHistoryPolicy,
    seed,
    confidence,
    comparisonCount,
    intervalConfidence,
    resamples,
    costLedger,
    scenarioIds,
    units,
    optimized,
    testCostPhase,
    finalEvidence,
    scores,
    best,
    pairwise,
  } = prev
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

function assertReportedCostWithinCeiling(
  totalCostUsd: number,
  costCeiling: number | undefined,
  phase: 'optimization' | 'total',
): void {
  const tolerance =
    Number.EPSILON * Math.max(1, Math.abs(totalCostUsd), Math.abs(costCeiling ?? 0)) * 8
  if (costCeiling !== undefined && totalCostUsd > costCeiling + tolerance) {
    throw new Error(
      `compareOptimizationMethods: reported ${phase} cost ${totalCostUsd} exceeds costCeiling ${costCeiling}`,
    )
  }
}

function assertOptimizationMethods<TScenario extends Scenario, TArtifact>(
  methods: readonly OptimizationMethod<TScenario, TArtifact>[],
): void {
  if (!Array.isArray(methods) || methods.length === 0) {
    throw new Error('compareOptimizationMethods: no methods to compare')
  }
  const names = new Set<string>()
  const pathOwners = new Map<string, string>()
  for (const method of methods) {
    if (!method || typeof method !== 'object' || typeof method.optimize !== 'function') {
      throw new Error('compareOptimizationMethods: every method must provide optimize(input)')
    }
    if (!method.name || method.name.trim() !== method.name) {
      throw new Error('compareOptimizationMethods: method names must be trimmed and non-empty')
    }
    if (names.has(method.name)) {
      throw new Error(`compareOptimizationMethods: duplicate method name '${method.name}'`)
    }
    names.add(method.name)
    const pathKey = slug(method.name)
    const prior = pathOwners.get(pathKey)
    if (prior) {
      throw new Error(
        `compareOptimizationMethods: method names '${prior}' and '${method.name}' map to the same run path '${pathKey}'`,
      )
    }
    pathOwners.set(pathKey, method.name)
  }
}

function assertComparisonPartitions<TScenario extends Scenario, TArtifact>(
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
): void {
  const partitions: Array<{
    name: 'trainScenarios' | 'selectionScenarios' | 'testScenarios'
    scenarios: TScenario[] | undefined
  }> = [
    { name: 'trainScenarios', scenarios: opts.trainScenarios },
    { name: 'selectionScenarios', scenarios: opts.selectionScenarios },
    { name: 'testScenarios', scenarios: opts.testScenarios },
  ]

  const owner = new Map<string, string>()
  for (const partition of partitions) {
    if (!Array.isArray(partition.scenarios) || partition.scenarios.length === 0) {
      throw new Error(`compareOptimizationMethods: ${partition.name} is empty`)
    }
    if (partition.name === 'testScenarios' && partition.scenarios.length < 2) {
      throw new Error(
        'compareOptimizationMethods: testScenarios requires at least 2 scenarios to estimate uncertainty',
      )
    }
    const local = new Set<string>()
    const duplicates = new Set<string>()
    const overlaps = new Map<string, string>()
    for (const scenario of partition.scenarios) {
      if (local.has(scenario.id)) duplicates.add(scenario.id)
      local.add(scenario.id)
      const prior = owner.get(scenario.id)
      if (prior !== undefined && prior !== partition.name) overlaps.set(scenario.id, prior)
    }
    if (duplicates.size > 0) {
      throw new Error(
        `compareOptimizationMethods: ${partition.name} contains duplicate scenario id(s) [${[
          ...duplicates,
        ].join(', ')}]`,
      )
    }
    if (overlaps.size > 0) {
      const detail = [...overlaps]
        .map(([id, prior]) => `${id} (${prior} ∩ ${partition.name})`)
        .join(', ')
      throw new Error(
        `compareOptimizationMethods: trainScenarios, selectionScenarios, and testScenarios must be pairwise disjoint; overlap: [${detail}]`,
      )
    }
    assertCampaignDesign(partition.scenarios, opts.reps ?? 1)
    for (const id of local) owner.set(id, partition.name)
  }
}

function slug(name: string): string {
  return (
    name
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'method'
  )
}

function createOptimizationMethodInput<TScenario extends Scenario, TArtifact>(
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
  methodName: string,
  resolvedRunDir: string,
  seed: number,
  baselineSurface: MutableSurface,
  costLedger: CostLedgerHandle,
  optimizationSignal: AbortSignal,
): OptimizationMethodInput<TScenario, TArtifact> {
  const methodRunDir = `${resolvedRunDir}/optimization/${slug(methodName)}`
  const signal = combineAbortSignals(
    opts.signal,
    opts.optimizationRunOptions?.signal,
    optimizationSignal,
  )
  return Object.freeze({
    baselineSurface: structuredClone(baselineSurface),
    trainScenarios: opts.trainScenarios,
    selectionScenarios: opts.selectionScenarios,
    dispatchWithSurface: opts.dispatchWithSurface,
    judges: opts.judges,
    runDir: methodRunDir,
    seed,
    runOptions: Object.freeze({
      ...(opts.optimizationRunOptions ?? {}),
      ...(opts.optimizationRunOptions?.dispatchRef === undefined && opts.dispatchRef !== undefined
        ? { dispatchRef: opts.dispatchRef }
        : {}),
      ...(signal ? { signal } : {}),
    }),
    costLedger,
  })
}

function callerDispatchRef<TScenario extends Scenario, TArtifact>(
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
): string {
  return (opts.dispatchRef ?? opts.dispatchWithSurface.name) || 'anonymous'
}
