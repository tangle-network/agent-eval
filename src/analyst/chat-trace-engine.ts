/**
 * A `TraceAnalysisEngine` that runs entirely inside Node against a
 * caller-owned `ChatClient`.
 *
 * The other engine in this package, `createDspyRlmTraceEngine`, reaches the
 * DSPy RLM through a Python subprocess. That made every model-backed analyst
 * unreachable for a consumer that already owns a model seam and no Python:
 * `createTraceAnalyst` requires an engine, the only exported constructor
 * required a Python runner, so `buildDefaultAnalystRegistry()` registered the
 * deterministic analyst alone and `analystsFromRegistry` refused the result.
 *
 * This engine closes that path. It drives the same investigation contract —
 * bounded trace tools, a prose answer, a strict findings array — with native
 * function calls over the transport the caller already bound with
 * `createChatClient`. A caller holding a bare
 * `(request: LlmCallRequest) => Promise<LlmCallResult>` adapts it in one line:
 *
 *   createChatClient({ transport: 'custom', chat: call, defaultModel, maximumAttempts })
 *
 * agent-eval still executes no paid model and holds no provider credential.
 * Every call goes through `paidChat`, so the shared cost ledger reserves the
 * priced maximum before the call and settles the receipt after it.
 *
 * Shape of one investigation:
 *   1. Investigation turns. The model reads the trace store through the tools
 *      its analyst kind was given. A turn that requests no tool ends the
 *      phase; an exhausted iteration or tool budget also ends it.
 *   2. One report turn. The model returns `{ answer, findings }` as JSON,
 *      decoded by the same `decodeRawFindingArray` the Python bridge uses, so
 *      a row this engine accepts is a row that engine could report.
 */

import { z } from 'zod'
import { paidChat } from '../chat-json-call'
import type { CustomTokenPricing } from '../cost-ledger'
import {
  extractJsonPayload,
  type LlmCallRequest,
  type LlmMessage,
  type LlmThinkingMode,
  type LlmToolCall,
  type LlmToolDefinition,
} from '../llm-client'
import type { TraceAnalysisToolDescriptor } from '../trace-analyst/tools'
import type { ChatClient } from './chat-client'
import type {
  TraceAnalysisEngine,
  TraceAnalysisEngineRequest,
  TraceAnalysisEngineResult,
} from './engine'
import { decodeRawFindingArray } from './finding-codec'
import { RawAnalystFindingSchema } from './finding-signature'

/** Bumped whenever this engine's execution behavior changes. */
const CHAT_TRACE_ENGINE_VERSION = '1.0.0'
const ENGINE_ID = 'chat-trace'

/**
 * Completion cap for one turn. 4096 is below what current coding models emit
 * for a full findings array — glm-5.2 through an OpenAI-compatible gateway
 * returns 8192 and the request is rejected outright — so the default starts
 * above what a real report needs. Spend is bounded by the cost ledger, not by
 * this number.
 */
const DEFAULT_MODEL_OUTPUT_TOKENS = 16_384

/** Marker appended to a tool result cut down to the retained-output budget. */
const TRUNCATION_MARKER = '\n…[truncated to the analyst maxOutputChars budget]'

export interface ChatTraceEngineOptions {
  /**
   * Caller-owned transport. Build it with `createChatClient`; agent-eval never
   * receives the provider credential.
   */
  chat: ChatClient
  /** Model for every call. Defaults to the client's `defaultModel`. */
  model?: string
  /** Endpoint rates used when the transport reports no billed amount. */
  pricing?: CustomTokenPricing
  /** Completion cap per turn. Default: 16384. */
  maxOutputTokens?: number
  /** Sampling temperature. Omitted from the request when absent. */
  temperature?: number
  /** Provider reasoning mode. Omitted when the provider default should apply. */
  thinking?: LlmThinkingMode
  /** Per-call deadline handed to the transport. */
  requestTimeoutMs?: number
  /**
   * How the report turn asks for structured output.
   *
   * `json-object` sends JSON mode, which every OpenAI-compatible endpoint
   * accepts, and relies on the finding grammar the analyst kind already puts
   * in its instructions. `json-schema` sends the generated response schema as
   * well, which stricter endpoints honour and older ones reject. Default:
   * `json-object`.
   */
  reportFormat?: 'json-object' | 'json-schema'
}

