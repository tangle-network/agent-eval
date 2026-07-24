import { randomBytes } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import type {
  CostChannel,
  CostReceipt,
  CostReceiptInput,
  MaximumCharge,
  PaidCallResult,
  RunPaidCallInput,
} from '../cost-ledger'
import {
  type ExternalTextCandidate,
  type ExternalTextEvaluationRequest,
  safePathComponent,
} from './external-optimizer-process'
import {
  externalOptimizerRunKey,
  openExternalOptimizerRunBudget,
} from './external-optimizer-run-budget'
import {
  createExternalTextEvaluator,
  decodeExternalTextCandidate,
  describeExternalScenario,
  type ExternalOptimizationExample,
  type ExternalTextEvaluationResponse,
  encodeExternalTextCandidate,
  mapExternalScenarios,
} from './external-text-evaluation'
import {
  assertExternalCostAccounting,
  assertExternalTextOptimizationConfig,
  assertExternalTextOptimizerResult,
  type ExternalOptimizerRunManifest,
  type ExternalOptimizerRunManifestEvent,
  type ExternalTextOptimizationMethodConfig,
  type ExternalTextOptimizerContext,
  type ExternalTextOptimizerResult,
  readExternalOptimizerRunManifest,
  snapshotExternalTextOptimizationConfig,
} from './external-text-optimization-contract'
import {
  costFromLedgerSummary,
  type OptimizationMethod,
  optimizationTokenUsageFromSummary,
} from './presets/compare-optimization-methods'
import { acquireSingleRunLock } from './single-run-lock'
import { type CampaignStorage, createRunCostLedger, fsCampaignStorage } from './storage'
import type { CampaignCostMeter, Scenario } from './types'

export type {
  ExternalOptimizationExample,
  ExternalTextEvaluationResponse,
  ExternalTextOptimizationMethodConfig,
  ExternalTextOptimizerContext,
  ExternalTextOptimizerResult,
}
export {
  createExternalTextEvaluator,
  decodeExternalTextCandidate,
  describeExternalScenario,
  encodeExternalTextCandidate,
  mapExternalScenarios,
}

const DEFAULT_MAX_CANDIDATE_CHARS = 200_000
const DEFAULT_MAX_EVIDENCE_CHARS = 100_000
const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000
const MAX_TIMER_DELAY_MS = 2_147_483_647

/**
 * Adapt a third-party text optimizer without reimplementing its search.
 *
 * The callback never receives final test cases. Calls to `evaluate` are
 * counted before execution and stop at `maxEvaluations`.
 */
