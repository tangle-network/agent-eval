import { describe, expect, it } from 'vitest'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'
import { computeToolUseMetrics } from '../src/tool-use-metrics'

describe('computeToolUseMetrics', () => {
  it('returns zeroed shape when no tool calls present', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const m = await computeToolUseMetrics(store, e.runId)
    expect(m.totalCalls).toBe(0)
    expect(m.errorRate).toBe(0)
  })

  it('counts duplicates by (toolName, argHash) — regression: arg-order variance would miss dupes', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const a = await e.tool({ name: 'search', toolName: 'search', args: { q: 'x', limit: 10 } })
    await a.end({ latencyMs: 10 } as Partial<import('../src/trace').ToolSpan>)
    const b = await e.tool({ name: 'search', toolName: 'search', args: { limit: 10, q: 'x' } }) // keys reordered
    await b.end({ latencyMs: 15 } as Partial<import('../src/trace').ToolSpan>)
    const m = await computeToolUseMetrics(store, e.runId)
    expect(m.totalCalls).toBe(2)
    expect(m.duplicateRate).toBeCloseTo(0.5)
  })

  it('tracks error rate and retry rate', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const errored = await e.tool({ name: 'write', toolName: 'write', args: { path: '/x' } })
    await errored.fail('permission denied')
    const retried = await e.tool({ name: 'write', toolName: 'write', args: { path: '/tmp/x' } })
    await retried.end()
    const clean = await e.tool({ name: 'read', toolName: 'read', args: { path: '/x' } })
    await clean.end()
    const m = await computeToolUseMetrics(store, e.runId)
    expect(m.totalCalls).toBe(3)
    expect(m.errorRate).toBeCloseTo(1 / 3, 3)
    expect(m.retryRate).toBe(1)
  })

  it('selectionAccuracy is present only when labels provided', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const t1 = await e.tool({ name: 'search', toolName: 'search', args: {} })
    await t1.end()
    const t2 = await e.tool({ name: 'write', toolName: 'write', args: {} })
    await t2.end()

    const m = await computeToolUseMetrics(store, e.runId)
    expect(m.selectionAccuracy).toBeUndefined()

    const labeled = await computeToolUseMetrics(store, e.runId, {
      selectionLabels: { [t1.span.spanId]: true, [t2.span.spanId]: false },
    })
    expect(labeled.selectionAccuracy).toBeCloseTo(0.5)
  })
})