/**
 * The report envelope. Its `findings` rows are generated from
 * `RawAnalystFindingSchema`, so the schema offered to a provider and the
 * decoder that accepts the answer cannot drift apart.
 */
function buildReportJsonSchema(): { name: string; schema: Record<string, unknown> } {
  const row = z.toJSONSchema(RawAnalystFindingSchema, { target: 'draft-7' }) as Record<
    string,
    unknown
  >
  delete row.$schema
  return {
    name: 'trace_analysis_report',
    schema: {
      type: 'object',
      additionalProperties: false,
      required: ['answer', 'findings'],
      properties: {
        answer: { type: 'string', description: 'Direct prose answer to the question.' },
        findings: { type: 'array', items: row },
      },
    },
  }
}

const REPORT_JSON_SCHEMA = buildReportJsonSchema()

/**
 * Run bounded recursive trace analysis in-process over a caller-owned chat
 * transport. No Python, no subprocess, no loopback proxy.
 */
export function createChatTraceEngine(options: ChatTraceEngineOptions): TraceAnalysisEngine {
  const model = resolveModel(options)
  const maxOutputTokens = options.maxOutputTokens ?? DEFAULT_MODEL_OUTPUT_TOKENS
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens <= 0) {
    throw new TypeError('chat trace engine maxOutputTokens must be a positive safe integer')
  }
  if (
    options.temperature !== undefined &&
    (!Number.isFinite(options.temperature) || options.temperature < 0)
  ) {
    throw new TypeError('chat trace engine temperature must be a non-negative finite number')
  }
  if (
    options.requestTimeoutMs !== undefined &&
    (!Number.isSafeInteger(options.requestTimeoutMs) || options.requestTimeoutMs <= 0)
  ) {
    throw new TypeError('chat trace engine requestTimeoutMs must be a positive safe integer')
  }
  const reportFormat = options.reportFormat ?? 'json-object'
  if (reportFormat !== 'json-object' && reportFormat !== 'json-schema') {
    throw new TypeError(`chat trace engine reportFormat must be json-object or json-schema`)
  }

  return {
    id: ENGINE_ID,
    description:
      'In-process recursive trace analysis over a caller-owned ChatClient with native tool calls.',
    model,
    version: CHAT_TRACE_ENGINE_VERSION,
    executionConfig: {
      kind: ENGINE_ID,
      model,
      transport: options.chat.transport,
      maximum_attempts: options.chat.maximumAttempts ?? null,
      pricing: options.pricing ? { ...options.pricing } : null,
      max_output_tokens: maxOutputTokens,
      temperature: options.temperature ?? null,
      thinking: options.thinking ?? null,
      request_timeout_ms: options.requestTimeoutMs ?? null,
      report_format: reportFormat,
      report_schema_name: REPORT_JSON_SCHEMA.name,
    },
    analyze: (request) => analyze(request, { ...options, model, maxOutputTokens, reportFormat }),
  }
}

interface ResolvedOptions extends ChatTraceEngineOptions {
  model: string
  maxOutputTokens: number
  reportFormat: 'json-object' | 'json-schema'
}

