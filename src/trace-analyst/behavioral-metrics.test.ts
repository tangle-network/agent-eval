import { describe, expect, it } from 'vitest'
import { deriveEfficiencyFindings } from '../analyst/behavioral-analyst'
import { diffFindings } from '../analyst/findings-store'
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

  it('orders mixed ISO and epoch timestamps by time instead of string representation', () => {
    const spans = [
      {
        ...llmSpan(1, 300, 90),
        start_time: '2024-01-01T00:00:00.000Z',
        end_time: '2024-01-01T00:00:00.400Z',
        attributes: { 'llm.input_tokens': 300, 'llm.output_tokens': 90 },
      },
      {
        ...llmSpan(2, 900, 60),
        start_time: '1704067201000',
        end_time: '1704067201400',
        attributes: { 'llm.input_tokens': 900, 'llm.output_tokens': 60 },
      },
      {
        ...llmSpan(3, 100, 30),
        start_time: '2024-01-01T00:00:02.000Z',
        end_time: '2024-01-01T00:00:02.400Z',
        attributes: { 'llm.input_tokens': 100, 'llm.output_tokens': 30 },
      },
    ]

    const metrics = computeTraceMetrics(spans)

    expect(metrics.inputTokenTrajectory).toEqual([300, 900, 100])
    expect(metrics.signals.map((signal) => signal.code)).not.toContain('monotonic-input-growth')
    expect(metrics.signals.map((signal) => signal.code)).not.toContain('output-length-decay')
  })

  it('does not infer one token trend across parallel workers', () => {
    const workers: TraceAnalystSpan[] = [0, 1, 2].map((index) => ({
      ...llmSpan(index + 1, 0, 0),
      span_id: `worker-${index}`,
      parent_span_id: 'root',
      name: `worker.${index}`,
      kind: 'AGENT',
      model_name: null,
      attributes: {},
    }))
    const calls = [
      { input: 100, output: 90 },
      { input: 300, output: 60 },
      { input: 900, output: 30 },
    ].map(({ input, output }, index) => ({
      ...llmSpan(index + 1, input, output),
      parent_span_id: `worker-${index}`,
      start_time: '2026-01-01T00:00:01.000Z',
      end_time: '2026-01-01T00:00:01.400Z',
    }))

    const metrics = computeTraceMetrics([...workers, ...calls])

    expect(metrics.tokenSequences).toHaveLength(3)
    expect(metrics.signals.map((signal) => signal.code)).not.toContain('monotonic-input-growth')
    expect(metrics.signals.map((signal) => signal.code)).not.toContain('output-length-decay')
  })

  it('does not join independent structural roots that share an agent name', () => {
    const roots: TraceAnalystSpan[] = [1, 2, 3].map((step) => ({
      ...llmSpan(step, 0, 0),
      span_id: `agent-${step}`,
      parent_span_id: null,
      kind: 'AGENT',
      agent_name: 'shared-name',
      model_name: null,
      attributes: {},
    }))
    const calls = [
      { input: 100, output: 90 },
      { input: 300, output: 60 },
      { input: 900, output: 30 },
    ].map(({ input, output }, index) => ({
      ...llmSpan(index + 1, input, output),
      parent_span_id: `agent-${index + 1}`,
      agent_name: 'shared-name',
    }))

    const metrics = computeTraceMetrics([...roots, ...calls])

    expect(metrics.tokenSequences).toHaveLength(3)
    expect(metrics.signals.map((signal) => signal.code)).not.toContain('monotonic-input-growth')
    expect(metrics.signals.map((signal) => signal.code)).not.toContain('output-length-decay')
  })

  it('joins serial parentless calls within one trace', () => {
    const calls = [
      { input: 100, output: 90 },
      { input: 300, output: 60 },
      { input: 900, output: 30 },
    ].map(({ input, output }, index) => ({
      ...llmSpan(index + 1, input, output),
      parent_span_id: null,
    }))

    const metrics = computeTraceMetrics(calls)

    expect(metrics.tokenSequences.map((sequence) => sequence.spanIds)).toEqual([
      ['llm-1', 'llm-2', 'llm-3'],
    ])
    expect(metrics.signals.map((signal) => signal.code)).toContain('monotonic-input-growth')
    expect(metrics.signals.map((signal) => signal.code)).toContain('output-length-decay')
  })

  it('does not infer one token trend across overlapping branches under one agent', () => {
    const agent: TraceAnalystSpan = {
      ...llmSpan(1, 0, 0),
      span_id: 'agent',
      parent_span_id: 'root',
      kind: 'AGENT',
      start_time: '2026-01-01T00:00:00.000Z',
      end_time: '2026-01-01T00:00:10.000Z',
      duration_ms: 10_000,
      model_name: null,
      attributes: {},
    }
    const branches: TraceAnalystSpan[] = ['a', 'b'].map((id) => ({
      ...agent,
      span_id: `branch-${id}`,
      parent_span_id: 'agent',
      kind: 'SPAN',
    }))
    const calls = [
      { id: 'a1', parent: 'branch-a', input: 100, output: 90, second: 1 },
      { id: 'b1', parent: 'branch-b', input: 400, output: 60, second: 2 },
      { id: 'a2', parent: 'branch-a', input: 900, output: 30, second: 3 },
    ].map(({ id, parent, input, output, second }) => ({
      ...llmSpan(second, input, output),
      span_id: id,
      parent_span_id: parent,
    }))

    const metrics = computeTraceMetrics([agent, ...branches, ...calls])

    expect(metrics.tokenSequences.map((sequence) => sequence.spanIds)).toEqual([
      ['a1', 'a2'],
      ['b1'],
    ])
    expect(metrics.signals.map((signal) => signal.code)).not.toContain('monotonic-input-growth')
    expect(metrics.signals.map((signal) => signal.code)).not.toContain('output-length-decay')
  })

  it('joins a direct call with later child calls when timing proves order', () => {
    const agent: TraceAnalystSpan = {
      ...llmSpan(1, 0, 0),
      span_id: 'agent',
      parent_span_id: 'root',
      kind: 'AGENT',
      start_time: '2026-01-01T00:00:00.000Z',
      end_time: '2026-01-01T00:00:10.000Z',
      duration_ms: 10_000,
      model_name: null,
      attributes: {},
    }
    const phase: TraceAnalystSpan = {
      ...agent,
      span_id: 'phase',
      parent_span_id: 'agent',
      kind: 'SPAN',
      start_time: '2026-01-01T00:00:02.000Z',
      end_time: '2026-01-01T00:00:04.000Z',
      duration_ms: 2000,
    }
    const calls = [
      { id: 'direct', parent: 'agent', input: 100, output: 90, second: 1 },
      { id: 'phase-1', parent: 'phase', input: 400, output: 60, second: 2 },
      { id: 'phase-2', parent: 'phase', input: 900, output: 30, second: 3 },
    ].map(({ id, parent, input, output, second }) => ({
      ...llmSpan(second, input, output),
      span_id: id,
      parent_span_id: parent,
    }))

    const metrics = computeTraceMetrics([agent, phase, ...calls])

    expect(metrics.tokenSequences.map((sequence) => sequence.spanIds)).toEqual([
      ['direct', 'phase-1', 'phase-2'],
    ])
    expect(metrics.signals.map((signal) => signal.code)).toContain('monotonic-input-growth')
    expect(metrics.signals.map((signal) => signal.code)).toContain('output-length-decay')
  })

  it('partitions 25,000 overlapping calls without pairwise lane search', () => {
    const calls = Array.from({ length: 25_000 }, (_, index) => ({
      ...llmSpan(1, index + 1, 1),
      span_id: `parallel-${index.toString().padStart(5, '0')}`,
      start_time: '2026-01-01T00:00:01.000Z',
      end_time: '2026-01-01T00:00:02.000Z',
      duration_ms: 1000,
      attributes: {
        'llm.input_tokens': index + 1,
        'llm.output_tokens': 1,
        step: index,
      },
    }))

    const metrics = computeTraceMetrics(calls)

    expect(metrics.tokenSequences).toHaveLength(25_000)
    expect(metrics.tokenSequences.every((sequence) => sequence.spanIds.length === 1)).toBe(true)
    expect(metrics.signals).toEqual([])
  })

  it('resolves 25,000 nested parent links without repeated ancestry walks', () => {
    const base = 1_704_067_200_000
    const calls = Array.from({ length: 25_000 }, (_, index) => ({
      ...llmSpan(index + 1, index + 1, 1),
      span_id: `nested-${index}`,
      parent_span_id: index === 0 ? 'missing-root' : `nested-${index - 1}`,
      start_time: String(base + index * 2),
      end_time: String(base + index * 2 + 1),
      duration_ms: 1,
    }))

    const metrics = computeTraceMetrics(calls)

    expect(metrics.tokenSequences.map((sequence) => sequence.spanIds.length)).toEqual([25_000])
    expect(metrics.signals.map((signal) => signal.code)).toContain('monotonic-input-growth')
  })

  it('orders malformed timestamps deterministically regardless of input order', () => {
    const valid = [llmSpan(1, 100, 90), llmSpan(4, 400, 60), llmSpan(2, 900, 30)]
    const malformed = {
      ...llmSpan(3, 200, 80),
      span_id: 'malformed',
      start_time: 'invalid',
      end_time: 'invalid',
      duration_ms: 0,
    }

    const forward = computeTraceMetrics([malformed, ...valid])
    const reversed = computeTraceMetrics([...valid].reverse().concat(malformed))

    expect(reversed.tokenSequences).toEqual(forward.tokenSequences)
    expect(reversed.signals).toEqual(forward.signals)
  })

  it('treats an incomplete timed lane as a barrier between serial calls', () => {
    const calls = [
      llmSpan(1, 100, 90),
      { ...llmSpan(2, 500, 70), end_time: 'invalid' },
      llmSpan(3, 300, 50),
      llmSpan(4, 900, 30),
    ]

    const metrics = computeTraceMetrics(calls)

    expect(metrics.tokenSequences.map((sequence) => sequence.spanIds)).toEqual([
      ['llm-3', 'llm-4'],
      ['llm-1'],
      ['llm-2'],
    ])
    expect(metrics.signals.map((signal) => signal.code)).not.toContain('monotonic-input-growth')
  })

  it('preserves complete sequences after a lane whose start time is missing', () => {
    const incomplete = {
      ...llmSpan(1, 50, 10),
      span_id: 'incomplete',
      start_time: 'invalid',
      end_time: '2026-01-01T00:00:00.500Z',
      duration_ms: 0,
    }
    const complete = [llmSpan(2, 100, 10), llmSpan(3, 300, 10), llmSpan(4, 900, 10)]

    const metrics = computeTraceMetrics([incomplete, ...complete])

    expect(metrics.tokenSequences.map((sequence) => sequence.spanIds)).toEqual([
      ['llm-2', 'llm-3', 'llm-4'],
      ['incomplete'],
    ])
    expect(metrics.signals.map((signal) => signal.code)).toContain('monotonic-input-growth')
  })

  it('still detects a trend inside one worker when another worker is present', () => {
    const workers: TraceAnalystSpan[] = ['a', 'b'].map((id) => ({
      ...llmSpan(1, 0, 0),
      span_id: `worker-${id}`,
      parent_span_id: 'root',
      name: `worker.${id}`,
      kind: 'AGENT',
      model_name: null,
      attributes: {},
    }))
    const workerA = [100, 400, 900].map((input, index) => ({
      ...llmSpan(index + 1, input, 90 - index * 30),
      parent_span_id: 'worker-a',
    }))
    const workerB = {
      ...llmSpan(1, 50, 20),
      span_id: 'worker-b-call',
      parent_span_id: 'worker-b',
    }

    const metrics = computeTraceMetrics([...workers, ...workerA, workerB])

    expect(metrics.tokenSequences.map((sequence) => sequence.spanIds.length)).toEqual([3, 1])
    expect(metrics.signals.map((signal) => signal.code)).toContain('monotonic-input-growth')
    expect(metrics.signals.map((signal) => signal.code)).toContain('output-length-decay')
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

  it('keeps finding identity stable across trace ids and cross-run diffs', () => {
    const a = deriveEfficiencyFindings(computeTraceMetrics(fixture530()), { producedAt: 'x' })
    const secondTrace = fixture530().map((span) => ({ ...span, trace_id: 't2' }))
    const b = deriveEfficiencyFindings(computeTraceMetrics(secondTrace), { producedAt: 'x' })
    expect(a.map((f) => f.finding_id)).toEqual(b.map((f) => f.finding_id))
    const diff = diffFindings(
      a.map((finding) => ({ ...finding, run_id: 'old' })),
      b.map((finding) => ({ ...finding, run_id: 'new' })),
    )
    expect(diff.appeared).toEqual([])
    expect(diff.disappeared).toEqual([])
    expect(diff.persisted).toHaveLength(4)
  })
})
