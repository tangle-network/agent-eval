import {
  type ExternalOptimizerModelProxy,
  type ExternalOptimizerRunnerCommand,
  removeCredentialEnvironment,
} from '../campaign/external-optimizer-contracts'
import { startExternalOptimizerModelProxy } from '../campaign/external-optimizer-model-proxy'
import { runWithCleanup } from '../campaign/external-optimizer-resources'
import { runExternalOptimizerProcess } from '../campaign/external-optimizer-subprocess'
import type { CustomTokenPricing } from '../cost-ledger'
import { resolveModelPricing } from '../metrics'
import type { TraceAnalysisEngine, TraceAnalysisEngineResult } from './engine'
import { type RawAnalystFinding, RawAnalystFindingSchema } from './finding-signature'
import { startTraceToolCallback } from './trace-tool-callback'

const DEFAULT_TIMEOUT_MS = 10 * 60_000
const DEFAULT_MODEL_OUTPUT_TOKENS = 4_096
const DEFAULT_MAX_COST_USD = 1
const MAX_MODEL_REQUEST_BYTES = 16 * 1024 * 1024
const MAX_MODEL_RESPONSE_BYTES = 4 * 1024 * 1024
const BRIDGE_MODULE = 'agent_eval_rpc.dspy_rlm_bridge'

export interface DspyRlmTraceEngineOptions {
  baseUrl: string
  apiKey: string
  model: string
  /** Exact provider rates. Required when the model is absent from the pricing table. */
  pricing?: CustomTokenPricing
  /** Maximum provider spend for one investigation. Default: 1 USD. */
  maxCostUsd?: number
  /** Controller response cap. Default: 4096. */
  maxOutputTokens?: number
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
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) {
    throw new TypeError('DSPy RLM timeoutMs must be a positive safe integer')
  }
  const maxCostUsd = options.maxCostUsd ?? DEFAULT_MAX_COST_USD
  if (!Number.isFinite(maxCostUsd) || maxCostUsd <= 0) {
    throw new TypeError('DSPy RLM maxCostUsd must be positive and finite')
  }
  const pricing = options.pricing ?? pricingForModel(options.model)

  return {
    id: 'dspy-rlm',
    description: 'Official DSPy RLM with bounded trace tools and metered model calls.',
    model: options.model,
    async analyze(request) {
      const callback = await startTraceToolCallback({
        tools: request.tools,
        maxCalls: request.limits.maxToolCalls,
        ...(request.signal ? { signal: request.signal } : {}),
      })
      let modelProxy: ExternalOptimizerModelProxy | undefined
      const result = await runWithCleanup({
        label: 'DSPy RLM trace-analysis resources',
        run: async () => {
          modelProxy = await startExternalOptimizerModelProxy({
            upstreamBaseUrl: options.baseUrl,
            upstreamApiKey: options.apiKey,
            model: options.model,
            budget: {
              maxCostUsd,
              maxRequests: request.limits.maxIterations + request.limits.maxLlmCalls + 1,
              maxRequestBytes: MAX_MODEL_REQUEST_BYTES,
              maxResponseBytes: MAX_MODEL_RESPONSE_BYTES,
              maxOutputTokensPerRequest: maxOutputTokens,
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
          const runner = sanitizedRunner(options.runner)
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
          return {
            ...parsed,
            toolCalls: callback.calls(),
            runtime: {
              ...parsed.runtime,
              modelRequestAttempts: requestAttempts,
              modelSuccessfulCompletions: successfulCompletions,
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
        parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; '),
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
