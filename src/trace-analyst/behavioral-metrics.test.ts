import { describe, expect, it } from 'vitest'
import { deriveEfficiencyFindings } from '../analyst/behavioral-analyst'
import { LLM_INPUT_TOKENS, LLM_OUTPUT_TOKENS } from '../trace/otlp-attributes'
import { computeTraceMetrics } from './behavioral-metrics'
import type { TraceAnalystSpan } from './types'

// A fixture shaped like the real 530b157_1 AppWorld trace where our Ax-RLM
// returned 0 findings and HALO produced its four behavioral diagnoses:
//   inputs 671→8776, outputs 157→75, 7× world.execute, no self-verification.
function llmSpan(step: number, inTok: number, outTok: number): TraceAnalystSpan {
  return {
    trace_id: 't1',
    span_id: `llm-${step}`,
    parent_span_id: 'root',
    name: `llm.step.${step}`,
    kind: 'LLM',
    start_time: `2026-01-01T00:00:0${step}.000Z`,
    end_time: `2026-01-01T00:00:0${step}.400Z`,
    duration_ms: 400,
    status: 'OK',
    service_name: 'appworld-repl-agent',
    agent_name: null,
    model_name: 'deepseek-chat',
    tool_name: null,
    attributes: { 'llm.input_tokens': inTok, 'llm.output_tokens': outTok, step },
  }
}
function toolSpan(step: number, tool: string): TraceAnalystSpan {
  return {
    trace_id: 't1',
    span_id: `tool-${step}`,
    parent_span_id: 'root',
    name: `tool.${tool}.${step}`,
    kind: 'TOOL',
    start_time: `2026-01-01T00:00:0${step}.500Z`,
    end_time: `2026-01-01T00:00:0${step}.600Z`,
    duration_ms: 100,
    status: 'OK',
    service_name: 'appworld-repl-agent',
    agent_name: null,
    model_name: null,
    tool_name: tool,
    attributes: { 'tool.name': tool, step },
  }
}

const INPUTS = [671, 1800, 3200, 5000, 7014, 8316, 8776]
const OUTPUTS = [157, 130, 110, 95, 88, 80, 75]
function fixture530(): TraceAnalystSpan[] {
  const spans: TraceAnalystSpan[] = []
  for (let i = 0; i < 7; i++) {
    spans.push(llmSpan(i + 1, INPUTS[i]!, OUTPUTS[i]!))
    spans.push(toolSpan(i + 1, 'world.execute'))
  }
  return spans
}

