/** The chunked one-shot JSON strategy: compile a chunked definition into a runnable arm. */
import { randomUUID } from 'node:crypto'
import {
  type ExternalOptimizerModelProxy,
  runWithCleanup,
  startExternalOptimizerModelProxy,
} from '../campaign/external-optimizer-process'
import {
  CostAccountingIncompleteError,
  CostCallConflictError,
  CostCeilingReachedError,
  CostLedger,
  type CostLedgerHandle,
  CostLedgerPersistenceError,
  type CostReceipt,
  CostReceiptCaptureError,
  type CostReceiptInput,
  CostReservationExceededError,
} from '../cost-ledger'
import { callLlmJson, type LlmCallRequest, type LlmClientOptions } from '../llm-client'
import { resolveModelPricing } from '../metrics'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { AnalystBenchmarkOutput, AnalystBenchmarkRunner } from './benchmark'
import { publicBenchmarkError } from './benchmark-public-errors'
import {
  type PublicAnalystBenchmarkModelConfig,
  positiveSafeInteger,
  requiredString,
} from './benchmark-public-types'
import {
  type PublicBenchmarkResponseCacheEntry,
  publicBenchmarkCallId,
  readPublicBenchmarkResponseCache,
  writePublicBenchmarkResponseCache,
} from './benchmark-response-cache'
import {
  type AnalystDefinition,
  AnalystExpressivenessError,
  type ChunkedEvidenceBinding,
} from './definition'
import { decodeReplyRows, type ReplyContract } from './reply-contract'
import type { AnalystFinding, AnalystRunInputs } from './types'
import { usageReceiptFromCostLedger } from './usage-receipt'

type BenchmarkContext = Parameters<AnalystBenchmarkRunner<AnalystRunInputs>['analyze']>[1]

/** The durable response cache location and the run identity its entries are keyed under. */
interface ChunkedDurability {
  readonly runIdentitySha256: string
  readonly responseCacheDir: string
}

/** The per-case key of one durable cache entry. */
interface ChunkedCacheIdentity {
  readonly runIdentitySha256: string
  readonly caseId: string
  readonly repetition: number
}

/** What one compiled chunked arm shares across every case it analyzes. */
interface ChunkedArm<TRow> {
  readonly definition: AnalystDefinition<TRow>
  readonly binding: ChunkedEvidenceBinding<TRow>
  readonly replyContract: ReplyContract<TRow>
  readonly attributeByteCaps: readonly number[]
  readonly config: PublicAnalystBenchmarkModelConfig
  readonly model: string
  readonly callRef: string
  readonly maxOutputTokens: number
  readonly maxCostUsd: number
  readonly maxReasoningTokens: number
  readonly maxModelRequestBytes: number
  readonly maxModelResponseBytes: number
  readonly modelRequestTimeoutMs: number
  readonly pricing: NonNullable<PublicAnalystBenchmarkModelConfig['pricing']>
  readonly costLedger: CostLedgerHandle
  readonly durability: ChunkedDurability | undefined
  readonly systemPrompt: string
}

/** One case's identity and what its analysis has produced so far, kept for the error path. */
interface ChunkedCase<TRow> {
  readonly context: BenchmarkContext
  readonly trajectoryId: string
  readonly costTags: {
    analystId: string
    benchmarkCaseId: string
    benchmarkRepetition: string
  }
  rawPredictions: TRow[]
  rejectedRows: string[]
  modelFindings: AnalystFinding[]
  providerModel: string
  producedAt: string | undefined
  modelMetadata: Record<string, unknown>
}

