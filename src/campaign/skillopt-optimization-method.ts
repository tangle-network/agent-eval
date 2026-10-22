import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import {
  assertExternalOptimizerCompletionCount,
  assertPriorExternalOptimizerUsage,
} from './external-optimizer-accounting'
import {
  openExternalOptimizerExecutionLog,
  openExternalOptimizerObservationLog,
  readExternalOptimizerObservationArtifact,
} from './external-optimizer-observations'
import {
  closeExternalOptimizerResources,
  type ExternalOptimizerCallbackLimits,
  type ExternalOptimizerModelProxy,
  type ExternalOptimizerResumeMode,
  type ExternalOptimizerRunnerCommand,
  removeCredentialEnvironment,
  resolveExternalOptimizerCallbackLimits,
  runExternalOptimizerProcess,
  runWithCleanup,
  startExternalOptimizerCallback,
  startExternalOptimizerModelProxy,
} from './external-optimizer-process'
import {
  type ExternalOptimizerRunBudget,
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
import { recordSkillOptSearch } from './gepa-search-import'
import {
  combineComparisonCosts,
  costFromLedgerSummary,
  optimizationTokenUsageFromSummary,
} from './optimization-cost'
import type {
  OptimizationMethod,
  OptimizationMethodInput,
  OptimizationMethodResult,
} from './optimization-method'
import type { OpenAICompatibleOptimizerModel } from './optimizer-model'
import type { SearchRunIdentity } from './search-ledger-recording'
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
import { type CampaignStorage, fsCampaignStorage } from './storage'
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
  /** Candidate-evaluation callback byte limits. Omitted fields use finite defaults. */
  evaluationCallbackLimits?: Partial<ExternalOptimizerCallbackLimits>
  timeoutMs?: number
  describeScenario?: (scenario: TScenario) => unknown
  describeArtifact?: (artifact: TArtifact, scenario: TScenario) => unknown
  resume?: ExternalOptimizerResumeMode
  runner?: SkillOptRunnerCommand
  /**
   * Record SkillOpt's search into a search ledger and return the bounded
   * receipt on the method result, so a comparison under `searchHistoryPolicy:
   * 'require-complete'` accepts this method. Every candidate the callback
   * evaluated becomes a node with an `unknown` edge (SkillOpt reports no
   * parents), and every evaluation becomes a cell.
   *
   * `identity` declares the immutable revisions and the model the ledger
   * requires and the bridge does not report. `path` defaults to
   * `<runDir>/search-ledger.jsonl`.
   */
  searchLedger?: { identity: SearchRunIdentity; path?: string }
}

type SkillOptInput<TScenario extends Scenario, TArtifact> = OptimizationMethodInput<
  TScenario,
  TArtifact
>
type SkillOptConfig<TScenario extends Scenario, TArtifact> = SkillOptOptimizationMethodConfig<
  TScenario,
  TArtifact
>

/** Everything the SkillOpt steps share once the run is prepared and its callback is listening. */
interface SkillOptRunContext<TScenario extends Scenario, TArtifact> {
  config: SkillOptConfig<TScenario, TArtifact>
  input: SkillOptInput<TScenario, TArtifact>
  name: string
  signal: AbortSignal | undefined
  started: number
  maxCandidateChars: number
  maxEvidenceChars: number
  storage: CampaignStorage
  runDir: string
  attemptId: string
  resume: ExternalOptimizerResumeMode
  bridgeRunner: SkillOptRunnerCommand | undefined
  runtimeIdentity: Awaited<ReturnType<typeof inspectExternalOptimizerRuntime>>
  trainSet: ReturnType<typeof describeExternalScenario>[]
  selectionSet: ReturnType<typeof describeExternalScenario>[]
  compatibleRunId: string
  runId: string
  runBudget: ExternalOptimizerRunBudget
  observationLog: ReturnType<typeof openExternalOptimizerObservationLog>
  executionLog: ReturnType<typeof openExternalOptimizerExecutionLog>
  callback: Awaited<ReturnType<typeof startExternalOptimizerCallback>>
}

