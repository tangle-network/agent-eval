/** Optimization method inputs, provenance, results, and comparison contracts. */

import type { CostLedgerHandle } from '../cost-ledger'
import type { ExternalOptimizerWireCounts } from './external-optimizer-contracts'
import type {
  ExternalOptimizerExecutionSummary,
  ExternalOptimizerObservationSummary,
} from './external-optimizer-observations'
import {
  assertGepaCandidatePopulationSummary,
  type GepaCandidatePopulationSummary,
} from './gepa-candidate-population'
import { captureJudge } from './judge-snapshot'
import {
  assertComparisonCost,
  type ComparisonCost,
  combineComparisonCosts,
  createMethodCostScope,
  type OptimizationTokenUsage,
} from './optimization-cost'
import type { RunCampaignOptions } from './run-campaign'
import {
  assertCompleteSearchHistory,
  assertSearchHistoryAdmissionOptions,
  type SearchHistoryAdmissionOptions,
  type SearchHistoryCoverageRow,
  type SearchHistoryReceipt,
  searchHistoryCoverageRow,
  verifySearchHistoryArtifact,
} from './search-history-receipt'
import type { CampaignStorage } from './storage'
import { surfaceContentHash } from './surface-identity'
import type { DispatchContext, JudgeConfig, MutableSurface, Scenario } from './types'

/** Shared campaign settings applied to every optimization method. */
export type OptimizationMethodRunOptions<TScenario extends Scenario, TArtifact> = Omit<
  RunCampaignOptions<TScenario, TArtifact>,
  'costCeiling' | 'costLedger' | 'dispatch' | 'judges' | 'runDir' | 'scenarios' | 'seed'
>

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
  /** Stable public identity of the execution-owner callback. */
  optimizerCallRef?: string
  runId: string
  /** Content identity shared by compatible resumptions. */
  compatibleRunId?: string
  resumed: boolean
  /** Whether the run seed reached every external engine configuration. */
  seedApplied?: boolean
  /** Evaluations the local callback metered — the trusted count. */
  evaluationCount: number
  /**
   * Evaluation total the external optimizer reported from its own counters.
   * A difference from `evaluationCount` means upstream skipped, cached, or
   * double-counted work; inspect before trusting upstream-derived budgets.
   */
  upstreamReportedEvaluations?: number
  artifactDir: string
  tokenUsage?: OptimizationTokenUsage
  /** Candidates submitted to the callback, per-case scores, and refusals. */
  observations?: ExternalOptimizerObservationSummary
  /** Exact accepted GEPA candidates, parent indices, and selection scores. */
  gepaCandidatePopulation?: GepaCandidatePopulationSummary
  /** Opaque Runtime execution evidence for every invoked optimizer-model call. */
  modelExecutions?: ExternalOptimizerExecutionSummary
  /** Anthropic-endpoint proxy traffic from agent CLI engines, when enabled. */
  anthropicEndpoint?: ExternalOptimizerWireCounts
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
  /** Invokes each method at the shared execution boundary, including composed children. */
  invokeMethod?(
    method: OptimizationMethod<TScenario, TArtifact>,
    input: OptimizationMethodInput<TScenario, TArtifact>,
  ): Promise<OptimizationMethodResult>
  /** Maps this method's local surface into the complete outer candidate. */
  readonly surfaceToRoot?: (surface: MutableSurface) => MutableSurface
}

/** Exact child results; costs and usage remain attributable to their owning methods. */
export interface OptimizationMethodComposition {
  kind: 'scoped' | 'sequential'
  baselineSurfaceHash: string
  stages: Array<{
    name: string
    baselineSurfaceHash: string
    result: OptimizationMethodResult
  }>
}

export interface OptimizationMethodResult {
  /** Surface selected without using the final test partition. */
  winnerSurface: MutableSurface
  composition?: OptimizationMethodComposition
  /** Optimization spend. Excludes final test scoring. */
  cost: ComparisonCost
  /** Optimization duration. Excludes final test scoring. */
  durationMs?: number
  /** Exact external implementation and run identity, when the method uses one. */
  provenance?: OptimizationMethodProvenance
  /** Bounded proof envelope over the canonical SearchLedger for this optimization. */
  searchHistory?: SearchHistoryReceipt
}