/** Refuse a definition the one-shot JSON strategy cannot execute exactly as declared. */
function checkChunkedDefinition<TRow>(
  definition: AnalystDefinition<TRow>,
  config: PublicAnalystBenchmarkModelConfig,
) {
  const { projection, binding, replyContract } = definition
  if (projection.mode !== 'chunked' || binding.kind !== 'chunked') {
    throw new AnalystExpressivenessError(
      `the chunked one-shot strategy compiles only chunked projections; definition ` +
        `'${definition.id}' declares projection '${projection.mode}' with a '${binding.kind}' binding`,
    )
  }
  if (config.instructionsOverride) {
    throw new Error(
      'the direct runner executes only the stock protocol; an instructions override requires the dspy-rlm runner',
    )
  }
  if (definition.repair.turns !== 0) {
    throw new AnalystExpressivenessError(
      `the one-shot JSON exchange grants no repair turn; definition '${definition.id}' ` +
        `declares ${definition.repair.turns}`,
    )
  }
  const reasoningEffort = definition.profile.model?.reasoningEffort
  if (reasoningEffort !== 'none') {
    throw new AnalystExpressivenessError(
      `the one-shot JSON strategy runs with thinking disabled and can express only reasoning ` +
        `effort 'none'; definition '${definition.id}' declares '${reasoningEffort}'`,
    )
  }
  if (!replyContract.parseEnvelope) {
    throw new AnalystExpressivenessError(
      `the one-shot JSON strategy needs a strict reply envelope; definition ` +
        `'${definition.id}' declares no parseEnvelope`,
    )
  }
  if (definition.taskDefinition === undefined) {
    throw new AnalystExpressivenessError(
      `the one-shot JSON strategy composes its system prompt from the task definition; ` +
        `definition '${definition.id}' declares none`,
    )
  }
  return {
    binding,
    replyContract,
    attributeByteCaps: projection.attributeByteCaps,
    taskDefinition: definition.taskDefinition,
  }
}

/** Validate the definition and transport, then resolve the model, budget, ledger and system prompt. */
function compileChunkedArm<TRow>(
  definition: AnalystDefinition<TRow>,
  config: PublicAnalystBenchmarkModelConfig,
): ChunkedArm<TRow> {
  const { binding, replyContract, attributeByteCaps, taskDefinition } = checkChunkedDefinition(
    definition,
    config,
  )
  const model = requiredString(config.model, 'model')
  const callRef = requiredString(config.callRef, 'callRef')
  if (typeof config.call !== 'function') throw new TypeError('call must be a function')
  if (typeof config.recordExecution !== 'function') {
    throw new TypeError('recordExecution must be a function')
  }
  const maxOutputTokens = positiveSafeInteger(config.maxOutputTokens, 'maxOutputTokens')
  const timeoutMs = positiveSafeInteger(config.timeoutMs, 'timeoutMs')
  const maxCostUsd = config.maxCostUsdPerAnalysis ?? 1
  assertDeclaredBudget(definition, { timeoutMs, maxOutputTokens, maxCostUsd })
  const maxReasoningTokens = config.maxReasoningTokens ?? maxOutputTokens * 4
  const maxModelRequestBytes = config.maxModelRequestBytes ?? 16 * 1024 * 1024
  const maxModelResponseBytes = config.maxModelResponseBytes ?? 4 * 1024 * 1024
  const modelRequestTimeoutMs = config.modelRequestTimeoutMs ?? timeoutMs
  const pricing = config.pricing ?? pricingForModel(model)
  const costLedger = config.costLedger ?? new CostLedger()
  const durability = config.durability
    ? {
        runIdentitySha256: requiredString(
          config.durability.runIdentitySha256,
          'durability.runIdentitySha256',
        ),
        responseCacheDir: requiredString(
          config.durability.responseCacheDir,
          'durability.responseCacheDir',
        ),
      }
    : undefined
  // The composed system prompt is definition content, sealed at bind time.
  const systemPrompt = [taskDefinition, ...replyContract.contractLines].join('\n\n')
  return {
    definition,
    binding,
    replyContract,
    attributeByteCaps,
    config,
    model,
    callRef,
    maxOutputTokens,
    maxCostUsd,
    maxReasoningTokens,
    maxModelRequestBytes,
    maxModelResponseBytes,
    modelRequestTimeoutMs,
    pricing,
    costLedger,
    durability,
    systemPrompt,
  }
}

