import { describe, expect, it } from 'vitest'
import { CaptureIntegrityError } from '../errors'
import {
  INPUT_VALUE,
  OUTPUT_VALUE,
  TOOL_ARGS_CAPTURED,
  TOOL_LATENCY_MS,
} from '../trace/attribute-vocabulary'
import type { ToolSpan } from '../trace/schema'
import { ToolTraceMissingError, toolSpansToTraceAnalysisStore } from './store-otlp'

function tool(overrides: Partial<ToolSpan> = {}): ToolSpan {
  return {
    runId: 'run-b',
    spanId: 'span-exec',
    parentSpanId: 'root',
    kind: 'tool',
    name: 'tool.exec',
    startedAt: 2_000,
    status: 'error',
    error: 'command exited 1',
    toolName: 'exec',
    args: { cmd: 'false' },
    result: { exitCode: 1 },
    latencyMs: 250,
    attributes: {
      'service.name': 'worker-service',
      'agent.name': 'worker-agent',
      'provider.request_id': 'request-original',
    },
    ...overrides,
  }
}

describe('toolSpansToTraceAnalysisStore', () => {
  it('fails with capture_integrity when trace evidence is absent', () => {
    for (const spans of [undefined, null, []] as const) {
      try {
        toolSpansToTraceAnalysisStore(spans)
        throw new Error('expected missing trace evidence to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(ToolTraceMissingError)
        expect((error as ToolTraceMissingError).code).toBe('capture_integrity')
      }
    }
  })

  it('groups tool spans by run and preserves trace evidence in an immutable snapshot', async () => {
    const failed = tool()
    const healthy = tool({
      runId: 'run-a',
      spanId: 'span-search',
      parentSpanId: undefined,
      name: 'tool.search',
      startedAt: 1_000,
      endedAt: 1_100,
      status: 'ok',
      error: undefined,
      toolName: 'search',
      args: { query: 'adapter' },
      result: { hits: 3 },
      latencyMs: 100,
      attributes: { 'provider.request_id': 'search-request' },
    })
    const store = toolSpansToTraceAnalysisStore([failed, healthy])

    failed.result = { exitCode: 0 }
    failed.attributes!['provider.request_id'] = 'request-mutated'

    const overview = await store.getOverview()
    expect(overview.total_traces).toBe(2)
    expect(overview.sample_trace_ids).toEqual(['run-a', 'run-b'])
    expect(overview.tool_names).toEqual(['exec', 'search'])
    expect(overview.services).toEqual(['worker-service'])
    expect(overview.agents).toEqual(['worker-agent'])
    expect(overview.errors).toEqual({ trace_count: 1, span_count: 1 })
    expect(overview.error_clusters).toHaveLength(1)
    expect(overview.error_clusters[0]!.status_message_sample).toBe('command exited 1')

    expect(await store.countTraces({ has_errors: true })).toBe(1)
    const execRuns = await store.queryTraces({ filters: { tool_names: ['exec'] }, limit: 10 })
    expect(execRuns.traces.map((trace) => trace.trace_id)).toEqual(['run-b'])

    const viewed = await store.viewTrace({ trace_id: 'run-b' })
    expect(viewed.oversized).toBeUndefined()
    expect(viewed.spans).toHaveLength(1)
    const span = viewed.spans![0]!
    expect(span).toMatchObject({
      trace_id: 'run-b',
      span_id: 'span-exec',
      parent_span_id: 'root',
      kind: 'TOOL',
      duration_ms: 250,
      status: 'ERROR',
      status_message: 'command exited 1',
      service_name: 'worker-service',
      agent_name: 'worker-agent',
      tool_name: 'exec',
    })
    expect(span.attributes[INPUT_VALUE]).toBe('{"cmd":"false"}')
    expect(span.attributes[OUTPUT_VALUE]).toBe('{"exitCode":1}')
    expect(span.attributes[TOOL_ARGS_CAPTURED]).toBe(true)
    expect(span.attributes[TOOL_LATENCY_MS]).toBe(250)
    expect(span.attributes['provider.request_id']).toBe('request-original')

    const search = await store.searchTrace({
      trace_id: 'run-b',
      regex_pattern: 'exitCode',
    })
    expect(search.hits).toHaveLength(1)
    expect(search.hits[0]!.span_id).toBe('span-exec')
  })

  it('rejects duplicate identities and malformed timestamps instead of dropping spans', () => {
    const span = tool()
    expect(() => toolSpansToTraceAnalysisStore([span, { ...span }])).toThrow(CaptureIntegrityError)
    expect(() => toolSpansToTraceAnalysisStore([tool({ startedAt: Number.MAX_VALUE })])).toThrow(
      CaptureIntegrityError,
    )
    expect(() =>
      toolSpansToTraceAnalysisStore([tool({ startedAt: 2_000, endedAt: 1_999 })]),
    ).toThrow(CaptureIntegrityError)
  })
})
