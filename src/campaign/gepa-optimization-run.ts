import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { contentHash } from '../verdict-cache'
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
  type ExternalOptimizerModelProxy,
  removeCredentialEnvironment,
  resolveExternalOptimizerCallbackLimits,
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
  type ExternalOptimizationExample,
  encodeExternalTextCandidate,
  mapExternalScenarios,
} from './external-text-optimization'
import { readGepaCandidatePopulationArtifact } from './gepa-candidate-population'
import {
  assertGepaComponentRecipe,
  GEPA_DEFAULT_MAX_CANDIDATE_CHARS,
  GEPA_DEFAULT_MAX_EVIDENCE_CHARS,
  GEPA_DEFAULT_TIMEOUT_MS,
  gepaRecipeEvaluationLimit,
  gepaRecipeHasAgentCliEngine,
  gepaRecipeSupportsResume,
} from './gepa-optimization-config'
import type { GepaOptimizationMethodConfig, GepaRunnerCommand } from './gepa-optimization-method'
import { assertGepaBridgeOutput, type GepaBridgeOutput } from './gepa-optimization-result'
import { recordGepaSearch } from './gepa-search-import'
import {
  combineComparisonCosts,
  costFromLedgerSummary,
  optimizationTokenUsageFromSummary,
} from './optimization-cost'
import type { OptimizationMethodInput, OptimizationMethodResult } from './optimization-method'
import type { OpenAICompatibleOptimizerModel } from './optimizer-model'
import type { SearchHistoryReceipt } from './search-history-receipt'
import type { SearchAttemptAccounting } from './search-ledger'
import { fsCampaignStorage } from './storage'
import type { Scenario } from './types'

function anthropicShimEnvironment(
  proxy: Pick<ExternalOptimizerModelProxy, 'baseUrl' | 'apiKey'>,
  optimizer: OpenAICompatibleOptimizerModel,
): Record<string, string> {
  return {
    // The Anthropic SDK appends /v1/messages itself; inject the origin.
    ANTHROPIC_BASE_URL: new URL(proxy.baseUrl).origin,
    ANTHROPIC_AUTH_TOKEN: proxy.apiKey,
    ANTHROPIC_MODEL: optimizer.model,
    // Background haiku-class calls must carry the one admitted model id.
    ANTHROPIC_SMALL_FAST_MODEL: optimizer.model,
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    // The proxy refuses thinking requests; adaptive thinking stays off.
    CLAUDE_CODE_DISABLE_ADAPTIVE_THINKING: '1',
    // Align the CLI's requested max_tokens with the per-request cap. The
    // engines only setdefault this variable, so the injected value wins.
    CLAUDE_CODE_MAX_OUTPUT_TOKENS: String(
      Math.min(optimizer.budget.maxOutputTokensPerRequest, 64_000),
    ),
    // The synthesized SSE sends its first byte after the owner call
    // completes; keep the CLI deadline above the proxy's request deadline.
    API_TIMEOUT_MS: String((optimizer.budget.requestTimeoutMs ?? 300_000) + 60_000),
  }
}

/** Spend the optimizer booked to its own candidate generation. Unknown stays
 *  unknown: the bridge reports proposer cost only when the engine measured it. */
function optimizerAccounting(
  tokenUsage: { inputTokens?: number; outputTokens?: number } | undefined,
  proposerCostUsd: number | undefined,
): SearchAttemptAccounting {
  return {
    tokens:
      tokenUsage?.inputTokens === undefined || tokenUsage.outputTokens === undefined
        ? { status: 'unknown', reason: 'the optimizer bridge reported no token usage' }
        : {
            status: 'known',
            inputTokens: tokenUsage.inputTokens,
            outputTokens: tokenUsage.outputTokens,
            cachedTokens: 0,
          },
    cost:
      proposerCostUsd === undefined
        ? {
            status: 'unknown',
            knownLowerBoundUsd: 0,
            reason: 'the optimizer bridge reported no proposer cost',
          }
        : { status: 'known', usd: proposerCostUsd, source: 'provider' },
  }
}

