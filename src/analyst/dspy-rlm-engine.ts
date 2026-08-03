import {
  type ExternalOptimizerModelCall,
  type ExternalOptimizerModelExecutionObservation,
  type ExternalOptimizerModelProxy,
  type ExternalOptimizerRunnerCommand,
  removeCredentialEnvironment,
} from '../campaign/external-optimizer-contracts'
import { startExternalOptimizerModelProxy } from '../campaign/external-optimizer-model-proxy'
import { runWithCleanup } from '../campaign/external-optimizer-resources'
import { runExternalOptimizerProcess } from '../campaign/external-optimizer-subprocess'
import type { CostReceiptInput, CustomTokenPricing } from '../cost-ledger'
import { resolveModelPricing } from '../metrics'
import type { TraceAnalysisEngine, TraceAnalysisEngineResult } from './engine'
import { type RawAnalystFinding, RawAnalystFindingSchema } from './finding-signature'
import { startTraceToolCallback } from './trace-tool-callback'

const DEFAULT_TIMEOUT_MS = 10 * 60_000
// 4096 is below what current coding models emit for a full findings array:
// glm-5.2 through an OpenAI-compatible gateway returns 8192 and the request is
// rejected outright (`502 — provider reported 8192 completion tokens,
// exceeding requested limit 4096`), so the default failed 2/2 smoke cases
// before any analysis ran. The cap exists to bound spend, and `maxCostUsd`
// already does that directly, so it starts above what a real completion needs.
const DEFAULT_MODEL_OUTPUT_TOKENS = 16_384
const DEFAULT_MAX_COST_USD = 1
const MAX_MODEL_REQUEST_BYTES = 16 * 1024 * 1024
const MAX_MODEL_RESPONSE_BYTES = 4 * 1024 * 1024
const BRIDGE_MODULE = 'agent_eval_rpc.dspy_rlm_bridge'
/** Bumped whenever this engine's execution behavior changes. */
const DSPY_RLM_ENGINE_VERSION = '1.0.0'

export interface DspyRlmTraceEngineOptions {
  baseUrl: string
  apiKey: string
  model: string
  /** Exact provider rates. Required when the model is absent from the pricing table. */
  pricing?: CustomTokenPricing
  /** Maximum provider spend for one investigation. Default: 1 USD. */
  maxCostUsd?: number
  /** Controller response cap. Default: 16384. */
  maxOutputTokens?: number
  /**
   * Thinking tokens one controller turn may bill on top of its completion.
   * A reasoning model bills these beyond `maxOutputTokens`, so the cost
   * reservation must cover them. Default: four times the completion cap.
   */
  maxReasoningTokens?: number
  /**
   * How the controller's reasoning and code fields are obtained.
   *
   * `tolerant` parses marker output strictly first, then recovers the fields
   * deterministically from prose plus a fenced code block — the shape coding
   * models naturally emit — at no extra model cost. `two-step` extracts with a
   * second call per turn. `chat` accepts marker output only. Default:
   * `tolerant`.
   */
  controlAdapter?: 'chat' | 'two-step' | 'tolerant'
  /** Python command used to load agent-eval-rpc[dspy]. Default: python. */
  runner?: ExternalOptimizerRunnerCommand
  /** Whole investigation deadline. Default: 10 minutes. */
  timeoutMs?: number
}

