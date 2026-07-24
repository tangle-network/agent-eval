import { assertJsonValue, assertNoCredentialValues, isRecord } from './external-optimizer-process'
import { snapshotExternalOptimizerRunner } from './external-optimizer-run-config'
import type {
  GepaAdaptiveEngineRun,
  GepaEngineOptions,
  GepaEngineRun,
  GepaOptimizationMethodConfig,
  GepaOptimizationRecipe,
} from './gepa-optimization-method'
import { assertOptimizerModel, snapshotOptimizerModel } from './optimizer-model'
import type { Scenario } from './types'

export const GEPA_DEFAULT_MAX_CANDIDATE_CHARS = 200_000
export const GEPA_DEFAULT_MAX_EVIDENCE_CHARS = 100_000
export const GEPA_DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

const MAX_TIMER_DELAY_MS = 2_147_483_647

export function snapshotGepaOptimizationConfig<TScenario extends Scenario, TArtifact>(
  config: GepaOptimizationMethodConfig<TScenario, TArtifact>,
): GepaOptimizationMethodConfig<TScenario, TArtifact> {
  const runner = snapshotExternalOptimizerRunner(config.runner)
  return {
    ...config,
    recipe: structuredClone(config.recipe),
    ...(config.engineModules ? { engineModules: [...config.engineModules] } : {}),
    ...(config.optimizer ? { optimizer: snapshotOptimizerModel(config.optimizer) } : {}),
    ...(runner ? { runner } : {}),
  }
}

export function assertGepaOptimizationConfig<TScenario extends Scenario, TArtifact>(
  config: GepaOptimizationMethodConfig<TScenario, TArtifact>,
): void {
  if (
    typeof config.objective !== 'string' ||
    !config.objective.trim() ||
    config.objective.trim() !== config.objective
  ) {
    throw new Error('gepaOptimizationMethod: objective must be trimmed and non-empty')
  }
  if (
    typeof config.evaluationId !== 'string' ||
    !config.evaluationId.trim() ||
    config.evaluationId.trim() !== config.evaluationId
  ) {
    throw new Error('gepaOptimizationMethod: evaluationId must be trimmed and non-empty')
  }
  if (
    config.name !== undefined &&
    (typeof config.name !== 'string' || !config.name.trim() || config.name.trim() !== config.name)
  ) {
    throw new Error('gepaOptimizationMethod: name must be trimmed and non-empty')
  }
  if (
    config.background !== undefined &&
    (typeof config.background !== 'string' ||
      !config.background.trim() ||
      config.background.trim() !== config.background)
  ) {
    throw new Error('gepaOptimizationMethod: background must be trimmed and non-empty')
  }
  if (
    config.resume !== undefined &&
    config.resume !== 'never' &&
    config.resume !== 'if-compatible' &&
    config.resume !== 'required'
  ) {
    throw new Error(
      "gepaOptimizationMethod: resume must be 'never', 'if-compatible', or 'required'",
    )
  }
  assertRecipe(config.recipe)
  if (
    config.maxCandidateChars !== undefined &&
    (!Number.isSafeInteger(config.maxCandidateChars) || config.maxCandidateChars <= 0)
  ) {
    throw new Error('gepaOptimizationMethod: maxCandidateChars must be a positive safe integer')
  }
  if (
    config.maxEvidenceChars !== undefined &&
    (!Number.isSafeInteger(config.maxEvidenceChars) || config.maxEvidenceChars <= 0)
  ) {
    throw new Error('gepaOptimizationMethod: maxEvidenceChars must be a positive safe integer')
  }
  if (
    config.timeoutMs !== undefined &&
    (!Number.isSafeInteger(config.timeoutMs) ||
      config.timeoutMs <= 0 ||
      config.timeoutMs > MAX_TIMER_DELAY_MS)
  ) {
    throw new Error(`gepaOptimizationMethod: timeoutMs must be between 1 and ${MAX_TIMER_DELAY_MS}`)
  }
  const evidenceLimit = config.maxEvidenceChars ?? GEPA_DEFAULT_MAX_EVIDENCE_CHARS
  if (
    JSON.stringify(config.objective).length > evidenceLimit ||
    JSON.stringify(config.background ?? '').length > evidenceLimit
  ) {
    throw new Error(
      'gepaOptimizationMethod: objective and background must each fit maxEvidenceChars',
    )
  }
  assertEngineModules(config.engineModules)
  if (config.optimizer !== undefined) {
    assertOptimizerModel(config.optimizer, 'gepaOptimizationMethod: optimizer')
    if (config.engineModules?.length) {
      throw new Error(
        'gepaOptimizationMethod: optimizer cannot be combined with engineModules because proxied reflection requires the built-in GEPA engine',
      )
    }
    assertProxiedGepaRecipe(config.recipe)
  }
}