export function externalTextOptimizationMethod<TScenario extends Scenario, TArtifact>(
  config: ExternalTextOptimizationMethodConfig<TScenario, TArtifact>,
): OptimizationMethod<TScenario, TArtifact> {
  assertExternalTextOptimizationConfig(config)
  const snapshot = snapshotExternalTextOptimizationConfig(config)

  return {
    name: snapshot.name,
    async optimize(input) {
      const seedCandidate = encodeExternalTextCandidate(input.baselineSurface)
      const expectsComponents = typeof seedCandidate !== 'string'
      const maxCandidateChars = snapshot.maxCandidateChars ?? DEFAULT_MAX_CANDIDATE_CHARS
      const maxEvidenceChars = snapshot.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS
      const attemptId = randomBytes(16).toString('hex')
      const storage = input.runOptions.storage ?? fsCampaignStorage()
      const resume = snapshot.resume ?? 'never'
      const trainSet = Object.freeze(
        input.trainScenarios.map((scenario) =>
          describeExternalScenario(
            scenario,
            snapshot.name,
            maxEvidenceChars,
            snapshot.describeScenario,
          ),
        ),
      )
      const selectionSet = Object.freeze(
        input.selectionScenarios.map((scenario) =>
          describeExternalScenario(
            scenario,
            snapshot.name,
            maxEvidenceChars,
            snapshot.describeScenario,
          ),
        ),
      )
      const methodDir = `${input.runDir}/external/${safePathComponent(snapshot.name)}`
      const runMaterial = {
        optimizer: {
          kind: snapshot.source.kind,
          package: snapshot.source.package,
          version: snapshot.source.version,
          ...(snapshot.source.sourceUrl ? { sourceUrl: snapshot.source.sourceUrl } : {}),
          ...(snapshot.source.revision ? { revision: snapshot.source.revision } : {}),
        },
        method: snapshot.name,
        evaluationId: snapshot.evaluationId,
        dispatchRef: input.runOptions.dispatchRef ?? null,
        objective: snapshot.objective,
        background: snapshot.background ?? '',
        seed: input.seed,
        seedCandidate,
        trainSet,
        selectionSet,
        maxEvaluations: snapshot.maxEvaluations,
        maxOptimizerCostUsd: snapshot.maxOptimizerCostUsd,
        maxCandidateChars,
        maxEvidenceChars,
      }
      const runId = externalOptimizerRunKey({
        material: runMaterial,
        attemptId,
        resumeEnabled: resume !== 'never',
      })
      const stateDir = `${methodDir}/state/${runId}`
      const artifactDir = `${methodDir}/attempts/${attemptId}`
      const manifestPath = `${stateDir}/run-manifest.jsonl`
      const evaluationCostPhase = 'external.evaluation'
      const optimizerCostPhase = 'external.optimizer'
      storage.ensureDir(stateDir)
      storage.ensureDir(artifactDir)
      if (resume !== 'never') await mkdir(stateDir, { recursive: true })
      const lock =
        resume === 'never'
          ? undefined
          : acquireSingleRunLock({
              lockPath: `${stateDir}.lock`,
              releaseOnExit: true,
            })
      let releaseLock = true
      try {
        let manifest =
          resume === 'never'
            ? undefined
            : readExternalOptimizerRunManifest(
                storage.read(manifestPath),
                storage.exists(manifestPath),
                manifestPath,
                runId,
              )
        const restoreRequested = manifest !== undefined
        if (resume === 'required' && !restoreRequested) {
          throw new Error(`${snapshot.name}: no compatible run state is available to resume`)
        }
        if (resume === 'never' && restoreRequested) {
          throw new Error(`${snapshot.name}: fresh optimizer run unexpectedly found prior state`)
        }
        if (resume !== 'never') {
          manifest = appendExternalOptimizerRunManifestEvent({
            storage,
            path: manifestPath,
            revision: manifest?.revision ?? 0,
            event: { runId, attemptId, status: 'partial' },
          })
        }
        const runBudget = openExternalOptimizerRunBudget({
          storage,
          runDir: methodDir,
          runKey: runId,
          attemptId,
          maxEvaluations: snapshot.maxEvaluations,
        })
        const optimizerLedger = createRunCostLedger({
          storage,
          runDir: `${stateDir}/cost`,
          costCeilingUsd: snapshot.maxOptimizerCostUsd,
        })

        const scenarioById = mapExternalScenarios(
          input.trainScenarios,
          input.selectionScenarios,
          `${snapshot.name} optimizer`,
        )
        const score = createExternalTextEvaluator({
          input,
          label: `${snapshot.name} optimizer`,
          runDir: artifactDir,
          compatibleRunId: runId,
          costPhase: evaluationCostPhase,
          costTags: runBudget.attemptTags,
          costLedger: input.costLedger,
          scenarioById,
          maxCandidateChars,
          maxEvidenceChars,
          describeArtifact: snapshot.describeArtifact,
        })
        let acceptingEvaluations = true
        const activeEvaluations = new Set<Promise<ExternalTextEvaluationResponse>>()
        const controller = new AbortController()
        const optimizerCostMeter: CampaignCostMeter = {
          async runPaidCall<T>(
            request: Omit<RunPaidCallInput<T>, 'channel' | 'phase' | 'tags'> & {
              channel?: CostChannel
            },
          ): Promise<PaidCallResult<T>> {
            const call = {
              methodResult: undefined as PaidCallResult<T> | undefined,
              providerStarted: false,
            }
            const subLimitResult = await optimizerLedger.runPaidCall<T>({
              ...request,
              channel: request.channel ?? 'optimizer',
              phase: optimizerCostPhase,
              tags: runBudget.attemptTags,
              signal: request.signal
                ? AbortSignal.any([controller.signal, request.signal])
                : controller.signal,
              execute: async (signal, callId) => {
                call.methodResult = await input.costLedger.runPaidCall<T>({
                  ...request,
                  callId,
                  channel: request.channel ?? 'optimizer',
                  phase: optimizerCostPhase,
                  tags: runBudget.attemptTags,
                  signal,
                  execute: (methodSignal, methodCallId) => {
                    call.providerStarted = true
                    return request.execute(methodSignal, methodCallId)
                  },
                })
                if (!call.methodResult.succeeded) {
                  throw new Error(`${snapshot.name}: method cost account rejected optimizer call`, {
                    cause: call.methodResult.error,
                  })
                }
                return call.methodResult.value
              },
              receipt: () => {
                if (!call.methodResult?.succeeded) {
                  throw new Error(`${snapshot.name}: optimizer call completed without a receipt`)
                }
                return mirroredCostReceipt(call.methodResult.receipt)
              },
              receiptFromError: () => {
                if (call.methodResult?.receipt) {
                  return mirroredCostReceipt(call.methodResult.receipt)
                }
                if (!call.providerStarted) {
                  return noChargeReceipt(modelBeforeExecution(request))
                }
                return undefined
              },
            })
            if (call.methodResult === undefined) return subLimitResult
            if (!call.methodResult.succeeded) return call.methodResult
            return subLimitResult.succeeded ? call.methodResult : subLimitResult
          },
        }
        Object.freeze(optimizerCostMeter)
        const evaluate = (
          request: ExternalTextEvaluationRequest,
          signal = controller.signal,
        ): Promise<ExternalTextEvaluationResponse> => {
          if (!acceptingEvaluations) {
            throw new Error(`${snapshot.name}: evaluate cannot be called after run() completes`)
          }
          if (runBudget.acceptEvaluation() === undefined) {
            throw new Error(`${snapshot.name}: maxEvaluations limit reached`)
          }
          const combinedSignal =
            signal === controller.signal
              ? controller.signal
              : AbortSignal.any([controller.signal, signal])
          const pending = score(cloneExternalEvaluationRequest(request), combinedSignal)
          activeEvaluations.add(pending)
          const remove = () => activeEvaluations.delete(pending)
          void pending.then(remove, remove)
          return pending
        }

        const started = Date.now()
        const timeoutMs = snapshot.timeoutMs ?? DEFAULT_TIMEOUT_MS
        const timeout = setTimeout(
          () => controller.abort(new Error(`${snapshot.name}: optimizer exceeded ${timeoutMs}ms`)),
          timeoutMs,
        )
        let result: ExternalTextOptimizerResult | undefined
        let runError: unknown
        let outstandingAtCompletion = 0
        let paidCallsAtCompletion = 0
        let runSettled = false
        const runPromise = Promise.resolve().then(() =>
          snapshot.run(
            Object.freeze({
              runId,
              name: snapshot.name,
              objective: snapshot.objective,
              evaluationId: snapshot.evaluationId,
              ...(snapshot.background ? { background: snapshot.background } : {}),
              seedCandidate: cloneExternalTextCandidate(seedCandidate),
              trainSet,
              selectionSet,
              maxEvaluations: snapshot.maxEvaluations,
              seed: input.seed,
              stateDir,
              restoreRequested,
              artifactDir,
              signal: controller.signal,
              cost: optimizerCostMeter,
              evaluate,
            }),
          ),
        )
        void runPromise.then(
          () => {
            runSettled = true
          },
          () => {
            runSettled = true
          },
        )
        try {
          result = await raceWithAbort(runPromise, controller.signal)
          outstandingAtCompletion = activeEvaluations.size
          paidCallsAtCompletion = optimizerLedger.summary().pendingCalls
        } catch (error) {
          runError = error
        } finally {
          acceptingEvaluations = false
          clearTimeout(timeout)
        }
        await Promise.allSettled([...activeEvaluations])
        const paidCallsSettled = await optimizerLedger.waitForIdle({ timeoutMs: 5_000 })
        if (runError !== undefined) {
          if ((!runSettled || !paidCallsSettled) && lock) {
            releaseLock = false
            void Promise.allSettled([
              runPromise,
              optimizerLedger.waitForIdle({ timeoutMs: MAX_TIMER_DELAY_MS }),
            ]).then(() => lock.release())
          }
          throw runError
        }
        if (!paidCallsSettled) {
          if (lock) {
            releaseLock = false
            void Promise.allSettled([
              runPromise,
              optimizerLedger.waitForIdle({ timeoutMs: MAX_TIMER_DELAY_MS }),
            ]).then(() => lock.release())
          }
          throw new Error(`${snapshot.name}: optimizer paid calls did not settle`)
        }
        if (paidCallsAtCompletion > 0) {
          throw new Error(
            `${snapshot.name}: run() completed with ${paidCallsAtCompletion} outstanding paid call(s); await every context.cost.runPaidCall()`,
          )
        }
        if (outstandingAtCompletion > 0) {
          throw new Error(
            `${snapshot.name}: run() completed with ${outstandingAtCompletion} outstanding evaluation(s); await every evaluate() call`,
          )
        }
        assertExternalTextOptimizerResult(
          result,
          snapshot.name,
          maxCandidateChars,
          expectsComponents,
        )
        if (result.resumed !== restoreRequested) {
          throw new Error(
            `${snapshot.name}: optimizer reported resumed=${String(result.resumed)} but restoreRequested=${String(restoreRequested)}`,
          )
        }

        const evaluationCost = costFromLedgerSummary(
          input.costLedger.summary({
            phase: evaluationCostPhase,
            tags: runBudget.runTags,
          }),
        )
        const optimizerFilter = {
          phase: optimizerCostPhase,
          tags: runBudget.runTags,
        }
        const optimizerReceipts = input.costLedger.list(optimizerFilter)
        const optimizerSummary = input.costLedger.summary(optimizerFilter)
        const optimizerCost = costFromLedgerSummary(optimizerSummary)
        assertExternalCostAccounting(
          result.costAccounting,
          optimizerSummary.totalCalls,
          snapshot.name,
        )
        const externalCostReason =
          result.costAccounting.kind === 'external' ? result.costAccounting.reason : undefined
        const tokenUsage = optimizationTokenUsageFromSummary(optimizerSummary, optimizerReceipts)
        if (resume !== 'never') {
          appendExternalOptimizerRunManifestEvent({
            storage,
            path: manifestPath,
            revision: manifest!.revision,
            event: { runId, attemptId, status: 'completed' },
          })
        }
        return {
          winnerSurface: decodeExternalTextCandidate(result.bestCandidate),
          cost: {
            totalCostUsd: evaluationCost.totalCostUsd + optimizerCost.totalCostUsd,
            accountingComplete:
              evaluationCost.accountingComplete &&
              optimizerCost.accountingComplete &&
              externalCostReason === undefined,
            incompleteReasons: [
              ...evaluationCost.incompleteReasons.map((reason) => `evaluation: ${reason}`),
              ...optimizerCost.incompleteReasons.map((reason) => `optimizer: ${reason}`),
              ...(externalCostReason
                ? [`optimizer: external spend is not observed: ${externalCostReason}`]
                : []),
            ],
          },
          durationMs: Date.now() - started,
          provenance: {
            source: { ...snapshot.source, evidence: 'declared' },
            runId,
            resumed: result.resumed,
            evaluationCount: runBudget.acceptedEvaluations(),
            artifactDir,
            ...(tokenUsage ? { tokenUsage } : {}),
          },
        }
      } finally {
        if (releaseLock) lock?.release()
      }
    },
  }
}