/** Use the official DSPy RLM as a bounded recursive trace-analysis engine. */
export function createDspyRlmTraceEngine(options: DspyRlmTraceEngineOptions): TraceAnalysisEngine {
  assertOptions(options)
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MODEL_OUTPUT_TOKENS
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new TypeError('DSPy RLM maxOutputTokens must be a positive safe integer')
  }
  const controlAdapter = options.controlAdapter ?? 'tolerant'
  const maxReasoningTokens = options.maxReasoningTokens ?? maxOutputTokens * 4
  if (!Number.isSafeInteger(maxReasoningTokens) || maxReasoningTokens < 0) {
    throw new TypeError('DSPy RLM maxReasoningTokens must be a non-negative safe integer')
  }
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('DSPy RLM timeoutMs must be a positive safe integer')
  }
  const maxCostUsd = options.maxCostUsd ?? DEFAULT_MAX_COST_USD
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    throw new TypeError('DSPy RLM maxCostUsd must be positive and finite')
  }
  const pricing = options.pricing ?? pricingForModel(options.model)

  const runner = sanitizedRunner(options.runner)
  return {
    id: 'dspy-rlm',
    description: 'Official DSPy RLM with bounded trace tools and metered model calls.',
    model: options.model,
    version: DSPY_RLM_ENGINE_VERSION,
    executionConfig: {
      bridge_module: BRIDGE_MODULE,
      base_url: options.baseUrl,
      model: options.model,
      api_key_provided: true,
      pricing: { ...pricing },
      max_cost_usd: maxCostUsd,
      max_output_tokens: maxOutputTokens,
      max_reasoning_tokens: maxReasoningTokens,
      control_adapter: controlAdapter,
      timeout_ms: timeoutMs,
      max_request_bytes: MAX_MODEL_REQUEST_BYTES,
      max_response_bytes: MAX_MODEL_RESPONSE_BYTES,
      runner: runner ? 'caller-supplied' : 'default',
      runner_command: runner?.command ?? null,
    },
    async analyze(request) {
      const callback = await startTraceToolCallback({
        tools: request.tools,
        maxCalls: request.limits.maxToolCalls,
        ...(request.signal ? { signal: request.signal } : {}),
      })
      let modelProxy: ExternalOptimizerModelProxy | undefined
      const modelExecutions: ExternalOptimizerModelExecutionObservation[] = []
      const result = await runWithCleanup({
        label: 'DSPy RLM trace-analysis resources',
        run: async () => {
          modelProxy = await startExternalOptimizerModelProxy({
            call: dspyModelCall(options, pricing),
            callRef: `dspy-rlm:${options.model}:${new URL(options.baseUrl).origin}`,
            recordExecution: (observation) => {
              modelExecutions.push(structuredClone(observation))
            },
            model: options.model,
            budget: {
              maxCostUsd,
              maxRequests: request.limits.maxIterations + request.limits.maxLlmCalls + 1,
              maxRequestBytes: MAX_MODEL_REQUEST_BYTES,
              maxResponseBytes: MAX_MODEL_RESPONSE_BYTES,
              maxOutputTokensPerRequest: maxOutputTokens,
              maxReasoningTokensPerRequest: maxReasoningTokens,
              requestTimeoutMs: timeoutMs,
              pricing,
            },
            costLedger: request.costLedger,
            channel: 'analyst',
            phase: request.costPhase,
            actor: request.analystId,
            ...(request.costTags ? { tags: request.costTags } : {}),
            ...(request.signal ? { signal: request.signal } : {}),
          })
          request.log?.('trace analyst engine started', {
            engine: 'dspy-rlm',
            model: options.model,
            tools: request.tools.map((tool) => tool.name),
            limits: request.limits,
          })
          const raw = await runExternalOptimizerProcess<unknown>({
            label: 'DSPy RLM trace analysis',
            tempPrefix: 'agent-eval-dspy-rlm-',
            module: BRIDGE_MODULE,
            input: {
              operation: 'analyze',
              question: request.question,
              instructions: request.instructions,
              modelProxy: {
                baseUrl: modelProxy.baseUrl,
                apiKey: modelProxy.apiKey,
                model: options.model,
                maxOutputTokens,
              },
              toolCallback: {
                url: callback.url,
                token: callback.token,
              },
              toolSpecs: request.tools.map(({ name, description, parameters }) => ({
                name,
                description,
                parameters,
              })),
              controlAdapter,
              limits: {
                maxIterations: request.limits.maxIterations,
                maxLlmCalls: request.limits.maxLlmCalls,
                maxOutputChars: request.limits.maxOutputChars,
              },
            },
            ...(runner ? { runner } : {}),
            timeoutMs,
            ...(request.signal ? { signal: request.signal } : {}),
          })
          const parsed = parseBridgeOutput(raw, (index, reason) => {
            request.log?.('finding rejected: bridge row failed schema validation', {
              engine: 'dspy-rlm',
              index,
              reason,
            })
          })
          const successfulCompletions = modelProxy.successfulCompletions()
          const requestAttempts = modelProxy.requestAttempts()
          if (parsed.modelCalls !== successfulCompletions) {
            throw new Error(
              `DSPy RLM reported ${parsed.modelCalls} model calls, but the provider proxy recorded ${successfulCompletions}`,
            )
          }
          modelProxy.assertExecutionComplete()
          return {
            ...parsed,
            toolCalls: callback.calls(),
            runtime: {
              ...parsed.runtime,
              modelRequestAttempts: requestAttempts,
              modelSuccessfulCompletions: successfulCompletions,
              modelExecutions,
            },
          } satisfies TraceAnalysisEngineResult
        },
        cleanup: async () => {
          const results = await Promise.allSettled([
            ...(modelProxy ? [modelProxy.close()] : []),
            callback.close(),
          ])
          const errors = results.flatMap((entry) =>
            entry.status === 'rejected' ? [entry.reason] : [],
          )
          if (errors.length > 0) {
            throw new AggregateError(errors, 'DSPy RLM resource cleanup failed')
          }
        },
      })
      request.log?.('trace analyst engine completed', {
        engine: 'dspy-rlm',
        model_calls: result.modelCalls,
        model_request_attempts: result.runtime.modelRequestAttempts,
        tool_calls: result.toolCalls,
        findings: result.findings.length,
      })
      return result
    },
  }
}

