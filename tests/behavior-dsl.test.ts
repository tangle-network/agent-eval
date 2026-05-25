import { describe, expect, it } from 'vitest'
import { expectAgent, runExpectations } from '../src/behavior-dsl'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

async function setupRun(
  configure: (e: TraceEmitter) => Promise<void>,
): Promise<{ store: InMemoryTraceStore; runId: string }> {
  const store = new InMemoryTraceStore()
  const e = new TraceEmitter(store)
  await e.startRun({ scenarioId: 's' })
  await configure(e)
  await e.endRun({ pass: true })
  return { store, runId: e.runId }
}

describe('BehaviorAssertion.toCall', () => {
  it('passes when tool called with matching args', async () => {
    const { store, runId } = await setupRun(async (e) => {
      const h = await e.tool({ name: 'search', toolName: 'search', args: { q: 'hello' } })
      await h.end()
    })
    const r = await expectAgent(store, runId).toCall('search').withArgs({ q: /hell/ }).check()
    expect(r.ok).toBe(true)
  })

  it('fails when called zero times', async () => {
    const { store, runId } = await setupRun(async () => {})
    const r = await expectAgent(store, runId).toCall('search').check()
    expect(r.ok).toBe(false)
    expect(r.detail).toMatch(/0/)
  })

  it('times() enforces exact count', async () => {
    const { store, runId } = await setupRun(async (e) => {
      for (let i = 0; i < 3; i++) {
        const h = await e.tool({ name: 'read', toolName: 'read', args: { i } })
        await h.end()
      }
    })
    expect((await expectAgent(store, runId).toCall('read').times(3).check()).ok).toBe(true)
    expect((await expectAgent(store, runId).toCall('read').times(2).check()).ok).toBe(false)
  })
})

describe('BehaviorAssertion.toRefuse', () => {
  it('passes on refusal marker', async () => {
    const { store, runId } = await setupRun(async (e) => {
      const h = await e.span({
        kind: 'llm',
        name: 'gen',
        model: 'm',
        messages: [],
        output: "I can't help with that.",
      })
      await h.end()
    })
    const r = await expectAgent(store, runId).toRefuse().check()
    expect(r.ok).toBe(true)
  })

  it('fails without refusal marker — regression: silent compliance looks like success', async () => {
    const { store, runId } = await setupRun(async (e) => {
      const h = await e.span({
        kind: 'llm',
        name: 'gen',
        model: 'm',
        messages: [],
        output: 'Here is the code you asked for.',
      })
      await h.end()
    })
    const r = await expectAgent(store, runId).toRefuse().check()
    expect(r.ok).toBe(false)
  })
})

describe('BehaviorAssertion budget + completion', () => {
  it('toRespectBudget fails when breach event exists', async () => {
    const { store, runId } = await setupRun(async (e) => {
      await e.recordBudget({
        dimension: 'tokens',
        limit: 5,
        consumed: 6,
        remaining: -1,
        breached: true,
      })
    })
    expect((await expectAgent(store, runId).toRespectBudget('tokens').check()).ok).toBe(false)
    expect((await expectAgent(store, runId).toRespectBudget('usd').check()).ok).toBe(true)
  })

  it('toCompleteWithin checks tool + llm + wall caps', async () => {
    const { store, runId } = await setupRun(async (e) => {
      const h = await e.tool({ name: 'search', toolName: 'search', args: {} })
      await h.end()
      const h2 = await e.tool({ name: 'read', toolName: 'read', args: {} })
      await h2.end()
    })
    expect((await expectAgent(store, runId).toCompleteWithin({ toolCalls: 2 }).check()).ok).toBe(
      true,
    )
    expect((await expectAgent(store, runId).toCompleteWithin({ toolCalls: 1 }).check()).ok).toBe(
      false,
    )
  })

  it('toNeverCall passes when tool not invoked', async () => {
    const { store, runId } = await setupRun(async () => {})
    expect((await expectAgent(store, runId).toNeverCall('shell').check()).ok).toBe(true)
  })
})

describe('runExpectations', () => {
  it('collects results without throwing on individual failures', async () => {
    const { store, runId } = await setupRun(async () => {})
    const report = await runExpectations([
      expectAgent(store, runId).toCall('search'), // fails
      expectAgent(store, runId).toNeverCall('shell'), // passes
    ])
    expect(report.passCount).toBe(1)
    expect(report.failCount).toBe(1)
    expect(report.pass).toBe(false)
  })
})
