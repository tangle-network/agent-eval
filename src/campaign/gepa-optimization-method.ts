import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import {
  assertExternalOptimizerCompletionCount,
  assertPriorExternalOptimizerUsage,
} from './external-optimizer-accounting'
import {
  closeExternalOptimizerResources,
  type ExternalOptimizerModelProxy,
  type ExternalOptimizerResumeMode,
  type ExternalOptimizerRunnerCommand,
  removeCredentialEnvironment,
  runExternalOptimizerProcess,
  runWithCleanup,
  startExternalOptimizerCallback,
  startExternalOptimizerModelProxy,
} from './external-optimizer-process'
import {
  externalOptimizerCompatibleRunKey,
  externalOptimizerRunKey,
  openExternalOptimizerRunBudget,
} from './external-optimizer-run-budget'
import { externalOptimizerRunnerIdentity, snapshotJson } from './external-optimizer-run-config'
import {
  assertExternalOptimizerRunBinding,
  inspectExternalOptimizerRuntime,
  observedExternalOptimizerRuntime,
} from './external-optimizer-runtime'
import {
  createExternalTextEvaluator,
  decodeExternalTextCandidate,
  describeExternalScenario,
  encodeExternalTextCandidate,
  mapExternalScenarios,
} from './external-text-optimization'
import {
  assertGepaComponentRecipe,
  assertGepaOptimizationConfig,
  defaultGepaMethodName,
  GEPA_DEFAULT_MAX_CANDIDATE_CHARS,
  GEPA_DEFAULT_MAX_EVIDENCE_CHARS,
  GEPA_DEFAULT_TIMEOUT_MS,
  gepaRecipeEvaluationLimit,
  gepaRecipeSupportsResume,
  snapshotGepaOptimizationConfig,
} from './gepa-optimization-config'
import { assertGepaBridgeOutput, type GepaBridgeOutput } from './gepa-optimization-result'
import type { OpenAICompatibleOptimizerModel } from './optimizer-model'
import {
  costFromLedgerSummary,
  type OptimizationMethod,
  optimizationTokenUsageFromSummary,
} from './presets/compare-optimization-methods'
import { fsCampaignStorage } from './storage'
import type { Scenario } from './types'