function parseBridgeOutput(
  value: unknown,
  onRejectedFinding: (index: number, reason: string) => void,
): Omit<TraceAnalysisEngineResult, 'toolCalls'> {
  if (!isRecord(value)) throw new Error('DSPy RLM bridge output must be an object')
  if (typeof value.answer !== 'string' || !value.answer.trim()) {
    throw new Error('DSPy RLM bridge returned no answer')
  }
  if (!Array.isArray(value.findings)) {
    throw new Error('DSPy RLM bridge findings must be an array')
  }
  // Findings are model output: one malformed row is model noise, not a bridge
  // fault, and the rest of the paid investigation must survive it. Rejected
  // rows are logged per row and counted in runtime.rejectedFindings.
  let rejectedFindings = 0
  const findings: RawAnalystFinding[] = []
  value.findings.forEach((finding, index) => {
    const parsed = RawAnalystFindingSchema.safeParse(finding)
    if (!parsed.success) {
      rejectedFindings += 1
      onRejectedFinding(
        index,
        parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; '),
      )
      return
    }
    findings.push(parsed.data)
  })
  if (!Array.isArray(value.trajectory)) {
    throw new Error('DSPy RLM bridge trajectory must be an array')
  }
  if (!Number.isSafeInteger(value.modelCalls) || (value.modelCalls as number) <= 0) {
    throw new Error('DSPy RLM bridge modelCalls must be a positive safe integer')
  }
  if (!isRecord(value.runtime)) {
    throw new Error('DSPy RLM bridge runtime must be an object')
  }
  return {
    answer: value.answer,
    findings,
    trajectory: value.trajectory,
    modelCalls: value.modelCalls as number,
    runtime: { ...value.runtime, rejectedFindings },
  }
}

