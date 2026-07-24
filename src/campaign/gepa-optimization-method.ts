import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { CostLedgerSummary } from '../cost-ledger'
import {
  assertJsonValue,
  assertNoCredentialValues,
  type ExternalOptimizerModelProxy,
  type ExternalOptimizerResumeMode,
  type ExternalOptimizerRunnerCommand,
  type ExternalTextCandidate,
  isExternalTextCandidate,
  isRecord,
  removeCredentialEnvironment,
  runExternalOptimizerProcess,
  startExternalOptimizerCallback,
  startExternalOptimizerModelProxy,
} from './external-optimizer-process'
import {
  createExternalTextEvaluator,
  describeExternalScenario,
  mapExternalScenarios,
} from './external-text-optimization'
import {
  assertOptimizerModel,
  type OpenAICompatibleOptimizerModel,
  snapshotOptimizerModel,
} from './optimizer-model'
import {
  costFromLedgerSummary,
  type OptimizationMethod,
} from './presets/compare-optimization-methods'
import { fsCampaignStorage } from './storage'
import type { MutableSurface, Scenario } from './types'

/** Shared settings for one bounded GEPA engine invocation. */
export interface GepaEngineOptions {
  /** GEPA engine name. GEPA validates names available in its Python runtime. */
  engine: string
  /** Required cap for this engine's own model or CLI spend. */
  maxProposerCostUsd: number
  /** Maximum concurrent evaluations inside this engine. Default: 8. */
  maxConcurrency?: number
  /** Stop the engine after it reaches this score. */
  stopAtScore?: number
  /** Isolate agent-based engines. Default: true. */
  sandbox?: boolean
  /**
   * JSON-safe configuration for the registered GEPA engine.
   * Python callables and class instances cannot cross the process boundary.
   */
  engineConfig?: Record<string, unknown>
}

/** One independently budgeted GEPA engine invocation. */
export interface GepaEngineRun extends GepaEngineOptions {
  /** Maximum callback evaluations this engine may consume. */
  maxEvaluations: number
}

/** An engine in an adaptive run. All engines share the recipe evaluation limit. */
export type GepaAdaptiveEngineRun = GepaEngineOptions

/**
 * A direct mapping to a GEPA optimization recipe.
 *
 * GEPA owns every search and composition operation represented here. Tangle
 * supplies the candidate, data, execution callback, judges, and budgets.
 */
export type GepaOptimizationRecipe =
  | {
      kind: 'engine'
      run: GepaEngineRun
    }
  | {
      kind: 'sequential'
      runs: readonly GepaEngineRun[]
    }
  | {
      kind: 'adaptive-sequential'
      runs: readonly GepaAdaptiveEngineRun[]
      /** One evaluation budget shared by every adaptive stage. */
      maxEvaluations: number
      /** Switch engines after this many evaluations without improvement. */
      plateauEvaluations: number
      patience?: number
      minEvaluationsPerStage?: number
      improvementEpsilon?: number
      cycle?: boolean
      maxSwitches?: number
      maxConcurrency?: number
    }
  | {
      kind: 'best-of'
      runs: readonly GepaEngineRun[]
      maxWorkers?: number
    }
  | {
      kind: 'vote'
      runs: readonly GepaEngineRun[]
      maxWorkers?: number
    }
  | {
      kind: 'omni'
      explore: readonly GepaEngineRun[]
      continueWith: GepaEngineRun
      maxWorkers?: number
    }

/** The command that runs the Python GEPA bridge. */
export type GepaRunnerCommand = ExternalOptimizerRunnerCommand

