import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import { CostCallConflictError, CostLedger, type CostLedgerPersistence } from '../cost-ledger'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalystSpan } from '../trace-analyst/types'
import {
  createPublicBenchmarkModelRunner,
  publicBenchmarkProtocolSha256,
} from './benchmark-real-model'
import { buildTraceToolsForGroup } from './tool-groups'

describe('createPublicBenchmarkModelRunner', () => {
  it('makes one bounded structured call and validates the exact cited action', async () => {
    const traceId = 'trace-1'
    const action = 'writeFile("broken configuration")'
    const spans = [span(traceId, 'step-2', action)]
    const requestedCaps: number[] = []
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>
      expect(body).toMatchObject({
        model: 'glm-5.2',
        max_tokens: 1_024,
        response_format: { type: 'json_object' },
        thinking: { type: 'disabled' },
      })
      const prompt = (body.messages as Array<{ content: string }>)
        .map((message) => message.content)
        .join('\n')
      expect(prompt).toContain('"step": a positive integer')
      expect(prompt).toContain('constructs exact trace URIs and action previews')
      expect(prompt).not.toContain('"uri"')
      expect(prompt).not.toContain('"excerpt"')
      return modelResponse({
        report: 'Step 2 wrote the configuration that caused the final failure.',
        findings: [
          {
            step: 2,
            severity: 'high',
            claim: 'Step 2 wrote an invalid configuration.',
            confidence: 0.95,
          },
        ],
      })
    }) as typeof fetch
    const runner = createPublicBenchmarkModelRunner('codetracebench', {
      baseUrl: 'https://provider.invalid/v1',
      apiKey: 'test',
      model: 'glm-5.2',
      maxOutputTokens: 1_024,
      timeoutMs: 30_000,
      fetchImpl,
    })

    const output = await runner.analyze(
      {
        traceStore: singleTraceStore(traceId, spans, {
          fitAtCap: 1_024,
          onView: (cap) => requestedCaps.push(cap),
        }),
      },
      { caseId: `codetrace:${traceId}`, repetition: 0 },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(requestedCaps).toEqual([4_096, 2_048, 1_024])
    expect(output.error).toBeUndefined()
    expect(output.findings).toHaveLength(1)
    expect(output.findings[0]).toMatchObject({
      analyst_id: 'model',
      subject: 'incorrect-step-2',
      evidence_refs: [
        {
          uri: 'trace://trace-1/span/step-2',
          excerpt: action,
        },
      ],
    })
    expect(output.usage).toMatchObject({
      calls: 1,
      tokens: { input: 100, output: 50 },
    })
    expect(output.metadata).toMatchObject({
      analysisMode: 'single-pass',
      providerModel: 'glm-5.2',
      outputAdapter: 'codetracebench-incorrect-step',
    })
  })

  it('maps AgentRx category and step output onto exact trace evidence', async () => {
    const traceId = 'agentrx-trace'
    const action = 'handoff({ result: "not checked" })'
    const fetchImpl = vi.fn(async () =>
      modelResponse({
        report: 'The handoff accepted an unchecked tool result.',
        findings: [
          {
            step: 4,
            category: 'misinterpretation-of-tool-output-handoff-failure',
            severity: 'high',
            claim: 'The assistant treated an unchecked tool result as valid.',
            confidence: 0.9,
          },
        ],
      }),
    ) as typeof fetch
    const runner = createPublicBenchmarkModelRunner('agentrx', {
      baseUrl: 'https://provider.invalid/v1',
      apiKey: 'test',
      model: 'glm-5.2',
      maxOutputTokens: 1_024,
      timeoutMs: 30_000,
      fetchImpl,
    })

    const output = await runner.analyze(
      { traceStore: singleTraceStore(traceId, [span(traceId, 'step-4', action)]) },
      { caseId: `agentrx:${traceId}`, repetition: 0 },
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(output.error).toBeUndefined()
    expect(output.findings).toHaveLength(1)
    expect(output.findings[0]).toMatchObject({
      area: 'misinterpretation-of-tool-output-handoff-failure',
      subject: 'root-cause',
      evidence_refs: [
        {
          uri: 'trace://agentrx-trace/span/step-4',
          excerpt: action,
        },
      ],
    })
    expect(output.metadata).toMatchObject({
      outputAdapter: 'agentrx-taxonomy-and-root-step',
      providerModel: 'glm-5.2',
    })
  })

  it('reuses a cached paid response after settlement persistence fails', async () => {
    const traceId = 'trace-1'
    const durability = {
      runIdentitySha256: 'a'.repeat(64),
      responseCacheDir: mkdtempSync(join(tmpdir(), 'benchmark-model-cache-')),
    }
    const state = { events: '', revision: '0', rejectSettlement: true }
    const persistence: CostLedgerPersistence = {
      read: () => ({ revision: state.revision, events: state.events }),
      append(expectedRevision, event) {
        if (expectedRevision !== state.revision) return undefined
        const parsed = JSON.parse(event) as { record?: { status?: string } }
        if (state.rejectSettlement && parsed.record?.status === 'settled') return undefined
        state.events += event
        state.revision = String(Buffer.byteLength(state.events))
        return state.revision
      },
    }
    const ledger = new CostLedger({ persistence })
    const fetchImpl = vi.fn(async () =>
      modelResponse({
        report: 'Step 2 caused the failure.',
        findings: [
          {
            step: 2,
            severity: 'high',
            claim: 'Step 2 wrote the invalid configuration.',
            confidence: 0.9,
          },
        ],
      }),
    ) as typeof fetch
    const config = {
      baseUrl: 'https://provider.invalid/v1',
      apiKey: 'test',
      model: 'glm-5.2',
      maxOutputTokens: 1_024,
      timeoutMs: 30_000,
      costLedger: ledger,
      durability,
      fetchImpl,
    }
    const input = {
      traceStore: singleTraceStore(traceId, [
        span(traceId, 'step-2', 'writeFile("invalid configuration")'),
      ]),
    }
    const context = { caseId: `codetrace:${traceId}`, repetition: 0 }

    await expect(
      createPublicBenchmarkModelRunner('codetracebench', config).analyze(input, context),
    ).rejects.toBeInstanceOf(CostCallConflictError)
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(ledger.listPending?.()).toHaveLength(1)

    state.rejectSettlement = false
    const resumed = await createPublicBenchmarkModelRunner('codetracebench', config).analyze(
      input,
      context,
    )
    const replayed = await createPublicBenchmarkModelRunner('codetracebench', config).analyze(
      input,
      context,
    )

    expect(fetchImpl).toHaveBeenCalledTimes(1)
    expect(ledger.listPending?.()).toHaveLength(0)
    expect(resumed.error).toBeUndefined()
    expect(replayed.error).toBeUndefined()
    expect(resumed.findings).toHaveLength(1)
    expect(replayed.findings).toEqual(resumed.findings)
    expect(resumed.metadata).toMatchObject({
      responseSource: 'durable-cache',
      cost: {
        source: 'agent-eval-model-pricing',
        estimatedCostUsd: expect.any(Number),
        ratesPerThousandTokens: {
          inputUsdPerThousand: 0.0006,
          outputUsdPerThousand: 0.0022,
        },
      },
    })
  })

  it('refuses to replay an interrupted provider request without a cached response', async () => {
    const traceId = 'trace-1'
    const durability = {
      runIdentitySha256: 'b'.repeat(64),
      responseCacheDir: mkdtempSync(join(tmpdir(), 'benchmark-model-cache-')),
    }
    const state = { events: '', revision: '0' }
    const persistence: CostLedgerPersistence = {
      read: () => ({ revision: state.revision, events: state.events }),
      append(expectedRevision, event) {
        if (expectedRevision !== state.revision) return undefined
        state.events += event
        state.revision = String(Buffer.byteLength(state.events))
        return state.revision
      },
    }
    const input = {
      traceStore: singleTraceStore(traceId, [
        span(traceId, 'step-2', 'writeFile("invalid configuration")'),
      ]),
    }
    const context = { caseId: `codetrace:${traceId}`, repetition: 0 }
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const providerCallIds: string[] = []
    const interruptedFetch = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
      providerCallIds.push(new Headers(init?.headers).get('Idempotency-Key') ?? '')
      markStarted()
      return new Promise<Response>(() => {})
    }) as typeof fetch
    const firstRunner = createPublicBenchmarkModelRunner('codetracebench', {
      baseUrl: 'https://provider.invalid/v1',
      apiKey: 'test',
      model: 'glm-5.2',
      maxOutputTokens: 1_024,
      timeoutMs: 30_000,
      costLedger: new CostLedger({ persistence }),
      durability,
      fetchImpl: interruptedFetch,
    })
    const interrupted = firstRunner.analyze(input, { ...context, signal: controller.signal })
    await started
    controller.abort()
    await expect(interrupted).rejects.toMatchObject({ name: 'AbortError' })

    const resumedFetch = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      providerCallIds.push(new Headers(init?.headers).get('Idempotency-Key') ?? '')
      return modelResponse({
        report: 'No incorrect step is supported.',
        findings: [],
      })
    }) as typeof fetch
    await expect(
      createPublicBenchmarkModelRunner('codetracebench', {
        baseUrl: 'https://provider.invalid/v1',
        apiKey: 'test',
        model: 'glm-5.2',
        maxOutputTokens: 1_024,
        timeoutMs: 30_000,
        costLedger: new CostLedger({ persistence }),
        durability,
        fetchImpl: resumedFetch,
      }).analyze(input, context),
    ).rejects.toBeInstanceOf(CostCallConflictError)

    expect(resumedFetch).not.toHaveBeenCalled()
    expect(providerCallIds).toHaveLength(1)
    expect(providerCallIds[0]).toMatch(/^analyst-benchmark-[a-f0-9]{64}$/)
  })

  it.each([401, 429])('persists HTTP %i without the provider body or bearer', async (status) => {
    const secret = 'AUDIT_SECRET_456'
    const runner = createPublicBenchmarkModelRunner('codetracebench', {
      baseUrl: 'https://provider.invalid/v1',
      apiKey: secret,
      model: 'glm-5.2',
      maxOutputTokens: 1_024,
      timeoutMs: 30_000,
      fetchImpl: vi.fn(
        async () =>
          new Response(JSON.stringify({ error: `Bearer ${secret}` }), {
            status,
            headers: { 'content-type': 'application/json' },
          }),
      ) as typeof fetch,
    })

    const output = await runner.analyze(
      { traceStore: singleTraceStore('trace-1', [span('trace-1', 'step-1', 'Inspect.')]) },
      { caseId: 'codetrace:trace-1', repetition: 0 },
    )

    expect(output.error).toEqual({
      class: 'LlmCallError',
      code: 'judge',
      status,
      message: `Provider request failed with HTTP ${status}.`,
    })
    expect(JSON.stringify(output)).not.toContain(secret)
  })

  it('distinguishes timeout, malformed output, and unavailable evidence failures', async () => {
    const run = async (
      response: () => Promise<Response>,
      spans = [span('trace-1', 'step-1', 'A')],
    ) =>
      createPublicBenchmarkModelRunner('codetracebench', {
        baseUrl: 'https://provider.invalid/v1',
        apiKey: 'test',
        model: 'glm-5.2',
        maxOutputTokens: 1_024,
        timeoutMs: 30_000,
        fetchImpl: vi.fn(response) as typeof fetch,
      }).analyze(
        { traceStore: singleTraceStore('trace-1', spans) },
        { caseId: 'codetrace:trace-1', repetition: 0 },
      )

    await expect(
      run(async () => {
        throw new DOMException('timed out', 'AbortError')
      }),
    ).resolves.toMatchObject({ error: { class: 'ProviderTimeoutError' } })
    await expect(run(async () => new Response('not-json', { status: 200 }))).resolves.toMatchObject(
      { error: { class: 'ModelOutputParseError' } },
    )
    await expect(
      run(async () =>
        modelResponse({
          report: 'Selected a step that does not exist.',
          findings: [{ step: 99, severity: 'high', claim: 'Missing.', confidence: 0.9 }],
        }),
      ),
    ).resolves.toMatchObject({
      error: {
        class: 'BenchmarkEvidenceError',
        message: expect.stringContaining('unavailable assistant steps'),
      },
    })
  })

  it('uses the focused one-trace tool set without dataset pagination', () => {
    const tools = buildTraceToolsForGroup('singleTrace', {} as never)
    expect(tools.map((tool) => tool.name)).toEqual([
      'getDatasetOverview',
      'viewTrace',
      'viewSpans',
      'searchTrace',
      'searchSpan',
    ])
  })

  it('binds each dataset to an explicit analyst protocol digest', () => {
    const codeTrace = publicBenchmarkProtocolSha256('codetracebench')
    const agentRx = publicBenchmarkProtocolSha256('agentrx')

    expect(codeTrace).toMatch(/^[a-f0-9]{64}$/)
    expect(agentRx).toMatch(/^[a-f0-9]{64}$/)
    expect(codeTrace).not.toBe(agentRx)
  })
})