async function analyze(
  request: TraceAnalysisEngineRequest,
  options: ResolvedOptions,
): Promise<TraceAnalysisEngineResult> {
  // One model call is spent on the report, so a budget of one call would buy
  // an answer with no investigation behind it. Refuse instead of pretending.
  if (request.limits.maxLlmCalls < 2) {
    throw new Error(
      `chat trace engine reserves one model call for the report, so maxLlmCalls must be at least 2 (analyst '${request.analystId}' declared ${request.limits.maxLlmCalls})`,
    )
  }
  const toolsByName = new Map(request.tools.map((tool) => [tool.name, tool]))
  if (toolsByName.size !== request.tools.length) {
    throw new Error(`chat trace engine received duplicate tool names for '${request.analystId}'`)
  }
  const toolDefinitions: LlmToolDefinition[] = request.tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }))
  const investigationTurns = Math.max(
    1,
    Math.min(request.limits.maxIterations, request.limits.maxLlmCalls - 1),
  )

  const messages: LlmMessage[] = [
    { role: 'system', content: systemPrompt(request, investigationTurns) },
  ]
  if (request.taskInputs) {
    messages.push({ role: 'user', content: renderTaskInputs(request.taskInputs) })
  }
  messages.push({ role: 'user', content: request.question })

  request.log?.('trace analyst engine started', {
    engine: ENGINE_ID,
    model: options.model,
    transport: options.chat.transport,
    tools: request.tools.map((tool) => tool.name),
    limits: request.limits,
  })

  const trajectory: unknown[] = []
  const servedModels = new Set<string>()
  let modelCalls = 0
  let toolCalls = 0
  let truncatedToolResults = 0
  let toolBudgetExhausted = false
  let turnsUsed = 0
  let stoppedOnAnswer = false

  for (let turn = 0; turn < investigationTurns; turn++) {
    turnsUsed = turn + 1
    const response = await callModel(request, options, {
      messages,
      tools: toolDefinitions,
      toolChoice: 'auto',
      purpose: 'investigation',
    })
    modelCalls += 1
    servedModels.add(response.servedModel ?? 'unreported')
    const requested = response.toolCalls ?? []
    messages.push({
      role: 'assistant',
      content: response.content,
      ...(requested.length > 0 ? { toolCalls: requested } : {}),
    })
    trajectory.push({
      turn: turnsUsed,
      phase: 'investigation',
      content: response.content,
      tool_calls: requested.map((call) => ({ id: call.id, name: call.name })),
      finish_reason: response.finishReason ?? null,
    })
    if (requested.length === 0) {
      stoppedOnAnswer = true
      break
    }
    for (const call of requested) {
      if (toolCalls >= request.limits.maxToolCalls) {
        toolBudgetExhausted = true
        // Every requested id still needs an answer: a provider rejects the
        // next turn when one tool call is left unanswered.
        messages.push(toolMessage(call, exhaustedToolBudget(request.limits.maxToolCalls)))
        continue
      }
      toolCalls += 1
      const executed = await executeTool(call, toolsByName, request)
      if (executed.truncated) truncatedToolResults += 1
      messages.push(toolMessage(call, executed.payload))
      trajectory.push({
        turn: turnsUsed,
        phase: 'tool',
        name: call.name,
        ok: executed.ok,
        truncated: executed.truncated,
        result_chars: executed.payload.length,
      })
    }
    if (toolBudgetExhausted) break
  }

  messages.push({ role: 'user', content: reportPrompt(options.reportFormat) })
  const report = await callModel(request, options, {
    messages,
    purpose: 'report',
    json: options.reportFormat,
  })
  modelCalls += 1
  servedModels.add(report.servedModel ?? 'unreported')
  trajectory.push({
    turn: turnsUsed + 1,
    phase: 'report',
    content: report.content,
    finish_reason: report.finishReason ?? null,
  })

  const parsed = parseReport(report.content, request.analystId, (index, reason) => {
    request.log?.('finding rejected: report row failed schema validation', {
      engine: ENGINE_ID,
      index,
      reason,
    })
  })

  const result: TraceAnalysisEngineResult = {
    answer: parsed.answer,
    findings: parsed.findings,
    trajectory,
    modelCalls,
    toolCalls,
    runtime: {
      engine: ENGINE_ID,
      model: options.model,
      transport: options.chat.transport,
      report_format: options.reportFormat,
      investigation_turns: turnsUsed,
      investigation_stopped_on_answer: stoppedOnAnswer,
      tool_budget_exhausted: toolBudgetExhausted,
      truncated_tool_results: truncatedToolResults,
      rejected_findings: parsed.rejectedFindings,
      // A gateway can answer `model: X` from another model on HTTP 200, so the
      // ids the provider echoed travel with the result as evidence.
      served_models: [...servedModels].sort(),
      task_inputs: request.taskInputs ? 'prompt-delivered' : 'none',
    },
  }
  request.log?.('trace analyst engine completed', {
    engine: ENGINE_ID,
    model_calls: result.modelCalls,
    tool_calls: result.toolCalls,
    findings: result.findings.length,
  })
  return result
}

interface ModelTurn {
  content: string
  toolCalls?: LlmToolCall[]
  servedModel?: string | null
  finishReason?: string | null
}

