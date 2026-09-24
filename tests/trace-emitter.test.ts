import { describe, expect, it } from 'vitest'
import { type CaptureWrite, TraceEmitter } from '../src/trace/emitter'
import { assertRunCaptured } from '../src/trace/integrity'
import type { Span } from '../src/trace/schema'
import { InMemoryTraceStore } from '../src/trace/store'

/** A store whose span appends fail while `failing` is set. */
class FlakySpanStore extends InMemoryTraceStore {
  failing = false
  override async appendSpan(span: Span): Promise<void> {
    if (this.failing) throw new Error('disk full')
    return super.appendSpan(span)
  }
}

describe('TraceEmitter capture', () => {
  it('keeps a failing store write out of the traced run and records the loss on the run', async () => {
    const store = new FlakySpanStore()
    const reported: CaptureWrite[] = []
    const emitter = new TraceEmitter(store, {
      onCaptureError: (_error, write) => reported.push(write),
    })
    await emitter.startRun({ scenarioId: 's' })
    store.failing = true
    const result = await emitter.within({ kind: 'tool', name: 'lost' }, async () => 'answer')
    store.failing = false
    await emitter.endRun({ pass: true })

    expect(result).toBe('answer')
    // The span append failed, then ending the unwritten span failed too.
    expect(reported).toEqual(['appendSpan', 'updateSpan'])
    const run = await store.getRun(emitter.runId)
    expect(run?.capture).toEqual({
      written: 1,
      dropped: 2,
      lastError: expect.stringContaining('updateSpan'),
    })

    const integrity = await assertRunCaptured(store, emitter.runId)
    expect(integrity.ok).toBe(false)
    expect(integrity.issues.map((issue) => issue.code)).toEqual(['dropped_writes'])
  })

  it('records a clean account when every write landed', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    await emitter.within({ kind: 'tool', name: 't' }, async () => undefined)
    await emitter.endRun({ pass: true })

    expect((await store.getRun(emitter.runId))?.capture).toEqual({ written: 3, dropped: 0 })
    expect((await assertRunCaptured(store, emitter.runId)).ok).toBe(true)
  })

  it('ignores a reporter that throws', async () => {
    const store = new FlakySpanStore()
    store.failing = true
    const emitter = new TraceEmitter(store, {
      onCaptureError: () => {
        throw new Error('reporter broke')
      },
    })
    await emitter.startRun({ scenarioId: 's' })
    await expect(emitter.within({ kind: 'tool', name: 't' }, async () => 1)).resolves.toBe(1)
    expect(emitter.captureStats().dropped).toBe(2)
  })

  it('still fails the span and rethrows when the traced code throws', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    await expect(
      emitter.within({ kind: 'tool', name: 't' }, async () => {
        throw new Error('tool broke')
      }),
    ).rejects.toThrow('tool broke')
    const [span] = await store.spans({ runId: emitter.runId })
    expect(span).toMatchObject({ status: 'error', error: 'tool broke' })
  })
})

describe('TraceEmitter parenting', () => {
  it('parents children of parallel within calls to their own span', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    const root = await emitter.span({ kind: 'agent', name: 'root' })
    await Promise.all(
      ['a', 'b', 'c'].map((arm) =>
        emitter.within({ kind: 'agent', name: `arm-${arm}` }, async () => {
          // Yield so the three arms interleave.
          await new Promise((resolve) => setTimeout(resolve, 1))
          await emitter.within({ kind: 'tool', name: `tool-${arm}` }, async () => undefined)
        }),
      ),
    )
    await root.end()

    const spans = await store.spans({ runId: emitter.runId })
    const byName = new Map(spans.map((span) => [span.name, span]))
    for (const arm of ['a', 'b', 'c']) {
      expect(byName.get(`arm-${arm}`)?.parentSpanId).toBe(root.span.spanId)
      expect(byName.get(`tool-${arm}`)?.parentSpanId).toBe(byName.get(`arm-${arm}`)?.spanId)
    }
  })

  it('nests handles by call order and attaches events to the open span', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    const outer = await emitter.span({ kind: 'agent', name: 'outer' })
    const inner = await emitter.tool({ name: 'inner', toolName: 'shell', args: {} })
    const event = await emitter.emit({ kind: 'log' })
    await inner.end()
    const sibling = await emitter.tool({ name: 'sibling', toolName: 'shell', args: {} })
    await sibling.end()
    await outer.end()

    expect(inner.span.parentSpanId).toBe(outer.span.spanId)
    expect(event.spanId).toBe(inner.span.spanId)
    expect(sibling.span.parentSpanId).toBe(outer.span.spanId)
    expect(emitter.currentSpanId()).toBeUndefined()
  })

  it('keeps an explicit parent even when the caller passes undefined keys', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 's' })
    const outer = await emitter.span({ kind: 'agent', name: 'outer' })
    const child = await emitter.span({ kind: 'tool', name: 'child', parentSpanId: undefined })
    expect(child.span.parentSpanId).toBe(outer.span.spanId)
  })
})
