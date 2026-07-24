/**
 * Compare optimization methods on shared train, selection, and test data.
 * Optimizers receive only train and selection data. After every optimizer
 * finishes, their selected surfaces are measured on the same untouched test
 * data and compared with paired confidence intervals.
 */

import { combineAbortSignals } from '../../abort-signal'
import { mapConcurrent } from '../../concurrency'
import type { CostLedgerHandle, CostLedgerSummary, CostReceipt } from '../../cost-ledger'
import { pairedBootstrap } from '../../statistics'
import { contentHash } from '../../verdict-cache'
import { assertCampaignDesign } from '../coverage'
import { type RunCampaignOptions, runCampaign } from '../run-campaign'
import { resolveRunDir } from '../run-dir'
import { campaignBreakdown } from '../score-utils'
import { createRunCostLedger, fsCampaignStorage } from '../storage'
import { surfaceContentHash } from '../surface-identity'
import type {
  CampaignResult,
  DispatchContext,
  JudgeConfig,
  MutableSurface,
  Scenario,
} from '../types'

/** Shared campaign settings applied to every optimization method. */
export type OptimizationMethodRunOptions<TScenario extends Scenario, TArtifact> = Omit<
  RunCampaignOptions<TScenario, TArtifact>,
  'costCeiling' | 'costLedger' | 'dispatch' | 'judges' | 'runDir' | 'scenarios' | 'seed'
>

/** Cost reported by a method or by final test scoring. */
export interface ComparisonCost {
  totalCostUsd: number
  accountingComplete: boolean
  incompleteReasons: string[]
}

export interface OptimizationPackageSource {
  kind: 'package'
  /** Whether package identity was inspected or supplied by caller code. */
  evidence: 'observed' | 'declared'
  package: string
  version: string
  sourceUrl?: string
  revision?: string
  /** SHA-256 of all installed module files observed before the run. */
  sourceSha256?: string
}

export interface OptimizationModuleSource {
  module: string
  sourceSha256: string
}

export interface OptimizationPythonRuntime {
  implementation: string
  version: string
}

export interface OptimizationTokenUsage {
  /** All input tokens, including cache reads and cache creation. */
  inputTokens: number
  /** Input tokens served from a provider cache. */
  cachedInputTokens?: number
  /** Input tokens used to create or write a provider cache entry. */
  cacheWriteInputTokens?: number
  outputTokens: number
  /** Reasoning tokens included in `outputTokens`. */
  reasoningTokens?: number
  totalTokens: number
  calls: number
}

export interface OptimizationMethodProvenance {
  /** External optimizer package. */
  source: OptimizationPackageSource
  /** Python bridge package that invoked the optimizer. */
  bridge?: OptimizationPackageSource
  /** Custom engine modules imported by the optimizer. */
  modules?: OptimizationModuleSource[]
  /** Python implementation used by the bridge process. */
  python?: OptimizationPythonRuntime
  /** Exact model identifier configured for optimizer-owned model calls. */
  optimizerModel?: string
  runId: string
  /** Content identity shared by compatible resumptions. */
  compatibleRunId?: string
  resumed: boolean
  evaluationCount: number
  artifactDir: string
  tokenUsage?: OptimizationTokenUsage
}

/** Shared inputs for one optimization method. Final test data is absent. */
export interface OptimizationMethodInput<TScenario extends Scenario, TArtifact> {
  /** Surface every method starts from. */
  readonly baselineSurface: MutableSurface
  /** Evidence used to author or fit candidates. */
  readonly trainScenarios: readonly TScenario[]
  /** Data used for candidate acceptance, early stopping, and model selection. */
  readonly selectionScenarios: readonly TScenario[]
  /** Runs one scenario with a candidate surface. */
  readonly dispatchWithSurface: (
    surface: MutableSurface,
    scenario: TScenario,
    ctx: DispatchContext,
  ) => Promise<TArtifact>
  /** Scores artifacts produced by `dispatchWithSurface`. */
  readonly judges: readonly JudgeConfig<TArtifact, TScenario>[]
  /** Method-specific artifacts are written below this directory. */
  readonly runDir: string
  readonly seed: number
  /** Shared defaults for every method. A method may override them explicitly. */
  readonly runOptions: Readonly<OptimizationMethodRunOptions<TScenario, TArtifact>>
  /** Durable spend account shared by every method and final scoring. */
  readonly costLedger: CostLedgerHandle
}

