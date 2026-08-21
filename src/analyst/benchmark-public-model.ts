import { randomUUID } from 'node:crypto'
import { z } from 'zod'
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
import type { AnalystBenchmarkRunner } from './benchmark'
import { agentRxPredictionsToFindings } from './benchmark-datasets'
import {
  resolveAssistantStepEvidence,
  validateCodeTraceFindingEvidence,
} from './benchmark-evidence-validation'
import {
  type CodeTraceBlockDiagnostics,
  type CodeTraceFailureBlock,
  expandCodeTraceFailureBlocks,
} from './benchmark-public-adapters'
import { publicBenchmarkError } from './benchmark-public-errors'
import {
  MAX_INCORRECT_BLOCK_STEPS,
  MAX_INCORRECT_BLOCKS,
  PUBLIC_BENCHMARK_ENVELOPE_CONTRACT,
  publicBenchmarkFieldContract,
  publicBenchmarkProtocolSha256,
  publicBenchmarkTaskPrompt,
  TRACE_PROJECTION_ATTRIBUTE_BYTE_CAPS,
} from './benchmark-public-prompt'
import {
  type PublicAnalystBenchmarkDataset,
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
import { type AnalystDefinition, AnalystExpressivenessError } from './definition'
import { decodeReplyRows, type ReplyContract } from './reply-contract'
import type { AnalystFinding, AnalystRunInputs } from './types'
import { usageReceiptFromCostLedger } from './usage-receipt'

export {
  CODE_TRACE_BENCH_ANALYST_PROMPT,
  publicBenchmarkProtocolSha256,
} from './benchmark-public-prompt'

/**
 * One-shot JSON baseline arm. Not a recursive trace analyst.
 *
 * The arm is expressed as an `AnalystDefinition`
 * (`publicDirectAnalystDefinition`): the task text, field and envelope
 * contracts, the descending projection ladder, and the zero-repair declaration
 * are definition content, and `createPublicBenchmarkDirectRunner` is a thin
 * shell that builds the definition and runs it through the chunked strategy
 * below — the same strategy `bindAnalyst` (./bind) dispatches to.
 */

export interface PublicDirectDefinitionArgs {
  /** Whole-analysis deadline (`config.timeoutMs`). */
  timeoutMs: number
  /** Completion-token cap per call (`config.maxOutputTokens`). */
  maxOutputTokens: number
  /** Per-case provider spend ceiling (`config.maxCostUsdPerAnalysis`). */
  maxCostUsd: number
}

/** The direct arm as a declarative unit for one public dataset. */
export function publicDirectAnalystDefinition(
  dataset: PublicAnalystBenchmarkDataset,
  args: PublicDirectDefinitionArgs,
): AnalystDefinition<PublicBenchmarkModelPrediction> {
  const actor =
    dataset === 'agentrx' ? 'agentrx-root-cause-localizer' : 'codetracebench-step-localizer'
  const outputAdapter =
    dataset === 'agentrx' ? 'agentrx-taxonomy-and-root-step' : 'codetracebench-incorrect-block'
  return {
    id: 'direct',
    description: 'One-shot JSON baseline over the caller-owned model path.',
    version: '1.0.0',
    area: dataset === 'agentrx' ? 'root-cause' : 'incorrect',
    // One-shot JSON transport runs with thinking disabled.
    profile: { model: { reasoningEffort: 'none' } },
    // The task text is the whole ask: the one-shot prompt carries no question line.
    question: '',
    taskDefinition: publicBenchmarkTaskPrompt(dataset),
    projection: { mode: 'chunked', attributeByteCaps: TRACE_PROJECTION_ATTRIBUTE_BYTE_CAPS },
    replyContract: directReplyContract(dataset),
    contractLimits:
      dataset === 'agentrx'
        ? { maxFindings: 1 }
        : { maxBlocks: MAX_INCORRECT_BLOCKS, maxBlockSteps: MAX_INCORRECT_BLOCK_STEPS },
    budget: {
      timeoutMs: args.timeoutMs,
      maxCostUsd: args.maxCostUsd,
      maxOutputTokens: args.maxOutputTokens,
    },
    repair: { turns: 0 },
    protocolSha256: publicBenchmarkProtocolSha256(dataset),
    binding: {
      kind: 'chunked',
      subjectFromCaseId: (caseId) => trajectoryIdFromCaseId(dataset, caseId),
      baseMetadata: { analysisMode: 'direct-baseline', outputAdapter },
      costActor: actor,
      costPhase: 'analyst.public-benchmark',
      userMessage: (rendered) => `TRACE DATA:\n${rendered}\n\nReturn the analysis JSON object.`,
      async expandRows({ subject, rows, store, analystId, producedAt, providerModel, signal }) {
        const converted = await publicBenchmarkPredictionsToFindings({
          dataset,
          trajectoryId: subject,
          predictions: rows,
          store,
          analystId,
          providerModel: requiredString(providerModel ?? '', 'finding providerModel'),
          producedAt: requiredString(producedAt ?? '', 'finding producedAt'),
          ...(signal ? { signal } : {}),
        })
        return { findings: converted.findings, diagnostics: converted.diagnostics }
      },
      ...(dataset === 'codetracebench'
        ? {
            verifyFindings: async (args: {
              subject: string
              findings: readonly AnalystFinding[]
              store: TraceAnalysisStore
              signal?: AbortSignal
            }) => {
              await validateCodeTraceFindingEvidence({
                trajectoryId: args.subject,
                findings: [...args.findings],
                store: args.store,
                ...(args.signal ? { signal: args.signal } : {}),
              })
            },
          }
        : {}),
    },
  }
}

/** Thin shell: validate config, declare the definition, run the chunked strategy. */
export function createPublicBenchmarkDirectRunner(
  dataset: PublicAnalystBenchmarkDataset,
  config: PublicAnalystBenchmarkModelConfig,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  if (config.instructionsOverride) {
    throw new Error(
      'the direct runner executes only the stock protocol; an instructions override requires the dspy-rlm runner',
    )
  }
  const maxOutputTokens = positiveSafeInteger(config.maxOutputTokens, 'maxOutputTokens')
  const timeoutMs = positiveSafeInteger(config.timeoutMs, 'timeoutMs')
  return runChunkedAnalystDefinition(
    publicDirectAnalystDefinition(dataset, {
      timeoutMs,
      maxOutputTokens,
      maxCostUsd: config.maxCostUsdPerAnalysis ?? 1,
    }),
    config,
  )
}

// ── Chunked one-shot execution strategy ─────────────────────────────

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
  const systemPrompt = [definition.taskDefinition, ...replyContract.contractLines].join('\n\n')
  return {
    id: definition.id,
    async analyze(input, context) {
      const trajectoryId = binding.subjectFromCaseId(context.caseId)
      const costTags = {
        analystId: binding.costActor,
        benchmarkCaseId: context.caseId,
        benchmarkRepetition: String(context.repetition),
      }
      let rawPredictions: TRow[] = []
      let rejectedRows: string[] = []
      let modelFindings: AnalystFinding[] = []
      let providerModel = model
      let producedAt: string | undefined
      let modelMetadata: Record<string, unknown> = {
        ...binding.baseMetadata,
        protocolSha256: definition.protocolSha256,
        callRef,
      }
      try {
        if (!input.traceStore) {
          throw new Error(`chunked analyst '${definition.id}' requires a trace store`)
        }
        const preparedContext = await prepareSingleTraceContext(
          input.traceStore,
          context,
          projection.attributeByteCaps,
        )
        if (preparedContext === undefined) {
          throw new Error(`trace '${trajectoryId}' has no readable spans`)
        }
        const request: LlmCallRequest = {
          model,
          messages: [
            {
              role: 'system',
              content: systemPrompt,
            },
            {
              role: 'user',
              content: binding.userMessage(preparedContext),
            },
          ],
          jsonMode: true,
          thinking: 'disabled',
          maxTokens: maxOutputTokens,
          timeoutMs: modelRequestTimeoutMs,
        }
        const cacheIdentity = durability
          ? {
              runIdentitySha256: durability.runIdentitySha256,
              caseId: context.caseId,
              repetition: context.repetition,
            }
          : undefined
        const callId = cacheIdentity ? publicBenchmarkCallId(cacheIdentity) : undefined
        const cached = cacheIdentity
          ? readPublicBenchmarkResponseCache(durability!.responseCacheDir, cacheIdentity)
          : undefined
        if (cached) {
          const receipt = settleCachedResponse(costLedger, cached)
          modelMetadata = {
            ...modelMetadata,
            responseSource: 'durable-cache',
            cost: costReceiptMetadata(receipt),
          }
          if (cached.status === 'failed') {
            return {
              findings: [],
              usage: usageReceiptFromCostLedger(costLedger, {
                channel: 'analyst',
                tags: costTags,
              }),
              error: cached.error,
              metadata: modelMetadata,
            }
          }
          const response = decodeReplyRows(replyContract, cached.response)
          rawPredictions = response.rows
          rejectedRows = response.rejected.map((entry) => entry.reason)
          providerModel = cached.metadata.providerModel
          producedAt = cached.metadata.producedAt
          modelMetadata = {
            ...modelMetadata,
            ...response.extras,
            providerModel: cached.metadata.providerModel,
            providerDurationMs: cached.metadata.providerDurationMs,
            finishReason: cached.metadata.finishReason,
          }
        } else {
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
                  maxCostUsd,
                  maxRequests: 1,
                  maxRequestBytes: maxModelRequestBytes,
                  maxResponseBytes: maxModelResponseBytes,
                  maxOutputTokensPerRequest: maxOutputTokens,
                  maxReasoningTokensPerRequest: maxReasoningTokens,
                  pricing,
                  requestTimeoutMs: modelRequestTimeoutMs,
                },
                costLedger,
                channel: 'analyst',
                phase: binding.costPhase,
                actor: binding.costActor,
                tags: costTags,
                callId: providerCallId,
                ...(context.signal ? { signal: context.signal } : {}),
              })
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
            },
            cleanup: async () => {
              await modelProxy?.close()
            },
          })
          const response = completed.response
          rawPredictions = response.rows
          rejectedRows = response.rejected.map((entry) => entry.reason)
          providerModel = completed.result.model
          producedAt = completed.producedAt
          modelMetadata = {
            ...modelMetadata,
            responseSource: 'provider',
            ...response.extras,
            providerModel: completed.result.model,
            providerDurationMs: completed.result.durationMs,
            finishReason: completed.result.finishReason ?? null,
            cost: costReceiptMetadata(completed.receipt),
          }
        }

        const converted = await binding.expandRows({
          subject: trajectoryId,
          rows: rawPredictions,
          store: input.traceStore,
          analystId: definition.id,
          providerModel,
          producedAt: requiredString(producedAt ?? '', 'finding producedAt'),
          ...(context.signal ? { signal: context.signal } : {}),
        })
        modelFindings = converted.findings
        if (converted.diagnostics) {
          modelMetadata = {
            ...modelMetadata,
            blockDiagnostics: {
              ...(converted.diagnostics as Record<string, unknown>),
              rejectedBlocks: rejectedRows,
            },
          }
        }
        if (binding.verifyFindings) {
          await binding.verifyFindings({
            subject: trajectoryId,
            findings: modelFindings,
            store: input.traceStore,
            ...(context.signal ? { signal: context.signal } : {}),
          })
        }
        return {
          findings: modelFindings,
          usage: usageReceiptFromCostLedger(costLedger, {
            channel: 'analyst',
            tags: costTags,
          }),
          metadata: modelMetadata,
        }
      } catch (error) {
        if (context.signal?.aborted) throw error
        if (isPaidCallControlError(error)) throw error
        return {
          findings: [],
          usage: usageReceiptFromCostLedger(costLedger, {
            channel: 'analyst',
            tags: costTags,
          }),
          error: publicBenchmarkError(error, []),
          metadata: {
            ...modelMetadata,
            rawPredictions,
            acceptedFindings: modelFindings,
          },
        }
      }
    },
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

const ModelSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info'])
const AgentRxPredictionSchema = z
  .object({
    step: z.number().int().positive(),
    severity: ModelSeveritySchema,
    claim: z.string().min(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).optional(),
    recommended_action: z.string().min(1).optional(),
  })
  .strict()
const CodeTraceBlockPredictionSchema = z
  .object({
    first_step: z.number().int().positive(),
    last_step: z.number().int().positive(),
    consequence_step: z.number().int().positive(),
    escape_status: z.enum(['escaped', 'unescaped']),
    severity: ModelSeveritySchema,
    claim: z.string().min(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).optional(),
    recommended_action: z.string().min(1).optional(),
  })
  .strict()
  .superRefine((block, ctx) => {
    if (block.last_step < block.first_step) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `failure block last_step ${block.last_step} precedes first_step ${block.first_step}`,
      })
      return
    }
    const length = block.last_step - block.first_step + 1
    if (length > MAX_INCORRECT_BLOCK_STEPS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `failure block spans ${length} steps; the maximum is ${MAX_INCORRECT_BLOCK_STEPS}`,
      })
    }
    // The damage a block caused can surface anywhere from the block's own first
    // step onward: a step carries both the assistant action and the observation
    // it produced, and a long block often shows its damage mid-block rather than
    // at the end. Only a consequence before the block began is incoherent.
    if (block.consequence_step < block.first_step) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `failure block consequence_step ${block.consequence_step} precedes first_step ${block.first_step}`,
      })
    }
  })