export function gepaRecipeSupportsResume(recipe: GepaOptimizationRecipe): boolean {
  return recipe.kind === 'engine' && recipe.run.engine === 'gepa'
}

export function gepaRecipeEvaluationLimit(
  recipe: GepaOptimizationRecipe,
  selectionScenarioCount: number,
): number {
  if (recipe.kind === 'adaptive-sequential') return recipe.maxEvaluations
  const runs =
    recipe.kind === 'engine'
      ? [recipe.run]
      : recipe.kind === 'sequential' || recipe.kind === 'best-of' || recipe.kind === 'vote'
        ? [...recipe.runs]
        : [...recipe.explore, recipe.continueWith]
  let total = 0
  for (const run of runs) {
    total = addEvaluationLimit(total, run.maxEvaluations)
  }
  if (recipe.kind === 'vote' && selectionScenarioCount > 0) {
    total = addEvaluationLimit(total, recipe.runs.length * selectionScenarioCount)
  }
  return total
}

export function assertGepaComponentRecipe(recipe: GepaOptimizationRecipe, name: string): void {
  const unsupported = recipeEngineOptions(recipe).find((run) => run.engine !== 'gepa')
  if (unsupported) {
    throw new Error(
      `${name}: component surfaces require GEPA's 'gepa' engine; '${unsupported.engine}' accepts one text candidate`,
    )
  }
}

export function defaultGepaMethodName(recipe: GepaOptimizationRecipe): string {
  if (recipe.kind === 'engine') return `gepa:${recipe.run.engine}`
  if (recipe.kind === 'omni') {
    return `gepa:omni:${recipe.continueWith.engine}`
  }
  return `gepa:${recipe.kind}`
}

function assertEngineModules(engineModules: readonly string[] | undefined): void {
  if (engineModules === undefined) return
  if (!Array.isArray(engineModules)) {
    throw new Error('gepaOptimizationMethod: engineModules must be an array')
  }
  const seen = new Set<string>()
  for (const module of engineModules) {
    if (
      typeof module !== 'string' ||
      !module ||
      !/^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)*$/.test(module)
    ) {
      throw new Error(
        'gepaOptimizationMethod: engineModules must contain public dotted Python module names',
      )
    }
    if (seen.has(module)) {
      throw new Error('gepaOptimizationMethod: engineModules must not contain duplicates')
    }
    seen.add(module)
  }
}

function assertRecipe(recipe: GepaOptimizationRecipe): void {
  if (!recipe || typeof recipe !== 'object') {
    throw new Error('gepaOptimizationMethod: recipe is required')
  }
  if (recipe.kind === 'engine') {
    assertEngineRun(recipe.run, 'recipe.run')
    return
  }
  if (recipe.kind === 'sequential') {
    assertEngineRuns(recipe.runs, 'recipe.runs', 1)
    return
  }
  if (recipe.kind === 'adaptive-sequential') {
    assertAdaptiveEngineRuns(recipe.runs, 'recipe.runs')
    assertPositiveSafeInteger(recipe.maxEvaluations, 'recipe.maxEvaluations')
    assertPositiveSafeInteger(recipe.plateauEvaluations, 'recipe.plateauEvaluations')
    if (recipe.patience !== undefined) {
      assertPositiveSafeInteger(recipe.patience, 'recipe.patience')
    }
    if (
      recipe.minEvaluationsPerStage !== undefined &&
      (!Number.isSafeInteger(recipe.minEvaluationsPerStage) || recipe.minEvaluationsPerStage < 0)
    ) {
      throw new Error(
        'gepaOptimizationMethod: recipe.minEvaluationsPerStage must be a non-negative safe integer',
      )
    }
    if (
      recipe.improvementEpsilon !== undefined &&
      (!Number.isFinite(recipe.improvementEpsilon) || recipe.improvementEpsilon < 0)
    ) {
      throw new Error(
        'gepaOptimizationMethod: recipe.improvementEpsilon must be a non-negative finite number',
      )
    }
    if (recipe.cycle !== undefined && typeof recipe.cycle !== 'boolean') {
      throw new Error('gepaOptimizationMethod: recipe.cycle must be a boolean')
    }
    if (recipe.maxSwitches !== undefined) {
      assertPositiveSafeInteger(recipe.maxSwitches, 'recipe.maxSwitches')
    }
    if (recipe.maxConcurrency !== undefined) {
      assertPositiveSafeInteger(recipe.maxConcurrency, 'recipe.maxConcurrency')
    }
    return
  }
  if (recipe.kind === 'best-of' || recipe.kind === 'vote') {
    assertEngineRuns(recipe.runs, 'recipe.runs', 2)
    assertParallelControls(recipe)
    return
  }
  if (recipe.kind === 'omni') {
    assertEngineRuns(recipe.explore, 'recipe.explore', 2)
    assertEngineRun(recipe.continueWith, 'recipe.continueWith')
    assertParallelControls(recipe)
    return
  }
  throw new Error('gepaOptimizationMethod: unsupported recipe')
}

