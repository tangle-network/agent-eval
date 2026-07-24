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
  describeExternalScenario,
  mapExternalScenarios,
} from './external-text-optimization'
import type { OpenAICompatibleOptimizerModel } from './optimizer-model'
import {
  costFromLedgerSummary,
  type OptimizationMethod,
  optimizationTokenUsageFromSummary,
} from './presets/compare-optimization-methods'
import {
  assertSkillOptOptimizationConfig,
  SKILLOPT_DEFAULT_MAX_CANDIDATE_CHARS,
  SKILLOPT_DEFAULT_MAX_EVIDENCE_CHARS,
  SKILLOPT_DEFAULT_TIMEOUT_MS,
  snapshotSkillOptOptimizationConfig,
} from './skillopt-optimization-config'
import {
  assertSkillOptBridgeOutput,
  type SkillOptBridgeOutput,
} from './skillopt-optimization-result'
import { fsCampaignStorage } from './storage'
import type { Scenario } from './types'

export interface SkillOptTrainerConfig {
  epochs: number
  batchSize: number
  accumulation?: number
  editBudget?: number
  minEditBudget?: number
  analystWorkers?: number
  minibatchSize?: number
  mergeBatchSize?: number
  maxAnalystRounds?: number
  evaluationWorkers?: number
  learningRateSchedule?: 'constant' | 'linear' | 'cosine' | 'autonomous'
  learningRateControl?: 'fixed' | 'autonomous' | 'none'
  updateMode?: 'patch' | 'rewrite_from_suggestions' | 'full_rewrite_minibatch'
  failureOnly?: boolean
  useSlowUpdate?: boolean
  useMetaSkill?: boolean
  /**
   * Additional flat SkillOpt trainer settings. Tangle overwrites data,
   * output, split, seed, validation, and activation settings.
   */
  overrides?: Record<string, unknown>
}

export type SkillOptRunnerCommand = ExternalOptimizerRunnerCommand

export interface SkillOptOptimizationMethodConfig<TScenario extends Scenario, TArtifact = unknown> {
  name?: string
  /** Goal included with every described train and selection case. */
  objective: string
  background?: string
  /** Stable identity for the dispatch, judges, model settings, and scoring logic. */
  evaluationId: string
  trainer: SkillOptTrainerConfig
  /**
   * OpenAI-compatible model connection and hard limits for SkillOpt's own
   * optimizer calls.
   */
  optimizer: OpenAICompatibleOptimizerModel
  /** Hard cap on candidate-case callback requests. */
  maxEvaluations: number
  /** Scores at or above this value count as hard successes. Default: 1. */
  hardScoreThreshold?: number
  maxCandidateChars?: number
  /** Maximum serialized scenario plus evaluation evidence. Default: 100,000. */
  maxEvidenceChars?: number
  timeoutMs?: number
  describeScenario?: (scenario: TScenario) => unknown
  describeArtifact?: (artifact: TArtifact, scenario: TScenario) => unknown
  resume?: ExternalOptimizerResumeMode
  runner?: SkillOptRunnerCommand
}