function singleTraceStore(
  traceId: string,
  spans: TraceAnalystSpan[],
  options: { fitAtCap?: number; onView?: (cap: number) => void } = {},
): TraceAnalysisStore {
  return {
    async getOverview() {
      return {
        total_traces: 1,
        raw_jsonl_bytes: 1,
        services: [],
        agents: [],
        models: [],
        tool_names: [],
        sample_trace_ids: [traceId],
        errors: { trace_count: 0, span_count: 0 },
        error_clusters: [],
        time_range: {
          earliest: '2026-01-01T00:00:00.000Z',
          latest: '2026-01-01T00:00:01.000Z',
        },
      }
    },
    async viewTrace(input: { per_attribute_byte_cap?: number }) {
      const cap = input.per_attribute_byte_cap ?? 4_096
      options.onView?.(cap)
      if (cap > (options.fitAtCap ?? 4_096)) {
        return {
          trace_id: traceId,
          oversized: {
            span_count: spans.length,
            top_span_names: [],
            span_response_bytes_max: 1,
            error_span_count: 0,
          },
        }
      }
      return { trace_id: traceId, spans }
    },
    async viewSpans(input: { span_ids: readonly string[] }) {
      const requested = new Set(input.span_ids)
      const found = spans.filter((candidate) => requested.has(candidate.span_id))
      const foundIds = new Set(found.map((candidate) => candidate.span_id))
      return {
        trace_id: traceId,
        spans: found,
        missing_span_ids: input.span_ids.filter((id) => !foundIds.has(id)),
        omitted_span_ids: [],
        has_more: false,
        truncated_attribute_count: 0,
      }
    },
  } as unknown as TraceAnalysisStore
}

function span(traceId: string, spanId: string, content: string): TraceAnalystSpan {
  return {
    trace_id: traceId,
    span_id: spanId,
    parent_span_id: 'root',
    name: 'message.assistant',
    kind: 'LLM',
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: '2026-01-01T00:00:01.000Z',
    duration_ms: 1_000,
    status: 'OK',
    service_name: null,
    agent_name: 'assistant',
    model_name: null,
    tool_name: null,
    attributes: { content },
  }
}

function modelResponse(
  value: Record<string, unknown>,
  usage = { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
): Response {
  return new Response(
    JSON.stringify({
      model: 'glm-5.2',
      choices: [
        {
          message: { content: JSON.stringify(value) },
          finish_reason: 'stop',
        },
      ],
      usage,
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  )
}
