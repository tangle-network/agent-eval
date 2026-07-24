import { assertJsonValue, assertNoCredentialValues } from './external-optimizer-process'
import { snapshotExternalOptimizerRunner } from './external-optimizer-run-config'
import { assertOptimizerModel, snapshotOptimizerModel } from './optimizer-model'
import type { SkillOptOptimizationMethodConfig } from './skillopt-optimization-method'
import type { Scenario } from './types'

export const SKILLOPT_DEFAULT_MAX_CANDIDATE_CHARS = 200_000
export const SKILLOPT_DEFAULT_MAX_EVIDENCE_CHARS = 100_000
export const SKILLOPT_DEFAULT_TIMEOUT_MS = 60 * 60 * 1000

const MAX_TIMER_DELAY_MS = 2_147_483_647

export function snapshotSkillOptOptimizationConfig<TScenario extends Scenario, TArtifact>(
  config: SkillOptOptimizationMethodConfig<TScenario, TArtifact>,
): SkillOptOptimizationMethodConfig<TScenario, TArtifact> {
  const runner = snapshotExternalOptimizerRunner(config.runner)
  return {
    ...config,
    trainer: structuredClone(config.trainer),
    optimizer: snapshotOptimizerModel(config.optimizer),
    ...(runner ? { runner } : {}),
  }
}

export function assertSkillOptOptimizationConfig<TScenario extends Scenario, TArtifact>(
  config: SkillOptOptimizationMethodConfig<TScenario, TArtifact>,
): void {
  if (!config.trainer || typeof config.trainer !== 'object') {
    throw new Error('skillOptOptimizationMethod: trainer is required')
  }
  if (
    config.name !== undefined &&
    (typeof config.name !== 'string' || !config.name.trim() || config.name.trim() !== config.name)
  ) {
    throw new Error('skillOptOptimizationMethod: name must be trimmed and non-empty')
  }
  if (
    config.background !== undefined &&
    (typeof config.background !== 'string' ||
      !config.background.trim() ||
      config.background.trim() !== config.background)
  ) {
    throw new Error('skillOptOptimizationMethod: background must be trimmed and non-empty')
  }
  for (const [label, value] of [
    ['objective', config.objective],
    ['evaluationId', config.evaluationId],
  ] as const) {
    if (typeof value !== 'string' || !value.trim() || value.trim() !== value) {
      throw new Error(`skillOptOptimizationMethod: ${label} must be trimmed and non-empty`)
    }
  }
  assertPositiveSafeInteger(config.trainer.epochs, 'trainer.epochs')
  assertPositiveSafeInteger(config.trainer.batchSize, 'trainer.batchSize')
  assertPositiveSafeInteger(config.maxEvaluations, 'maxEvaluations')
  for (const [label, value] of [
    ['trainer.accumulation', config.trainer.accumulation],
    ['trainer.editBudget', config.trainer.editBudget],
    ['trainer.minEditBudget', config.trainer.minEditBudget],
    ['trainer.analystWorkers', config.trainer.analystWorkers],
    ['trainer.minibatchSize', config.trainer.minibatchSize],
    ['trainer.mergeBatchSize', config.trainer.mergeBatchSize],
    ['trainer.maxAnalystRounds', config.trainer.maxAnalystRounds],
    ['trainer.evaluationWorkers', config.trainer.evaluationWorkers],
    ['maxCandidateChars', config.maxCandidateChars],
    ['maxEvidenceChars', config.maxEvidenceChars],
    ['timeoutMs', config.timeoutMs],
  ] as const) {
    if (value !== undefined) assertPositiveSafeInteger(value, label)
  }
  if (config.timeoutMs !== undefined && config.timeoutMs > MAX_TIMER_DELAY_MS) {
    throw new Error(`skillOptOptimizationMethod: timeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`)
  }
  if (
    config.trainer.minEditBudget !== undefined &&
    config.trainer.editBudget !== undefined &&
    config.trainer.minEditBudget > config.trainer.editBudget
  ) {
    throw new Error(
      'skillOptOptimizationMethod: trainer.minEditBudget must not exceed trainer.editBudget',
    )
  }
  assertOptionalEnum(
    config.trainer.learningRateSchedule,
    ['constant', 'linear', 'cosine', 'autonomous'],
    'trainer.learningRateSchedule',
  )
  assertOptionalEnum(
    config.trainer.learningRateControl,
    ['fixed', 'autonomous', 'none'],
    'trainer.learningRateControl',
  )
  assertOptionalEnum(
    config.trainer.updateMode,
    ['patch', 'rewrite_from_suggestions', 'full_rewrite_minibatch'],
    'trainer.updateMode',
  )
  for (const [label, value] of [
    ['trainer.failureOnly', config.trainer.failureOnly],
    ['trainer.useSlowUpdate', config.trainer.useSlowUpdate],
    ['trainer.useMetaSkill', config.trainer.useMetaSkill],
  ] as const) {
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error(`skillOptOptimizationMethod: ${label} must be a boolean`)
    }
  }
  if (
    config.hardScoreThreshold !== undefined &&
    (!Number.isFinite(config.hardScoreThreshold) ||
      config.hardScoreThreshold < 0 ||
      config.hardScoreThreshold > 1)
  ) {
    throw new Error('skillOptOptimizationMethod: hardScoreThreshold must be in [0, 1]')
  }
  if (
    config.resume !== undefined &&
    config.resume !== 'never' &&
    config.resume !== 'if-compatible' &&
    config.resume !== 'required'
  ) {
    throw new Error(
      "skillOptOptimizationMethod: resume must be 'never', 'if-compatible', or 'required'",
    )
  }
  assertJsonValue(config.trainer.overrides ?? {}, 'skillOptOptimizationMethod: trainer.overrides')
  assertNoCredentialValues(
    config.trainer.overrides ?? {},
    'skillOptOptimizationMethod: trainer.overrides',
    'optimizer',
  )
  assertOptimizerModel(config.optimizer, 'skillOptOptimizationMethod: optimizer')
  const evidenceLimit = config.maxEvidenceChars ?? SKILLOPT_DEFAULT_MAX_EVIDENCE_CHARS
  if (
    JSON.stringify(config.objective).length > evidenceLimit ||
    JSON.stringify(config.background ?? '').length > evidenceLimit
  ) {
    throw new Error(
      'skillOptOptimizationMethod: objective and background must each fit maxEvidenceChars',
    )
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`skillOptOptimizationMethod: ${label} must be a positive safe integer`)
  }
}

function assertOptionalEnum<T extends string>(
  value: T | undefined,
  allowed: readonly T[],
  label: string,
): void {
  if (value !== undefined && !allowed.includes(value)) {
    throw new Error(`skillOptOptimizationMethod: ${label} must be one of ${allowed.join(', ')}`)
  }
}