/** What the GEPA run key is hashed over; fields added later join only when enabled so earlier run keys keep their identity. */
function gepaRunMaterial<TScenario extends Scenario, TArtifact>(
  config: GepaOptimizationMethodConfig<TScenario, TArtifact>,
  input: OptimizationMethodInput<TScenario, TArtifact>,
  parts: {
    name: string
    runtimeIdentity: Awaited<ReturnType<typeof inspectExternalOptimizerRuntime>>
    bridgeRunner: GepaOptimizationMethodConfig<TScenario, TArtifact>['runner']
    seedCandidate: ReturnType<typeof encodeExternalTextCandidate>
    trainSet: readonly ExternalOptimizationExample[]
    selectionSet: readonly ExternalOptimizationExample[]
    maxCandidateChars: number
    maxPopulationCandidates: number
    maxEvidenceChars: number
  },
) {
  const {
    name,
    runtimeIdentity,
    bridgeRunner,
    seedCandidate,
    trainSet,
    selectionSet,
    maxCandidateChars,
    maxPopulationCandidates,
    maxEvidenceChars,
  } = parts
  return {
    optimizer: 'gepa',
    runtime: runtimeIdentity,
    method: name,
    evaluationId: config.evaluationId,
    dispatchRef: input.runOptions.dispatchRef ?? null,
    seed: input.seed,
    recipe: snapshotJson(config.recipe, 'GEPA run settings'),
    engineModules: config.engineModules ?? [],
    objective: config.objective,
    background: config.background ?? '',
    seedCandidate,
    trainSet,
    selectionSet,
    maxCandidateChars,
    maxPopulationCandidates,
    maxEvidenceChars,
    evaluationCallbackLimits: resolveExternalOptimizerCallbackLimits(
      config.evaluationCallbackLimits,
    ),
    optimizerModel: config.optimizer
      ? {
          model: config.optimizer.model,
          callRef: config.optimizer.callRef,
          budget: config.optimizer.budget,
          // Included only when enabled so pre-existing run keys keep
          // their identity.
          ...(config.optimizer.anthropicEndpoint === true ? { anthropicEndpoint: true } : {}),
        }
      : null,
    runner: externalOptimizerRunnerIdentity(bridgeRunner, 'agent_eval_rpc.gepa_bridge'),
    trustResumeState: config.trustResumeState === true,
  }
}

