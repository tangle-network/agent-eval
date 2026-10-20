/** Comparison admission, disjoint partitions, and isolated method/final measurement inputs. */

import { combineAbortSignals } from '../../abort-signal'
import type { CostLedgerHandle } from '../../cost-ledger'
import { contentHash } from '../../verdict-cache'
import { assertCampaignDesign } from '../coverage'
import { surfaceContentHash } from '../surface-identity'
import type { MutableSurface, Scenario } from '../types'
import type {
  CompareOptimizationMethodsOptions,
  OptimizationMethod,
  OptimizationMethodInput,
} from './optimization-method-types'

export function assertReportedCostWithinCeiling(
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

export function assertOptimizationMethods<TScenario extends Scenario, TArtifact>(
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

export function assertComparisonControls<TScenario extends Scenario, TArtifact>(
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
  assertConfidence(confidence)
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

export function assertComparisonPartitions<TScenario extends Scenario, TArtifact>(
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

export function slug(name: string): string {
  return (
    name
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .toLowerCase() || 'method'
  )
}

export function assertConfidence(confidence: number): void {
  if (!Number.isFinite(confidence) || confidence <= 0 || confidence >= 1) {
    throw new Error(
      `compareOptimizationMethods: confidence must be a finite number in (0,1), got ${String(confidence)}`,
    )
  }
}

export function minimumBootstrapResamples(confidence: number, comparisonCount: number): number {
  const exact = (2 * comparisonCount) / (1 - confidence)
  return Math.ceil(exact - Number.EPSILON * Math.max(1, exact) * 32)
}

export function createOptimizationMethodInput<TScenario extends Scenario, TArtifact>(
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

export function finalCostPhase<TScenario extends Scenario, TArtifact>(
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

export function finalDispatchRef<TScenario extends Scenario, TArtifact>(
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
  surface: MutableSurface,
): string {
  return `compareOptimizationMethods:${callerDispatchRef(opts)}:${surfaceContentHash(surface)}`
}

export function callerDispatchRef<TScenario extends Scenario, TArtifact>(
  opts: CompareOptimizationMethodsOptions<TScenario, TArtifact>,
): string {
  return (opts.dispatchRef ?? opts.dispatchWithSurface.name) || 'anonymous'
}
