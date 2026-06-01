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
})