/** Starts the callback server the GEPA bridge calls back into: evaluations are counted against the run budget and observed into the log. */
async function startGepaCallback<TScenario extends Scenario, TArtifact>(
  config: GepaOptimizationMethodConfig<TScenario, TArtifact>,
  input: OptimizationMethodInput<TScenario, TArtifact>,
  parts: {
    runDir: string
    runId: string
    runBudget: ReturnType<typeof openExternalOptimizerRunBudget>
    observationLog: ReturnType<typeof openExternalOptimizerObservationLog>
    evaluationLimit: number
    maxCandidateChars: number
    maxEvidenceChars: number
  },
) {
  const {
    runDir,
    runId,
    runBudget,
    observationLog,
    evaluationLimit,
    maxCandidateChars,
    maxEvidenceChars,
  } = parts
  const signal = input.runOptions.signal
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
    costLedger: input.costLedger,
    scenarioById,
    maxCandidateChars,
    maxEvidenceChars,
    describeArtifact: config.describeArtifact,
  })
  let attemptEvaluationCount = 0
  return startExternalOptimizerCallback({
    token: randomBytes(32).toString('hex'),
    maxEvaluations: evaluationLimit,
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
}

/** The settled inputs of one GEPA run: its identity, budgets, evaluation callback and logs. */
export async function prepareGepaRun<TScenario extends Scenario, TArtifact>(
  config: GepaOptimizationMethodConfig<TScenario, TArtifact>,
  input: OptimizationMethodInput<TScenario, TArtifact>,
  name: string,
) {
  const signal = input.runOptions.signal
  signal?.throwIfAborted()
  if (typeof input.baselineSurface !== 'string' && input.baselineSurface.kind !== 'components') {
    throw new Error(`${name}: GEPA bridge supports text and component surfaces`)
  }
  const expectsComponents = typeof input.baselineSurface !== 'string'
  if (expectsComponents) {
    assertGepaComponentRecipe(config.recipe, name)
  }

  const started = Date.now()
  const maxCandidateChars = config.maxCandidateChars ?? GEPA_DEFAULT_MAX_CANDIDATE_CHARS
  const maxEvidenceChars = config.maxEvidenceChars ?? GEPA_DEFAULT_MAX_EVIDENCE_CHARS
  const timeoutMs = config.timeoutMs ?? GEPA_DEFAULT_TIMEOUT_MS
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
    timeoutMs,
    ...(signal ? { signal } : {}),
  })
  const seedCandidate = encodeExternalTextCandidate(input.baselineSurface)
  const trainSet = input.trainScenarios.map((scenario) =>
    describeExternalScenario(scenario, 'GEPA', maxEvidenceChars, config.describeScenario),
  )
  const selectionSet = input.selectionScenarios.map((scenario) =>
    describeExternalScenario(scenario, 'GEPA', maxEvidenceChars, config.describeScenario),
  )
  const evaluationLimit = gepaRecipeEvaluationLimit(config.recipe, input.selectionScenarios.length)
  const maxPopulationCandidates = Math.min(Number.MAX_SAFE_INTEGER, evaluationLimit + 1)
  const populationScenarioIds = (selectionSet.length > 0 ? selectionSet : trainSet).map(
    (scenario) => scenario.id,
  )
  const runMaterial = gepaRunMaterial(config, input, {
    name,
    runtimeIdentity,
    bridgeRunner,
    seedCandidate,
    trainSet,
    selectionSet,
    maxCandidateChars,
    maxPopulationCandidates,
    maxEvidenceChars,
  })
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
  const observationLog = openExternalOptimizerObservationLog({
    storage,
    path: `${runDir}/observations-${attemptId}.jsonl`,
  })
  const executionLog = config.optimizer
    ? openExternalOptimizerExecutionLog({
        storage,
        path: `${runDir}/model-executions-${attemptId}.jsonl`,
      })
    : undefined
  const callback = await startGepaCallback(config, input, {
    runDir,
    runId,
    runBudget,
    observationLog,
    evaluationLimit,
    maxCandidateChars,
    maxEvidenceChars,
  })

  return {
    signal,
    expectsComponents,
    started,
    maxCandidateChars,
    maxEvidenceChars,
    timeoutMs,
    storage,
    runDir,
    costLedger,
    attemptId,
    resume,
    bridgeRunner,
    runtimeIdentity,
    seedCandidate,
    trainSet,
    selectionSet,
    evaluationLimit,
    maxPopulationCandidates,
    populationScenarioIds,
    compatibleRunId,
    runId,
    runBudget,
    observationLog,
    executionLog,
    callback,
    name,
    config,
    input,
  }
}

export type GepaRun<TScenario extends Scenario, TArtifact> = Awaited<
  ReturnType<typeof prepareGepaRun<TScenario, TArtifact>>
>

/** Start the optimizer model proxy when one is configured, run the GEPA bridge, and release the resources either way. */
export async function runBridge<TScenario extends Scenario, TArtifact>(
  ctx: GepaRun<TScenario, TArtifact>,
) {
  const {
    signal,
    maxCandidateChars,
    maxEvidenceChars,
    timeoutMs,
    runDir,
    costLedger,
    attemptId,
    resume,
    bridgeRunner,
    runtimeIdentity,
    seedCandidate,
    trainSet,
    selectionSet,
    maxPopulationCandidates,
    compatibleRunId,
    runId,
    runBudget,
    executionLog,
    callback,
    name,
    config,
    input,
  } = ctx
  const runnerEnv = bridgeRunner?.env ?? {}
  let modelProxy: ExternalOptimizerModelProxy | undefined
  // Injected at spawn time only, after the run keys are computed, so the
  // per-run port and ephemeral token never enter run identity.
  const bridgeRunnerForSpawn = (): GepaRunnerCommand | undefined => {
    if (!modelProxy) return bridgeRunner
    const anthropicChildEnv =
      config.optimizer?.anthropicEndpoint === true && gepaRecipeHasAgentCliEngine(config.recipe)
        ? anthropicShimEnvironment(modelProxy, config.optimizer)
        : undefined
    if (!bridgeRunner && !anthropicChildEnv) return bridgeRunner
    return {
      ...(bridgeRunner ?? {}),
      env: {
        ...removeCredentialEnvironment(runnerEnv),
        ...(anthropicChildEnv ?? {}),
      },
    }
  }
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
          call: config.optimizer.call,
          callRef: config.optimizer.callRef,
          recordExecution: executionLog!.observe,
          model: config.optimizer.model,
          budget: config.optimizer.budget,
          ...(config.optimizer.servedModelPolicy
            ? { servedModelPolicy: config.optimizer.servedModelPolicy }
            : {}),
          ...(config.optimizer.anthropicEndpoint === true ? { anthropicEndpoint: true } : {}),
          costLedger,
          phase: 'gepa.optimizer-model',
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
          timeoutMs,
          engineModules: config.engineModules ?? [],
          recipe: config.recipe,
          objective: config.objective,
          ...(config.background ? { background: config.background } : {}),
          seedCandidate,
          trainSet,
          selectionSet,
          maxCandidateChars,
          maxPopulationCandidates,
          maxEvidenceChars,
          outputDir,
          ...(modelProxy && config.optimizer
            ? {
                modelProxy: {
                  baseUrl: modelProxy.baseUrl,
                  apiKey: modelProxy.apiKey,
                  model: config.optimizer.model,
                  budget: config.optimizer.budget,
                  ...(config.optimizer.anthropicEndpoint === true
                    ? { anthropicEndpoint: true }
                    : {}),
                },
              }
            : {}),
        },
        runner: bridgeRunnerForSpawn(),
        timeoutMs,
        ...(signal ? { signal } : {}),
      })
      return { result, outputDir }
    },
    cleanup: closeResources,
  })
  return { result, outputDir, modelProxy }
}