describe('computeTraceMetrics — deterministic behavioral signals (no LLM)', () => {
  it('extracts the exact trajectories + histogram from the 530b157_1-shaped trace', () => {
    const m = computeTraceMetrics(fixture530())
    expect(m.traceId).toBe('t1')
    expect(m.inputTokenTrajectory).toEqual(INPUTS)
    expect(m.outputTokenTrajectory).toEqual(OUTPUTS)
    expect(m.toolHistogram).toEqual({ 'world.execute': 7 })
    expect(m.distinctTools).toBe(1)
    expect(m.totalToolCalls).toBe(7)
    expect(m.hasSelfVerification).toBe(false)
  })

  it('prefers canonical OpenInference token attributes', () => {
    const spans = [
      {
        ...llmSpan(1, 10, 5),
        attributes: { [LLM_INPUT_TOKENS]: 10, [LLM_OUTPUT_TOKENS]: 5, step: 1 },
      },
      {
        ...llmSpan(2, 20, 4),
        attributes: { [LLM_INPUT_TOKENS]: 20, [LLM_OUTPUT_TOKENS]: 4, step: 2 },
      },
    ]

    const m = computeTraceMetrics(spans)
    expect(m.inputTokenTrajectory).toEqual([10, 20])
    expect(m.outputTokenTrajectory).toEqual([5, 4])
  })

  it('fires all four HALO-class signals on the suboptimal-but-successful trace', () => {
    const codes = computeTraceMetrics(fixture530())
      .signals.map((s) => s.code)
      .sort()
    expect(codes).toEqual(
      [
        'monotonic-input-growth',
        'no-self-verification',
        'output-length-decay',
        'single-tool-dependency',
      ].sort(),
    )
  })

  it('is order-independent (sorts by step) and shuffling spans does not change signals', () => {
    const shuffled = [...fixture530()].reverse()
    expect(computeTraceMetrics(shuffled).inputTokenTrajectory).toEqual(INPUTS)
  })

  it('uses one deterministic time order when any token sample lacks a step', () => {
    const spans = [
      {
        ...llmSpan(1, 400, 30),
        start_time: '2026-01-01T00:00:03.000Z',
        end_time: '2026-01-01T00:00:03.400Z',
      },
      {
        ...llmSpan(2, 200, 60),
        start_time: '2026-01-01T00:00:02.000Z',
        end_time: '2026-01-01T00:00:02.400Z',
        attributes: { 'llm.input_tokens': 200, 'llm.output_tokens': 60 },
      },
      {
        ...llmSpan(3, 100, 90),
        start_time: '2026-01-01T00:00:01.000Z',
        end_time: '2026-01-01T00:00:01.400Z',
        attributes: { 'llm.input_tokens': 100, 'llm.output_tokens': 90, step: 2 },
      },
    ]

    const forward = computeTraceMetrics(spans)
    const reversed = computeTraceMetrics([...spans].reverse())

    expect(forward.inputTokenTrajectory).toEqual([100, 200, 400])
    expect(reversed.inputTokenTrajectory).toEqual(forward.inputTokenTrajectory)
    expect(reversed.signals).toEqual(forward.signals)
  })

  it('does NOT fire tool signals below the min-call threshold (no false positives)', () => {
    const tiny = [llmSpan(1, 100, 50), llmSpan(2, 100, 50), toolSpan(1, 'world.execute')]
    const codes = computeTraceMetrics(tiny).signals.map((s) => s.code)
    expect(codes).not.toContain('single-tool-dependency')
    expect(codes).not.toContain('no-self-verification')
  })

  it('self-verification tool suppresses the no-self-verification signal', () => {
    const spans = fixture530()
    spans.push(toolSpan(8, 'world.eval'))
    const m = computeTraceMetrics(spans)
    expect(m.hasSelfVerification).toBe(true)
    expect(m.signals.map((s) => s.code)).not.toContain('no-self-verification')
  })

  it('counts real read/inspect tool names (Read/Grep) as self-verification', () => {
    for (const tool of ['Read', 'Grep', 'read_file', 'git.status']) {
      const spans = fixture530()
      spans.push(toolSpan(8, tool))
      const m = computeTraceMetrics(spans)
      expect(m.hasSelfVerification).toBe(true)
      expect(m.signals.map((s) => s.code)).not.toContain('no-self-verification')
    }
  })

  it('FIRES monotonic-input-growth on a 0→huge blowup (first call reported 0 input tokens)', () => {
    // First LLM call reports 0 input tokens, then context explodes. Ratio is
    // unbounded — the old `first > 0 ? last/first : 0` forced growth to 0 and
    // silently dropped the most severe possible blowup.
    const spans = [llmSpan(1, 0, 100), llmSpan(2, 4000, 90), llmSpan(3, 9000, 80)]
    const sig = computeTraceMetrics(spans).signals.find((s) => s.code === 'monotonic-input-growth')
    expect(sig).toBeDefined()
    expect(sig!.severity).toBe('high')
    // Displayed ratio must stay sane (no NaN/Infinity literal leaking into the message).
    expect(sig!.detail).not.toContain('Infinity')
    expect(sig!.detail).not.toContain('NaN')
    expect(sig!.detail).toContain('0→9000')
    expect(sig!.evidence.first).toBe(0)
    expect(sig!.evidence.last).toBe(9000)
    expect(sig!.evidence.growth_x).toBe('unbounded')
  })

  it('does NOT fire monotonic-input-growth when input stays at 0 (no blowup)', () => {
    const spans = [llmSpan(1, 0, 100), llmSpan(2, 0, 90), llmSpan(3, 0, 80)]
    const codes = computeTraceMetrics(spans).signals.map((s) => s.code)
    expect(codes).not.toContain('monotonic-input-growth')
  })

  it('rejects spans from multiple traces instead of fabricating one trajectory', () => {
    const spans = [
      llmSpan(1, 100, 90),
      { ...llmSpan(2, 200, 60), trace_id: 't2' },
      { ...llmSpan(3, 400, 30), trace_id: 't3' },
    ]

    expect(() => computeTraceMetrics(spans)).toThrow(
      'computeTraceMetrics: expected spans from one trace, received 3 traces',
    )
  })

  it('does not attribute output decay to context growth when input stays flat', () => {
    const spans = [llmSpan(1, 100, 90), llmSpan(2, 100, 60), llmSpan(3, 100, 30)]

    expect(computeTraceMetrics(spans).signals.map((signal) => signal.code)).not.toContain(
      'output-length-decay',
    )
  })

  it('does not infer token trends across an LLM call with missing usage', () => {
    const missingUsage = {
      ...llmSpan(2, 200, 60),
      attributes: { step: 2 },
    }
    const spans = [llmSpan(1, 100, 90), missingUsage, llmSpan(3, 400, 30)]
    const metrics = computeTraceMetrics(spans)

    expect(metrics.llmCallCount).toBe(3)
    expect(metrics.inputTokenTrajectory).toEqual([100, 400])
    expect(metrics.outputTokenTrajectory).toEqual([90, 30])
    expect(metrics.signals.map((signal) => signal.code)).not.toContain('monotonic-input-growth')
    expect(metrics.signals.map((signal) => signal.code)).not.toContain('output-length-decay')
  })

  it('does not infer output decay when one LLM call lacks output usage', () => {
    const missingOutput = {
      ...llmSpan(2, 200, 60),
      attributes: { 'llm.input_tokens': 200, step: 2 },
    }
    const spans = [llmSpan(1, 100, 90), missingOutput, llmSpan(3, 400, 60), llmSpan(4, 800, 30)]

    expect(computeTraceMetrics(spans).signals.map((signal) => signal.code)).not.toContain(
      'output-length-decay',
    )
  })

  it('does not infer monotonic growth or output decay across context resets', () => {
    const inputs = [25_073, 100_000, 240_000, 30_000, 120_000, 210_878]
    const outputs = [934, 150, 1_200, 120, 900, 137]
    const spans = inputs.map((input, index) => llmSpan(index + 1, input, outputs[index]!))

    const codes = computeTraceMetrics(spans).signals.map((signal) => signal.code)

    expect(codes).not.toContain('monotonic-input-growth')
    expect(codes).not.toContain('output-length-decay')
  })

  it('requires paired input and output samples before attributing output decay to context growth', () => {
    const inputs = [llmSpan(1, 100, 10), llmSpan(2, 200, 10), llmSpan(3, 400, 10)].map((span) => ({
      ...span,
      attributes: {
        'llm.input_tokens': span.attributes['llm.input_tokens'],
        step: span.attributes.step,
      },
    }))
    const outputs = [llmSpan(4, 100, 90), llmSpan(5, 100, 60), llmSpan(6, 100, 30)].map((span) => ({
      ...span,
      attributes: {
        'llm.output_tokens': span.attributes['llm.output_tokens'],
        step: span.attributes.step,
      },
    }))

    const codes = computeTraceMetrics([...inputs, ...outputs]).signals.map((signal) => signal.code)

    expect(codes).not.toContain('output-length-decay')
  })
})