export interface OptimizationMethodResult {
  /** Surface selected without using the final test partition. */
  winnerSurface: MutableSurface
  /** Optimization spend. Excludes final test scoring. */
  cost: ComparisonCost
  /** Optimization duration. Excludes final test scoring. */
  durationMs?: number
  /** Exact external implementation and run identity, when the method uses one. */
  provenance?: OptimizationMethodProvenance
}

/** A complete optimization method, including candidate generation and selection. */
export interface OptimizationMethod<TScenario extends Scenario = Scenario, TArtifact = unknown> {
  /** Unique, trimmed display name. Its normalized form must also be unique. */
  name: string
  optimize: (
    input: OptimizationMethodInput<TScenario, TArtifact>,
  ) => Promise<OptimizationMethodResult>
}

export interface OptimizationMethodScore {
  name: string
  /** Mean final-test composite of the baseline (identical across methods). */
  baselineComposite: number
  /** Mean final-test composite of this method's selected surface. */
  winnerComposite: number
  /** Mean per-scenario final-test lift (winner minus baseline). */
  lift: number
  /** Simultaneous paired-bootstrap interval for per-scenario lift.
   *  `low > 0` excludes zero after adjustment for all reported contrasts. */
  liftCi: { low: number; high: number }
  /** Optimization spend reported by the method. Excludes final test scoring. */
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
  winnerSurface: MutableSurface
  /** 1-based, by descending lift. */
  rank: number
}

export interface OptimizationMethodPairwise {
  /** Higher-ranked method. */
  a: string
  b: string
  /** Mean per-scenario untouched-test delta (a − b). */
  deltaMean: number
  low: number
  high: number
  /** `a` if the CI clears 0, `b` if it is entirely negative, else `'tie'`. */
  favored: string
}

export interface OptimizationMethodComparison {
  /** Sorted by descending lift; `rank` set accordingly. */
  scores: OptimizationMethodScore[]
  best: OptimizationMethodScore
  /** Best vs each other method, using simultaneous paired-bootstrap intervals. */
  pairwise: OptimizationMethodPairwise[]
  testScenarioIds: string[]
  /** Sum of the costs reported by every optimization method. */
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
}