/** Shared settings for one bounded GEPA engine invocation. */
export interface GepaEngineOptions {
  /** GEPA engine name. GEPA validates names available in its Python runtime. */
  engine: string
  /** Required cap for this engine's own model or CLI spend. */
  maxProposerCostUsd: number
  /** Maximum concurrent evaluations inside this engine. Default: 1. */
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
  /** Stable identity for the dispatch, judges, model settings, and scoring logic. */
  evaluationId: string
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
  /**
   * Required for resumable direct GEPA runs because upstream state uses Python
   * pickle. Enable only for state created locally in a directory you control.
   */
  trustResumeState?: boolean
  runner?: GepaRunnerCommand
}

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
  assertGepaOptimizationConfig(config)
  config = snapshotGepaOptimizationConfig(config)
  const name = config.name ?? defaultGepaMethodName(config.recipe)

  return {
    name,
    async optimize(input) {
      const signal = input.runOptions.signal
      signal?.throwIfAborted()
      if (
        typeof input.baselineSurface !== 'string' &&
        input.baselineSurface.kind !== 'components'
      ) {
        throw new Error(`${name}: GEPA bridge supports text and component surfaces`)
      }
      const expectsComponents = typeof input.baselineSurface !== 'string'
      if (expectsComponents) {
        assertGepaComponentRecipe(config.recipe, name)
      }

      const started = Date.now()
      const maxCandidateChars = config.maxCandidateChars ?? GEPA_DEFAULT_MAX_CANDIDATE_CHARS
      const maxEvidenceChars = config.maxEvidenceChars ?? GEPA_DEFAULT_MAX_EVIDENCE_CHARS
      const storage = input.runOptions.storage ?? fsCampaignStorage()
      const runDir = `${input.runDir}/gepa`
      storage.ensureDir(runDir)
      const costLedger = input.costLedger
      const attemptId = randomBytes(16).toString('hex')
      const resume = config.resume ?? 'never'
      const bridgeRunner =
        config.optimizer && config.runner
          ? {
              ...config.runner,
              env: removeCredentialEnvironment(config.runner.env ?? {}),
            }
          : config.runner
      const runtimeIdentity = await inspectExternalOptimizerRuntime({
        label: name,
        package: 'gepa',
        module: 'agent_eval_rpc.gepa_bridge',
        engineModules: config.engineModules,
        ...(bridgeRunner ? { runner: bridgeRunner } : {}),
        timeoutMs: config.timeoutMs ?? GEPA_DEFAULT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      })
      const seedCandidate = encodeExternalTextCandidate(input.baselineSurface)
      const trainSet = input.trainScenarios.map((scenario) =>
        describeExternalScenario(scenario, 'GEPA', maxEvidenceChars, config.describeScenario),
      )
      const selectionSet = input.selectionScenarios.map((scenario) =>
        describeExternalScenario(scenario, 'GEPA', maxEvidenceChars, config.describeScenario),
      )
      const evaluationLimit = gepaRecipeEvaluationLimit(
        config.recipe,
        input.selectionScenarios.length,
      )
      const runMaterial = {
        optimizer: 'gepa',
        runtime: runtimeIdentity,
        method: name,
        evaluationId: config.evaluationId,
        seed: input.seed,
        recipe: snapshotJson(config.recipe, 'GEPA run settings'),
        engineModules: config.engineModules ?? [],
        objective: config.objective,
        background: config.background ?? '',
        seedCandidate,
        trainSet,
        selectionSet,
        maxCandidateChars,
        maxEvidenceChars,
        optimizerModel: config.optimizer
          ? {
              model: config.optimizer.model,
              baseUrl: config.optimizer.baseUrl,
              budget: config.optimizer.budget,
            }
          : null,
        runner: externalOptimizerRunnerIdentity(bridgeRunner, 'agent_eval_rpc.gepa_bridge'),
        trustResumeState: config.trustResumeState === true,
      }
      const compatibleRunId = externalOptimizerCompatibleRunKey(runMaterial)
      const runId = externalOptimizerRunKey({
        material: runMaterial,
        attemptId,
        resumeEnabled: resume !== 'never' && gepaRecipeSupportsResume(config.recipe),
      })
      const runBudget = openExternalOptimizerRunBudget({
        storage,
        runDir,
        runKey: runId,
        attemptId,
        maxEvaluations: evaluationLimit,
      })
      const scenarioById = mapExternalScenarios(
        input.trainScenarios,
        input.selectionScenarios,
        'GEPA bridge',
      )
      const evaluate = createExternalTextEvaluator({
        input,
        label: 'GEPA bridge',
        runDir,
        compatibleRunId: runId,
        costPhase: 'gepa.external-evaluation',
        costTags: runBudget.attemptTags,
        costLedger,
        scenarioById,
        maxCandidateChars,
        maxEvidenceChars,
        describeArtifact: config.describeArtifact,
      })
      const callback = await startExternalOptimizerCallback({
        token: randomBytes(32).toString('hex'),
        maxEvaluations: evaluationLimit,
        acceptEvaluation: () => runBudget.acceptEvaluation(),
        evaluate,
        ...(signal ? { signal } : {}),
      })

      const runnerEnv = bridgeRunner?.env ?? {}
      let modelProxy: ExternalOptimizerModelProxy | undefined
      const closeResources = () =>
        closeExternalOptimizerResources({
          label: name,
          callback,
          ...(modelProxy ? { modelProxy } : {}),
        })
      const { result, outputDir } = await runWithCleanup({
        label: `${name} optimizer resources`,
        run: async () => {
          if (config.optimizer) {
            const priorOptimizerUsage = costLedger.summary({
              phase: 'gepa.optimizer-model',
              tags: runBudget.runTags,
            })
            assertPriorExternalOptimizerUsage(priorOptimizerUsage, config.optimizer.budget, name)
            modelProxy = await startExternalOptimizerModelProxy({
              upstreamBaseUrl: config.optimizer.baseUrl,
              upstreamApiKey: config.optimizer.apiKey,
              model: config.optimizer.model,
              budget: config.optimizer.budget,
              costLedger,
              phase: 'gepa.optimizer-model',
              actor: name,
              tags: { ...runBudget.attemptTags },
              initialUsage: {
                requests: priorOptimizerUsage.totalCalls,
                costUsd: priorOptimizerUsage.totalCostUsd,
              },
              ...(signal ? { signal } : {}),
            })
          }
          const outputDir = `${runDir}/external`
          await mkdir(outputDir, { recursive: true })
          const result = await runExternalOptimizerProcess<GepaBridgeOutput>({
            label: 'GEPA bridge',
            tempPrefix: 'agent-eval-gepa-',
            module: 'agent_eval_rpc.gepa_bridge',
            input: {
              attemptId,
              compatibleRunId,
              runId,
              runtimeIdentity,
              resume,
              trustedResumeState: config.trustResumeState === true,
              evaluationId: config.evaluationId,
              seed: input.seed,
              callbackUrl: callback.url,
              callbackToken: callback.token,
              engineModules: config.engineModules ?? [],
              recipe: config.recipe,
              objective: config.objective,
              ...(config.background ? { background: config.background } : {}),
              seedCandidate,
              trainSet,
              selectionSet,
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
              modelProxy && bridgeRunner
                ? {
                    ...bridgeRunner,
                    env: removeCredentialEnvironment(runnerEnv),
                  }
                : bridgeRunner,
            timeoutMs: config.timeoutMs ?? GEPA_DEFAULT_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
          })
          return { result, outputDir }
        },
        cleanup: closeResources,
      })
      signal?.throwIfAborted()
      assertGepaBridgeOutput(
        result,
        name,
        maxCandidateChars,
        config.recipe.kind,
        evaluationLimit,
        expectsComponents,
      )
      assertExternalOptimizerRunBinding({
        label: name,
        runtime: runtimeIdentity,
        returnedSource: result.upstream,
        compatibleRunId,
        runId,
        returnedRunId: result.runId,
        resume,
        resumed: result.resumed,
      })
      if (callback.evaluations() !== result.totalEvaluations) {
        throw new Error(
          `${name}: GEPA reported ${result.totalEvaluations} evaluations but the callback received ${callback.evaluations()}`,
        )
      }

      const evaluationCost = costFromLedgerSummary(
        costLedger.summary({
          phase: 'gepa.external-evaluation',
          tags: runBudget.runTags,
        }),
      )
      const optimizerSummary = costLedger.summary({
        phase: 'gepa.optimizer-model',
        tags: runBudget.runTags,
      })
      const optimizerReceipts = costLedger.list({
        phase: 'gepa.optimizer-model',
        tags: runBudget.runTags,
      })
      const optimizerCost = costFromLedgerSummary(optimizerSummary)
      const reportedProposerCost = result.proposerCostUsd ?? 0
      if (modelProxy) {
        assertExternalOptimizerCompletionCount(
          result.tokenUsage,
          modelProxy.requestAttempts(),
          modelProxy.successfulCompletions(),
          name,
          'GEPA',
        )
      }
      const tokenUsage = modelProxy
        ? optimizationTokenUsageFromSummary(optimizerSummary, optimizerReceipts)
        : undefined
      const runtime = observedExternalOptimizerRuntime(runtimeIdentity)
      return {
        winnerSurface: decodeExternalTextCandidate(result.bestCandidate),
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
                ...(result.resumed
                  ? ['GEPA proposer cost before this resumed attempt is unavailable']
                  : []),
              ],
            },
        durationMs: Date.now() - started,
        provenance: {
          ...runtime,
          compatibleRunId,
          runId,
          resumed: result.resumed,
          evaluationCount: runBudget.acceptedEvaluations(),
          artifactDir: outputDir,
          ...(tokenUsage ? { tokenUsage } : {}),
        },
      }
    },
  }
}