export interface GepaOptimizationMethodConfig<TScenario extends Scenario, TArtifact = unknown> {
  /** Unique comparison-method name. Default identifies the GEPA recipe. */
  name?: string
  /** A direct GEPA recipe. */
  recipe: GepaOptimizationRecipe
  /** Plain-language goal shown to the external optimizer. */
  objective: string
  /** Revision of the dispatch, judges, model settings, and scoring logic. */
  evaluationVersion: string
  /** Optional bounded context about the surface and task. */
  background?: string
  /**
   * Public dotted Python modules imported before GEPA resolves engine names.
   * Each module should call GEPA's official `register_engine()` API at import.
   */
  engineModules?: readonly string[]
  /** Reject external candidates longer than this. Default: 200,000 characters. */
  maxCandidateChars?: number
  /** Reject serialized score evidence longer than this. Default: 100,000 characters. */
  maxEvidenceChars?: number
  /** End the bridge process after this many milliseconds. Default: 30 minutes. */
  timeoutMs?: number
  /**
   * OpenAI-compatible model used by standard GEPA reflection.
   * Calls pass through Agent Eval's local model proxy. Every recipe engine must
   * be `gepa` when this is set.
   */
  optimizer?: OpenAICompatibleOptimizerModel
  /**
   * Decide what the external optimizer may read for a train or selection case.
   * The returned value must be JSON-serializable. The final comparison cases
   * are not accepted by this API and cannot be serialized here.
   */
  describeScenario?: (scenario: TScenario) => unknown
  /** Optional bounded artifact evidence returned to GEPA after each evaluation. */
  describeArtifact?: (artifact: TArtifact, scenario: TScenario) => unknown
  /** Default: `never`. Compatible runs resume only when explicitly enabled. */
  resume?: ExternalOptimizerResumeMode
  runner?: GepaRunnerCommand
}

interface GepaBridgeOutput {
  bestCandidate: ExternalTextCandidate
  bestScore: number
  totalEvaluations: number
  recipeKind: GepaOptimizationRecipe['kind']
  proposerCostUsd?: number
  proposerCostAccounting?: 'metered' | 'reported' | 'unavailable'
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    calls: number
  }
  upstream: {
    package: 'gepa'
    version: string
    sourceUrl?: string
    revision?: string
  }
  runId: string
  resumed: boolean
}

const DEFAULT_MAX_CANDIDATE_CHARS = 200_000
const DEFAULT_MAX_EVIDENCE_CHARS = 100_000
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000

/**
 * Turn an optional GEPA installation into an `OptimizationMethod`.
 *
 * GEPA receives only serialized train and selection cases. The caller's final
 * test partition stays inside `compareOptimizationMethods`, which invokes this
 * method without a test-set field. The local callback routes every candidate
 * evaluation through the same dispatch and judges used by other methods.
 */
