import { describe, expect, it } from 'vitest'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'
import { classifyFailure } from '../src/failure-taxonomy'

async function ctxFor(store: InMemoryTraceStore, runId: string) {
  const run = (await store.getRun(runId))!
  const spans = await store.spans({ runId })
  const events = await store.events({ runId })
  return { run, spans, events }
}

describe('classifyFailure', () => {
  it('returns success when run completed with pass=true', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.endRun({ pass: true, score: 1 })
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('success')
  })

  it('detects budget breach — regression: budget kills would hide as "unknown"', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.recordBudget({ dimension: 'tokens', limit: 10, consumed: 11, remaining: -1, breached: true })
    await e.endRun({ pass: false })
    const ctx = await ctxFor(store, e.runId)
    const c = classifyFailure(ctx)
    expect(c.failureClass).toBe('budget_exceeded')
    expect(c.triggerEventId).toBeDefined()
  })

  it('detects sandbox exit code non-zero', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const h = await e.sandbox({ name: 'test', command: 'npm test' })
    await h.end({ exitCode: 1, status: 'error' } as Partial<import('../src/trace').SandboxSpan>)
    await e.endRun({ pass: false })
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('sandbox_failure')
  })

  it('classifies timeout when aborted with matching note', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.abortRun('wall-clock deadline exceeded (timeout)')
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('timeout')
  })

  it('detects repeated tool errors as tool_recovery_failure', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    for (let i = 0; i < 3; i++) {
      const h = await e.tool({ name: 'search', toolName: 'search', args: { q: `q${i}` } })
      await h.fail('HTTP 500')
    }
    await e.endRun({ pass: false })
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('tool_recovery_failure')
  })

  it('explicit outcome.failureClass wins over rules', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.endRun({ pass: false, failureClass: 'policy_violation' })
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('policy_violation')
  })

  it('falls through to unknown when nothing else matches', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    await e.endRun({ pass: false })
    const ctx = await ctxFor(store, e.runId)
    expect(classifyFailure(ctx).failureClass).toBe('unknown')
  })
})
