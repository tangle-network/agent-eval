import { describe, expect, it } from 'vitest'
import { exportRunAsOtlp, InMemoryTraceStore, TraceEmitter } from '../src/trace'

describe('OTLP export', () => {
  it('maps a run + spans into OTLP resource spans — regression: missing fields break Jaeger render', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 'scn-1', variantId: 'v1', codeSha: 'abc123' })
    const root = await emitter.span({ kind: 'agent', name: 'root' })
    const tool = await emitter.span({
      kind: 'tool',
      name: 'search',
      toolName: 'search',
      args: { q: 'x' },
    })
    await tool.end({ latencyMs: 42 } as Partial<import('../src/trace').ToolSpan>)
    await root.end()
    await emitter.endRun({ pass: true, score: 0.8 })

    const otlp = await exportRunAsOtlp(store, emitter.runId, { 'deployment.environment': 'test' })
    const scope = otlp.resourceSpans[0].scopeSpans[0]
    expect(scope.spans).toHaveLength(2)
    const toolSpan = scope.spans.find((s) => s.name === 'search')!
    expect(
      toolSpan.attributes.find((a) => a.key === 'openinference.span.kind')?.value.stringValue,
    ).toBe('TOOL')
    expect(toolSpan.attributes.find((a) => a.key === 'span.kind')).toBeUndefined()
    expect(toolSpan.attributes.find((a) => a.key === 'tool.name')?.value.stringValue).toBe('search')
    expect(toolSpan.attributes.find((a) => a.key === 'tool.args_captured')?.value.boolValue).toBe(
      true,
    )
    expect(toolSpan.attributes.find((a) => a.key === 'input.value')?.value.stringValue).toBe(
      '{"q":"x"}',
    )
    expect(toolSpan.attributes.find((a) => a.key === 'tool.latency_ms')?.value.intValue).toBe('42')
    // Resource attrs carry run metadata
    const resAttrs = otlp.resourceSpans[0].resource.attributes
    expect(resAttrs.find((a) => a.key === 'run.scenario_id')?.value.stringValue).toBe('scn-1')
    expect(resAttrs.find((a) => a.key === 'deployment.environment')?.value.stringValue).toBe('test')
  })

  it('distinguishes unavailable arguments from a captured no-argument call', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    const tool = await emitter.tool({
      name: 'search',
      toolName: 'search',
      args: undefined,
      argsCaptured: false,
    })
    await tool.end()
    const noArgs = await emitter.tool({
      name: 'list',
      toolName: 'list',
      args: undefined,
      argsCaptured: true,
    })
    await noArgs.end()

    const otlp = await exportRunAsOtlp(store, emitter.runId)
    const spans = otlp.resourceSpans[0]!.scopeSpans[0]!.spans
    const unavailable = spans.find((span) => span.name === 'search')!.attributes
    const captured = spans.find((span) => span.name === 'list')!.attributes

    expect(unavailable.find((a) => a.key === 'tool.args_captured')?.value.boolValue).toBe(false)
    expect(unavailable.find((a) => a.key === 'input.value')).toBeUndefined()
    expect(captured.find((a) => a.key === 'tool.args_captured')?.value.boolValue).toBe(true)
    expect(captured.find((a) => a.key === 'input.value')?.value.stringValue).toBe('null')
  })

  it('does not let custom attributes overwrite canonical tool evidence', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    const tool = await emitter.tool({
      name: 'search',
      toolName: 'search',
      args: undefined,
      argsCaptured: false,
      attributes: {
        'openinference.span.kind': 'LLM',
        'tool.name': 'forged',
        'tool.args_captured': true,
        'input.value': 'forged',
      },
    })
    await tool.end()

    const otlp = await exportRunAsOtlp(store, emitter.runId)
    const attributes = otlp.resourceSpans[0]!.scopeSpans[0]!.spans[0]!.attributes

    expect(attributes.find((a) => a.key === 'openinference.span.kind')?.value.stringValue).toBe(
      'TOOL',
    )
    expect(attributes.find((a) => a.key === 'tool.name')?.value.stringValue).toBe('search')
    expect(attributes.find((a) => a.key === 'tool.args_captured')?.value.boolValue).toBe(false)
    expect(attributes.find((a) => a.key === 'input.value')).toBeUndefined()
  })

  it('sets status=error with message on failed spans', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    await expect(
      emitter.within({ kind: 'custom', name: 'crash' }, async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow()
    const otlp = await exportRunAsOtlp(store, emitter.runId)
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0]
    expect(span.status?.code).toBe(2)
    expect(span.status?.message).toBe('boom')
  })

  it('span + trace ids are valid hex of proper lengths', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    const h = await emitter.span({ kind: 'agent', name: 'a' })
    await h.end()
    const otlp = await exportRunAsOtlp(store, emitter.runId)
    const span = otlp.resourceSpans[0].scopeSpans[0].spans[0]
    expect(span.spanId).toMatch(/^[0-9a-f]{16}$/i)
    expect(span.traceId).toMatch(/^[0-9a-f]{32}$/i)
  })
})