/** Run Microsoft's SkillOpt trainer as a complete optimization method. */
export function skillOptOptimizationMethod<TScenario extends Scenario, TArtifact>(
  config: SkillOptOptimizationMethodConfig<TScenario, TArtifact>,
): OptimizationMethod<TScenario, TArtifact> {
  assertSkillOptOptimizationConfig(config)
  config = snapshotSkillOptOptimizationConfig(config)
  const name = config.name ?? 'skillopt'
  return {
    name,
    async optimize(input) {
      const signal = input.runOptions.signal
      signal?.throwIfAborted()
      if (typeof input.baselineSurface !== 'string') {
        throw new Error(`${name}: SkillOpt requires a string baselineSurface`)
      }

      const started = Date.now()
      const maxCandidateChars = config.maxCandidateChars ?? SKILLOPT_DEFAULT_MAX_CANDIDATE_CHARS
      const maxEvidenceChars = config.maxEvidenceChars ?? SKILLOPT_DEFAULT_MAX_EVIDENCE_CHARS
      const storage = input.runOptions.storage ?? fsCampaignStorage()
      const runDir = `${input.runDir}/skillopt`
      storage.ensureDir(runDir)
      const costLedger = input.costLedger
      const attemptId = randomBytes(16).toString('hex')
      const resume = config.resume ?? 'never'
      const bridgeRunner = config.runner
        ? {
            ...config.runner,
            env: removeCredentialEnvironment(config.runner.env ?? {}),
          }
        : undefined
      const runtimeIdentity = await inspectExternalOptimizerRuntime({
        label: name,
        package: 'skillopt',
        module: 'agent_eval_rpc.skillopt_bridge',
        ...(bridgeRunner ? { runner: bridgeRunner } : {}),
        timeoutMs: config.timeoutMs ?? SKILLOPT_DEFAULT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      })
      const trainSet = input.trainScenarios.map((scenario) =>
        describeExternalScenario(scenario, 'SkillOpt', maxEvidenceChars, config.describeScenario),
      )
      const selectionSet = input.selectionScenarios.map((scenario) =>
        describeExternalScenario(scenario, 'SkillOpt', maxEvidenceChars, config.describeScenario),
      )
      const runMaterial = {
        optimizer: 'skillopt',
        runtime: runtimeIdentity,
        method: name,
        evaluationId: config.evaluationId,
        dispatchRef: input.runOptions.dispatchRef ?? null,
        seed: input.seed,
        trainer: snapshotJson(config.trainer, 'SkillOpt run settings'),
        objective: config.objective,
        background: config.background ?? '',
        optimizerModel: {
          model: config.optimizer.model,
          baseUrl: config.optimizer.baseUrl,
          budget: config.optimizer.budget,
        },
        seedCandidate: input.baselineSurface,
        trainSet,
        selectionSet,
        maxEvaluations: config.maxEvaluations,
        hardScoreThreshold: config.hardScoreThreshold ?? 1,
        maxCandidateChars,
        maxEvidenceChars,
        runner: externalOptimizerRunnerIdentity(bridgeRunner, 'agent_eval_rpc.skillopt_bridge'),
      }
      const compatibleRunId = externalOptimizerCompatibleRunKey(runMaterial)
      const runId = externalOptimizerRunKey({
        material: runMaterial,
        attemptId,
        resumeEnabled: resume !== 'never',
      })
      const runBudget = openExternalOptimizerRunBudget({
        storage,
        runDir,
        runKey: runId,
        attemptId,
        maxEvaluations: config.maxEvaluations,
      })
      const scenarioById = mapExternalScenarios(
        input.trainScenarios,
        input.selectionScenarios,
        'SkillOpt bridge',
      )
      const evaluate = createExternalTextEvaluator({
        input,
        label: 'SkillOpt bridge',
        runDir,
        compatibleRunId: runId,
        costPhase: 'skillopt.external-evaluation',
        costTags: runBudget.attemptTags,
        costLedger,
        scenarioById,
        maxCandidateChars,
        maxEvidenceChars,
        describeArtifact: config.describeArtifact,
      })
      const callback = await startExternalOptimizerCallback({
        token: randomBytes(32).toString('hex'),
        maxEvaluations: config.maxEvaluations,
        acceptEvaluation: () => runBudget.acceptEvaluation(),
        evaluate,
        ...(signal ? { signal } : {}),
      })
      const runnerEnv = bridgeRunner?.env ?? {}
      let activeModelProxy: ExternalOptimizerModelProxy | undefined
      const closeResources = () =>
        closeExternalOptimizerResources({
          label: name,
          callback,
          ...(activeModelProxy ? { modelProxy: activeModelProxy } : {}),
        })
      const { result, outputDir, modelProxy } = await runWithCleanup({
        label: `${name} optimizer resources`,
        run: async () => {
          const priorOptimizerUsage = costLedger.summary({
            phase: 'skillopt.optimizer-model',
            tags: runBudget.runTags,
          })
          assertPriorExternalOptimizerUsage(priorOptimizerUsage, config.optimizer.budget, name)
          const modelProxy = await startExternalOptimizerModelProxy({
            upstreamBaseUrl: config.optimizer.baseUrl,
            upstreamApiKey: config.optimizer.apiKey,
            model: config.optimizer.model,
            budget: config.optimizer.budget,
            costLedger,
            phase: 'skillopt.optimizer-model',
            actor: name,
            tags: { ...runBudget.attemptTags },
            initialUsage: {
              requests: priorOptimizerUsage.totalCalls,
              costUsd: priorOptimizerUsage.totalCostUsd,
            },
            ...(signal ? { signal } : {}),
          })
          activeModelProxy = modelProxy
          const outputDir = `${runDir}/external`
          await mkdir(outputDir, { recursive: true })
          const result = await runExternalOptimizerProcess<SkillOptBridgeOutput>({
            label: 'SkillOpt bridge',
            tempPrefix: 'agent-eval-skillopt-',
            module: 'agent_eval_rpc.skillopt_bridge',
            input: {
              attemptId,
              compatibleRunId,
              runId,
              runtimeIdentity,
              resume,
              evaluationId: config.evaluationId,
              seed: input.seed,
              callbackUrl: callback.url,
              callbackToken: callback.token,
              objective: config.objective,
              ...(config.background ? { background: config.background } : {}),
              trainer: config.trainer,
              optimizerModel: config.optimizer.model,
              modelBudget: config.optimizer.budget,
              seedCandidate: input.baselineSurface,
              trainSet,
              selectionSet,
              maxEvaluations: config.maxEvaluations,
              hardScoreThreshold: config.hardScoreThreshold ?? 1,
              maxCandidateChars,
              maxEvidenceChars,
              outputDir,
            },
            runner: {
              ...bridgeRunner,
              env: {
                ...removeCredentialEnvironment(runnerEnv),
                OPENAI_COMPATIBLE_BASE_URL: modelProxy.baseUrl,
                OPENAI_COMPATIBLE_API_KEY: modelProxy.apiKey,
                OPTIMIZER_OPENAI_COMPATIBLE_BASE_URL: modelProxy.baseUrl,
                OPTIMIZER_OPENAI_COMPATIBLE_API_KEY: modelProxy.apiKey,
                TARGET_OPENAI_COMPATIBLE_BASE_URL: modelProxy.baseUrl,
                TARGET_OPENAI_COMPATIBLE_API_KEY: modelProxy.apiKey,
                OPENAI_COMPATIBLE_MODEL: config.optimizer.model,
                OPENAI_COMPATIBLE_MAX_TOKENS: String(
                  config.optimizer.budget.maxOutputTokensPerRequest,
                ),
                OPTIMIZER_OPENAI_COMPATIBLE_MODEL: config.optimizer.model,
                OPTIMIZER_OPENAI_COMPATIBLE_MAX_TOKENS: String(
                  config.optimizer.budget.maxOutputTokensPerRequest,
                ),
                TARGET_OPENAI_COMPATIBLE_MODEL: config.optimizer.model,
                TARGET_OPENAI_COMPATIBLE_MAX_TOKENS: String(
                  config.optimizer.budget.maxOutputTokensPerRequest,
                ),
              },
            },
            timeoutMs: config.timeoutMs ?? SKILLOPT_DEFAULT_TIMEOUT_MS,
            ...(signal ? { signal } : {}),
          })
          return { result, outputDir, modelProxy }
        },
        cleanup: closeResources,
      })
      signal?.throwIfAborted()
      assertSkillOptBridgeOutput(result, name, maxCandidateChars, config.maxEvaluations)
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
          `${name}: SkillOpt reported ${result.totalEvaluations} evaluations but the callback received ${callback.evaluations()}`,
        )
      }

      const evaluationCost = costFromLedgerSummary(
        costLedger.summary({
          phase: 'skillopt.external-evaluation',
          tags: runBudget.runTags,
        }),
      )
      const optimizerUsage = costLedger.summary({
        phase: 'skillopt.optimizer-model',
        tags: runBudget.runTags,
      })
      const optimizerReceipts = costLedger.list({
        phase: 'skillopt.optimizer-model',
        tags: runBudget.runTags,
      })
      const optimizerCost = costFromLedgerSummary(optimizerUsage)
      assertExternalOptimizerCompletionCount(
        result.tokenUsage,
        modelProxy.requestAttempts(),
        modelProxy.successfulCompletions(),
        name,
        'SkillOpt',
      )
      const tokenUsage = optimizationTokenUsageFromSummary(optimizerUsage, optimizerReceipts)
      const runtime = observedExternalOptimizerRuntime(runtimeIdentity)
      return {
        winnerSurface: result.bestCandidate,
        cost: {
          totalCostUsd: evaluationCost.totalCostUsd + optimizerCost.totalCostUsd,
          accountingComplete: evaluationCost.accountingComplete && optimizerCost.accountingComplete,
          incompleteReasons: [
            ...evaluationCost.incompleteReasons.map((reason) => `evaluation: ${reason}`),
            ...optimizerCost.incompleteReasons.map((reason) => `optimizer model: ${reason}`),
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
