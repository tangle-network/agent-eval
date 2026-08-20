import type { ExternalOptimizerTokenUsage } from './external-optimizer-accounting'
import { assertExternalOptimizerTokenUsage } from './external-optimizer-accounting'
import { type ExternalTextCandidate, isExternalTextCandidate } from './external-optimizer-process'
import {
  assertExternalOptimizerPackageSource,
  type ExternalOptimizerPackageSource,
} from './external-optimizer-source'
import {
  assertGepaCandidatePopulationSummary,
  type GepaCandidatePopulationSummary,
} from './gepa-candidate-population'
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
  /**
   * Whether the run seed reached every engine configuration in the recipe.
   * False when the recipe includes an agent engine, which accepts no seed.
   */
  seedApplied: boolean
  candidatePopulation?: GepaCandidatePopulationSummary
}

export function assertGepaBridgeOutput(
  result: GepaBridgeOutput,
  name: string,
  maxCandidateChars: number,
  recipeKind: GepaOptimizationRecipe['kind'],
  maxEvaluations: number,
  maxPopulationCandidates: number,
  scenarioIds: readonly string[],
  expectsComponents: boolean,
  requiresCandidatePopulation: boolean,
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
  if (typeof result.seedApplied !== 'boolean') {
    throw new Error(
      `${name}: GEPA bridge returned an invalid seedApplied flag; upgrade agent-eval-rpc to a release that forwards the run seed`,
    )
  }
  if (result.candidatePopulation !== undefined) {
    assertGepaCandidatePopulationSummary(result.candidatePopulation)
    if (result.candidatePopulation.runId !== result.runId) {
      throw new Error(`${name}: GEPA candidate population has a different run ID`)
    }
    if (
      result.candidatePopulation.maxCandidates !== maxPopulationCandidates ||
      result.candidatePopulation.maxCandidateChars !== maxCandidateChars ||
      result.candidatePopulation.surfaceKind !== (expectsComponents ? 'components' : 'text') ||
      result.candidatePopulation.scenarioIds.length !== scenarioIds.length ||
      result.candidatePopulation.scenarioIds.some(
        (scenarioId, index) => scenarioId !== scenarioIds[index],
      )
    ) {
      throw new Error(`${name}: GEPA candidate population differs from its configured bounds`)
    }
  } else if (requiresCandidatePopulation) {
    throw new Error(`${name}: GEPA bridge omitted the official candidate population`)
  }
}

function isGepaCandidate(value: unknown, maxChars: number): value is ExternalTextCandidate {
  if (!isExternalTextCandidate(value)) return false
  const size = typeof value === 'string' ? value.length : JSON.stringify(value).length
  return size <= maxChars
}
