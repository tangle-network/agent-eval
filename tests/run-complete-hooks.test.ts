import { describe, it, expect } from 'vitest'
import { InMemoryTraceStore } from '../src/trace/store'
import { TraceEmitter, type RunCompleteHook } from '../src/trace/emitter'

describe('TraceEmitter onRunComplete hooks', () => {
  it('fires hooks in order after endRun, with run context', async () => {
    const store = new InMemoryTraceStore()
    const calls: Array<{ runId: string; status: string; pass?: boolean }> = []
    const hook: RunCompleteHook = (ctx) => {
      calls.push({ runId: ctx.runId, status: ctx.status, pass: ctx.outcome?.pass })
    }
    const emitter = new TraceEmitter(store, { onRunComplete: [hook, hook] })
    await emitter.startRun({ scenarioId: 'x' })
    await emitter.endRun({ pass: true, score: 0.9 })
    expect(calls).toHaveLength(2)
    expect(calls[0]).toEqual({ runId: emitter.runId, status: 'completed', pass: true })
  })

  it('fires hooks on abortRun with status=aborted', async () => {
    const store = new InMemoryTraceStore()
    const seen: string[] = []
    const emitter = new TraceEmitter(store, {
      onRunComplete: [(ctx) => { seen.push(ctx.status) }],
    })
    await emitter.startRun({ scenarioId: 'x' })
    await emitter.abortRun('user cancelled')
    expect(seen).toEqual(['aborted'])
  })

  it('swallows hook errors by default and writes a log event', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store, {
      onRunComplete: [() => { throw new Error('boom') }],
    })
    await emitter.startRun({ scenarioId: 'x' })
    await expect(emitter.endRun({ pass: true })).resolves.toBeUndefined()
    const events = await store.events({ runId: emitter.runId })
    expect(events.some((e) => e.kind === 'log' && (e.payload as { source?: string }).source === 'run_complete_hook')).toBe(true)
  })

  it('propagates hook errors when hookErrors=throw', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store, {
      onRunComplete: [() => { throw new Error('boom') }],
      hookErrors: 'throw',
    })
    await emitter.startRun({ scenarioId: 'x' })
    await expect(emitter.endRun({ pass: true })).rejects.toThrow('boom')
  })

  it('addRunCompleteHook attaches hooks after construction', async () => {
    const store = new InMemoryTraceStore()
    const seen: string[] = []
    const emitter = new TraceEmitter(store)
    emitter.addRunCompleteHook(() => { seen.push('hi') })
    await emitter.startRun({ scenarioId: 'x' })
    await emitter.endRun({ pass: true })
    expect(seen).toEqual(['hi'])
  })
})