function assertEngineRuns(runs: readonly GepaEngineRun[], label: string, minimum: number): void {
  if (!Array.isArray(runs) || runs.length < minimum) {
    throw new Error(
      `gepaOptimizationMethod: ${label} must contain at least ${minimum} bounded engine run${minimum === 1 ? '' : 's'}`,
    )
  }
  for (const [index, run] of runs.entries()) {
    assertEngineRun(run, `${label}[${index}]`)
  }
}

function assertAdaptiveEngineRuns(runs: readonly GepaAdaptiveEngineRun[], label: string): void {
  if (!Array.isArray(runs) || runs.length < 2) {
    throw new Error(
      `gepaOptimizationMethod: ${label} must contain at least two bounded engine runs`,
    )
  }
  for (const [index, run] of runs.entries()) {
    assertEngineOptions(run, `${label}[${index}]`)
  }
}

function assertEngineRun(run: GepaEngineRun, label: string): void {
  assertEngineOptions(run, label)
  assertPositiveSafeInteger(run.maxEvaluations, `${label}.maxEvaluations`)
}

function assertEngineOptions(run: GepaEngineOptions, label: string): void {
  if (!run || typeof run !== 'object') {
    throw new Error(`gepaOptimizationMethod: ${label} is required`)
  }
  if (typeof run.engine !== 'string' || !run.engine.trim() || run.engine.trim() !== run.engine) {
    throw new Error(`gepaOptimizationMethod: ${label}.engine must be a trimmed non-empty string`)
  }
  if (!Number.isFinite(run.maxProposerCostUsd) || run.maxProposerCostUsd <= 0) {
    throw new Error(
      `gepaOptimizationMethod: ${label}.maxProposerCostUsd must be a positive finite number`,
    )
  }
  if (run.maxConcurrency !== undefined) {
    assertPositiveSafeInteger(run.maxConcurrency, `${label}.maxConcurrency`)
  }
  if (run.stopAtScore !== undefined && !Number.isFinite(run.stopAtScore)) {
    throw new Error(`gepaOptimizationMethod: ${label}.stopAtScore must be a finite number`)
  }
  if (run.sandbox !== undefined && typeof run.sandbox !== 'boolean') {
    throw new Error(`gepaOptimizationMethod: ${label}.sandbox must be a boolean`)
  }
  assertJsonValue(run.engineConfig ?? {}, `gepaOptimizationMethod: ${label}.engineConfig`)
  assertNoCredentialValues(run.engineConfig ?? {}, `gepaOptimizationMethod: ${label}.engineConfig`)
}

function assertProxiedGepaRecipe(recipe: GepaOptimizationRecipe): void {
  for (const [index, run] of recipeEngineOptions(recipe).entries()) {
    if (run.engine !== 'gepa') {
      throw new Error(
        `gepaOptimizationMethod: optimizer requires GEPA's 'gepa' engine; recipe engine ${index} is '${run.engine}'`,
      )
    }
    const reflection = isRecord(run.engineConfig?.reflection)
      ? run.engineConfig.reflection
      : undefined
    if (reflection && Object.hasOwn(reflection, 'reflection_lm')) {
      throw new Error(
        'gepaOptimizationMethod: optimizer replaces engineConfig.reflection.reflection_lm; remove the duplicate setting',
      )
    }
    const reflectionOptions = isRecord(reflection?.reflection_lm_kwargs)
      ? reflection.reflection_lm_kwargs
      : undefined
    if (
      reflectionOptions &&
      [
        'api_base',
        'api_key',
        'api_url',
        'base_url',
        'endpoint',
        'messages',
        'model',
        'stream',
      ].some((key) => Object.hasOwn(reflectionOptions, key))
    ) {
      throw new Error(
        'gepaOptimizationMethod: proxied reflection transport settings belong in optimizer',
      )
    }
  }
}

function assertParallelControls(recipe: { maxWorkers?: number }): void {
  if (recipe.maxWorkers !== undefined) {
    assertPositiveSafeInteger(recipe.maxWorkers, 'recipe.maxWorkers')
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`gepaOptimizationMethod: ${label} must be a positive safe integer`)
  }
}

function recipeEngineOptions(recipe: GepaOptimizationRecipe): readonly GepaEngineOptions[] {
  if (recipe.kind === 'engine') return [recipe.run]
  if (recipe.kind === 'omni') return [...recipe.explore, recipe.continueWith]
  return recipe.runs
}

function addEvaluationLimit(total: number, increment: number): number {
  const next = total + increment
  if (!Number.isSafeInteger(next)) {
    throw new Error('gepaOptimizationMethod: recipe evaluation limit exceeds safe integer range')
  }
  return next
}