async function callModel(
  request: TraceAnalysisEngineRequest,
  options: ResolvedOptions,
  turn: {
    messages: LlmMessage[]
    tools?: LlmToolDefinition[]
    toolChoice?: LlmCallRequest['toolChoice']
    purpose: 'investigation' | 'report'
    json?: 'json-object' | 'json-schema'
  },
): Promise<ModelTurn> {
  const chatRequest: LlmCallRequest = {
    model: options.model,
    // The transport may mutate what it is handed; the conversation is ours.
    messages: turn.messages.map((message) => ({ ...message })),
    maxTokens: options.maxOutputTokens,
    ...(turn.tools && turn.tools.length > 0
      ? { tools: turn.tools, ...(turn.toolChoice ? { toolChoice: turn.toolChoice } : {}) }
      : {}),
    ...(turn.json ? { jsonMode: true } : {}),
    ...(turn.json === 'json-schema' ? { jsonSchema: REPORT_JSON_SCHEMA } : {}),
    ...(options.temperature === undefined ? {} : { temperature: options.temperature }),
    ...(options.thinking === undefined ? {} : { thinking: options.thinking }),
    ...(options.requestTimeoutMs === undefined ? {} : { timeoutMs: options.requestTimeoutMs }),
  }
  const paid = await paidChat({
    chat: options.chat,
    request: chatRequest,
    ledger: request.costLedger,
    channel: 'analyst',
    phase: request.costPhase,
    actor: request.analystId,
    ...(request.costTags ? { tags: request.costTags } : {}),
    ...(options.pricing ? { pricing: options.pricing } : {}),
    ...(request.signal ? { signal: request.signal } : {}),
  })
  if (!paid.succeeded) {
    // The transport already spent its own attempts. A failure here ends the
    // investigation: continuing would report an answer the model never gave.
    throw new Error(
      `chat trace engine ${turn.purpose} call failed for '${request.analystId}': ${paid.error.message}`,
      { cause: paid.error },
    )
  }
  return {
    content: paid.response.content,
    ...(paid.response.toolCalls ? { toolCalls: paid.response.toolCalls } : {}),
    ...(paid.response.servedModel === undefined ? {} : { servedModel: paid.response.servedModel }),
    ...(paid.response.finishReason === undefined
      ? {}
      : { finishReason: paid.response.finishReason }),
  }
}

interface ExecutedTool {
  ok: boolean
  truncated: boolean
  payload: string
}

async function executeTool(
  call: LlmToolCall,
  toolsByName: ReadonlyMap<string, TraceAnalysisToolDescriptor>,
  request: TraceAnalysisEngineRequest,
): Promise<ExecutedTool> {
  const descriptor = toolsByName.get(call.name)
  if (!descriptor) {
    return {
      ok: false,
      truncated: false,
      payload: toolError(
        `unknown tool '${call.name}'; available tools are ${[...toolsByName.keys()].sort().join(', ')}`,
      ),
    }
  }
  let args: unknown
  try {
    args = call.argumentsJson.trim() === '' ? {} : JSON.parse(call.argumentsJson)
  } catch (error) {
    return {
      ok: false,
      truncated: false,
      payload: toolError(
        `arguments for '${call.name}' were not JSON: ${messageOf(error)}. Send valid JSON arguments.`,
      ),
    }
  }
  try {
    const value = await descriptor.handler(
      args,
      request.signal ? { signal: request.signal } : undefined,
    )
    return truncateToolPayload(JSON.stringify(value ?? null), request.limits.maxOutputChars)
  } catch (error) {
    // A bounded store refuses an oversized or malformed read by design. That
    // refusal is the model's next instruction, not the run's failure.
    if (request.signal?.aborted) throw error
    request.log?.('trace tool failed', {
      engine: ENGINE_ID,
      analyst_id: request.analystId,
      tool: call.name,
      reason: messageOf(error),
    })
    return { ok: false, truncated: false, payload: toolError(messageOf(error)) }
  }
}

function truncateToolPayload(payload: string, maxOutputChars: number): ExecutedTool {
  if (payload.length <= maxOutputChars) return { ok: true, truncated: false, payload }
  const keep = Math.max(0, maxOutputChars - TRUNCATION_MARKER.length)
  return { ok: true, truncated: true, payload: `${payload.slice(0, keep)}${TRUNCATION_MARKER}` }
}

