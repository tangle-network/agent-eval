import type { ExternalOptimizerTokenUsage } from './external-optimizer-accounting'
import { assertExternalOptimizerTokenUsage } from './external-optimizer-accounting'
import { isCandidateText } from './external-optimizer-process'
import {
  assertExternalOptimizerPackageIdentity,
  assertExternalOptimizerSourceDetails,
  type ExternalOptimizerPackageSource,
} from './external-optimizer-source'

export interface SkillOptBridgeOutput {
  bestCandidate: string
  bestScore: number
  totalEvaluations: number
  totalSteps: number
  tokenUsage?: ExternalOptimizerTokenUsage
  upstream: ExternalOptimizerPackageSource<'skillopt'>
  runId: string
  resumed: boolean
}

export function assertSkillOptBridgeOutput(
  result: SkillOptBridgeOutput,
  name: string,
  maxCandidateChars: number,
  maxEvaluations: number,
): asserts result is SkillOptBridgeOutput {
  if (!isCandidateText(result.bestCandidate, maxCandidateChars)) {
    throw new Error(`${name}: SkillOpt bridge returned an invalid candidate`)
  }
  if (!Number.isFinite(result.bestScore) || result.bestScore < 0 || result.bestScore > 1) {
    throw new Error(`${name}: SkillOpt bridge returned an invalid bestScore`)
  }
  if (
    !Number.isSafeInteger(result.totalEvaluations) ||
    result.totalEvaluations < 0 ||
    result.totalEvaluations > maxEvaluations
  ) {
    throw new Error(`${name}: SkillOpt bridge returned invalid totalEvaluations`)
  }
  if (!Number.isSafeInteger(result.totalSteps) || result.totalSteps < 0) {
    throw new Error(`${name}: SkillOpt bridge returned invalid totalSteps`)
  }
  assertExternalOptimizerPackageIdentity(result.upstream, 'skillopt', name, 'SkillOpt')
  if (
    typeof result.runId !== 'string' ||
    result.runId.length === 0 ||
    result.runId !== result.runId.trim()
  ) {
    throw new Error(`${name}: SkillOpt bridge returned an invalid runId`)
  }
  if (typeof result.resumed !== 'boolean') {
    throw new Error(`${name}: SkillOpt bridge returned an invalid resumed flag`)
  }
  assertExternalOptimizerSourceDetails(result.upstream, name, 'SkillOpt')
  assertExternalOptimizerTokenUsage(result.tokenUsage, name, 'SkillOpt')
}