/** A complete optimization method, including candidate generation and selection. */
export interface OptimizationMethod<TScenario extends Scenario = Scenario, TArtifact = unknown> {
  /** Unique, trimmed display name. Its normalized form must also be unique. */
  name: string
  optimize: (
    input: OptimizationMethodInput<TScenario, TArtifact>,
  ) => Promise<OptimizationMethodResult>
}

/** Both complete-method workflows use the same detached inputs, accounting, and evidence admission. */
export async function executeOptimizationMethod<S extends Scenario, A>(
  options: SearchHistoryAdmissionOptions & {
    method: OptimizationMethod<S, A>
    input: OptimizationMethodInput<S, A>
    storage: CampaignStorage
  },
) {
  assertSearchHistoryAdmissionOptions(options)
  const { method, input } = options
  const costScope = createMethodCostScope(input.costLedger, method.name)
  const cloneScenarios = (scenarios: readonly S[]) =>
    Object.freeze(scenarios.map((scenario) => structuredClone(scenario)))
  const detachedInput: OptimizationMethodInput<S, A> = Object.freeze({
    ...input,
    baselineSurface: structuredClone(input.baselineSurface),
    trainScenarios: cloneScenarios(input.trainScenarios),
    selectionScenarios: cloneScenarios(input.selectionScenarios),
    judges: Object.freeze(input.judges.map(captureJudge)),
    runOptions: Object.freeze({ ...input.runOptions }),
    costLedger: costScope.ledger,
  })
  const selected = structuredClone(
    await (input.invokeMethod
      ? input.invokeMethod(method, detachedInput)
      : method.optimize(detachedInput)),
  )
  assertOptimizationResult(method.name, selected)
  if (
    selected.composition &&
    selected.composition.baselineSurfaceHash !== surfaceContentHash(input.baselineSurface)
  )
    throw new Error(`optimization method '${method.name}' returned a disconnected baseline`)
  const history = admitHistory(method.name, selected, options)
  return { selected, cost: costScope.reconcile(selected.cost), history }
}

function admitHistory(
  name: string,
  result: OptimizationMethodResult,
  options: SearchHistoryAdmissionOptions & { storage: CampaignStorage },
): SearchHistoryCoverageRow {
  if (result.composition) {
    const parent =
      result.searchHistory === undefined
        ? undefined
        : admitHistory(name, { ...result, composition: undefined }, options)
    const stages = result.composition.stages.map((stage) =>
      admitHistory(stage.name, stage.result, options),
    )
    return Object.freeze({
      producerId: name,
      status:
        stages.every((stage) => stage.status === 'complete') &&
        (parent === undefined || parent.status === 'complete')
          ? 'complete'
          : 'incomplete',
      reasons: Object.freeze([
        ...(parent?.reasons ?? []),
        ...stages.flatMap((stage) =>
          stage.reasons.map((reason) => `${stage.producerId}: ${reason}`),
        ),
      ]),
      stages: Object.freeze(stages),
      ...(parent?.receipt ? { receipt: parent.receipt } : {}),
      ...(options.searchHistoryVerification === 'ledger' ? { ledgerVerified: true as const } : {}),
    })
  }
  const history = searchHistoryCoverageRow(name, result.searchHistory)
  if (options.searchHistoryPolicy === 'require-complete')
    assertCompleteSearchHistory(name, result.searchHistory)
  if (options.searchHistoryVerification === 'ledger') {
    if (!result.searchHistory) assertCompleteSearchHistory(name, result.searchHistory)
    verifySearchHistoryArtifact(result.searchHistory, options.storage)
    return Object.freeze({ ...history, ledgerVerified: true as const })
  }
  return history
}

function assertOptimizationResult(name: string, result: OptimizationMethodResult): void {
  assertResult(name, result, new Set())
}