/** The case's usage as the cost ledger has settled it so far. */
function chunkedCaseUsage<TRow>(arm: ChunkedArm<TRow>, run: ChunkedCase<TRow>) {
  return usageReceiptFromCostLedger(arm.costLedger, { channel: 'analyst', tags: run.costTags })
}

/** The one JSON-mode, thinking-disabled request this case sends. */
function buildChunkedRequest<TRow>(arm: ChunkedArm<TRow>, preparedContext: string): LlmCallRequest {
  return {
    model: arm.model,
    messages: [
      {
        role: 'system',
        content: arm.systemPrompt,
      },
      {
        role: 'user',
        content: arm.binding.userMessage(preparedContext),
      },
    ],
    jsonMode: true,
    thinking: 'disabled',
    maxTokens: arm.maxOutputTokens,
    timeoutMs: arm.modelRequestTimeoutMs,
  }
}

/** Settle a durable-cache hit; returns the failed output when the cached call had failed. */
function applyCachedResponse<TRow>(
  arm: ChunkedArm<TRow>,
  run: ChunkedCase<TRow>,
  cached: PublicBenchmarkResponseCacheEntry,
): AnalystBenchmarkOutput | undefined {
  const receipt = settleCachedResponse(arm.costLedger, cached)
  run.modelMetadata = {
    ...run.modelMetadata,
    responseSource: 'durable-cache',
    cost: costReceiptMetadata(receipt),
  }
  if (cached.status === 'failed') {
    return {
      findings: [],
      usage: chunkedCaseUsage(arm, run),
      error: cached.error,
      metadata: run.modelMetadata,
    }
  }
  const response = decodeReplyRows(arm.replyContract, cached.response)
  run.rawPredictions = response.rows
  run.rejectedRows = response.rejected.map((entry) => entry.reason)
  run.providerModel = cached.metadata.providerModel
  run.producedAt = cached.metadata.producedAt
  run.modelMetadata = {
    ...run.modelMetadata,
    ...response.extras,
    providerModel: cached.metadata.providerModel,
    providerDurationMs: cached.metadata.providerDurationMs,
    finishReason: cached.metadata.finishReason,
  }
  return undefined
}

/** Make the one paid call through the model proxy, caching its response or its settled failure. */
async function callChunkedThroughProxy<TRow>(
  arm: ChunkedArm<TRow>,
  context: BenchmarkContext,
  modelProxy: ExternalOptimizerModelProxy,
  request: LlmCallRequest,
  cacheIdentity: ChunkedCacheIdentity | undefined,
  providerCallId: string,
) {
  const { costLedger, durability, replyContract } = arm
  // The only endpoint this client ever targets is the loopback
  // model proxy started above: `modelProxy.baseUrl` is
  // `http://127.0.0.1:<port>/v1` with an ephemeral token, and the
  // caller-owned execution owner behind it makes the paid call.
  // agent-eval issues no provider request here.
  const llmOptions: LlmClientOptions = {
    baseUrl: modelProxy.baseUrl,
    apiKey: modelProxy.apiKey,
    maximumAttempts: 1,
    jsonSchemaTransport: 'json-object',
    jsonPayloadMode: 'exact',
    thinking: 'disabled',
  }
  try {
    const completed = await callLlmJson<unknown>(request, {
      ...llmOptions,
      ...(context.signal ? { signal: context.signal } : {}),
      idempotencyKey: providerCallId,
    })
    const response = decodeReplyRows(replyContract, completed.value)
    const responseProducedAt = new Date().toISOString()
    const receipt = requiredSettledReceipt(costLedger, providerCallId)
    if (cacheIdentity) {
      writePublicBenchmarkResponseCache(durability!.responseCacheDir, {
        kind: 'agent-eval/public-benchmark-model-response',
        ...cacheIdentity,
        callId: providerCallId,
        status: 'succeeded',
        // Cache the provider's own payload, not the parse result: a
        // resume re-parses this value, so it must stay exactly what
        // the contract accepts.
        response: completed.value,
        metadata: {
          providerModel: completed.result.model,
          providerDurationMs: completed.result.durationMs,
          finishReason: completed.result.finishReason ?? null,
          producedAt: responseProducedAt,
        },
        receipt: cacheReceiptInput(receipt),
      })
    }
    modelProxy.assertExecutionComplete()
    return { ...completed, response, producedAt: responseProducedAt, receipt }
  } catch (error) {
    const controlFailure = modelProxy.failures().find(isPaidCallControlError)
    if (controlFailure) throw controlFailure
    const receipt = settledReceipt(costLedger, providerCallId)
    if (cacheIdentity) {
      if (receipt) {
        writePublicBenchmarkResponseCache(durability!.responseCacheDir, {
          kind: 'agent-eval/public-benchmark-model-response',
          ...cacheIdentity,
          callId: providerCallId,
          status: 'failed',
          error: publicBenchmarkError(error, []),
          receipt: cacheReceiptInput(receipt),
        })
      }
    }
    throw error
  }
}