describe('deriveEfficiencyFindings — the 0→4, any-model flip', () => {
  it('emits 4 structured findings matching HALO, confidence 1, with auditable evidence', () => {
    const findings = deriveEfficiencyFindings(computeTraceMetrics(fixture530()), {
      producedAt: '2026-01-01T00:00:00.000Z',
    })
    expect(findings).toHaveLength(4)
    for (const f of findings) {
      expect(f.area).toBe('efficiency')
      expect(f.confidence).toBe(1)
      expect(f.evidence_refs[0]!.kind).toBe('metric')
      expect(f.recommended_action).toBeTruthy()
      expect(f.metadata?.deterministic).toBe(true)
      expect(f.metadata?.trace_id).toBe('t1')
      expect(f.evidence_refs[0]!.uri).toContain('/t1/')
    }
    const growth = findings.find((f) => f.subject === 'monotonic-input-growth')!
    expect(growth.claim).toContain('671→8776')
    expect((growth.metadata!.evidence as { growth_x: number }).growth_x).toBeCloseTo(13.08, 1)
  })

  it('is fully deterministic — identical finding_ids across runs (any model, any machine)', () => {
    const a = deriveEfficiencyFindings(computeTraceMetrics(fixture530()), { producedAt: 'x' })
    const b = deriveEfficiencyFindings(computeTraceMetrics(fixture530()), { producedAt: 'x' })
    expect(a.map((f) => f.finding_id)).toEqual(b.map((f) => f.finding_id))
  })
})