export interface CompareOptimizationMethodsOptions<TScenario extends Scenario, TArtifact>
  extends Omit<RunCampaignOptions<TScenario, TArtifact>, 'dispatch' | 'judges' | 'scenarios'> {
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
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
): Promise<OptimizationMethodComparison> {
  assertOptimizationMethods(opts.methods)
  assertComparisonPartitions(opts)
  const seed = opts.seed ?? 42
  const confidence = opts.confidence ?? 0.95
  assertConfidence(confidence)
  const optimizationConcurrency = opts.optimizationConcurrency ?? 1
  const comparisonCount = (opts.methods.length * (opts.methods.length + 1)) / 2
  const intervalConfidence = 1 - (1 - confidence) / comparisonCount
  const minimumResamples = minimumBootstrapResamples(confidence, comparisonCount)
  const resamples = opts.resamples ?? Math.max(2000, minimumResamples)
  assertComparisonControls(opts, seed, resamples, confidence)
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
    const byScenario: Record<string, number> = {}
    for (const { scenarioId, composite } of campaignBreakdown(campaign).scenarios) {
      byScenario[scenarioId] = composite
    }
    return byScenario
  }

  // Every surface must have a score for every designed test scenario. Filling a
  // missing score with zero would change the comparison instead of reporting a failed run.
  const scenarioIds = opts.testScenarios.map((s) => s.id).sort()
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
  const optimizationOwner = new AbortController()
  const optimized = await mapConcurrent(opts.methods, optimizationConcurrency, async (method) => {
    try {
      const out = await method.optimize(
        createOptimizationMethodInput(
          opts,
          method.name,
          resolvedRunDir,
          seed,
          baselineSurface,
          costLedger,
          optimizationOwner.signal,
        ),
      )
      assertOptimizationResult(method.name, out)
      const winnerSurface = structuredClone(out.winnerSurface)
      return {
        name: method.name,
        winnerSurface,
        cost: out.cost,
        durationMs: out.durationMs,
        provenance: out.provenance,
      }
    } catch (error) {
      if (!optimizationOwner.signal.aborted) optimizationOwner.abort(error)
      throw error
    }
  })
  assertReportedCostWithinCeiling(
    combineCosts(
      optimized.map((result) => ({
        label: `method '${result.name}'`,
        cost: result.cost,
      })),
    ).totalCostUsd,
    opts.costCeiling,
    'optimization',
  )
  const testCostPhase = finalCostPhase(opts, baselineSurface, optimized, seed)
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
    const boot = pairedBootstrap(baselineArr, w.arr, {
      seed,
      resamples,
      confidence: intervalConfidence,
      statistic: 'mean',
    })
    const score: OptimizationMethodScore = {
      name: w.name,
      baselineComposite: mean(baselineArr),
      winnerComposite: mean(w.arr),
      lift: boot.mean,
      liftCi: { low: boot.low, high: boot.high },
      optimizationCost: w.cost,
      scenarioScores: scenarioIds.map((scenarioId, index) => ({
        scenarioId,
        baselineComposite: baselineArr[index]!,
        winnerComposite: w.arr[index]!,
        lift: w.arr[index]! - baselineArr[index]!,
      })),
      winnerSurface: structuredClone(w.winnerSurface),
      rank: 0,
    }
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
  const bestArr = byName.get(best.name)!.arr
  const pairwise: OptimizationMethodPairwise[] = scores.slice(1).map((other) => {
    const otherArr = byName.get(other.name)!.arr
    // before = other, after = best ⇒ delta = best − other on the test set.
    const boot = pairedBootstrap(otherArr, bestArr, {
      seed,
      resamples,
      confidence: intervalConfidence,
      statistic: 'mean',
    })
    const favored = boot.low > 0 ? best.name : boot.high < 0 ? other.name : 'tie'
    return {
      a: best.name,
      b: other.name,
      deltaMean: boot.mean,
      low: boot.low,
      high: boot.high,
      favored,
    }
  })

  const optimizationCost = combineCosts(
    scores.map((score) => ({ label: `method '${score.name}'`, cost: score.optimizationCost })),
  )
  const testCost = costFromLedgerSummary(costLedger.summary({ phase: testCostPhase }))
  const totalCost = combineCosts([
    { label: 'optimization', cost: optimizationCost },
    { label: 'final test', cost: testCost },
  ])
  assertReportedCostWithinCeiling(totalCost.totalCostUsd, opts.costCeiling, 'total')
  return {
    scores,
    best,
    pairwise,
    testScenarioIds: scenarioIds,
    optimizationCost,
    testCost,
    totalCost,
    confidence,
    intervalConfidence,
    comparisonCount,
    seed,
    resamples,
    reps: opts.reps ?? 1,
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

export function assertOptimizationResult(name: string, result: OptimizationMethodResult): void {
  if (!result || typeof result !== 'object') {
    throw new Error(`compareOptimizationMethods: method '${name}' returned no result`)
  }
  try {
    surfaceContentHash(result.winnerSurface)
  } catch (cause) {
    throw new Error(
      `compareOptimizationMethods: method '${name}' returned an invalid winnerSurface`,
      { cause },
    )
  }
  assertComparisonCost(result.cost, `method '${name}'`)
  if (
    result.durationMs !== undefined &&
    (!Number.isFinite(result.durationMs) || result.durationMs < 0)
  ) {
    throw new Error(`compareOptimizationMethods: method '${name}' returned an invalid durationMs`)
  }
  if (result.provenance !== undefined) {
    assertOptimizationProvenance(name, result.provenance)
  }
}

function assertOptimizationProvenance(
  methodName: string,
  value: OptimizationMethodProvenance,
): void {
  const fail = (field: string): never => {
    throw new Error(
      `compareOptimizationMethods: method '${methodName}' returned invalid provenance.${field}`,
    )
  }
  if (!value || typeof value !== 'object') fail('value')
  if (
    !value.source ||
    value.source.kind !== 'package' ||
    !['observed', 'declared'].includes(value.source.evidence) ||
    typeof value.source.package !== 'string' ||
    !value.source.package.trim() ||
    typeof value.source.version !== 'string' ||
    !value.source.version.trim()
  ) {
    fail('source')
  }
  for (const [field, entry] of [
    ['sourceUrl', value.source.sourceUrl],
    ['revision', value.source.revision],
  ] as const) {
    if (entry !== undefined && (typeof entry !== 'string' || !entry.trim())) fail(`source.${field}`)
  }
  if (typeof value.runId !== 'string' || !value.runId.trim()) fail('runId')
  if (
    value.optimizerModel !== undefined &&
    (typeof value.optimizerModel !== 'string' ||
      !value.optimizerModel.trim() ||
      value.optimizerModel.trim() !== value.optimizerModel)
  ) {
    fail('optimizerModel')
  }
  if (typeof value.resumed !== 'boolean') fail('resumed')
  if (!Number.isSafeInteger(value.evaluationCount) || value.evaluationCount < 0) {
    fail('evaluationCount')
  }
  if (typeof value.artifactDir !== 'string' || !value.artifactDir.trim()) fail('artifactDir')
  if (value.tokenUsage !== undefined) {
    for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'calls'] as const) {
      if (!Number.isSafeInteger(value.tokenUsage[field]) || value.tokenUsage[field] < 0) {
        fail(`tokenUsage.${field}`)
      }
    }
    for (const field of [
      'cachedInputTokens',
      'cacheWriteInputTokens',
      'reasoningTokens',
    ] as const) {
      const entry = value.tokenUsage[field]
      if (entry !== undefined && (!Number.isSafeInteger(entry) || entry < 0)) {
        fail(`tokenUsage.${field}`)
      }
    }
    if (
      (value.tokenUsage.cachedInputTokens ?? 0) + (value.tokenUsage.cacheWriteInputTokens ?? 0) >
      value.tokenUsage.inputTokens
    ) {
      fail('tokenUsage.inputTokens')
    }
    if (
      value.tokenUsage.reasoningTokens !== undefined &&
      value.tokenUsage.reasoningTokens > value.tokenUsage.outputTokens
    ) {
      fail('tokenUsage.reasoningTokens')
    }
    if (
      value.tokenUsage.totalTokens !==
      value.tokenUsage.inputTokens + value.tokenUsage.outputTokens
    ) {
      fail('tokenUsage.totalTokens')
    }
  }
}