/** Call the provider once behind a budgeted loopback proxy and record the response on the case. */
async function applyProviderResponse<TRow>(
  arm: ChunkedArm<TRow>,
  run: ChunkedCase<TRow>,
  request: LlmCallRequest,
  cacheIdentity: ChunkedCacheIdentity | undefined,
  callId: string | undefined,
): Promise<void> {
  const { binding, costLedger, config, callRef, model } = arm
  const { context } = run
  assertNoSettledResponseWithoutCache(costLedger, callId)
  const providerCallId = callId ?? `analyst-benchmark-${randomUUID()}`
  let modelProxy: ExternalOptimizerModelProxy | undefined
  const completed = await runWithCleanup({
    label: 'public benchmark direct model resources',
    run: async () => {
      modelProxy = await startExternalOptimizerModelProxy({
        call: config.call,
        callRef,
        recordExecution: config.recordExecution,
        model,
        budget: {
          maxCostUsd: arm.maxCostUsd,
          maxRequests: 1,
          maxRequestBytes: arm.maxModelRequestBytes,
          maxResponseBytes: arm.maxModelResponseBytes,
          maxOutputTokensPerRequest: arm.maxOutputTokens,
          maxReasoningTokensPerRequest: arm.maxReasoningTokens,
          pricing: arm.pricing,
          requestTimeoutMs: arm.modelRequestTimeoutMs,
        },
        costLedger,
        channel: 'analyst',
        phase: binding.costPhase,
        actor: binding.costActor,
        tags: run.costTags,
        callId: providerCallId,
        ...(context.signal ? { signal: context.signal } : {}),
      })
      return callChunkedThroughProxy(
        arm,
        context,
        modelProxy,
        request,
        cacheIdentity,
        providerCallId,
      )
    },
    cleanup: async () => {
      await modelProxy?.close()
    },
  })
  const response = completed.response
  run.rawPredictions = response.rows
  run.rejectedRows = response.rejected.map((entry) => entry.reason)
  run.providerModel = completed.result.model
  run.producedAt = completed.producedAt
  run.modelMetadata = {
    ...run.modelMetadata,
    responseSource: 'provider',
    ...response.extras,
    providerModel: completed.result.model,
    providerDurationMs: completed.result.durationMs,
    finishReason: completed.result.finishReason ?? null,
    cost: costReceiptMetadata(completed.receipt),
  }
}