/** Check the bridge output against the run it was started for, and return the candidate population it reports. */
export function verifyBridgeResult<TScenario extends Scenario, TArtifact>(
  ctx: GepaRun<TScenario, TArtifact>,
  result: GepaBridgeOutput,
): ReturnType<typeof readGepaCandidatePopulationArtifact> | null {
  const {
    signal,
    expectsComponents,
    maxCandidateChars,
    storage,
    resume,
    runtimeIdentity,
    evaluationLimit,
    maxPopulationCandidates,
    populationScenarioIds,
    compatibleRunId,
    runId,
    callback,
    name,
    config,
  } = ctx
  signal?.throwIfAborted()
  assertGepaBridgeOutput(
    result,
    name,
    maxCandidateChars,
    config.recipe.kind,
    evaluationLimit,
    maxPopulationCandidates,
    populationScenarioIds,
    expectsComponents,
    config.recipe.kind === 'engine' && config.recipe.run.engine === 'gepa',
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
  const population = result.candidatePopulation
    ? readGepaCandidatePopulationArtifact({ summary: result.candidatePopulation, storage })
    : null
  if (population) {
    const selected = population.candidates[population.bestIndex]
    const selectedHash = contentHash({
      kind: 'external-text-candidate',
      candidate: result.bestCandidate,
    })
    if (selected?.candidateHash !== selectedHash) {
      throw new Error(`${name}: GEPA candidate population identifies a different winner`)
    }
  }
  return population
}

/** Every recipe records its search in the search ledger when one is configured. */
export async function recordGepaSearchHistory<TScenario extends Scenario, TArtifact>(
  ctx: GepaRun<TScenario, TArtifact>,
  result: GepaBridgeOutput,
  population: ReturnType<typeof readGepaCandidatePopulationArtifact> | null,
): Promise<SearchHistoryReceipt | undefined> {
  const { storage, runDir, evaluationLimit, runId, observationLog, name, config, input } = ctx
  // Every recipe records its search. A composed recipe reports no
  // population, so its candidates enter with `unknown` edges, as SkillOpt's.
  const searchHistory: SearchHistoryReceipt | undefined = config.searchLedger
    ? await recordGepaSearch({
        name,
        path: config.searchLedger.path ?? `${runDir}/search-ledger.jsonl`,
        searchId: runId,
        identity: config.searchLedger.identity,
        storage,
        seed: input.seed,
        baselineSurface: input.baselineSurface,
        trainScenarios: input.trainScenarios,
        selectionScenarios: input.selectionScenarios,
        evaluationLimit,
        ...(population
          ? { population }
          : { population: null, selected: decodeExternalTextCandidate(result.bestCandidate) }),
        observations: readExternalOptimizerObservationArtifact({
          summary: observationLog.summary(),
          storage,
        }),
        generationAccounting: optimizerAccounting(result.tokenUsage, result.proposerCostUsd),
      })
    : undefined
  return searchHistory
}

/** Evaluation and optimizer-model cost, with the proxy's completeness checks. */
export function gepaCosts<TScenario extends Scenario, TArtifact>(
  ctx: GepaRun<TScenario, TArtifact>,
  result: GepaBridgeOutput,
  modelProxy: ExternalOptimizerModelProxy | undefined,
) {
  const { costLedger, runtimeIdentity, runBudget, name, config } = ctx
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
    modelProxy.assertExecutionComplete()
    // The bridge's httpx hooks observe exactly the reflection (OpenAI-wire)
    // traffic. Anthropic-wire calls come from the claude CLI, which cannot
    // self-report counts; their receipts are cross-checked below.
    const wires = modelProxy.wireUsage()
    assertExternalOptimizerCompletionCount(
      result.tokenUsage,
      wires.openai.requestAttempts,
      wires.openai.successfulCompletions,
      name,
      'GEPA',
    )
    if (config.optimizer?.anthropicEndpoint === true) {
      const anthropicReceipts = costLedger.list({
        phase: 'gepa.optimizer-model',
        tags: { ...runBudget.attemptTags, wire: 'anthropic' },
      })
      if (anthropicReceipts.length !== wires.anthropic.requestAttempts) {
        throw new Error(
          `${name}: the Anthropic endpoint admitted ${wires.anthropic.requestAttempts} model calls but the ledger holds ${anthropicReceipts.length} receipts`,
        )
      }
    }
  }
  const tokenUsage = modelProxy
    ? optimizationTokenUsageFromSummary(optimizerSummary, optimizerReceipts)
    : undefined
  const runtime = observedExternalOptimizerRuntime(runtimeIdentity)
  const meteredCost = modelProxy
    ? combineComparisonCosts([
        { label: 'evaluation', cost: evaluationCost },
        { label: 'optimizer model', cost: optimizerCost },
      ])
    : undefined
  const externalTotalCostUsd = evaluationCost.totalCostUsd + reportedProposerCost
  return { evaluationCost, tokenUsage, runtime, meteredCost, externalTotalCostUsd }
}

