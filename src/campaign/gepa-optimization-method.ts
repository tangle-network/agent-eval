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
import { readGepaCandidatePopulationArtifact } from './gepa-candidate-population'
import {
  assertGepaComponentRecipe,
  assertGepaOptimizationConfig,
  defaultGepaMethodName,
  GEPA_DEFAULT_MAX_CANDIDATE_CHARS,
  GEPA_DEFAULT_MAX_EVIDENCE_CHARS,
  GEPA_DEFAULT_TIMEOUT_MS,
  gepaRecipeEvaluationLimit,
  gepaRecipeHasAgentCliEngine,
  gepaRecipeSupportsResume,
  snapshotGepaOptimizationConfig,
} from './gepa-optimization-config'
import { assertGepaBridgeOutput, type GepaBridgeOutput } from './gepa-optimization-result'
import type { OpenAICompatibleOptimizerModel } from './optimizer-model'
import {
  combineComparisonCosts,
  costFromLedgerSummary,
  type OptimizationMethod,
  optimizationTokenUsageFromSummary,
} from './presets/compare-optimization-methods'
import type { SearchHistoryReceipt } from './search-history-receipt'
import type { SearchAttemptAccounting } from './search-ledger'
import { openSearchLedger } from './search-ledger'
import { recordCandidatePopulationSearch, type SearchRunIdentity } from './search-ledger-recording'
import { fsCampaignStorage } from './storage'
import type { Scenario } from './types'

/** Shared settings for one bounded GEPA engine invocation. */
export interface GepaEngineOptions {
  /** GEPA engine name. GEPA validates names available in its Python runtime. */
  engine: string
  /** Optional billed-USD stop. Omit when the execution owner reports USD as unknown. */
  maxProposerCostUsd?: number
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
  /** Candidate-evaluation callback byte limits. Omitted fields use finite defaults. */
  evaluationCallbackLimits?: Partial<ExternalOptimizerCallbackLimits>
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
  /**
   * Record GEPA's own candidate population into the canonical `SearchLedger`
   * and return the bounded receipt on the method result, so a comparison run
   * under `searchHistoryPolicy: 'require-complete'` accepts this method.
   *
   * `identity` declares the immutable revisions and the model snapshot the
   * ledger requires and the bridge does not report. `path` defaults to
   * `<runDir>/search-ledger.jsonl`.
   */
  searchLedger?: { identity: SearchRunIdentity; path?: string }
}

/**
 * Turn an optional GEPA installation into an `OptimizationMethod`.
 *
 * GEPA receives only serialized train and selection cases. The caller's final
 * test partition stays inside `compareOptimizationMethods`, which invokes this
 * method without a test-set field. The local callback routes every candidate
 * evaluation through the same dispatch and judges used by other methods.
 */
/**
 * Environment for a bridge child that spawns `claude` CLI subprocesses.
 *
 * Both agent CLI engines start the CLI with the bridge's own environment, so
 * these variables travel bridge → engine → CLI. They merge AFTER
 * `removeCredentialEnvironment`: the ephemeral loopback token is the only
 * credential the child may see, and a caller-supplied ANTHROPIC_AUTH_TOKEN is
 * stripped like any other credential.
 */
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
      const evaluationLimit = gepaRecipeEvaluationLimit(
        config.recipe,
        input.selectionScenarios.length,
      )
      const maxPopulationCandidates = Math.min(Number.MAX_SAFE_INTEGER, evaluationLimit + 1)
      const populationScenarioIds = (selectionSet.length > 0 ? selectionSet : trainSet).map(
        (scenario) => scenario.id,
      )
      const runMaterial = {
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
      let attemptEvaluationCount = 0
      const callback = await startExternalOptimizerCallback({
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
      let searchHistory: SearchHistoryReceipt | undefined
      if (result.candidatePopulation) {
        const population = readGepaCandidatePopulationArtifact({
          summary: result.candidatePopulation,
          storage,
        })
        const selected = population.candidates[population.bestIndex]
        const selectedHash = contentHash({
          kind: 'external-text-candidate',
          candidate: result.bestCandidate,
        })
        if (selected?.candidateHash !== selectedHash) {
          throw new Error(`${name}: GEPA candidate population identifies a different winner`)
        }
        if (config.searchLedger) {
          searchHistory = await recordCandidatePopulationSearch({
            ledger: openSearchLedger({
              path: config.searchLedger.path ?? `${runDir}/search-ledger.jsonl`,
              campaignId: runId,
            }),
            storage,
            runDir,
            identity: config.searchLedger.identity,
            population,
            scenarios: input.selectionScenarios,
            generationAccounting: optimizerAccounting(result.tokenUsage, result.proposerCostUsd),
            producerId: name,
            runId,
          })
        }
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
    },
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