const AgentRxCategorySchema = z.enum([
  'instruction-plan-adherence-failure',
  'invention-of-new-information',
  'invalid-invocation',
  'misinterpretation-of-tool-output-handoff-failure',
  'intent-plan-misalignment',
  'underspecified-user-intent',
  'intent-not-supported',
  'guardrails-triggered',
  'system-failure',
  'inconclusive',
])
const CodeTraceModelResponseEnvelopeSchema = z
  .object({
    report: z.string().min(1).max(4_000),
    findings: z.array(z.unknown()).max(MAX_INCORRECT_BLOCKS),
  })
  .strict()
const AgentRxModelResponseSchema = z
  .object({
    report: z.string().min(1).max(4_000),
    findings: z
      .array(AgentRxPredictionSchema.extend({ category: AgentRxCategorySchema }).strict())
      .max(1),
  })
  .strict()

type AgentRxModelPrediction = z.infer<typeof AgentRxPredictionSchema> & {
  category?: z.infer<typeof AgentRxCategorySchema>
}
type CodeTraceModelPrediction = z.infer<typeof CodeTraceBlockPredictionSchema>
export type PublicBenchmarkModelPrediction = AgentRxModelPrediction | CodeTraceModelPrediction

/**
 * The one-shot reply grammar per dataset. The envelope is the contract and
 * stays strict. Individual CodeTraceBench blocks are model output: one
 * malformed block must not void a case whose remaining blocks are usable and
 * whose provider call is already paid for, so rows decode individually and
 * every rejection is reported.
 */