/** Expand the accepted rows into findings and ground them against the store. */
async function expandChunkedFindings<TRow>(
  arm: ChunkedArm<TRow>,
  run: ChunkedCase<TRow>,
  store: TraceAnalysisStore,
): Promise<void> {
  const { binding, definition } = arm
  const { context } = run
  const converted = await binding.expandRows({
    subject: run.trajectoryId,
    rows: run.rawPredictions,
    store,
    analystId: definition.id,
    providerModel: run.providerModel,
    producedAt: requiredString(run.producedAt ?? '', 'finding producedAt'),
    ...(context.signal ? { signal: context.signal } : {}),
  })
  run.modelFindings = converted.findings
  if (converted.diagnostics) {
    run.modelMetadata = {
      ...run.modelMetadata,
      blockDiagnostics: {
        ...(converted.diagnostics as Record<string, unknown>),
        rejectedBlocks: run.rejectedRows,
      },
    }
  }
  if (binding.verifyFindings) {
    await binding.verifyFindings({
      subject: run.trajectoryId,
      findings: run.modelFindings,
      store,
      ...(context.signal ? { signal: context.signal } : {}),
    })
  }
}

/** Answer one case from the durable cache or the provider, then expand and ground its findings. */
async function analyzeChunkedRows<TRow>(
  arm: ChunkedArm<TRow>,
  run: ChunkedCase<TRow>,
  store: TraceAnalysisStore,
): Promise<AnalystBenchmarkOutput> {
  const { context, trajectoryId } = run
  const preparedContext = await prepareSingleTraceContext(store, context, arm.attributeByteCaps)
  if (preparedContext === undefined) {
    throw new Error(`trace '${trajectoryId}' has no readable spans`)
  }
  const request = buildChunkedRequest(arm, preparedContext)
  const cacheIdentity = arm.durability
    ? {
        runIdentitySha256: arm.durability.runIdentitySha256,
        caseId: context.caseId,
        repetition: context.repetition,
      }
    : undefined
  const callId = cacheIdentity ? publicBenchmarkCallId(cacheIdentity) : undefined
  const cached = cacheIdentity
    ? readPublicBenchmarkResponseCache(arm.durability!.responseCacheDir, cacheIdentity)
    : undefined
  if (cached) {
    const failed = applyCachedResponse(arm, run, cached)
    if (failed) return failed
  } else {
    await applyProviderResponse(arm, run, request, cacheIdentity, callId)
  }

  await expandChunkedFindings(arm, run, store)
  return {
    findings: run.modelFindings,
    usage: chunkedCaseUsage(arm, run),
    metadata: run.modelMetadata,
  }
}

/** Analyze one benchmark case; a paid-call control error or an abort is rethrown, any other failure is recorded. */
async function analyzeChunkedCase<TRow>(
  arm: ChunkedArm<TRow>,
  input: AnalystRunInputs,
  context: BenchmarkContext,
): Promise<AnalystBenchmarkOutput> {
  const { definition, binding } = arm
  const run: ChunkedCase<TRow> = {
    context,
    trajectoryId: binding.subjectFromCaseId(context.caseId),
    costTags: {
      analystId: binding.costActor,
      benchmarkCaseId: context.caseId,
      benchmarkRepetition: String(context.repetition),
    },
    rawPredictions: [],
    rejectedRows: [],
    modelFindings: [],
    providerModel: arm.model,
    producedAt: undefined,
    modelMetadata: {
      ...binding.baseMetadata,
      protocolSha256: definition.protocolSha256,
      callRef: arm.callRef,
    },
  }
  try {
    if (!input.traceStore) {
      throw new Error(`chunked analyst '${definition.id}' requires a trace store`)
    }
    return await analyzeChunkedRows(arm, run, input.traceStore)
  } catch (error) {
    if (context.signal?.aborted) throw error
    if (isPaidCallControlError(error)) throw error
    return {
      findings: [],
      usage: chunkedCaseUsage(arm, run),
      error: publicBenchmarkError(error, []),
      metadata: {
        ...run.modelMetadata,
        rawPredictions: run.rawPredictions,
        acceptedFindings: run.modelFindings,
      },
    }
  }
}

/**
 * Compile a chunked-projection definition into a runnable one-shot JSON arm
 * over the caller-owned model path. Prompt content, the projection ladder,
 * the reply grammar, and the budget declaration come from the definition;
 * caching, cost settlement, and the model proxy are transport machinery.
 */