/** Run Microsoft's SkillOpt trainer as a complete optimization method. */
export function skillOptOptimizationMethod<TScenario extends Scenario, TArtifact>(
  config: SkillOptOptimizationMethodConfig<TScenario, TArtifact>,
): OptimizationMethod<TScenario, TArtifact> {
  assertSkillOptOptimizationConfig(config)
  config = snapshotSkillOptOptimizationConfig(config)
  const snapshot = config
  const name = snapshot.name ?? 'skillopt'
  return {
    name,
    optimize: (input) => optimizeWithSkillOpt(snapshot, name, input),
  }
}

async function optimizeWithSkillOpt<TScenario extends Scenario, TArtifact>(
  config: SkillOptConfig<TScenario, TArtifact>,
  name: string,
  input: SkillOptInput<TScenario, TArtifact>,
): Promise<OptimizationMethodResult> {
  const signal = input.runOptions.signal
  signal?.throwIfAborted()
  if (typeof input.baselineSurface !== 'string') {
    throw new Error(`${name}: SkillOpt requires a string baselineSurface`)
  }
  const context = await prepareSkillOptRun(config, name, input)
  const { result, outputDir, modelProxy } = await runSkillOptBridge(context)
  signal?.throwIfAborted()
  return finishSkillOptRun(context, result, outputDir, modelProxy)
}