function directReplyContract(
  dataset: PublicAnalystBenchmarkDataset,
): ReplyContract<PublicBenchmarkModelPrediction> {
  if (dataset === 'agentrx') {
    return {
      rowsField: 'findings',
      contractLines: [publicBenchmarkFieldContract('agentrx'), PUBLIC_BENCHMARK_ENVELOPE_CONTRACT],
      repairContractLines: [],
      parseEnvelope(value) {
        const parsed = AgentRxModelResponseSchema.parse(value)
        return { rows: parsed.findings, extras: { report: parsed.report } }
      },
      decodeRow(row) {
        // The strict envelope already validated every row.
        return { ok: true, row: row as AgentRxModelPrediction }
      },
    }
  }
  return {
    rowsField: 'findings',
    contractLines: [
      publicBenchmarkFieldContract('codetracebench'),
      PUBLIC_BENCHMARK_ENVELOPE_CONTRACT,
    ],
    repairContractLines: [],
    parseEnvelope(value) {
      const envelope = CodeTraceModelResponseEnvelopeSchema.parse(value)
      return { rows: envelope.findings, extras: { report: envelope.report } }
    },
    decodeRow(row, index) {
      const parsed = CodeTraceBlockPredictionSchema.safeParse(row)
      if (parsed.success) return { ok: true, row: parsed.data }
      return {
        ok: false,
        reason: `block ${index}: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.') || '<root>'} ${issue.message}`)
          .join('; ')}`,
      }
    },
    whenAllRowsRejected: 'fail',
    allRejectedMessage: 'every reported failure block was malformed',
  }
}

async function publicBenchmarkPredictionsToFindings(options: {
  dataset: PublicAnalystBenchmarkDataset
  trajectoryId: string
  predictions: readonly PublicBenchmarkModelPrediction[]
  store: TraceAnalysisStore
  analystId: string
  providerModel: string
  producedAt: string
  signal?: AbortSignal
}): Promise<{ findings: AnalystFinding[]; diagnostics: CodeTraceBlockDiagnostics | undefined }> {
  if (options.predictions.length === 0 && options.dataset === 'agentrx') {
    return { findings: [], diagnostics: undefined }
  }
  if (options.dataset === 'agentrx') {
    const prediction = options.predictions[0]!
    if (!('step' in prediction)) {
      throw new Error('AgentRx model output must name a single root-cause step')
    }
    if (!prediction.category) {
      throw new Error('AgentRx model output is missing its failure category')
    }
    const evidenceByStep = await resolveAssistantStepEvidence({
      trajectoryId: options.trajectoryId,
      steps: [prediction.step],
      store: options.store,
      ...(options.signal ? { signal: options.signal } : {}),
    })
    const [finding] = agentRxPredictionsToFindings(
      options.trajectoryId,
      [
        {
          failure_case: prediction.category,
          step_number: prediction.step,
          description: prediction.rationale ?? prediction.claim,
        },
      ],
      {
        analystId: options.analystId,
        producedAt: options.producedAt,
        confidence: prediction.confidence,
      },
    )
    if (!finding) throw new Error('AgentRx output adapter produced no root-cause finding')
    return {
      findings: [
        {
          ...finding,
          evidence_refs: [evidenceByStep.get(prediction.step)!],
          metadata: {
            ...finding.metadata,
            model: options.providerModel,
          },
        },
      ],
      diagnostics: undefined,
    }
  }

  const blocks = options.predictions.map((prediction): CodeTraceFailureBlock => {
    if (!('first_step' in prediction)) {
      throw new Error('CodeTraceBench model output must report first_step/last_step failure blocks')
    }
    return {
      firstStep: prediction.first_step,
      lastStep: prediction.last_step,
      consequenceStep: prediction.consequence_step,
      escapeStatus: prediction.escape_status,
      severity: prediction.severity,
      claim: prediction.claim,
      confidence: prediction.confidence,
      ...(prediction.rationale === undefined ? {} : { rationale: prediction.rationale }),
      ...(prediction.recommended_action === undefined
        ? {}
        : { recommendedAction: prediction.recommended_action }),
      metadata: { analysis_mode: 'direct-baseline', model: options.providerModel },
    }
  })
  return expandCodeTraceFailureBlocks({
    trajectoryId: options.trajectoryId,
    blocks,
    store: options.store,
    analystId: options.analystId,
    producedAt: options.producedAt,
    ...(options.signal ? { signal: options.signal } : {}),
  })
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

function trajectoryIdFromCaseId(dataset: PublicAnalystBenchmarkDataset, caseId: string): string {
  const prefix = dataset === 'agentrx' ? 'agentrx:' : 'codetrace:'
  if (!caseId.startsWith(prefix) || caseId.length === prefix.length) {
    throw new Error(`unexpected ${dataset} benchmark case id '${caseId}'`)
  }
  return caseId.slice(prefix.length)
}