export function runChunkedAnalystDefinition<TRow>(
  definition: AnalystDefinition<TRow>,
  config: PublicAnalystBenchmarkModelConfig,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  const arm = compileChunkedArm(definition, config)
  return {
    id: definition.id,
    analyze: (input, context) => analyzeChunkedCase(arm, input, context),
  }
}

/** A definition that declares one budget while the transport runs another is refused. */
function assertDeclaredBudget<TRow>(
  definition: AnalystDefinition<TRow>,
  effective: { timeoutMs: number; maxOutputTokens: number; maxCostUsd: number },
): void {
  const declared = definition.budget
  if (
    declared.timeoutMs !== effective.timeoutMs ||
    declared.maxOutputTokens !== effective.maxOutputTokens ||
    declared.maxCostUsd !== effective.maxCostUsd
  ) {
    throw new AnalystExpressivenessError(
      `definition '${definition.id}' declares budget ${JSON.stringify(declared)} but the bound ` +
        `transport runs ${JSON.stringify(effective)}; the declaration must state what executes`,
    )
  }
}

function settleCachedResponse(
  costLedger: CostLedgerHandle,
  cached: PublicBenchmarkResponseCacheEntry,
): CostReceipt {
  const settled = costLedger.list().find((receipt) => receipt.callId === cached.callId)
  const pending = costLedger.listPending?.().find((record) => record.callId === cached.callId)
  if (settled && pending) {
    throw new CostCallConflictError(
      `benchmark response '${cached.callId}' is both pending and settled`,
      { callId: cached.callId },
    )
  }
  const receipt = pending
    ? costLedger.reconcile(cached.callId, cached.receipt, {
        ...(cached.status === 'failed' ? { failed: true } : {}),
      })
    : settled
  if (!receipt) {
    throw new CostCallConflictError(
      `benchmark response cache '${cached.callId}' has no matching cost record`,
      { callId: cached.callId },
    )
  }
  assertCacheReceiptMatches(cached, receipt)
  return receipt
}

function assertNoSettledResponseWithoutCache(
  costLedger: CostLedgerHandle,
  callId: string | undefined,
): void {
  if (!callId) return
  if (costLedger.list().some((receipt) => receipt.callId === callId)) {
    throw new CostCallConflictError(
      `settled benchmark call '${callId}' has no durable response cache`,
      { callId },
    )
  }
}

function assertCacheReceiptMatches(
  cached: PublicBenchmarkResponseCacheEntry,
  receipt: CostReceipt,
): void {
  const expected = cached.receipt
  const mismatch =
    receipt.callId !== cached.callId ||
    receipt.model !== expected.model ||
    receipt.inputTokens !== expected.inputTokens ||
    receipt.outputTokens !== expected.outputTokens ||
    (receipt.reasoningTokens ?? 0) !== (expected.reasoningTokens ?? 0) ||
    (receipt.cachedTokens ?? 0) !== (expected.cachedTokens ?? 0) ||
    (receipt.cacheWriteTokens ?? 0) !== (expected.cacheWriteTokens ?? 0) ||
    (expected.actualCostUsd !== undefined && receipt.actualCostUsd !== expected.actualCostUsd) ||
    (expected.estimatedCostUsd !== undefined &&
      receipt.estimatedCostUsd !== expected.estimatedCostUsd) ||
    (expected.costUnknown === true && !receipt.costUnknown) ||
    (expected.usageUnknown === true && !receipt.usageUnknown) ||
    (cached.status === 'succeeded' && receipt.error !== undefined) ||
    (cached.status === 'failed' && receipt.error === undefined)
  if (mismatch) {
    throw new CostCallConflictError(
      `benchmark response cache receipt does not match cost record '${cached.callId}'`,
      { callId: cached.callId, receipt },
    )
  }
}

function isPaidCallControlError(error: unknown): boolean {
  return (
    error instanceof CostAccountingIncompleteError ||
    error instanceof CostCallConflictError ||
    error instanceof CostCeilingReachedError ||
    error instanceof CostLedgerPersistenceError ||
    error instanceof CostReceiptCaptureError ||
    error instanceof CostReservationExceededError
  )
}