function assertOptions(options: DspyRlmTraceEngineOptions): void {
  for (const [name, value] of [
    ['baseUrl', options.baseUrl],
    ['apiKey', options.apiKey],
    ['model', options.model],
  ] as const) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new TypeError(`DSPy RLM ${name} must be a non-empty string`)
    }
  }
  let baseUrl: URL
  try {
    baseUrl = new URL(options.baseUrl)
  } catch {
    throw new TypeError('DSPy RLM baseUrl must be an HTTP(S) URL')
  }
  if (
    (baseUrl.protocol !== 'http:' && baseUrl.protocol !== 'https:') ||
    baseUrl.username ||
    baseUrl.password ||
    baseUrl.search ||
    baseUrl.hash
  ) {
    throw new TypeError(
      'DSPy RLM baseUrl must be an HTTP(S) URL without credentials, query, or fragment',
    )
  }
}

function dspyModelCall(
  options: DspyRlmTraceEngineOptions,
  pricing: CustomTokenPricing,
): ExternalOptimizerModelCall {
  return async (request) => {
    const started = performance.now()
    const baseUrl = options.baseUrl.replace(/\/+$/, '')
    const path = /\/v\d+$/.test(baseUrl) ? request.path.replace(/^\/v1/, '') : request.path
    try {
      const response = await fetch(`${baseUrl}${path}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(request.body),
        signal: request.signal,
        redirect: 'error',
      })
      return {
        succeeded: true,
        response,
        receipt: await dspyResponseReceipt(response.clone(), request.model, pricing),
        execution: {
          kind: 'agent-eval/dspy-rlm-model-call',
          model: request.model,
          path: request.path,
          status: response.status,
          durationMs: performance.now() - started,
        },
      }
    } catch (error) {
      return {
        succeeded: false,
        error: error instanceof Error ? error.message : String(error),
        receipt: unknownDspyReceipt(request.model),
        execution: {
          kind: 'agent-eval/dspy-rlm-model-call',
          model: request.model,
          path: request.path,
          error: error instanceof Error ? error.name : 'Error',
          durationMs: performance.now() - started,
        },
      }
    }
  }
}

async function dspyResponseReceipt(
  response: Response,
  model: string,
  pricing: CustomTokenPricing,
): Promise<CostReceiptInput> {
  let value: unknown
  try {
    value = await response.json()
  } catch {
    return unknownDspyReceipt(model)
  }
  if (!isRecord(value) || !isRecord(value.usage)) return unknownDspyReceipt(model)
  const inputTokens = value.usage.prompt_tokens ?? value.usage.input_tokens
  const outputTokens = value.usage.completion_tokens ?? value.usage.output_tokens
  if (
    !Number.isSafeInteger(inputTokens) ||
    (inputTokens as number) < 0 ||
    !Number.isSafeInteger(outputTokens) ||
    (outputTokens as number) < 0
  ) {
    return unknownDspyReceipt(model)
  }
  const actualCostUsd = value.usage.cost
  return {
    model,
    inputTokens: inputTokens as number,
    outputTokens: outputTokens as number,
    ...(typeof actualCostUsd === 'number' && Number.isFinite(actualCostUsd) && actualCostUsd >= 0
      ? { actualCostUsd }
      : { customTokenPricing: pricing }),
  }
}

function unknownDspyReceipt(model: string): CostReceiptInput {
  return {
    model,
    inputTokens: 0,
    outputTokens: 0,
    usageUnknown: true,
    costUnknown: true,
  }
}

function pricingForModel(model: string): CustomTokenPricing {
  const pricing = resolveModelPricing(model)
  if (!pricing) {
    throw new Error(
      `no pricing is configured for '${model}'; provide DspyRlmTraceEngineOptions.pricing`,
    )
  }
  return {
    inputUsdPerMillion: pricing.input * 1_000,
    outputUsdPerMillion: pricing.output * 1_000,
  }
}

function sanitizedRunner(
  runner: ExternalOptimizerRunnerCommand | undefined,
): ExternalOptimizerRunnerCommand | undefined {
  if (!runner) return undefined
  return {
    ...(runner.command ? { command: runner.command } : {}),
    ...(runner.args ? { args: runner.args } : {}),
    ...(runner.env ? { env: removeCredentialEnvironment(runner.env) } : {}),
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
