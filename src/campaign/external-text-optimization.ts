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
  combineComparisonCosts,
  costFromLedgerSummary,
  optimizationTokenUsageFromSummary,
} from './optimization-cost'
import type {
  OptimizationMethod,
  OptimizationMethodInput,
  OptimizationMethodResult,
} from './optimization-method'
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
    optimize: (input) => optimizeExternalText(snapshot, input),
  }
}

/** What one optimizer run derives from its configuration and input before the optimizer starts. */
interface ExternalRun<TScenario extends Scenario, TArtifact> {
  readonly snapshot: ExternalTextOptimizationMethodConfig<TScenario, TArtifact>
  readonly input: OptimizationMethodInput<TScenario, TArtifact>
  readonly seedCandidate: ExternalTextCandidate
  readonly expectsComponents: boolean
  readonly maxCandidateChars: number
  readonly maxEvidenceChars: number
  readonly attemptId: string
  readonly storage: CampaignStorage
  readonly resume: NonNullable<ExternalTextOptimizationMethodConfig<TScenario, TArtifact>['resume']>
  readonly trainSet: readonly ExternalOptimizationExample[]
  readonly selectionSet: readonly ExternalOptimizationExample[]
  readonly methodDir: string
  readonly runId: string
  readonly stateDir: string
  readonly artifactDir: string
  readonly manifestPath: string
  readonly lock: ReturnType<typeof acquireSingleRunLock> | undefined
  /** False once a still-running optimizer or paid call has taken over releasing the lock. */
  releaseLock: boolean
}

/** The stores one optimizer run charges and counts against. */
interface ExternalRunAccounts {
  readonly runBudget: ReturnType<typeof openExternalOptimizerRunBudget>
  readonly optimizerLedger: ReturnType<typeof createRunCostLedger>
}

/** The live optimizer: its abort control, in-flight evaluations and run promise. */
interface OptimizerSession {
  readonly controller: AbortController
  readonly activeEvaluations: Set<Promise<ExternalTextEvaluationResponse>>
  readonly runPromise: Promise<ExternalTextOptimizerResult>
  readonly timeout: ReturnType<typeof setTimeout>
  readonly started: number
  readonly state: { acceptingEvaluations: boolean; runSettled: boolean }
}

const EVALUATION_COST_PHASE = 'external.evaluation'
const OPTIMIZER_COST_PHASE = 'external.optimizer'

async function optimizeExternalText<TScenario extends Scenario, TArtifact>(
  snapshot: ExternalTextOptimizationMethodConfig<TScenario, TArtifact>,
  input: OptimizationMethodInput<TScenario, TArtifact>,
): Promise<OptimizationMethodResult> {
  const run = await prepareExternalRun(snapshot, input)
  try {
    const { manifest, restoreRequested } = restoreRunManifest(run)
    const accounts = openRunAccounts(run)
    const session = startOptimizerSession(run, accounts, restoreRequested)
    const result = await awaitOptimizerResult(run, accounts, session, restoreRequested)
    return finishRun(run, accounts, session, manifest, result)
  } finally {
    if (run.releaseLock) run.lock?.release()
  }
}

function describeExternalScenarios<TScenario extends Scenario, TArtifact>(
  scenarios: readonly TScenario[],
  snapshot: ExternalTextOptimizationMethodConfig<TScenario, TArtifact>,
  maxEvidenceChars: number,
): readonly ExternalOptimizationExample[] {
  return Object.freeze(
    scenarios.map((scenario) =>
      describeExternalScenario(
        scenario,
        snapshot.name,
        maxEvidenceChars,
        snapshot.describeScenario,
      ),
    ),
  )
}

