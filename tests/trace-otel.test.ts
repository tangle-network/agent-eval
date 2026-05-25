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
    expect(toolSpan.attributes.find((a) => a.key === 'tool.name')?.value.stringValue).toBe('search')
    expect(toolSpan.attributes.find((a) => a.key === 'tool.latency_ms')?.value.intValue).toBe('42')
    // Resource attrs carry run metadata
    const resAttrs = otlp.resourceSpans[0].resource.attributes
    expect(resAttrs.find((a) => a.key === 'run.scenario_id')?.value.stringValue).toBe('scn-1')
    expect(resAttrs.find((a) => a.key === 'deployment.environment')?.value.stringValue).toBe('test')
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