function appendExternalOptimizerRunManifestEvent(input: {
  storage: CampaignStorage
  path: string
  revision: number
  event: ExternalOptimizerRunManifestEvent
}): ExternalOptimizerRunManifest {
  if (!input.storage.append) {
    throw new Error('external optimizer resume requires appendable storage')
  }
  const line = `${JSON.stringify(input.event)}\n`
  const revision = input.storage.append(input.path, line, input.revision)
  if (revision === undefined) {
    throw new Error(`external optimizer run manifest was updated concurrently at '${input.path}'`)
  }
  return {
    status: input.event.status,
    attemptId: input.event.attemptId,
    revision,
  }
}

function mirroredCostReceipt(receipt: CostReceipt): CostReceiptInput {
  const usage = {
    model: receipt.model,
    inputTokens: receipt.inputTokens,
    outputTokens: receipt.outputTokens,
    ...(receipt.reasoningTokens === undefined ? {} : { reasoningTokens: receipt.reasoningTokens }),
    ...(receipt.cachedTokens === undefined ? {} : { cachedTokens: receipt.cachedTokens }),
    ...(receipt.cacheWriteTokens === undefined
      ? {}
      : { cacheWriteTokens: receipt.cacheWriteTokens }),
    ...(receipt.usageUnknown === undefined ? {} : { usageUnknown: receipt.usageUnknown }),
  }
  return receipt.costUnknown
    ? { ...usage, costUnknown: true }
    : { ...usage, actualCostUsd: receipt.costUsd }
}

function noChargeReceipt(model: string): CostReceiptInput {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    actualCostUsd: 0,
  }
}

function modelBeforeExecution(request: { model?: string; maximumCharge?: MaximumCharge }): string {
  if (request.model) return request.model
  if (request.maximumCharge && 'model' in request.maximumCharge) {
    return request.maximumCharge.model
  }
  return 'unstarted-optimizer-call'
}

function cloneExternalTextCandidate(candidate: ExternalTextCandidate): ExternalTextCandidate {
  return typeof candidate === 'string' ? candidate : { ...candidate }
}

function cloneExternalEvaluationRequest(
  request: ExternalTextEvaluationRequest,
): ExternalTextEvaluationRequest {
  return {
    candidate: cloneExternalTextCandidate(request.candidate),
    exampleId: request.exampleId,
  }
}

async function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) throw signal.reason
  return await new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(signal.reason)
    signal.addEventListener('abort', onAbort, { once: true })
    void promise.then(
      (value) => {
        signal.removeEventListener('abort', onAbort)
        resolve(value)
      },
      (error) => {
        signal.removeEventListener('abort', onAbort)
        reject(error)
      },
    )
  })
}
