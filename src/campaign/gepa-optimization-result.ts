import type { ExternalOptimizerTokenUsage } from './external-optimizer-accounting'
import { assertExternalOptimizerTokenUsage } from './external-optimizer-accounting'
import { type ExternalTextCandidate, isExternalTextCandidate } from './external-optimizer-process'
import {
  assertExternalOptimizerPackageSource,
  type ExternalOptimizerPackageSource,
} from './external-optimizer-source'
import type { GepaOptimizationRecipe } from './gepa-optimization-method'

export interface GepaBridgeOutput {
  bestCandidate: ExternalTextCandidate
  bestScore: number
  totalEvaluations: number
  recipeKind: GepaOptimizationRecipe['kind']
  proposerCostUsd?: number
  proposerCostAccounting?: 'metered' | 'reported' | 'unavailable'
  tokenUsage?: ExternalOptimizerTokenUsage
  upstream: ExternalOptimizerPackageSource<'gepa'>
  runId: string
  resumed: boolean
}

export function assertGepaBridgeOutput(
  result: GepaBridgeOutput,
  name: string,
  maxCandidateChars: number,
  recipeKind: GepaOptimizationRecipe['kind'],
  maxEvaluations: number,
  expectsComponents: boolean,
): asserts result is GepaBridgeOutput {
  if (result.recipeKind !== recipeKind) {
    throw new Error(`${name}: GEPA bridge reported recipe '${String(result.recipeKind)}'`)
  }
  if (
    !isGepaCandidate(result.bestCandidate, maxCandidateChars) ||
    expectsComponents !== (typeof result.bestCandidate !== 'string')
  ) {
    throw new Error(`${name}: GEPA bridge returned an invalid candidate`)
  }
  if (!Number.isFinite(result.bestScore)) {
    throw new Error(`${name}: GEPA bridge returned an invalid bestScore`)
  }
  if (
    !Number.isSafeInteger(result.totalEvaluations) ||
    result.totalEvaluations < 0 ||
    result.totalEvaluations > maxEvaluations
  ) {
    throw new Error(`${name}: GEPA bridge returned an invalid totalEvaluations`)
  }
  if (
    result.proposerCostUsd !== undefined &&
    (!Number.isFinite(result.proposerCostUsd) || result.proposerCostUsd < 0)
  ) {
    throw new Error(`${name}: GEPA bridge returned an invalid proposerCostUsd`)
  }
  if (
    result.proposerCostAccounting !== 'metered' &&
    result.proposerCostAccounting !== 'reported' &&
    result.proposerCostAccounting !== 'unavailable'
  ) {
    throw new Error(`${name}: GEPA bridge returned invalid proposerCostAccounting`)
  }
  if (
    (result.proposerCostAccounting !== 'unavailable') !==
    (result.proposerCostUsd !== undefined)
  ) {
    throw new Error(`${name}: GEPA bridge returned inconsistent proposer cost accounting`)
  }
  assertExternalOptimizerTokenUsage(result.tokenUsage, name, 'GEPA')
  if (result.proposerCostAccounting === 'metered' && result.tokenUsage === undefined) {
    throw new Error(`${name}: metered GEPA bridge omitted tokenUsage`)
  }
  assertExternalOptimizerPackageSource(result.upstream, 'gepa', name, 'GEPA')
  if (
    typeof result.runId !== 'string' ||
    result.runId.length === 0 ||
    result.runId !== result.runId.trim()
  ) {
    throw new Error(`${name}: GEPA bridge returned an invalid runId`)
  }
  if (typeof result.resumed !== 'boolean') {
    throw new Error(`${name}: GEPA bridge returned an invalid resumed flag`)
  }
}

function isGepaCandidate(value: unknown, maxChars: number): value is ExternalTextCandidate {
  if (!isExternalTextCandidate(value)) return false
  const size = typeof value === 'string' ? value.length : JSON.stringify(value).length
  return size <= maxChars
}