/** Run identity, scenario descriptions and directories, then the resume lock. */
async function prepareExternalRun<TScenario extends Scenario, TArtifact>(
  snapshot: ExternalTextOptimizationMethodConfig<TScenario, TArtifact>,
  input: OptimizationMethodInput<TScenario, TArtifact>,
): Promise<ExternalRun<TScenario, TArtifact>> {
  const seedCandidate = encodeExternalTextCandidate(input.baselineSurface)
  const maxCandidateChars = snapshot.maxCandidateChars ?? DEFAULT_MAX_CANDIDATE_CHARS
  const maxEvidenceChars = snapshot.maxEvidenceChars ?? DEFAULT_MAX_EVIDENCE_CHARS
  const attemptId = randomBytes(16).toString('hex')
  const storage = input.runOptions.storage ?? fsCampaignStorage()
  const resume = snapshot.resume ?? 'never'
  const trainSet = describeExternalScenarios(input.trainScenarios, snapshot, maxEvidenceChars)
  const selectionSet = describeExternalScenarios(
    input.selectionScenarios,
    snapshot,
    maxEvidenceChars,
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
  return {
    snapshot,
    input,
    seedCandidate,
    expectsComponents: typeof seedCandidate !== 'string',
    maxCandidateChars,
    maxEvidenceChars,
    attemptId,
    storage,
    resume,
    trainSet,
    selectionSet,
    methodDir,
    runId,
    stateDir,
    artifactDir,
    manifestPath: `${stateDir}/run-manifest.jsonl`,
    lock,
    releaseLock: true,
  }
}

/** Reads prior state when resuming, and records this attempt as partial. */
function restoreRunManifest<TScenario extends Scenario, TArtifact>(
  run: ExternalRun<TScenario, TArtifact>,
): { manifest: ExternalOptimizerRunManifest | undefined; restoreRequested: boolean } {
  const { snapshot, storage, manifestPath, runId, attemptId, resume } = run
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
  return { manifest, restoreRequested }
}

function openRunAccounts<TScenario extends Scenario, TArtifact>(
  run: ExternalRun<TScenario, TArtifact>,
): ExternalRunAccounts {
  const { snapshot, storage, methodDir, runId, attemptId, stateDir } = run
  return {
    runBudget: openExternalOptimizerRunBudget({
      storage,
      runDir: methodDir,
      runKey: runId,
      attemptId,
      maxEvaluations: snapshot.maxEvaluations,
    }),
    optimizerLedger: createRunCostLedger({
      storage,
      runDir: `${stateDir}/cost`,
      costCeilingUsd: snapshot.maxOptimizerCostUsd,
    }),
  }
}

/** Optimizer paid calls, charged to the optimizer's own limit and mirrored into the method's account. */
function createOptimizerCostMeter<TScenario extends Scenario, TArtifact>(
  run: ExternalRun<TScenario, TArtifact>,
  accounts: ExternalRunAccounts,
  controller: AbortController,
): CampaignCostMeter {
  const { snapshot, input } = run
  const { runBudget, optimizerLedger } = accounts
  const meter: CampaignCostMeter = {
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
        phase: OPTIMIZER_COST_PHASE,
        tags: runBudget.attemptTags,
        signal: request.signal
          ? AbortSignal.any([controller.signal, request.signal])
          : controller.signal,
        execute: async (signal, callId) => {
          call.methodResult = await input.costLedger.runPaidCall<T>({
            ...request,
            callId,
            channel: request.channel ?? 'optimizer',
            phase: OPTIMIZER_COST_PHASE,
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
  return Object.freeze(meter)
}

/** Starts the optimizer with its evaluator, cost meter, timeout and frozen context. */
function startOptimizerSession<TScenario extends Scenario, TArtifact>(
  run: ExternalRun<TScenario, TArtifact>,
  accounts: ExternalRunAccounts,
  restoreRequested: boolean,
): OptimizerSession {
  const { snapshot, input, runId, stateDir, artifactDir } = run
  const { runBudget } = accounts
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
    costPhase: EVALUATION_COST_PHASE,
    costTags: runBudget.attemptTags,
    costLedger: input.costLedger,
    scenarioById,
    maxCandidateChars: run.maxCandidateChars,
    maxEvidenceChars: run.maxEvidenceChars,
    describeArtifact: snapshot.describeArtifact,
  })
  const controller = new AbortController()
  const activeEvaluations = new Set<Promise<ExternalTextEvaluationResponse>>()
  const state = { acceptingEvaluations: true, runSettled: false }
  const optimizerCostMeter = createOptimizerCostMeter(run, accounts, controller)
  const evaluate = (
    request: ExternalTextEvaluationRequest,
    signal = controller.signal,
  ): Promise<ExternalTextEvaluationResponse> => {
    if (!state.acceptingEvaluations) {
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
  const runPromise = Promise.resolve().then(() =>
    snapshot.run(
      Object.freeze({
        runId,
        name: snapshot.name,
        objective: snapshot.objective,
        evaluationId: snapshot.evaluationId,
        ...(snapshot.background ? { background: snapshot.background } : {}),
        seedCandidate: cloneExternalTextCandidate(run.seedCandidate),
        trainSet: run.trainSet,
        selectionSet: run.selectionSet,
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
  const markSettled = () => {
    state.runSettled = true
  }
  void runPromise.then(markSettled, markSettled)
  return { controller, activeEvaluations, runPromise, timeout, started, state }
}

/** Waits for the optimizer, then refuses a run that left evaluations or paid calls outstanding. */
async function awaitOptimizerResult<TScenario extends Scenario, TArtifact>(
  run: ExternalRun<TScenario, TArtifact>,
  accounts: ExternalRunAccounts,
  session: OptimizerSession,
  restoreRequested: boolean,
): Promise<ExternalTextOptimizerResult> {
  const { snapshot, lock } = run
  const { optimizerLedger } = accounts
  let result: ExternalTextOptimizerResult | undefined
  let runError: unknown
  let outstandingAtCompletion = 0
  let paidCallsAtCompletion = 0
  try {
    result = await raceWithAbort(session.runPromise, session.controller.signal)
    outstandingAtCompletion = session.activeEvaluations.size
    paidCallsAtCompletion = optimizerLedger.summary().pendingCalls
  } catch (error) {
    runError = error
  } finally {
    session.state.acceptingEvaluations = false
    clearTimeout(session.timeout)
  }
  await Promise.allSettled([...session.activeEvaluations])
  const paidCallsSettled = await optimizerLedger.waitForIdle({ timeoutMs: 5_000 })
  const handOffLock = () => {
    if (!lock) return
    run.releaseLock = false
    void Promise.allSettled([
      session.runPromise,
      optimizerLedger.waitForIdle({ timeoutMs: MAX_TIMER_DELAY_MS }),
    ]).then(() => lock.release())
  }
  if (runError !== undefined) {
    if (!session.state.runSettled || !paidCallsSettled) handOffLock()
    throw runError
  }
  if (!paidCallsSettled) {
    handOffLock()
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
    run.maxCandidateChars,
    run.expectsComponents,
  )
  if (result.resumed !== restoreRequested) {
    throw new Error(
      `${snapshot.name}: optimizer reported resumed=${String(result.resumed)} but restoreRequested=${String(restoreRequested)}`,
    )
  }
  return result
}

/** Measures evaluation and optimizer spend, records completion, and builds the method result. */
function finishRun<TScenario extends Scenario, TArtifact>(
  run: ExternalRun<TScenario, TArtifact>,
  accounts: ExternalRunAccounts,
  session: OptimizerSession,
  manifest: ExternalOptimizerRunManifest | undefined,
  result: ExternalTextOptimizerResult,
): OptimizationMethodResult {
  const { snapshot, input, storage, runId, attemptId } = run
  const { runBudget } = accounts
  const evaluationCost = costFromLedgerSummary(
    input.costLedger.summary({
      phase: EVALUATION_COST_PHASE,
      tags: runBudget.runTags,
    }),
  )
  const optimizerFilter = {
    phase: OPTIMIZER_COST_PHASE,
    tags: runBudget.runTags,
  }
  const optimizerReceipts = input.costLedger.list(optimizerFilter)
  const optimizerSummary = input.costLedger.summary(optimizerFilter)
  const optimizerCost = costFromLedgerSummary(optimizerSummary)
  assertExternalCostAccounting(result.costAccounting, optimizerSummary.totalCalls, snapshot.name)
  const externalCostReason =
    result.costAccounting.kind === 'external' ? result.costAccounting.reason : undefined
  const tokenUsage = optimizationTokenUsageFromSummary(optimizerSummary, optimizerReceipts)
  if (run.resume !== 'never') {
    appendExternalOptimizerRunManifestEvent({
      storage,
      path: run.manifestPath,
      revision: manifest!.revision,
      event: { runId, attemptId, status: 'completed' },
    })
  }
  const measuredCost = combineComparisonCosts([
    { label: 'evaluation', cost: evaluationCost },
    { label: 'optimizer', cost: optimizerCost },
  ])
  return {
    winnerSurface: decodeExternalTextCandidate(result.bestCandidate),
    cost: {
      ...measuredCost,
      ...(externalCostReason ? { costProvenance: { kind: 'uncaptured', usd: null } as const } : {}),
      accountingComplete: measuredCost.accountingComplete && externalCostReason === undefined,
      incompleteReasons: [
        ...measuredCost.incompleteReasons,
        ...(externalCostReason
          ? [`optimizer: external spend is not observed: ${externalCostReason}`]
          : []),
      ],
    },
    durationMs: Date.now() - session.started,
    provenance: {
      source: { ...snapshot.source, evidence: 'declared' },
      runId,
      resumed: result.resumed,
      evaluationCount: runBudget.acceptedEvaluations(),
      artifactDir: run.artifactDir,
      ...(tokenUsage ? { tokenUsage } : {}),
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