function settledReceipt(costLedger: CostLedgerHandle, callId: string): CostReceipt | undefined {
  return costLedger.list().find((receipt) => receipt.callId === callId)
}

function requiredSettledReceipt(costLedger: CostLedgerHandle, callId: string): CostReceipt {
  const receipt = settledReceipt(costLedger, callId)
  if (!receipt) {
    throw new CostAccountingIncompleteError(
      `caller-owned model call '${callId}' produced no cost receipt`,
    )
  }
  return receipt
}

function cacheReceiptInput(receipt: CostReceipt): CostReceiptInput {
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
  if (receipt.costUnknown) return { ...usage, costUnknown: true }
  if (receipt.actualCostUsd !== undefined) {
    return { ...usage, actualCostUsd: receipt.actualCostUsd }
  }
  if (receipt.estimatedCostUsd !== undefined) {
    return { ...usage, estimatedCostUsd: receipt.estimatedCostUsd }
  }
  if (receipt.pricing) {
    return {
      ...usage,
      customTokenPricing: {
        inputUsdPerMillion: receipt.pricing.inputUsdPerThousand * 1_000,
        ...(receipt.pricing.cachedInputUsdPerThousand === undefined
          ? {}
          : { cachedInputUsdPerMillion: receipt.pricing.cachedInputUsdPerThousand * 1_000 }),
        ...(receipt.pricing.cacheWriteUsdPerThousand === undefined
          ? {}
          : { cacheWriteUsdPerMillion: receipt.pricing.cacheWriteUsdPerThousand * 1_000 }),
        outputUsdPerMillion: receipt.pricing.outputUsdPerThousand * 1_000,
      },
    }
  }
  return { ...usage, estimatedCostUsd: receipt.costUsd }
}

function costReceiptMetadata(receipt: CostReceipt): Record<string, unknown> {
  if (receipt.actualCostUsd !== undefined) {
    return { source: 'provider', actualCostUsd: receipt.actualCostUsd }
  }
  if (receipt.estimatedCostUsd !== undefined) {
    return { source: 'external-estimate', estimatedCostUsd: receipt.estimatedCostUsd }
  }
  if (receipt.pricing) {
    return {
      source: 'agent-eval-model-pricing',
      estimatedCostUsd: receipt.costUsd,
      ratesPerThousandTokens: receipt.pricing,
    }
  }
  return {
    source: 'unknown',
    estimatedCostUsd: null,
  }
}

function pricingForModel(model: string): NonNullable<PublicAnalystBenchmarkModelConfig['pricing']> {
  const pricing = resolveModelPricing(model)
  if (!pricing) {
    throw new Error(
      `no pricing is configured for '${model}'; provide PublicAnalystBenchmarkModelConfig.pricing`,
    )
  }
  return {
    inputUsdPerMillion: pricing.input * 1_000,
    outputUsdPerMillion: pricing.output * 1_000,
  }
}

async function prepareSingleTraceContext(
  store: TraceAnalysisStore,
  context: { signal?: AbortSignal },
  attributeByteCaps: readonly number[],
): Promise<string | undefined> {
  const storeContext = context.signal ? { signal: context.signal } : undefined
  const overview = await store.getOverview(undefined, storeContext)
  if (overview.total_traces !== 1 || overview.sample_trace_ids.length !== 1) {
    throw new Error(
      `public model benchmark requires exactly one trace, received ${overview.total_traces}`,
    )
  }
  const traceId = overview.sample_trace_ids[0]!
  for (const perAttributeByteCap of attributeByteCaps) {
    const viewed = await store.viewTrace(
      {
        trace_id: traceId,
        per_attribute_byte_cap: perAttributeByteCap,
      },
      storeContext,
    )
    if (!viewed.spans) continue
    return JSON.stringify({
      trace_id: traceId,
      per_attribute_byte_cap: perAttributeByteCap,
      spans: viewed.spans,
    })
  }
  return undefined
}
