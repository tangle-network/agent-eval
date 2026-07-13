import { describe, expect, it } from 'vitest'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { TraceAnalystSpan } from '../trace-analyst/types'
import { buildDefaultAnalystRegistry } from './default-registry'

function span(over: Partial<TraceAnalystSpan> & { span_id: string }): TraceAnalystSpan {
  return {
    trace_id: 't1',
    parent_span_id: 'root',
    name: over.span_id,
    kind: 'SPAN',
    start_time: '2026-01-01T00:00:00.000Z',
    end_time: '2026-01-01T00:00:00.100Z',
    duration_ms: 100,
    status: 'OK',
    service_name: 'agent',
    agent_name: null,
    model_name: null,
    tool_name: null,
    attributes: {},
    ...over,
  }
}

// Suboptimal-but-successful trace: input grows 10x, output decays, single tool, no verify.
const INPUTS = [600, 1500, 3000, 5000, 6000]
const OUTPUTS = [150, 120, 100, 80, 70]
const SPANS: TraceAnalystSpan[] = []
for (let i = 0; i < 5; i++) {
  SPANS.push(
    span({
      span_id: `llm-${i}`,
      kind: 'LLM',
      model_name: 'deepseek-chat',
      attributes: { 'llm.input_tokens': INPUTS[i]!, 'llm.output_tokens': OUTPUTS[i]!, step: i },
    }),
    span({
      span_id: `tool-${i}`,
      kind: 'TOOL',
      tool_name: 'world.execute',
      attributes: { step: i },
    }),
  )
}

const fakeStore = {
  async getOverview() {
    return { sample_trace_ids: ['t1'] }
  },
  async viewTrace() {
    return { trace_id: 't1', spans: SPANS }
  },
} as unknown as TraceAnalysisStore

function stubAi() {
  return {} as never
}

describe('buildDefaultAnalystRegistry', () => {
  it('always registers the deterministic behavioral analyst (no ai needed)', () => {
    const ids = buildDefaultAnalystRegistry()
      .list()
      .map((a) => a.id)
    expect(ids).toContain('efficiency-behavioral')
  })

  it('registers the agentic RLM kinds when an ai service is supplied', () => {
    const ids = buildDefaultAnalystRegistry({ ai: stubAi() })
      .list()
      .map((a) => a.id)
    expect(ids).toContain('efficiency-behavioral')
    expect(ids).toContain('failure-mode')
    expect(ids.length).toBeGreaterThanOrEqual(5)
  })

  it('omits the behavioral analyst when includeBehavioral=false', () => {
    const ids = buildDefaultAnalystRegistry({ includeBehavioral: false })
      .list()
      .map((a) => a.id)
    expect(ids).not.toContain('efficiency-behavioral')
  })

  // The any-model regression gate: the default suite, with NO LLM, must emit
  // the four HALO-class behavioral findings on a suboptimal trace.
  it('emits >=4 deterministic behavioral findings on a suboptimal trace (any-model CI gate)', async () => {
    const registry = buildDefaultAnalystRegistry()
    const res = await registry.run('gate', { traceStore: fakeStore })
    expect(res.findings.length).toBeGreaterThanOrEqual(4)
    const subjects = res.findings.map((f) => f.subject).sort()
    expect(subjects).toEqual(
      [
        'monotonic-input-growth',
        'no-self-verification',
        'output-length-decay',
        'single-tool-dependency',
      ].sort(),
    )
    expect(res.per_analyst.every((p) => p.status === 'ok')).toBe(true)
  })

  it('analyzes sampled traces independently instead of joining unrelated calls', async () => {
    const cases: Array<[string, number, number]> = [
      ['t1', 100, 90],
      ['t2', 200, 60],
      ['t3', 400, 30],
    ]
    const traces = new Map(
      cases.map(([traceId, input, output]) => [
        traceId,
        [
          span({
            trace_id: traceId,
            span_id: `llm-${traceId}`,
            kind: 'LLM',
            attributes: {
              'llm.input_tokens': input,
              'llm.output_tokens': output,
              step: 1,
            },
          }),
        ],
      ]),
    )
    const store = {
      async getOverview() {
        return { sample_trace_ids: [...traces.keys()] }
      },
      async viewTrace({ trace_id }: { trace_id: string }) {
        return { trace_id, spans: traces.get(trace_id) }
      },
    } as unknown as TraceAnalysisStore

    const result = await buildDefaultAnalystRegistry().run('independent-traces', {
      traceStore: store,
    })

    expect(result.findings).toEqual([])
    expect(result.per_analyst[0]?.status).toBe('ok')
  })

  it('reports oversized traces as incomplete instead of silently dropping them', async () => {
    const store = {
      async getOverview() {
        return { sample_trace_ids: ['large'] }
      },
      async viewTrace() {
        return {
          trace_id: 'large',
          oversized: {
            span_count: 10_000,
            top_span_names: [],
            span_response_bytes_max: 1_000,
            error_span_count: 0,
          },
        }
      },
    } as unknown as TraceAnalysisStore

    const result = await buildDefaultAnalystRegistry().run('oversized-trace', {
      traceStore: store,
    })

    expect(result.per_analyst[0]).toMatchObject({
      status: 'failed',
      error: {
        message: "behavioralAnalyst: trace 'large' is oversized; complete spans are required",
      },
    })
  })
})