function assertComparisonControls<TScenario extends Scenario, TArtifact>(
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
  seed: number,
  resamples: number,
  confidence: number,
): void {
  if (
    opts.optimizationRunOptions &&
    'costCeiling' in (opts.optimizationRunOptions as unknown as Record<string, unknown>)
  ) {
    throw new Error(
      'compareOptimizationMethods: optimizationRunOptions.costCeiling is not supported; costCeiling covers optimization and final scoring',
    )
  }
  if (!opts.judges || opts.judges.length === 0) {
    throw new Error('compareOptimizationMethods: at least one judge is required')
  }
  if (typeof opts.dispatchWithSurface !== 'function') {
    throw new Error('compareOptimizationMethods: dispatchWithSurface must be a function')
  }
  if (
    opts.dispatchRef !== undefined &&
    (typeof opts.dispatchRef !== 'string' ||
      opts.dispatchRef.trim().length === 0 ||
      opts.dispatchRef.trim() !== opts.dispatchRef)
  ) {
    throw new Error(
      'compareOptimizationMethods: dispatchRef must be trimmed and non-empty when provided',
    )
  }
  const optimizationDispatchRef = opts.optimizationRunOptions?.dispatchRef
  if (
    optimizationDispatchRef !== undefined &&
    (typeof optimizationDispatchRef !== 'string' ||
      optimizationDispatchRef.trim().length === 0 ||
      optimizationDispatchRef.trim() !== optimizationDispatchRef)
  ) {
    throw new Error(
      'compareOptimizationMethods: optimizationRunOptions.dispatchRef must be trimmed and non-empty when provided',
    )
  }
  if (
    opts.dispatchRef !== undefined &&
    optimizationDispatchRef !== undefined &&
    opts.dispatchRef !== optimizationDispatchRef
  ) {
    throw new Error(
      'compareOptimizationMethods: dispatchRef must match optimizationRunOptions.dispatchRef when both are provided',
    )
  }
  try {
    surfaceContentHash(opts.baselineSurface)
  } catch (cause) {
    throw new Error('compareOptimizationMethods: baselineSurface is invalid', { cause })
  }
  const judgeNames = new Set<string>()
  for (const judge of opts.judges) {
    if (
      !judge ||
      typeof judge !== 'object' ||
      typeof judge.name !== 'string' ||
      judge.name.trim().length === 0 ||
      judge.name.trim() !== judge.name ||
      typeof judge.score !== 'function' ||
      !Array.isArray(judge.dimensions) ||
      judge.dimensions.length === 0
    ) {
      throw new Error(
        'compareOptimizationMethods: every judge needs a trimmed name, at least one dimension, and score(input)',
      )
    }
    if (judgeNames.has(judge.name)) {
      throw new Error(`compareOptimizationMethods: duplicate judge name '${judge.name}'`)
    }
    judgeNames.add(judge.name)
    const dimensionKeys = new Set<string>()
    for (const dimension of judge.dimensions) {
      if (
        !dimension ||
        typeof dimension.key !== 'string' ||
        dimension.key.trim().length === 0 ||
        dimension.key.trim() !== dimension.key ||
        typeof dimension.description !== 'string' ||
        dimension.description.trim().length === 0
      ) {
        throw new Error(
          `compareOptimizationMethods: judge '${judge.name}' has an invalid dimension`,
        )
      }
      if (dimensionKeys.has(dimension.key)) {
        throw new Error(
          `compareOptimizationMethods: judge '${judge.name}' has duplicate dimension '${dimension.key}'`,
        )
      }
      dimensionKeys.add(dimension.key)
    }
  }
  if (typeof opts.runDir !== 'string' || opts.runDir.trim().length === 0) {
    throw new Error('compareOptimizationMethods: runDir must be a non-empty string')
  }
  if (!Number.isSafeInteger(seed)) {
    throw new Error(`compareOptimizationMethods: seed must be a safe integer, got ${String(seed)}`)
  }
  if (!Number.isSafeInteger(resamples) || resamples <= 0 || resamples > 1_000_000) {
    throw new Error(
      `compareOptimizationMethods: resamples must be a positive safe integer no greater than 1000000, got ${String(resamples)}`,
    )
  }
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new Error(
      `compareOptimizationMethods: confidence must be a finite number in (0,1), got ${String(confidence)}`,
    )
  }
  const minimumResamples = minimumBootstrapResamples(
    confidence,
    (opts.methods.length * (opts.methods.length + 1)) / 2,
  )
  if (resamples < minimumResamples) {
    throw new Error(
      `compareOptimizationMethods: resamples must be at least ${minimumResamples} for simultaneous confidence ${confidence} across ${opts.methods.length} methods, got ${resamples}`,
    )
  }
  if (
    opts.optimizationConcurrency !== undefined &&
    (!Number.isSafeInteger(opts.optimizationConcurrency) || opts.optimizationConcurrency <= 0)
  ) {
    throw new Error(
      'compareOptimizationMethods: optimizationConcurrency must be a positive safe integer',
    )
  }
  if (
    opts.maxConcurrency !== undefined &&
    (!Number.isSafeInteger(opts.maxConcurrency) || opts.maxConcurrency <= 0)
  ) {
    throw new Error('compareOptimizationMethods: maxConcurrency must be a positive safe integer')
  }
  if (
    opts.dispatchTimeoutMs !== undefined &&
    (!Number.isSafeInteger(opts.dispatchTimeoutMs) ||
      opts.dispatchTimeoutMs < 0 ||
      opts.dispatchTimeoutMs > 2_147_483_647)
  ) {
    throw new Error(
      'compareOptimizationMethods: dispatchTimeoutMs must be a non-negative safe integer no greater than 2147483647',
    )
  }
  if (
    opts.costCeiling !== undefined &&
    (!Number.isFinite(opts.costCeiling) || opts.costCeiling < 0)
  ) {
    throw new Error(
      'compareOptimizationMethods: costCeiling must be a finite number greater than or equal to 0',
    )
  }
  if (
    opts.costCeiling !== undefined &&
    opts.costLedger !== undefined &&
    opts.costLedger.costCeilingUsd !== opts.costCeiling
  ) {
    throw new Error(
      'compareOptimizationMethods: costCeiling must match the shared CostLedger ceiling',
    )
  }
}