export function gepaOptimizationMethod<TScenario extends Scenario, TArtifact>(
  config: GepaOptimizationMethodConfig<TScenario, TArtifact>,
): OptimizationMethod<TScenario, TArtifact> {
  assertConfig(config)
  config = snapshotConfig(config)
  const name = config.name ?? defaultMethodName(config.recipe)

  return {
    name,
    async optimize(input) {
      if (
        typeof input.baselineSurface !== 'string' &&
        input.baselineSurface.kind !== 'components'
      ) {
        throw new Error(`${name}: GEPA bridge supports text and component surfaces`)
      }
      const expectsComponents = typeof input.baselineSurface !== 'string'
      if (expectsComponents) {
        assertComponentRecipe(config.recipe, name)
      }

      const started = Date.now()
      const maxCandidateChars = config.maxCandidateChars ?? DEFAULT_MAX_CANDIDATE_CHARS
      const maxEvidenceChars = config.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS
      const storage = input.runOptions.storage ?? fsCampaignStorage()
      const runDir = `${input.runDir}/gepa`
      storage.ensureDir(runDir)
      const costLedger = input.costLedger
      const scenarioById = mapExternalScenarios(
        input.trainScenarios,
        input.selectionScenarios,
        'GEPA bridge',
      )
      const evaluate = createExternalTextEvaluator({
        input,
        label: 'GEPA bridge',
        runDir,
        costPhase: 'gepa.external-evaluation',
        costLedger,
        scenarioById,
        maxCandidateChars,
        maxEvidenceChars,
        describeArtifact: config.describeArtifact,
      })
      const evaluationLimit = recipeEvaluationLimit(config.recipe, input.selectionScenarios.length)
      const callback = await startExternalOptimizerCallback({
        token: randomBytes(32).toString('hex'),
        maxEvaluations: evaluationLimit,
        evaluate,
      })

      const runnerEnv = config.runner?.env ?? {}
      let modelProxy: ExternalOptimizerModelProxy | undefined
      try {
        if (config.optimizer) {
          modelProxy = await startExternalOptimizerModelProxy({
            upstreamBaseUrl: config.optimizer.baseUrl,
            upstreamApiKey: config.optimizer.apiKey,
            model: config.optimizer.model,
            budget: config.optimizer.budget,
            costLedger,
            phase: 'gepa.optimizer-model',
            actor: name,
          })
        }
        const outputDir = `${runDir}/external`
        await mkdir(outputDir, { recursive: true })
        const result = await runExternalOptimizerProcess<GepaBridgeOutput>({
          label: 'GEPA bridge',
          tempPrefix: 'agent-eval-gepa-',
          module: 'agent_eval_rpc.gepa_bridge',
          input: {
            version: 6,
            attemptId: randomBytes(16).toString('hex'),
            resume: config.resume ?? 'never',
            evaluationVersion: config.evaluationVersion,
            seed: input.seed,
            callbackUrl: callback.url,
            callbackToken: callback.token,
            engineModules: config.engineModules ?? [],
            recipe: config.recipe,
            objective: config.objective,
            ...(config.background ? { background: config.background } : {}),
            seedCandidate: encodeGepaCandidate(input.baselineSurface),
            trainSet: input.trainScenarios.map((scenario) =>
              describeExternalScenario(scenario, 'GEPA', maxEvidenceChars, config.describeScenario),
            ),
            selectionSet: input.selectionScenarios.map((scenario) =>
              describeExternalScenario(scenario, 'GEPA', maxEvidenceChars, config.describeScenario),
            ),
            maxCandidateChars,
            maxEvidenceChars,
            outputDir,
            ...(modelProxy && config.optimizer
              ? {
                  modelProxy: {
                    baseUrl: modelProxy.baseUrl,
                    apiKey: modelProxy.apiKey,
                    model: config.optimizer.model,
                    budget: config.optimizer.budget,
                  },
                }
              : {}),
          },
          runner:
            modelProxy && config.runner
              ? {
                  ...config.runner,
                  env: removeCredentialEnvironment(runnerEnv),
                }
              : config.runner,
          timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })
        assertBridgeOutput(
          result,
          name,
          maxCandidateChars,
          config.recipe.kind,
          evaluationLimit,
          expectsComponents,
        )
        if (callback.evaluations() !== result.totalEvaluations) {
          throw new Error(
            `${name}: GEPA reported ${result.totalEvaluations} evaluations but the callback received ${callback.evaluations()}`,
          )
        }

        const evaluationCost = costFromLedgerSummary(
          costLedger.summary({ phase: 'gepa.external-evaluation' }),
        )
        const optimizerSummary = costLedger.summary({ phase: 'gepa.optimizer-model' })
        const optimizerCost = costFromLedgerSummary(optimizerSummary)
        const reportedProposerCost = result.proposerCostUsd ?? 0
        if (modelProxy) {
          if (result.proposerCostAccounting !== 'metered') {
            throw new Error(`${name}: proxied GEPA did not report metered proposer cost`)
          }
          assertTokenUsageMatchesLedger(result.tokenUsage, optimizerSummary, name)
          assertMeteredCostMatches(result.proposerCostUsd, optimizerCost.totalCostUsd, name)
        }
        return {
          winnerSurface: decodeGepaCandidate(result.bestCandidate),
          cost: modelProxy
            ? {
                totalCostUsd: evaluationCost.totalCostUsd + optimizerCost.totalCostUsd,
                accountingComplete:
                  evaluationCost.accountingComplete && optimizerCost.accountingComplete,
                incompleteReasons: [
                  ...evaluationCost.incompleteReasons.map((reason) => `evaluation: ${reason}`),
                  ...optimizerCost.incompleteReasons.map((reason) => `optimizer model: ${reason}`),
                ],
              }
            : {
                totalCostUsd: evaluationCost.totalCostUsd + reportedProposerCost,
                accountingComplete: false,
                incompleteReasons: [
                  ...evaluationCost.incompleteReasons,
                  result.proposerCostAccounting === 'reported'
                    ? 'GEPA proposer cost is externally reported and has no agent-eval receipt'
                    : 'GEPA proposer cost is unavailable',
                ],
              },
          durationMs: Date.now() - started,
          provenance: {
            source: {
              kind: 'package' as const,
              package: result.upstream.package,
              version: result.upstream.version,
              ...(result.upstream.sourceUrl ? { sourceUrl: result.upstream.sourceUrl } : {}),
              ...(result.upstream.revision ? { revision: result.upstream.revision } : {}),
            },
            runId: result.runId,
            resumed: result.resumed,
            evaluationCount: result.totalEvaluations,
            artifactDir: outputDir,
            ...(modelProxy
              ? {
                  tokenUsage: {
                    inputTokens: optimizerSummary.inputTokens,
                    outputTokens: optimizerSummary.outputTokens,
                    totalTokens: optimizerSummary.inputTokens + optimizerSummary.outputTokens,
                    calls: optimizerSummary.totalCalls,
                  },
                }
              : {}),
          },
        }
      } finally {
        await modelProxy?.close()
        await callback.close()
      }
    },
  }
}