/** Resolve identities, open the run's budget and logs, and start the evaluation callback. */
async function prepareSkillOptRun<TScenario extends Scenario, TArtifact>(
  config: SkillOptConfig<TScenario, TArtifact>,
  name: string,
  input: SkillOptInput<TScenario, TArtifact>,
): Promise<SkillOptRunContext<TScenario, TArtifact>> {
  const signal = input.runOptions.signal
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
      callRef: config.optimizer.callRef,
      budget: config.optimizer.budget,
    },
    seedCandidate: input.baselineSurface,
    trainSet,
    selectionSet,
    maxEvaluations: config.maxEvaluations,
    hardScoreThreshold: config.hardScoreThreshold ?? 1,
    maxCandidateChars,
    maxEvidenceChars,
    evaluationCallbackLimits: resolveExternalOptimizerCallbackLimits(
      config.evaluationCallbackLimits,
    ),
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
  const observationLog = openExternalOptimizerObservationLog({
    storage,
    path: `${runDir}/observations-${attemptId}.jsonl`,
  })
  const executionLog = openExternalOptimizerExecutionLog({
    storage,
    path: `${runDir}/model-executions-${attemptId}.jsonl`,
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
  let attemptEvaluationCount = 0
  const callback = await startExternalOptimizerCallback({
    token: randomBytes(32).toString('hex'),
    maxEvaluations: config.maxEvaluations,
    acceptEvaluation: () => {
      const accepted = runBudget.acceptEvaluation()
      if (accepted === undefined) return undefined
      attemptEvaluationCount += 1
      return attemptEvaluationCount
    },
    evaluate,
    observe: observationLog.observe,
    ...(config.evaluationCallbackLimits ? { limits: config.evaluationCallbackLimits } : {}),
    ...(signal ? { signal } : {}),
  })
  return {
    config,
    input,
    name,
    signal,
    started,
    maxCandidateChars,
    maxEvidenceChars,
    storage,
    runDir,
    attemptId,
    resume,
    bridgeRunner,
    runtimeIdentity,
    trainSet,
    selectionSet,
    compatibleRunId,
    runId,
    runBudget,
    observationLog,
    executionLog,
    callback,
  }
}

/** Start the metered model proxy and run the Python bridge, always closing the callback and proxy. */
async function runSkillOptBridge<TScenario extends Scenario, TArtifact>(
  context: SkillOptRunContext<TScenario, TArtifact>,
): Promise<{
  result: SkillOptBridgeOutput
  outputDir: string
  modelProxy: ExternalOptimizerModelProxy
}> {
  const { config, input, name, signal, runDir, runBudget, callback } = context
  const costLedger = input.costLedger
  const runnerEnv = context.bridgeRunner?.env ?? {}
  let activeModelProxy: ExternalOptimizerModelProxy | undefined
  const closeResources = () =>
    closeExternalOptimizerResources({
      label: name,
      callback,
      ...(activeModelProxy ? { modelProxy: activeModelProxy } : {}),
    })
  return runWithCleanup({
    label: `${name} optimizer resources`,
    run: async () => {
      const priorOptimizerUsage = costLedger.summary({
        phase: 'skillopt.optimizer-model',
        tags: runBudget.runTags,
      })
      assertPriorExternalOptimizerUsage(priorOptimizerUsage, config.optimizer.budget, name)
      const modelProxy = await startExternalOptimizerModelProxy({
        call: config.optimizer.call,
        callRef: config.optimizer.callRef,
        recordExecution: context.executionLog.observe,
        model: config.optimizer.model,
        budget: config.optimizer.budget,
        ...(config.optimizer.servedModelPolicy
          ? { servedModelPolicy: config.optimizer.servedModelPolicy }
          : {}),
        costLedger,
        phase: 'skillopt.optimizer-model',
        actor: name,
        tags: { ...runBudget.attemptTags },
        initialUsage: {
          requests: priorOptimizerUsage.totalCalls,
          ...(priorOptimizerUsage.costProvenance.kind === 'uncaptured'
            ? {}
            : { costUsd: priorOptimizerUsage.totalCostUsd }),
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
          attemptId: context.attemptId,
          compatibleRunId: context.compatibleRunId,
          runId: context.runId,
          runtimeIdentity: context.runtimeIdentity,
          resume: context.resume,
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
          trainSet: context.trainSet,
          selectionSet: context.selectionSet,
          maxEvaluations: config.maxEvaluations,
          hardScoreThreshold: config.hardScoreThreshold ?? 1,
          maxCandidateChars: context.maxCandidateChars,
          maxEvidenceChars: context.maxEvidenceChars,
          outputDir,
        },
        runner: {
          ...context.bridgeRunner,
          env: {
            ...removeCredentialEnvironment(runnerEnv),
            ...skillOptModelEnvironment(config, modelProxy),
          },
        },
        timeoutMs: config.timeoutMs ?? SKILLOPT_DEFAULT_TIMEOUT_MS,
        ...(signal ? { signal } : {}),
      })
      return { result, outputDir, modelProxy }
    },
    cleanup: closeResources,
  })
}

/** Point every OpenAI-compatible client the bridge uses at the metered model proxy. */
function skillOptModelEnvironment<TScenario extends Scenario, TArtifact>(
  config: SkillOptConfig<TScenario, TArtifact>,
  modelProxy: ExternalOptimizerModelProxy,
): Record<string, string> {
  const maxTokens = String(config.optimizer.budget.maxOutputTokensPerRequest)
  return {
    OPENAI_COMPATIBLE_BASE_URL: modelProxy.baseUrl,
    OPENAI_COMPATIBLE_API_KEY: modelProxy.apiKey,
    OPTIMIZER_OPENAI_COMPATIBLE_BASE_URL: modelProxy.baseUrl,
    OPTIMIZER_OPENAI_COMPATIBLE_API_KEY: modelProxy.apiKey,
    TARGET_OPENAI_COMPATIBLE_BASE_URL: modelProxy.baseUrl,
    TARGET_OPENAI_COMPATIBLE_API_KEY: modelProxy.apiKey,
    OPENAI_COMPATIBLE_MODEL: config.optimizer.model,
    OPENAI_COMPATIBLE_MAX_TOKENS: maxTokens,
    OPTIMIZER_OPENAI_COMPATIBLE_MODEL: config.optimizer.model,
    OPTIMIZER_OPENAI_COMPATIBLE_MAX_TOKENS: maxTokens,
    TARGET_OPENAI_COMPATIBLE_MODEL: config.optimizer.model,
    TARGET_OPENAI_COMPATIBLE_MAX_TOKENS: maxTokens,
  }
}

/** Validate the bridge output against the run, total its spend, and build the method result. */
async function finishSkillOptRun<TScenario extends Scenario, TArtifact>(
  context: SkillOptRunContext<TScenario, TArtifact>,
  result: SkillOptBridgeOutput,
  outputDir: string,
  modelProxy: ExternalOptimizerModelProxy,
): Promise<OptimizationMethodResult> {
  const { config, input, name, runBudget, callback, observationLog, executionLog } = context
  const { runtimeIdentity, compatibleRunId, runId } = context
  const costLedger = input.costLedger
  assertSkillOptBridgeOutput(result, name, context.maxCandidateChars, config.maxEvaluations)
  assertExternalOptimizerRunBinding({
    label: name,
    runtime: runtimeIdentity,
    returnedSource: result.upstream,
    compatibleRunId,
    runId,
    returnedRunId: result.runId,
    resume: context.resume,
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
  modelProxy.assertExecutionComplete()
  assertExternalOptimizerCompletionCount(
    result.tokenUsage,
    modelProxy.requestAttempts(),
    modelProxy.successfulCompletions(),
    name,
    'SkillOpt',
  )
  const tokenUsage = optimizationTokenUsageFromSummary(optimizerUsage, optimizerReceipts)
  const runtime = observedExternalOptimizerRuntime(runtimeIdentity)
  const combinedCost = combineComparisonCosts([
    { label: 'evaluation', cost: evaluationCost },
    { label: 'optimizer model', cost: optimizerCost },
  ])
  const searchHistory = config.searchLedger
    ? await recordSkillOptSearch({
        name,
        path: config.searchLedger.path ?? `${context.runDir}/search-ledger.jsonl`,
        searchId: runId,
        identity: config.searchLedger.identity,
        storage: context.storage,
        seed: input.seed,
        baselineSurface: input.baselineSurface as string,
        trainScenarios: input.trainScenarios,
        selectionScenarios: input.selectionScenarios,
        evaluationLimit: config.maxEvaluations,
        observations: readExternalOptimizerObservationArtifact({
          summary: observationLog.summary(),
          storage: context.storage,
        }),
        selected: result.bestCandidate,
        // The model proxy metered every optimizer call, so its receipts are the spend.
        generationAccounting: {
          tokens: optimizerUsage.usageComplete
            ? {
                status: 'known',
                inputTokens: optimizerUsage.inputTokens,
                outputTokens: optimizerUsage.outputTokens,
                cachedTokens: optimizerUsage.cachedTokens,
              }
            : { status: 'unknown', reason: 'an optimizer call reported no token usage' },
          cost: optimizerCost.accountingComplete
            ? { status: 'known', usd: optimizerCost.totalCostUsd, source: 'provider' }
            : {
                status: 'unknown',
                knownLowerBoundUsd: optimizerCost.totalCostUsd,
                reason: optimizerCost.incompleteReasons.join('; ') || 'optimizer spend incomplete',
              },
        },
      })
    : undefined
  return {
    winnerSurface: result.bestCandidate,
    ...(searchHistory ? { searchHistory } : {}),
    cost: combinedCost,
    durationMs: Date.now() - context.started,
    provenance: {
      ...runtime,
      optimizerModel: config.optimizer.model,
      optimizerCallRef: config.optimizer.callRef,
      compatibleRunId,
      runId,
      resumed: result.resumed,
      evaluationCount: runBudget.acceptedEvaluations(),
      artifactDir: outputDir,
      ...(tokenUsage ? { tokenUsage } : {}),
      observations: observationLog.summary(),
      modelExecutions: executionLog.summary(),
    },
  }
}
