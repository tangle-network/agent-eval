import { describe, expect, it } from 'vitest'
import { CostLedger } from '../cost-ledger'
import type { LlmToolCall } from '../llm-client'
import { otlpTextToTraceAnalysisStore } from '../trace-analyst/store-otlp'
import { type ChatRequest, type ChatResponse, createChatClient } from './chat-client'
import { createChatTraceEngine } from './chat-trace-engine'
import { buildDefaultAnalystRegistry } from './default-registry'
import type { TraceAnalysisEngineRequest } from './engine'
import { DEFAULT_TRACE_ANALYST_KINDS } from './kinds'
import { buildTraceToolsForGroup } from './tool-groups'

const MODEL = 'test-analysis-model'
const TRACE_ID = 'trace-alpha'
const SPAN_A = 'span-alpha-1'
const SPAN_B = 'span-alpha-2'
const EXCERPT_A = 'the deploy step read a stale manifest'
const EXCERPT_B = 'retry three aborted before the health check'

function otlpLine(spanId: string, content: string): string {
  return JSON.stringify({
    trace_id: TRACE_ID,
    span_id: spanId,
    parent_span_id: null,
    name: `assistant ${spanId}`,
    kind: 'LLM',
    start_time: '2026-08-01T00:00:00.000Z',
    end_time: '2026-08-01T00:00:01.000Z',
    status: 'OK',
    attributes: { content, 'openinference.span.kind': 'LLM' },
  })
}

function traceStore() {
  return otlpTextToTraceAnalysisStore(
    `${[otlpLine(SPAN_A, EXCERPT_A), otlpLine(SPAN_B, EXCERPT_B)].join('\n')}\n`,
  )
}

function spanUri(spanId: string): string {
  return `trace://${encodeURIComponent(TRACE_ID)}/span/${encodeURIComponent(spanId)}`
}

const REPORT_FINDINGS = [
  {
    severity: 'high',
    claim: 'The run failed because the deploy step consumed a stale manifest.',
    confidence: 0.9,
    evidence: [
      { uri: spanUri(SPAN_A), excerpt: EXCERPT_A },
      { uri: spanUri(SPAN_B), excerpt: EXCERPT_B },
    ],
  },
]

function reportBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    answer: 'The run failed on a stale manifest and never reached the health check.',
    findings: REPORT_FINDINGS,
    ...overrides,
  })
}

function response(over: Partial<ChatResponse> = {}): ChatResponse {
  return {
    content: '',
    usage: { promptTokens: 400, completionTokens: 120, totalTokens: 520, captured: true },
    costUsd: 0.002,
    model: MODEL,
    servedModel: MODEL,
    durationMs: 4,
    raw: {},
    ...over,
  }
}

function toolCall(id: string, name: string, args: unknown = {}): LlmToolCall {
  return { id, name, argumentsJson: JSON.stringify(args) }
}

/**
 * The transport a real consumer binds, driven by a scripted handler. Every
 * request the engine sends is retained so a test can assert on the exact
 * conversation the model was shown.
 */
function mockChat(handler: (req: ChatRequest, turn: number) => ChatResponse) {
  const requests: ChatRequest[] = []
  const client = createChatClient({
    transport: 'mock',
    defaultModel: MODEL,
    handler: async (req) => {
      requests.push(req)
      return handler(req, requests.length)
    },
  })
  return { client, requests }
}

/** Investigate with one tool call, then report. The default consumer shape. */
function investigateThenReport(req: ChatRequest): ChatResponse {
  if (req.jsonMode) return response({ content: reportBody() })
  const alreadyRead = req.messages.some((message) => message.role === 'tool')
  if (alreadyRead) return response({ content: 'I have enough evidence.' })
  return response({
    content: 'Reading the dataset overview first.',
    toolCalls: [toolCall('call-1', 'getDatasetOverview')],
  })
}

function engineRequest(over: Partial<TraceAnalysisEngineRequest> = {}): TraceAnalysisEngineRequest {
  return {
    analystId: 'failure-mode',
    question: 'Why did this run fail?',
    instructions: 'Investigate the trace store and report failures with cited evidence.',
    tools: buildTraceToolsForGroup('all', traceStore()),
    limits: { maxIterations: 4, maxLlmCalls: 4, maxToolCalls: 8, maxOutputChars: 10_000 },
    costLedger: new CostLedger(),
    costPhase: 'trace-analysis',
    ...over,
  }
}

