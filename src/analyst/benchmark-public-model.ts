import { z } from 'zod'
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
import {
  callLlmJson,
  costReceiptFromLlm,
  costReceiptFromLlmError,
  type LlmCallRequest,
  type LlmCallResult,
  type LlmClientOptions,
  maximumChargeForLlmRequest,
} from '../llm-client'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { AnalystBenchmarkRunner } from './benchmark'
import { agentRxPredictionsToFindings } from './benchmark-datasets'
import {
  MAX_ASSISTANT_STEP_EVIDENCE_EXCERPT_CHARACTERS,
  resolveAssistantStepEvidence,
  validateCodeTraceFindingEvidence,
} from './benchmark-evidence-validation'
import { publicBenchmarkError } from './benchmark-public-errors'
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
import { sha256Digest } from './benchmark-verification-artifacts'
import type { AnalystFinding, AnalystRunInputs } from './types'
import { makeFinding } from './types'
import { usageReceiptFromCostLedger } from './usage-receipt'

const TRACE_PROJECTION_ATTRIBUTE_BYTE_CAPS = [4_096, 2_048, 1_024, 512, 256, 128, 64] as const

export function createPublicBenchmarkModelRunner(
  dataset: PublicAnalystBenchmarkDataset,
  config: PublicAnalystBenchmarkModelConfig,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  const model = requiredString(config.model, 'model')
  const baseUrl = requiredString(config.baseUrl, 'baseUrl')
  const apiKey = requiredString(config.apiKey, 'apiKey')
  const maxOutputTokens = positiveSafeInteger(config.maxOutputTokens, 'maxOutputTokens')
  const timeoutMs = positiveSafeInteger(config.timeoutMs, 'timeoutMs')
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
  const actor =
    dataset === 'agentrx' ? 'agentrx-root-cause-localizer' : 'codetracebench-step-localizer'
  const outputAdapter =
    dataset === 'agentrx' ? 'agentrx-taxonomy-and-root-step' : 'codetracebench-incorrect-step'
  const llmOptions: LlmClientOptions = {
    baseUrl,
    apiKey,
    maximumAttempts: 1,
    jsonSchemaTransport: 'json-object',
    jsonPayloadMode: 'exact',
    thinking: 'disabled',
    ...(config.fetchImpl ? { fetch: config.fetchImpl } : {}),
  }

  return {
    id: 'model',
    async analyze(input, context) {
      const trajectoryId = trajectoryIdFromCaseId(dataset, context.caseId)
      const costTags = {
        analystId: actor,
        benchmarkCaseId: context.caseId,
        benchmarkRepetition: String(context.repetition),
      }
      let rawPredictions: PublicBenchmarkModelPrediction[] = []
      let modelFindings: AnalystFinding[] = []
      let providerModel = model
      let producedAt: string | undefined
      let modelMetadata: Record<string, unknown> = {
        analysisMode: 'single-pass',
        outputAdapter,
        protocolSha256: publicBenchmarkProtocolSha256(dataset),
      }
      try {
        if (!input.traceStore) {
          throw new Error(`${dataset} model runner requires a trace store`)
        }
        const preparedContext = await prepareSingleTraceContext(input.traceStore, context)
        if (preparedContext === undefined) {
          throw new Error(`${dataset} trace '${trajectoryId}' has no readable spans`)
        }
        const request: LlmCallRequest = {
          model,
          messages: [
            {
              role: 'system',
              content: publicBenchmarkSystemPrompt(dataset),
            },
            {
              role: 'user',
              content: `TRACE DATA:\n${preparedContext}\n\nReturn the analysis JSON object.`,
            },
          ],
          jsonMode: true,
          thinking: 'disabled',
          maxTokens: maxOutputTokens,
          timeoutMs,
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
          const response = parsePublicBenchmarkModelResponse(dataset, cached.response)
          rawPredictions = response.findings
          providerModel = cached.metadata.providerModel
          producedAt = cached.metadata.producedAt
          modelMetadata = {
            ...modelMetadata,
            report: response.report,
            providerModel: cached.metadata.providerModel,
            providerDurationMs: cached.metadata.providerDurationMs,
            finishReason: cached.metadata.finishReason,
          }
        } else {
          assertNoSettledResponseWithoutCache(costLedger, callId)
          let completedResult: LlmCallResult | undefined
          const paid = await costLedger.runPaidCall({
            ...(callId ? { callId } : {}),
            channel: 'analyst',
            phase: 'analyst.public-benchmark',
            actor,
            model,
            signal: context.signal,
            maximumCharge: maximumChargeForLlmRequest(request, llmOptions),
            tags: costTags,
            execute: async (signal, providerCallId) => {
              try {
                const completed = await callLlmJson<unknown>(request, {
                  ...llmOptions,
                  signal,
                  idempotencyKey: providerCallId,
                })
                completedResult = completed.result
                const response = parsePublicBenchmarkModelResponse(dataset, completed.value)
                const responseProducedAt = new Date().toISOString()
                if (cacheIdentity) {
                  writePublicBenchmarkResponseCache(durability!.responseCacheDir, {
                    kind: 'agent-eval/public-benchmark-model-response',
                    ...cacheIdentity,
                    callId: providerCallId,
                    status: 'succeeded',
                    response,
                    metadata: {
                      providerModel: completed.result.model,
                      providerDurationMs: completed.result.durationMs,
                      finishReason: completed.result.finishReason ?? null,
                      producedAt: responseProducedAt,
                    },
                    receipt: costReceiptFromLlm(completed.result),
                  })
                }
                return { ...completed, response, producedAt: responseProducedAt }
              } catch (error) {
                if (cacheIdentity) {
                  writePublicBenchmarkResponseCache(durability!.responseCacheDir, {
                    kind: 'agent-eval/public-benchmark-model-response',
                    ...cacheIdentity,
                    callId: providerCallId,
                    status: 'failed',
                    error: publicBenchmarkError(error, [apiKey]),
                    receipt: receiptForProviderFailure(error, completedResult, model),
                  })
                }
                throw error
              }
            },
            receipt: ({ result }) => costReceiptFromLlm(result),
            receiptFromError: (error) => receiptForProviderFailure(error, completedResult, model),
          })
          if (!paid.succeeded) throw paid.error
          const response = paid.value.response
          rawPredictions = response.findings
          providerModel = paid.value.result.model
          producedAt = paid.value.producedAt
          modelMetadata = {
            ...modelMetadata,
            responseSource: 'provider',
            report: response.report,
            providerModel: paid.value.result.model,
            providerDurationMs: paid.value.result.durationMs,
            finishReason: paid.value.result.finishReason ?? null,
            cost: costReceiptMetadata(paid.receipt),
          }
        }

        modelFindings = await publicBenchmarkPredictionsToFindings({
          dataset,
          trajectoryId,
          predictions: rawPredictions,
          store: input.traceStore,
          analystId: 'model',
          providerModel,
          producedAt: requiredString(producedAt ?? '', 'finding producedAt'),
          ...(context.signal ? { signal: context.signal } : {}),
        })
        if (dataset === 'codetracebench') {
          await validateCodeTraceFindingEvidence({
            trajectoryId,
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
          error: publicBenchmarkError(error, [apiKey]),
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

function receiptForProviderFailure(
  error: unknown,
  completedResult: LlmCallResult | undefined,
  model: string,
): CostReceiptInput {
  if (completedResult) return costReceiptFromLlm(completedResult)
  if (error instanceof Error) {
    const captured = costReceiptFromLlmError(error)
    if (captured) return captured
  }
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    costUnknown: true,
    usageUnknown: true,
  }
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

const ModelSeveritySchema = z.enum(['critical', 'high', 'medium', 'low', 'info'])
const PublicBenchmarkPredictionSchema = z
  .object({
    step: z.number().int().positive(),
    severity: ModelSeveritySchema,
    claim: z.string().min(1),
    confidence: z.number().min(0).max(1),
    rationale: z.string().min(1).optional(),
    recommended_action: z.string().min(1).optional(),
  })
  .strict()
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
const CodeTraceModelResponseSchema = z
  .object({
    report: z.string().min(1).max(4_000),
    findings: z.array(PublicBenchmarkPredictionSchema).max(200),
  })
  .strict()
const AgentRxModelResponseSchema = z
  .object({
    report: z.string().min(1).max(4_000),
    findings: z
      .array(PublicBenchmarkPredictionSchema.extend({ category: AgentRxCategorySchema }).strict())
      .max(1),
  })
  .strict()

type PublicBenchmarkModelPrediction = z.infer<typeof PublicBenchmarkPredictionSchema> & {
  category?: z.infer<typeof AgentRxCategorySchema>
}

function parsePublicBenchmarkModelResponse(
  dataset: PublicAnalystBenchmarkDataset,
  value: unknown,
): { report: string; findings: PublicBenchmarkModelPrediction[] } {
  return dataset === 'agentrx'
    ? AgentRxModelResponseSchema.parse(value)
    : CodeTraceModelResponseSchema.parse(value)
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
}): Promise<AnalystFinding[]> {
  if (options.predictions.length === 0) return []
  const evidenceByStep = await resolveAssistantStepEvidence({
    trajectoryId: options.trajectoryId,
    steps: options.predictions.map((prediction) => prediction.step),
    store: options.store,
    ...(options.signal ? { signal: options.signal } : {}),
  })
  if (options.dataset === 'agentrx') {
    const prediction = options.predictions[0]!
    if (!prediction.category) {
      throw new Error('AgentRx model output is missing its failure category')
    }
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
    return [
      {
        ...finding,
        evidence_refs: [evidenceByStep.get(prediction.step)!],
        metadata: {
          ...finding.metadata,
          model: options.providerModel,
        },
      },
    ]
  }

  const byStep = new Map<number, PublicBenchmarkModelPrediction>()
  for (const prediction of options.predictions) {
    if (!byStep.has(prediction.step)) byStep.set(prediction.step, prediction)
  }
  return [...byStep]
    .sort(([left], [right]) => left - right)
    .map(([step, prediction]) =>
      makeFinding({
        analyst_id: options.analystId,
        area: 'incorrect',
        subject: `incorrect-step-${step}`,
        claim: `Step ${step} is incorrect. ${prediction.claim}`,
        rationale: prediction.rationale,
        severity: prediction.severity,
        confidence: prediction.confidence,
        evidence_refs: [evidenceByStep.get(step)!],
        recommended_action: prediction.recommended_action,
        metadata: {
          analysis_mode: 'single-pass',
          model: options.providerModel,
        },
        produced_at: options.producedAt,
        id_basis: `incorrect-step-${step}`,
      }),
    )
}

function publicBenchmarkSystemPrompt(dataset: PublicAnalystBenchmarkDataset): string {
  return `${dataset === 'agentrx' ? AGENT_RX_PROMPT : CODE_TRACE_BENCH_ANALYST_PROMPT}

Each finding must contain only:
- "step": a positive integer matching an existing assistant LLM span named step-<n>
- "severity": "critical", "high", "medium", "low", or "info"
- "claim": one sentence
- "confidence": a number from 0 through 1
- optional "rationale" and "recommended_action" strings
${dataset === 'agentrx' ? `- "category": one allowed failure category listed above` : ''}

Return exactly one JSON object with:
- "report": a concise evidence-based explanation, at most 4000 characters
- "findings": the strict finding array
Use an empty findings array when the trace does not support a finding.
Do not return a bare array, markdown, trace URIs, copied excerpts, or fields not listed above.
The runner constructs exact trace URIs and action previews from each selected step.`
}

export function publicBenchmarkProtocolSha256(dataset: PublicAnalystBenchmarkDataset): string {
  return sha256Digest(
    JSON.stringify({
      dataset,
      systemPrompt: publicBenchmarkSystemPrompt(dataset),
      transport: {
        attempts: 1,
        jsonMode: true,
        thinking: 'disabled',
      },
      traceProjectionAttributeByteCaps: TRACE_PROJECTION_ATTRIBUTE_BYTE_CAPS,
      evidence: {
        location: 'model-selected-positive-integer-assistant-step',
        uri: 'deterministic-trace-uri',
        excerpt: `exact-action-prefix-${MAX_ASSISTANT_STEP_EVIDENCE_EXCERPT_CHARACTERS}`,
      },
    }),
  )
}

async function prepareSingleTraceContext(
  store: TraceAnalysisStore,
  context: { signal?: AbortSignal },
): Promise<string | undefined> {
  const storeContext = context.signal ? { signal: context.signal } : undefined
  const overview = await store.getOverview(undefined, storeContext)
  if (overview.total_traces !== 1 || overview.sample_trace_ids.length !== 1) {
    throw new Error(
      `public model benchmark requires exactly one trace, received ${overview.total_traces}`,
    )
  }
  const traceId = overview.sample_trace_ids[0]!
  for (const perAttributeByteCap of TRACE_PROJECTION_ATTRIBUTE_BYTE_CAPS) {
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

const AGENT_RX_PROMPT = `Analyze exactly one failed agent trajectory.
Find the first unrecoverable critical failure, not every later symptom.
Inspect the complete supplied trace data.
Emit zero findings only when the trace does not contain enough evidence.
Otherwise emit exactly one finding.
Its category MUST be exactly one of:
instruction-plan-adherence-failure
invention-of-new-information
invalid-invocation
misinterpretation-of-tool-output-handoff-failure
intent-plan-misalignment
underspecified-user-intent
intent-not-supported
guardrails-triggered
system-failure
inconclusive
Its step is the positive integer n from the first unrecoverable assistant span named step-<n>.`

export const CODE_TRACE_BENCH_ANALYST_PROMPT = `Analyze exactly one coding-agent trajectory and its attached final verification.
Your task is the CodeTraceBench incorrect-step task: identify every wrong state-changing action, bad hypothesis that drives an action, and regression.
An incorrect step remains incorrect when the agent later recovers or the final verification passes.
Inspect the complete supplied trace data.
Use the final-verification outcome as evidence about the final state, not as a rule for whether earlier steps were incorrect.
For each candidate, inspect the assistant action and its following observation.
Label a failed command when the assistant caused it through a wrong action or unsupported hypothesis.
Label the later corrective action only when that action is itself wrong.
Do not label a diagnostic probe merely because it exposes an earlier defect.
Do not label a redundant but correct read or search; CodeTraceBench scores unuseful steps separately, and this run scores incorrect steps only.
Do not label a step solely because final verification failed.
When final verification is unavailable, use only directly observed trajectory evidence.
Emit one finding per incorrect assistant step.
Each finding's step MUST be the positive integer n from an existing assistant LLM span named step-<n>.
Never select an EVALUATOR, TOOL, CHAIN, final-verification, benchmark-verification, or message-<n> span.
Before emitting a finding, inspect its candidate span's attributes.content and describe only the action shown there.
When the trajectory has no incorrect steps, return an empty findings array.`

function trajectoryIdFromCaseId(dataset: PublicAnalystBenchmarkDataset, caseId: string): string {
  const prefix = dataset === 'agentrx' ? 'agentrx:' : 'codetrace:'
  if (!caseId.startsWith(prefix) || caseId.length === prefix.length) {
    throw new Error(`unexpected ${dataset} benchmark case id '${caseId}'`)
  }
  return caseId.slice(prefix.length)
}