function snapshotConfig<TScenario extends Scenario, TArtifact>(
  config: GepaOptimizationMethodConfig<TScenario, TArtifact>,
): GepaOptimizationMethodConfig<TScenario, TArtifact> {
  return {
    ...config,
    recipe: structuredClone(config.recipe),
    ...(config.engineModules ? { engineModules: [...config.engineModules] } : {}),
    ...(config.optimizer ? { optimizer: snapshotOptimizerModel(config.optimizer) } : {}),
    ...(config.runner
      ? {
          runner: {
            ...config.runner,
            ...(config.runner.args ? { args: [...config.runner.args] } : {}),
            ...(config.runner.env ? { env: { ...config.runner.env } } : {}),
          },
        }
      : {}),
  }
}

function assertConfig<TScenario extends Scenario, TArtifact>(
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
    typeof config.evaluationVersion !== 'string' ||
    !config.evaluationVersion.trim() ||
    config.evaluationVersion.trim() !== config.evaluationVersion
  ) {
    throw new Error('gepaOptimizationMethod: evaluationVersion must be trimmed and non-empty')
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
    (!Number.isSafeInteger(config.timeoutMs) || config.timeoutMs <= 0)
  ) {
    throw new Error('gepaOptimizationMethod: timeoutMs must be a positive safe integer')
  }
  const evidenceLimit = config.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS
  if (
    JSON.stringify(config.objective).length > evidenceLimit ||
    JSON.stringify(config.background ?? '').length > evidenceLimit
  ) {
    throw new Error(
      'gepaOptimizationMethod: objective and background must each fit maxEvidenceChars',
    )
  }
  if (config.engineModules !== undefined) {
    if (!Array.isArray(config.engineModules)) {
      throw new Error('gepaOptimizationMethod: engineModules must be an array')
    }
    const seen = new Set<string>()
    for (const module of config.engineModules) {
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

function recipeEvaluationLimit(
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

function assertComponentRecipe(recipe: GepaOptimizationRecipe, name: string): void {
  const unsupported = recipeEngineOptions(recipe).find((run) => run.engine !== 'gepa')
  if (unsupported) {
    throw new Error(
      `${name}: component surfaces require GEPA's 'gepa' engine; '${unsupported.engine}' accepts one text candidate`,
    )
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

function defaultMethodName(recipe: GepaOptimizationRecipe): string {
  if (recipe.kind === 'engine') return `gepa:${recipe.run.engine}`
  if (recipe.kind === 'omni') {
    return `gepa:omni:${recipe.continueWith.engine}`
  }
  return `gepa:${recipe.kind}`
}

function assertBridgeOutput(
  result: GepaBridgeOutput,
  name: string,
  maxCandidateChars: number,
  recipeKind: GepaOptimizationRecipe['kind'],
  maxEvaluations: number,
  expectsComponents: boolean,
): asserts result is GepaBridgeOutput {
  if (result.recipeKind !== recipeKind)
    throw new Error(`${name}: GEPA bridge reported recipe '${String(result.recipeKind)}'`)
  if (
    !isGepaCandidate(result.bestCandidate, maxCandidateChars) ||
    expectsComponents !== (typeof result.bestCandidate !== 'string')
  ) {
    throw new Error(`${name}: GEPA bridge returned an invalid candidate`)
  }
  if (!Number.isFinite(result.bestScore))
    throw new Error(`${name}: GEPA bridge returned an invalid bestScore`)
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
  if (result.tokenUsage !== undefined) {
    for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'calls'] as const) {
      if (!Number.isSafeInteger(result.tokenUsage[field]) || result.tokenUsage[field] < 0) {
        throw new Error(`${name}: GEPA bridge returned invalid tokenUsage.${field}`)
      }
    }
    if (
      result.tokenUsage.totalTokens !==
      result.tokenUsage.inputTokens + result.tokenUsage.outputTokens
    ) {
      throw new Error(`${name}: GEPA bridge returned inconsistent tokenUsage.totalTokens`)
    }
  }
  if (result.proposerCostAccounting === 'metered' && result.tokenUsage === undefined) {
    throw new Error(`${name}: metered GEPA bridge omitted tokenUsage`)
  }
  if (
    !isRecord(result.upstream) ||
    result.upstream.package !== 'gepa' ||
    typeof result.upstream.version !== 'string' ||
    !result.upstream.version.trim()
  ) {
    throw new Error(`${name}: GEPA bridge returned invalid upstream package provenance`)
  }
  if (
    result.upstream.sourceUrl !== undefined &&
    (typeof result.upstream.sourceUrl !== 'string' || !result.upstream.sourceUrl.trim())
  ) {
    throw new Error(`${name}: GEPA bridge returned an invalid upstream sourceUrl`)
  }
  if (
    result.upstream.revision !== undefined &&
    (typeof result.upstream.revision !== 'string' || !result.upstream.revision.trim())
  ) {
    throw new Error(`${name}: GEPA bridge returned an invalid upstream revision`)
  }
  if (typeof result.runId !== 'string' || !result.runId.trim()) {
    throw new Error(`${name}: GEPA bridge returned an invalid runId`)
  }
  if (typeof result.resumed !== 'boolean') {
    throw new Error(`${name}: GEPA bridge returned an invalid resumed flag`)
  }
}

function assertTokenUsageMatchesLedger(
  upstream: GepaBridgeOutput['tokenUsage'],
  ledger: CostLedgerSummary,
  name: string,
): void {
  if (!upstream) throw new Error(`${name}: GEPA did not report optimizer token usage`)
  const expected = {
    inputTokens: ledger.inputTokens,
    outputTokens: ledger.outputTokens,
    totalTokens: ledger.inputTokens + ledger.outputTokens,
    calls: ledger.totalCalls,
  }
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'calls'] as const) {
    if (upstream[field] !== expected[field]) {
      throw new Error(
        `${name}: GEPA tokenUsage.${field} ${upstream[field]} does not match metered ${expected[field]}`,
      )
    }
  }
}

function assertMeteredCostMatches(
  upstreamCostUsd: number | undefined,
  meteredCostUsd: number,
  name: string,
): void {
  if (
    upstreamCostUsd === undefined ||
    Math.abs(upstreamCostUsd - meteredCostUsd) >
      Math.max(Number.EPSILON * 16, meteredCostUsd * 1e-9)
  ) {
    throw new Error(
      `${name}: GEPA proposer cost ${String(upstreamCostUsd)} does not match metered ${meteredCostUsd}`,
    )
  }
}

function encodeGepaCandidate(surface: MutableSurface): ExternalTextCandidate {
  if (typeof surface === 'string') return surface
  if (surface.kind === 'components') return { ...surface.components }
  throw new Error('GEPA bridge cannot encode a code surface')
}

function decodeGepaCandidate(candidate: ExternalTextCandidate): MutableSurface {
  return typeof candidate === 'string'
    ? candidate
    : { kind: 'components', components: { ...candidate } }
}

function isGepaCandidate(value: unknown, maxChars: number): value is ExternalTextCandidate {
  if (!isExternalTextCandidate(value)) return false
  const size = typeof value === 'string' ? value.length : JSON.stringify(value).length
  return size <= maxChars
}