/** The method result: the winning surface, its cost and the provenance of the run. */
export function buildGepaOutcome<TScenario extends Scenario, TArtifact>(
  ctx: GepaRun<TScenario, TArtifact>,
  result: GepaBridgeOutput,
  outputDir: string,
  modelProxy: ExternalOptimizerModelProxy | undefined,
  searchHistory: SearchHistoryReceipt | undefined,
  costs: ReturnType<typeof gepaCosts<TScenario, TArtifact>>,
): OptimizationMethodResult {
  const { started, compatibleRunId, runId, runBudget, observationLog, executionLog, config } = ctx
  const { evaluationCost, tokenUsage, runtime, meteredCost, externalTotalCostUsd } = costs
  return {
    winnerSurface: decodeExternalTextCandidate(result.bestCandidate),
    ...(searchHistory ? { searchHistory } : {}),
    cost: modelProxy
      ? meteredCost!
      : {
          totalCostUsd: externalTotalCostUsd,
          costProvenance:
            result.proposerCostAccounting === 'reported' &&
            evaluationCost.costProvenance.kind !== 'uncaptured'
              ? { kind: 'estimated', usd: externalTotalCostUsd }
              : { kind: 'uncaptured', usd: null },
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
      ...(config.optimizer
        ? {
            optimizerModel: config.optimizer.model,
            optimizerCallRef: config.optimizer.callRef,
          }
        : {}),
      ...(modelProxy && config.optimizer?.anthropicEndpoint === true
        ? { anthropicEndpoint: modelProxy.wireUsage().anthropic }
        : {}),
      compatibleRunId,
      runId,
      resumed: result.resumed,
      seedApplied: result.seedApplied,
      evaluationCount: runBudget.acceptedEvaluations(),
      ...(result.upstreamReportedEvaluations !== undefined
        ? { upstreamReportedEvaluations: result.upstreamReportedEvaluations }
        : {}),
      artifactDir: outputDir,
      ...(tokenUsage ? { tokenUsage } : {}),
      observations: observationLog.summary(),
      ...(result.candidatePopulation
        ? { gepaCandidatePopulation: result.candidatePopulation }
        : {}),
      ...(executionLog ? { modelExecutions: executionLog.summary() } : {}),
    },
  }
}