function assertResult(
  name: string,
  result: OptimizationMethodResult,
  ancestors: Set<object>,
): void {
  if (!result || typeof result !== 'object') {
    throw new Error(`compareOptimizationMethods: method '${name}' returned no result`)
  }
  if (ancestors.has(result) || ancestors.size >= 128)
    throw new Error(
      `optimization method '${name}' returned cyclic or excessive composition nesting`,
    )
  ancestors.add(result)
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
  if (result.composition !== undefined) {
    const { kind, stages, baselineSurfaceHash } = result.composition
    if (
      !['scoped', 'sequential'].includes(kind) ||
      !/^sha256:[a-f0-9]{64}$/.test(baselineSurfaceHash) ||
      !Array.isArray(stages) ||
      !stages.length ||
      (kind === 'scoped' && stages.length !== 1)
    ) {
      throw new Error(`optimization method '${name}' returned invalid composition`)
    }
    stages.forEach((stage, index) => {
      if (!stage.name?.trim() || !/^sha256:[a-f0-9]{64}$/.test(stage.baselineSurfaceHash))
        throw new Error(`optimization method '${name}' returned invalid stage identity`)
      assertResult(stage.name, stage.result, ancestors)
      if (
        kind === 'sequential' &&
        index > 0 &&
        stage.baselineSurfaceHash !== surfaceContentHash(stages[index - 1]!.result.winnerSurface)
      )
        throw new Error(`optimization method '${name}' returned disconnected stages`)
    })
    if (kind === 'sequential' && stages[0]!.baselineSurfaceHash !== baselineSurfaceHash)
      throw new Error(`optimization method '${name}' returned a disconnected first stage`)
    const accumulated = combineComparisonCosts(
      stages.map((stage) => ({ label: stage.name, cost: stage.result.cost })),
    )
    if (
      result.cost.totalCostUsd !== accumulated.totalCostUsd ||
      result.cost.accountingComplete !== accumulated.accountingComplete ||
      result.cost.costProvenance.kind !== accumulated.costProvenance.kind
    )
      throw new Error(`optimization method '${name}' returned inconsistent composed cost`)
    if (
      kind === 'sequential' &&
      surfaceContentHash(result.winnerSurface) !==
        surfaceContentHash(stages[stages.length - 1]!.result.winnerSurface)
    )
      throw new Error(`optimization method '${name}' returned a disconnected winner`)
  }
  if (result.provenance !== undefined) {
    assertOptimizationProvenance(name, result.provenance)
  }
  ancestors.delete(result)
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
    value.source?.kind !== 'package' ||
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
  if (
    value.optimizerCallRef !== undefined &&
    (typeof value.optimizerCallRef !== 'string' ||
      !value.optimizerCallRef.trim() ||
      value.optimizerCallRef.trim() !== value.optimizerCallRef)
  ) {
    fail('optimizerCallRef')
  }
  if (typeof value.resumed !== 'boolean') fail('resumed')
  if (value.seedApplied !== undefined && typeof value.seedApplied !== 'boolean') {
    fail('seedApplied')
  }
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
  if (value.observations !== undefined) {
    if (
      value.observations.scope !== 'callback-submitted-candidates' ||
      typeof value.observations.path !== 'string' ||
      !value.observations.path.trim() ||
      typeof value.observations.sha256 !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(value.observations.sha256)
    ) {
      fail('observations')
    }
    for (const field of ['submittedCandidates', 'evaluations', 'refusals'] as const) {
      if (!Number.isSafeInteger(value.observations[field]) || value.observations[field] < 0) {
        fail(`observations.${field}`)
      }
    }
  }
  if (value.gepaCandidatePopulation !== undefined) {
    try {
      assertGepaCandidatePopulationSummary(value.gepaCandidatePopulation)
    } catch {
      fail('gepaCandidatePopulation')
    }
    if (value.gepaCandidatePopulation.runId !== value.runId) {
      fail('gepaCandidatePopulation.runId')
    }
  }
  if (value.modelExecutions !== undefined) {
    if (
      value.modelExecutions.scope !== 'runtime-model-calls' ||
      typeof value.modelExecutions.path !== 'string' ||
      !value.modelExecutions.path.trim() ||
      typeof value.modelExecutions.sha256 !== 'string' ||
      !/^sha256:[0-9a-f]{64}$/.test(value.modelExecutions.sha256)
    ) {
      fail('modelExecutions')
    }
    for (const field of ['calls', 'succeeded', 'failed'] as const) {
      if (!Number.isSafeInteger(value.modelExecutions[field]) || value.modelExecutions[field] < 0) {
        fail(`modelExecutions.${field}`)
      }
    }
    if (
      value.modelExecutions.calls !==
      value.modelExecutions.succeeded + value.modelExecutions.failed
    ) {
      fail('modelExecutions.calls')
    }
  }
  if (
    (value.optimizerModel === undefined) !== (value.optimizerCallRef === undefined) ||
    (value.optimizerModel === undefined) !== (value.modelExecutions === undefined)
  ) {
    fail('optimizerModel execution provenance')
  }
}