function toolMessage(call: LlmToolCall, content: string): LlmMessage {
  return { role: 'tool', toolCallId: call.id, content }
}

function toolError(reason: string): string {
  return JSON.stringify({ error: reason })
}

function exhaustedToolBudget(maxToolCalls: number): string {
  return toolError(
    `the trace-tool budget of ${maxToolCalls} calls is spent; answer from the evidence already read`,
  )
}

function systemPrompt(request: TraceAnalysisEngineRequest, investigationTurns: number): string {
  return [
    request.instructions.trim(),
    [
      'HOW THIS INVESTIGATION RUNS:',
      `- You have ${investigationTurns} investigation turns and at most ${request.limits.maxToolCalls} trace-tool calls.`,
      '- Call the trace tools to read the store. Never state a trace fact you did not read.',
      `- A tool result longer than ${request.limits.maxOutputChars} characters is truncated; narrow the query instead of asking again.`,
      '- A tool result carrying an "error" field is feedback: fix the call or take another route.',
      '- Answer with no tool call once you have the evidence. You are then asked for the final report.',
    ].join('\n'),
  ].join('\n\n')
}

function reportPrompt(reportFormat: 'json-object' | 'json-schema'): string {
  return [
    'Report now. Do not call any more tools.',
    'Return one JSON object with exactly two fields:',
    '  "answer": a direct prose answer to the question.',
    '  "findings": an array of findings in the schema above. Emit [] when there is nothing to report.',
    reportFormat === 'json-object'
      ? 'Return the object alone, with no surrounding prose and no code fence.'
      : 'Return the object in the response schema you were given.',
  ].join('\n')
}

function renderTaskInputs(taskInputs: Readonly<Record<string, unknown>>): string {
  // The engine contract forbids dropping structured inputs. This engine has no
  // code environment to bind them as variables, so they are delivered whole as
  // conversation material and the runtime record says which way they arrived.
  return [
    'TASK INPUTS — structured material delivered with the question, not fetched through tools:',
    JSON.stringify(taskInputs, null, 2),
  ].join('\n')
}

interface ParsedReport {
  answer: string
  findings: TraceAnalysisEngineResult['findings']
  rejectedFindings: number
}

function parseReport(
  content: string,
  analystId: string,
  onRejectedFinding: (index: number, reason: string) => void,
): ParsedReport {
  const envelope = coerceReportEnvelope(content, analystId)
  if (typeof envelope.answer !== 'string' || !envelope.answer.trim()) {
    throw new Error(`chat trace engine report for '${analystId}' carried no answer`)
  }
  // Findings are model output: one malformed row is model noise, not an engine
  // fault, and the rest of the paid investigation must survive it.
  const decoded = decodeRawFindingArray(envelope.findings)
  if (decoded.topLevelError !== undefined) {
    throw new Error(
      `chat trace engine report for '${analystId}' had a malformed findings array: ${decoded.topLevelError}`,
    )
  }
  for (const rejection of decoded.rejected) {
    onRejectedFinding(
      rejection.index,
      `${rejection.code}${rejection.path ? ` at ${rejection.path}` : ''}: ${rejection.message}`,
    )
  }
  return {
    answer: envelope.answer,
    findings: decoded.accepted,
    rejectedFindings: decoded.rejected.length,
  }
}

function coerceReportEnvelope(content: string, analystId: string): Record<string, unknown> {
  let value: unknown
  try {
    value = JSON.parse(extractJsonPayload(content))
  } catch (error) {
    throw new Error(`chat trace engine report for '${analystId}' was not JSON: ${messageOf(error)}`)
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`chat trace engine report for '${analystId}' was not a JSON object`)
  }
  return value as Record<string, unknown>
}

function resolveModel(options: ChatTraceEngineOptions): string {
  const model = options.model ?? options.chat.defaultModel
  if (typeof model !== 'string' || !model.trim() || model !== model.trim()) {
    throw new TypeError(
      'chat trace engine needs a model: pass ChatTraceEngineOptions.model or bind defaultModel on the ChatClient',
    )
  }
  return model
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
