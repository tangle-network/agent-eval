import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type { CostLedgerSummary } from '../cost-ledger'
import {
  assertJsonValue,
  assertNoCredentialValues,
  type ExternalOptimizerModelProxy,
  type ExternalOptimizerResumeMode,
  type ExternalOptimizerRunnerCommand,
  isCandidateText,
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
  reasoningEffort?: string
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
  /** Revision of the dispatch, judges, model settings, and scoring logic. */
  evaluationVersion: string
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

interface SkillOptBridgeOutput {
  bestCandidate: string
  bestScore: number
  totalEvaluations: number
  totalSteps: number
  tokenUsage?: {
    inputTokens: number
    outputTokens: number
    totalTokens: number
    calls: number
  }
  upstream: {
    package: 'skillopt'
    version: string
    sourceUrl?: string
    revision?: string
  }
  runId: string
  resumed: boolean
}

const DEFAULT_MAX_CANDIDATE_CHARS = 200_000
const DEFAULT_MAX_EVIDENCE_CHARS = 100_000
const DEFAULT_TIMEOUT_MS = 60 * 60 * 1000

/** Run Microsoft's SkillOpt trainer as a complete optimization method. */
export function skillOptOptimizationMethod<TScenario extends Scenario, TArtifact>(
  config: SkillOptOptimizationMethodConfig<TScenario, TArtifact>,
): OptimizationMethod<TScenario, TArtifact> {
  assertConfig(config)
  config = snapshotConfig(config)
  const name = config.name ?? 'skillopt'
  return {
    name,
    async optimize(input) {
      if (typeof input.baselineSurface !== 'string') {
        throw new Error(`${name}: SkillOpt requires a string baselineSurface`)
      }

      const started = Date.now()
      const maxCandidateChars = config.maxCandidateChars ?? DEFAULT_MAX_CANDIDATE_CHARS
      const maxEvidenceChars = config.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS
      const storage = input.runOptions.storage ?? fsCampaignStorage()
      const runDir = `${input.runDir}/skillopt`
      storage.ensureDir(runDir)
      const costLedger = input.costLedger
      const scenarioById = mapExternalScenarios(
        input.trainScenarios,
        input.selectionScenarios,
        'SkillOpt bridge',
      )
      const evaluate = createExternalTextEvaluator({
        input,
        label: 'SkillOpt bridge',
        runDir,
        costPhase: 'skillopt.external-evaluation',
        costLedger,
        scenarioById,
        maxCandidateChars,
        maxEvidenceChars,
        describeArtifact: config.describeArtifact,
      })
      const callback = await startExternalOptimizerCallback({
        token: randomBytes(32).toString('hex'),
        maxEvaluations: config.maxEvaluations,
        evaluate,
      })
      const runnerEnv = config.runner?.env ?? {}
      let modelProxy: ExternalOptimizerModelProxy | undefined
      try {
        modelProxy = await startExternalOptimizerModelProxy({
          upstreamBaseUrl: config.optimizer.baseUrl,
          upstreamApiKey: config.optimizer.apiKey,
          model: config.optimizer.model,
          budget: config.optimizer.budget,
          costLedger,
          phase: 'skillopt.optimizer-model',
          actor: name,
        })
        const outputDir = `${runDir}/external`
        await mkdir(outputDir, { recursive: true })
        const result = await runExternalOptimizerProcess<SkillOptBridgeOutput>({
          label: 'SkillOpt bridge',
          tempPrefix: 'agent-eval-skillopt-',
          module: 'agent_eval_rpc.skillopt_bridge',
          input: {
            version: 2,
            attemptId: randomBytes(16).toString('hex'),
            resume: config.resume ?? 'never',
            evaluationVersion: config.evaluationVersion,
            seed: input.seed,
            callbackUrl: callback.url,
            callbackToken: callback.token,
            objective: config.objective,
            ...(config.background ? { background: config.background } : {}),
            trainer: config.trainer,
            optimizerModel: config.optimizer.model,
            modelBudget: config.optimizer.budget,
            seedCandidate: input.baselineSurface,
            trainSet: input.trainScenarios.map((scenario) =>
              describeExternalScenario(
                scenario,
                'SkillOpt',
                maxEvidenceChars,
                config.describeScenario,
              ),
            ),
            selectionSet: input.selectionScenarios.map((scenario) =>
              describeExternalScenario(
                scenario,
                'SkillOpt',
                maxEvidenceChars,
                config.describeScenario,
              ),
            ),
            maxEvaluations: config.maxEvaluations,
            hardScoreThreshold: config.hardScoreThreshold ?? 1,
            maxCandidateChars,
            maxEvidenceChars,
            outputDir,
          },
          runner: {
            ...config.runner,
            env: {
              ...removeCredentialEnvironment(runnerEnv),
              OPENAI_COMPATIBLE_BASE_URL: modelProxy.baseUrl,
              OPENAI_COMPATIBLE_API_KEY: modelProxy.apiKey,
              OPTIMIZER_OPENAI_COMPATIBLE_BASE_URL: modelProxy.baseUrl,
              OPTIMIZER_OPENAI_COMPATIBLE_API_KEY: modelProxy.apiKey,
              TARGET_OPENAI_COMPATIBLE_BASE_URL: modelProxy.baseUrl,
              TARGET_OPENAI_COMPATIBLE_API_KEY: modelProxy.apiKey,
            },
          },
          timeoutMs: config.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        })
        assertBridgeOutput(result, name, maxCandidateChars, config.maxEvaluations)
        if (callback.evaluations() !== result.totalEvaluations) {
          throw new Error(
            `${name}: SkillOpt reported ${result.totalEvaluations} evaluations but the callback received ${callback.evaluations()}`,
          )
        }

        const evaluationCost = costFromLedgerSummary(
          costLedger.summary({ phase: 'skillopt.external-evaluation' }),
        )
        const optimizerCost = costFromLedgerSummary(
          costLedger.summary({ phase: 'skillopt.optimizer-model' }),
        )
        const optimizerUsage = costLedger.summary({ phase: 'skillopt.optimizer-model' })
        assertTokenUsageMatchesLedger(result.tokenUsage, optimizerUsage, name)
        return {
          winnerSurface: result.bestCandidate,
          cost: {
            totalCostUsd: evaluationCost.totalCostUsd + optimizerCost.totalCostUsd,
            accountingComplete:
              evaluationCost.accountingComplete && optimizerCost.accountingComplete,
            incompleteReasons: [
              ...evaluationCost.incompleteReasons.map((reason) => `evaluation: ${reason}`),
              ...optimizerCost.incompleteReasons.map((reason) => `optimizer model: ${reason}`),
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
            tokenUsage: {
              inputTokens: optimizerUsage.inputTokens,
              outputTokens: optimizerUsage.outputTokens,
              totalTokens: optimizerUsage.inputTokens + optimizerUsage.outputTokens,
              calls: optimizerUsage.totalCalls,
            },
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
  config: SkillOptOptimizationMethodConfig<TScenario, TArtifact>,
): SkillOptOptimizationMethodConfig<TScenario, TArtifact> {
  return {
    ...config,
    trainer: structuredClone(config.trainer),
    optimizer: snapshotOptimizerModel(config.optimizer),
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
    ['evaluationVersion', config.evaluationVersion],
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
  if (
    config.trainer.minEditBudget !== undefined &&
    config.trainer.editBudget !== undefined &&
    config.trainer.minEditBudget > config.trainer.editBudget
  ) {
    throw new Error(
      'skillOptOptimizationMethod: trainer.minEditBudget must not exceed trainer.editBudget',
    )
  }
  if (
    config.trainer.reasoningEffort !== undefined &&
    (typeof config.trainer.reasoningEffort !== 'string' ||
      !config.trainer.reasoningEffort.trim() ||
      config.trainer.reasoningEffort.trim() !== config.trainer.reasoningEffort)
  ) {
    throw new Error(
      'skillOptOptimizationMethod: trainer.reasoningEffort must be trimmed and non-empty',
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
  const evidenceLimit = config.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS
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

function assertBridgeOutput(
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
  if (
    !isRecord(result.upstream) ||
    result.upstream.package !== 'skillopt' ||
    typeof result.upstream.version !== 'string' ||
    !result.upstream.version.trim()
  ) {
    throw new Error(`${name}: SkillOpt bridge returned invalid upstream package provenance`)
  }
  if (typeof result.runId !== 'string' || !result.runId.trim()) {
    throw new Error(`${name}: SkillOpt bridge returned an invalid runId`)
  }
  if (typeof result.resumed !== 'boolean') {
    throw new Error(`${name}: SkillOpt bridge returned an invalid resumed flag`)
  }
  if (
    result.upstream.sourceUrl !== undefined &&
    (typeof result.upstream.sourceUrl !== 'string' || !result.upstream.sourceUrl.trim())
  ) {
    throw new Error(`${name}: SkillOpt bridge returned an invalid upstream sourceUrl`)
  }
  if (
    result.upstream.revision !== undefined &&
    (typeof result.upstream.revision !== 'string' || !result.upstream.revision.trim())
  ) {
    throw new Error(`${name}: SkillOpt bridge returned an invalid upstream revision`)
  }
  if (result.tokenUsage !== undefined) {
    for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'calls'] as const) {
      if (!Number.isSafeInteger(result.tokenUsage[field]) || result.tokenUsage[field] < 0) {
        throw new Error(`${name}: SkillOpt bridge returned invalid tokenUsage.${field}`)
      }
    }
    if (
      result.tokenUsage.totalTokens !==
      result.tokenUsage.inputTokens + result.tokenUsage.outputTokens
    ) {
      throw new Error(`${name}: SkillOpt bridge returned inconsistent tokenUsage.totalTokens`)
    }
  }
}

function assertTokenUsageMatchesLedger(
  upstream: SkillOptBridgeOutput['tokenUsage'],
  ledger: CostLedgerSummary,
  name: string,
): void {
  if (!upstream) {
    throw new Error(`${name}: SkillOpt did not report optimizer token usage`)
  }
  const expected = {
    inputTokens: ledger.inputTokens,
    outputTokens: ledger.outputTokens,
    totalTokens: ledger.inputTokens + ledger.outputTokens,
    calls: ledger.totalCalls,
  }
  for (const field of ['inputTokens', 'outputTokens', 'totalTokens', 'calls'] as const) {
    if (upstream[field] !== expected[field]) {
      throw new Error(
        `${name}: SkillOpt tokenUsage.${field} ${upstream[field]} does not match metered ${expected[field]}`,
      )
    }
  }
}