function assertComparisonPartitions<TScenario extends Scenario, TArtifact>(
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
): void {
  const legacy = opts as CompareOptimizationMethodsOptions<TScenario, TArtifact> & {
    holdoutScenarios?: unknown
  }
  if (legacy.holdoutScenarios !== undefined) {
    throw new Error(
      'compareOptimizationMethods: holdoutScenarios is ambiguous and no longer accepted. Provide disjoint trainScenarios, selectionScenarios, and testScenarios; selection may be reused adaptively, test must remain untouched.',
    )
  }

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

function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length
}

function slug(name: string): string {
  return (
    name
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'method'
  )
}

function assertConfidence(confidence: number): void {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new Error(
      `compareOptimizationMethods: confidence must be a finite number in (0,1), got ${String(confidence)}`,
    )
  }
}

function minimumBootstrapResamples(confidence: number, comparisonCount: number): number {
  const exact = (2 * comparisonCount) / (1 - confidence)
  return Math.ceil(exact - Number.EPSILON * Math.max(1, exact) * 32)
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
  const cloneScenarios = (scenarios: readonly TScenario[]): readonly TScenario[] =>
    Object.freeze(scenarios.map((scenario) => structuredClone(scenario)))
  const judges = opts.judges.map((judge) =>
    Object.freeze({
      ...judge,
      dimensions: Object.freeze(
        judge.dimensions.map((dimension) => Object.freeze({ ...dimension })),
      ),
    }),
  ) as JudgeConfig<TArtifact, TScenario>[]
  const signal = combineAbortSignals(
    opts.signal,
    opts.optimizationRunOptions?.signal,
    optimizationSignal,
  )
  return Object.freeze({
    baselineSurface: structuredClone(baselineSurface),
    trainScenarios: cloneScenarios(opts.trainScenarios),
    selectionScenarios: cloneScenarios(opts.selectionScenarios),
    dispatchWithSurface: opts.dispatchWithSurface,
    judges: Object.freeze(judges),
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

function finalCostPhase<TScenario extends Scenario, TArtifact>(
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
  baselineSurface: MutableSurface,
  winners: readonly { name: string; winnerSurface: MutableSurface }[],
  seed: number,
): string {
  const identity = contentHash({
    baseline: surfaceContentHash(baselineSurface),
    winners: winners.map((winner) => ({
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
  return `compareOptimizationMethods.test:${identity}`
}

function finalDispatchRef<TScenario extends Scenario, TArtifact>(
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
  surface: MutableSurface,
): string {
  return `compareOptimizationMethods:${callerDispatchRef(opts)}:${surfaceContentHash(surface)}`
}

function callerDispatchRef<TScenario extends Scenario, TArtifact>(
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
): string {
  return (opts.dispatchRef ?? opts.dispatchWithSurface.name) || 'anonymous'
}

/** Keep the cost fields a custom optimization method must report. */
export function costFromLedgerSummary(summary: CostLedgerSummary): ComparisonCost {
  const cost = {
    totalCostUsd: summary.totalCostUsd,
    accountingComplete: summary.accountingComplete,
    incompleteReasons: [...summary.incompleteReasons],
  }
  assertComparisonCost(cost, 'cost ledger')
  return cost
}

/** Preserve every optimizer token class while keeping total input and output explicit. */
export function optimizationTokenUsageFromSummary(
  summary: CostLedgerSummary,
  receipts: readonly CostReceipt[],
): OptimizationTokenUsage | undefined {
  if (!summary.usageComplete) return undefined
  if (receipts.length !== summary.totalCalls) {
    throw new Error('optimization token usage receipt count does not match the cost summary')
  }
  const cachedInputTokens = summary.cachedTokens
  const cacheWriteInputTokens = summary.cacheWriteTokens ?? 0
  const inputTokens = summary.inputTokens + cachedInputTokens + cacheWriteInputTokens
  const cacheReadComplete =
    receipts.length === 0 || receipts.every((receipt) => receipt.cachedTokens !== undefined)
  const cacheWriteComplete =
    receipts.length === 0 || receipts.every((receipt) => receipt.cacheWriteTokens !== undefined)
  const reasoningComplete =
    receipts.length === 0 || receipts.every((receipt) => receipt.reasoningTokens !== undefined)
  return {
    inputTokens,
    ...(cacheReadComplete ? { cachedInputTokens } : {}),
    ...(cacheWriteComplete ? { cacheWriteInputTokens } : {}),
    outputTokens: summary.outputTokens,
    ...(reasoningComplete ? { reasoningTokens: summary.reasoningTokens ?? 0 } : {}),
    totalTokens: inputTokens + summary.outputTokens,
    calls: summary.totalCalls,
  }
}

function combineCosts(entries: Array<{ label: string; cost: ComparisonCost }>): ComparisonCost {
  return {
    totalCostUsd: entries.reduce((total, entry) => total + entry.cost.totalCostUsd, 0),
    accountingComplete: entries.every((entry) => entry.cost.accountingComplete),
    incompleteReasons: entries.flatMap((entry) =>
      entry.cost.incompleteReasons.map((reason) => `${entry.label}: ${reason}`),
    ),
  }
}

function assertComparisonCost(cost: ComparisonCost, label: string): void {
  if (!cost || typeof cost !== 'object') {
    throw new Error(`compareOptimizationMethods: ${label} returned no cost`)
  }
  if (!Number.isFinite(cost.totalCostUsd) || cost.totalCostUsd < 0) {
    throw new Error(`compareOptimizationMethods: ${label} returned an invalid totalCostUsd`)
  }
  if (typeof cost.accountingComplete !== 'boolean') {
    throw new Error(`compareOptimizationMethods: ${label} returned invalid accountingComplete`)
  }
  if (
    !Array.isArray(cost.incompleteReasons) ||
    cost.incompleteReasons.some(
      (reason) => typeof reason !== 'string' || reason.trim().length === 0,
    )
  ) {
    throw new Error(`compareOptimizationMethods: ${label} returned invalid incompleteReasons`)
  }
  if (cost.accountingComplete !== (cost.incompleteReasons.length === 0)) {
    throw new Error(
      `compareOptimizationMethods: ${label} returned inconsistent cost completeness and reasons`,
    )
  }
}