describe('createChatTraceEngine', () => {
  it('constructs the full default analyst registry with no Python — regression: buildDefaultAnalystRegistry() registered only the deterministic analyst, so analystsFromRegistry refused it', () => {
    const { client } = mockChat(investigateThenReport)
    const registry = buildDefaultAnalystRegistry({
      engine: createChatTraceEngine({ chat: client }),
    })
    const ids = registry.list().map((entry) => entry.id)
    for (const kind of DEFAULT_TRACE_ANALYST_KINDS) expect(ids).toContain(kind.id)
    expect(ids).toContain('efficiency-behavioral')
    expect(ids).toHaveLength(DEFAULT_TRACE_ANALYST_KINDS.length + 1)
  })

  it('runs a default kind end to end through the registry in pure Node', async () => {
    const { client, requests } = mockChat(investigateThenReport)
    const registry = buildDefaultAnalystRegistry({
      engine: createChatTraceEngine({ chat: client }),
    })
    const result = await registry.run(
      'run-1',
      { traceStore: traceStore() },
      { only: ['failure-mode'] },
    )

    expect(result.per_analyst.map((entry) => [entry.analyst_id, entry.status])).toEqual([
      ['failure-mode', 'ok'],
    ])
    expect(result.findings).toHaveLength(1)
    const finding = result.findings[0]!
    expect(finding.analyst_id).toBe('failure-mode')
    expect(finding.evidence_refs.map((ref) => ref.uri)).toEqual([spanUri(SPAN_A), spanUri(SPAN_B)])
    expect(finding.metadata?.analysis_engine).toBe('chat-trace')
    expect(finding.metadata?.analysis_tool_calls).toBe(1)

    // Three calls: investigate, confirm, report. The tool result reached the model.
    expect(requests).toHaveLength(3)
    expect(requests[1]!.messages.some((message) => message.role === 'tool')).toBe(true)
    expect(requests[2]!.jsonMode).toBe(true)
    expect(requests[2]!.tools).toBeUndefined()
  })

  it('runs every model-backed default kind through one registry pass', async () => {
    const { client } = mockChat(investigateThenReport)
    const registry = buildDefaultAnalystRegistry({
      engine: createChatTraceEngine({ chat: client }),
    })
    const result = await registry.run(
      'run-2',
      { traceStore: traceStore() },
      { only: DEFAULT_TRACE_ANALYST_KINDS.map((kind) => kind.id) },
    )

    expect(result.per_analyst.filter((entry) => entry.status !== 'ok')).toEqual([])
    expect(new Set(result.findings.map((finding) => finding.analyst_id))).toEqual(
      new Set(DEFAULT_TRACE_ANALYST_KINDS.map((kind) => kind.id)),
    )
  })

  it('executes the requested trace tool and returns its real store answer', async () => {
    const engine = createChatTraceEngine({
      chat: mockChat((req) => {
        if (req.jsonMode) return response({ content: reportBody() })
        const read = req.messages.find((message) => message.role === 'tool')
        if (read) {
          expect(String(read.content)).toContain(TRACE_ID)
          return response({ content: 'done' })
        }
        return response({
          content: '',
          toolCalls: [toolCall('call-1', 'getDatasetOverview')],
        })
      }).client,
    })
    const result = await engine.analyze(engineRequest())

    expect(result.toolCalls).toBe(1)
    expect(result.modelCalls).toBe(3)
    expect(result.answer).toContain('stale manifest')
    expect(result.findings).toHaveLength(1)
    expect(result.runtime.served_models).toEqual([MODEL])
    expect(result.runtime.investigation_stopped_on_answer).toBe(true)
  })

  it('meters every call on the shared cost ledger', async () => {
    const ledger = new CostLedger()
    const engine = createChatTraceEngine({ chat: mockChat(investigateThenReport).client })
    await engine.analyze(engineRequest({ costLedger: ledger, costTags: { arm: 'a' } }))

    const summary = ledger.summary({ channel: 'analyst' })
    expect(summary.totalCalls).toBe(3)
    expect(summary.pendingCalls).toBe(0)
    expect(summary.inputTokens).toBe(1_200)
    expect(summary.outputTokens).toBe(360)
    expect(summary.totalCostUsd).toBeCloseTo(0.006, 10)
  })

  it('refuses a capped ledger call it cannot price rather than spending blind', async () => {
    // A capped ledger needs a priced maximum. Unpriced model + no pricing = refusal.
    const engine = createChatTraceEngine({ chat: mockChat(investigateThenReport).client })
    await expect(engine.analyze(engineRequest({ costLedger: new CostLedger(1) }))).rejects.toThrow(
      /investigation call failed/,
    )
  })

  it('prices a capped ledger call when the caller supplies endpoint rates', async () => {
    const ledger = new CostLedger(50)
    const engine = createChatTraceEngine({
      chat: mockChat(investigateThenReport).client,
      pricing: { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
    })
    const result = await engine.analyze(engineRequest({ costLedger: ledger }))
    expect(result.modelCalls).toBe(3)
    expect(ledger.summary({ channel: 'analyst' }).totalCalls).toBe(3)
  })

  it('answers every tool call once the tool budget is spent, then reports', async () => {
    const { client, requests } = mockChat((req) => {
      if (req.jsonMode) return response({ content: reportBody() })
      return response({
        content: '',
        toolCalls: [
          toolCall('call-1', 'getDatasetOverview'),
          toolCall('call-2', 'countTraces', {}),
        ],
      })
    })
    const engine = createChatTraceEngine({ chat: client })
    const result = await engine.analyze(
      engineRequest({
        limits: { maxIterations: 4, maxLlmCalls: 4, maxToolCalls: 1, maxOutputChars: 10_000 },
      }),
    )

    expect(result.toolCalls).toBe(1)
    expect(result.runtime.tool_budget_exhausted).toBe(true)
    const answered = requests
      .at(-1)!
      .messages.filter((message) => message.role === 'tool')
      .map((message) => message.toolCallId)
    expect(answered).toEqual(['call-1', 'call-2'])
    expect(String(requests.at(-1)!.messages.at(-2)!.content)).toContain(
      'budget of 1 calls is spent',
    )
  })

  it('hands a tool failure back to the model instead of ending the investigation', async () => {
    const { client, requests } = mockChat((req) => {
      if (req.jsonMode) return response({ content: reportBody() })
      if (req.messages.some((message) => message.role === 'tool'))
        return response({ content: 'ok' })
      return response({
        content: '',
        toolCalls: [
          toolCall('call-1', 'noSuchTool'),
          { id: 'call-2', name: 'countTraces', argumentsJson: '{not json' },
          toolCall('call-3', 'viewTrace', { trace_id: 'missing-trace' }),
        ],
      })
    })
    const engine = createChatTraceEngine({ chat: client })
    const result = await engine.analyze(engineRequest())

    expect(result.toolCalls).toBe(3)
    const toolMessages = requests[1]!.messages.filter((message) => message.role === 'tool')
    expect(String(toolMessages[0]!.content)).toContain("unknown tool 'noSuchTool'")
    expect(String(toolMessages[1]!.content)).toContain('were not JSON')
    expect(String(toolMessages[2]!.content)).toContain('error')
    expect(result.findings).toHaveLength(1)
  })

  it('truncates a tool result to the retained-output budget', async () => {
    const { client, requests } = mockChat((req) => {
      if (req.jsonMode) return response({ content: reportBody() })
      if (req.messages.some((message) => message.role === 'tool'))
        return response({ content: 'ok' })
      return response({ content: '', toolCalls: [toolCall('call-1', 'getDatasetOverview')] })
    })
    const engine = createChatTraceEngine({ chat: client })
    const result = await engine.analyze(
      engineRequest({
        limits: { maxIterations: 4, maxLlmCalls: 4, maxToolCalls: 8, maxOutputChars: 60 },
      }),
    )

    expect(result.runtime.truncated_tool_results).toBe(1)
    const toolMessage = requests[1]!.messages.find((message) => message.role === 'tool')!
    expect(String(toolMessage.content).length).toBe(60)
    expect(String(toolMessage.content)).toContain('truncated')
  })

  it('stops investigating when the iteration budget runs out and still reports', async () => {
    const { client } = mockChat((req) =>
      req.jsonMode
        ? response({ content: reportBody() })
        : response({ content: '', toolCalls: [toolCall(`call-${Date.now()}`, 'countTraces', {})] }),
    )
    const engine = createChatTraceEngine({ chat: client })
    const result = await engine.analyze(
      engineRequest({
        limits: { maxIterations: 2, maxLlmCalls: 8, maxToolCalls: 8, maxOutputChars: 10_000 },
      }),
    )

    expect(result.runtime.investigation_turns).toBe(2)
    expect(result.runtime.investigation_stopped_on_answer).toBe(false)
    expect(result.modelCalls).toBe(3)
  })

  it('keeps the valid findings when the model emits one malformed row', async () => {
    const { client } = mockChat((req) =>
      req.jsonMode
        ? response({
            content: reportBody({ findings: [...REPORT_FINDINGS, { severity: 'wat' }] }),
          })
        : response({ content: 'no tools needed' }),
    )
    const engine = createChatTraceEngine({ chat: client })
    const result = await engine.analyze(engineRequest())

    expect(result.findings).toHaveLength(1)
    expect(result.runtime.rejected_findings).toBe(1)
  })

  it('refuses a report with no answer rather than returning an empty investigation', async () => {
    const { client } = mockChat((req) =>
      req.jsonMode
        ? response({ content: JSON.stringify({ answer: '   ', findings: [] }) })
        : response({ content: 'no tools needed' }),
    )
    const engine = createChatTraceEngine({ chat: client })
    await expect(engine.analyze(engineRequest())).rejects.toThrow(/carried no answer/)
  })

  it('refuses a report that is not JSON', async () => {
    const { client } = mockChat((req) =>
      response({ content: req.jsonMode ? 'sorry, I cannot answer' : 'no tools needed' }),
    )
    const engine = createChatTraceEngine({ chat: client })
    await expect(engine.analyze(engineRequest())).rejects.toThrow(/was not JSON/)
  })

  it('accepts a fenced report body', async () => {
    const { client } = mockChat((req) =>
      req.jsonMode
        ? response({ content: `\`\`\`json\n${reportBody()}\n\`\`\`` })
        : response({ content: 'no tools needed' }),
    )
    const engine = createChatTraceEngine({ chat: client })
    const result = await engine.analyze(engineRequest())
    expect(result.findings).toHaveLength(1)
  })

  it('delivers structured task inputs instead of dropping them', async () => {
    const { client, requests } = mockChat((req) =>
      req.jsonMode ? response({ content: reportBody() }) : response({ content: 'no tools needed' }),
    )
    const engine = createChatTraceEngine({ chat: client })
    const result = await engine.analyze(
      engineRequest({ taskInputs: { candidate: { id: 'cand-9', turns: 3 } } }),
    )

    expect(result.runtime.task_inputs).toBe('prompt-delivered')
    expect(String(requests[0]!.messages[1]!.content)).toContain('cand-9')
  })

  it('refuses an analyst whose call budget cannot pay for both investigation and report', async () => {
    const engine = createChatTraceEngine({ chat: mockChat(investigateThenReport).client })
    await expect(
      engine.analyze(
        engineRequest({
          limits: { maxIterations: 4, maxLlmCalls: 1, maxToolCalls: 8, maxOutputChars: 10_000 },
        }),
      ),
    ).rejects.toThrow(/maxLlmCalls must be at least 2/)
  })

  it('sends the generated response schema when the caller asks for json-schema', async () => {
    const { client, requests } = mockChat((req) =>
      req.jsonMode ? response({ content: reportBody() }) : response({ content: 'no tools needed' }),
    )
    const engine = createChatTraceEngine({ chat: client, reportFormat: 'json-schema' })
    await engine.analyze(engineRequest())

    const schema = requests.at(-1)!.jsonSchema
    expect(schema?.name).toBe('trace_analysis_report')
    expect(Object.keys(schema?.schema.properties as Record<string, unknown>)).toEqual([
      'answer',
      'findings',
    ])
    expect(JSON.stringify(schema?.schema)).toContain('recommended_action')
  })

  it('seals a distinct execution identity per engine configuration', () => {
    const { client } = mockChat(investigateThenReport)
    const base = createChatTraceEngine({ chat: client })
    const hotter = createChatTraceEngine({ chat: client, temperature: 0.7 })
    expect(base.id).toBe('chat-trace')
    expect(base.model).toBe(MODEL)
    expect(base.executionConfig).not.toEqual(hotter.executionConfig)
    expect(base.executionConfig.report_format).toBe('json-object')
  })

  it('refuses to build without a model on the options or the client', () => {
    const client = createChatClient({
      transport: 'mock',
      handler: async () => response(),
    })
    expect(() => createChatTraceEngine({ chat: client })).toThrow(/needs a model/)
  })

  it('rejects invalid engine knobs at construction', () => {
    const { client } = mockChat(investigateThenReport)
    expect(() => createChatTraceEngine({ chat: client, maxOutputTokens: 0 })).toThrow(
      /maxOutputTokens/,
    )
    expect(() => createChatTraceEngine({ chat: client, temperature: -1 })).toThrow(/temperature/)
    expect(() => createChatTraceEngine({ chat: client, requestTimeoutMs: -5 })).toThrow(
      /requestTimeoutMs/,
    )
  })
})
