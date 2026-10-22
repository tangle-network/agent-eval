/** Admission checks for the shared controls of a method comparison. */

import { surfaceContentHash } from '../surface-identity'
import type { Scenario } from '../types'
import type { CompareOptimizationMethodsOptions } from './compare-optimization-methods'

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
