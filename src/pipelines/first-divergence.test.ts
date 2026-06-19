import { describe, expect, it } from 'vitest'
import type { Span } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { firstDivergenceView } from './first-divergence'

function llm(runId: string, n: number, model: string): Span {
  return {
    spanId: `${runId}-llm-${n}`,
    runId,
    kind: 'llm',
    name: `llm.step.${n}`,
    startedAt: n * 1000,
    endedAt: n * 1000 + 100,
    model,
    messages: [],
  }
}

async function seed(store: InMemoryTraceStore, runId: string, spans: Span[]): Promise<void> {
  for (const s of spans) await store.appendSpan(s)
  // buildTrajectory only reads spans + events; a run row isn't required for it.
  void runId
}

describe('firstDivergenceView', () => {
  it('reports the first differing step on equal-length, diverging trajectories', async () => {
    const store = new InMemoryTraceStore()
    await seed(store, 'A', [llm('A', 1, 'm1'), llm('A', 2, 'm1')])
    await seed(store, 'B', [llm('B', 1, 'm1'), llm('B', 2, 'm2')])
    const r = await firstDivergenceView(store, 'A', 'B')
    expect(r.firstDivergenceIndex).toBe(1)
    expect(r.aStep).toBeDefined()
    expect(r.bStep).toBeDefined()
    expect(r.reason).toContain('model m1 vs m2')
  })

  it('handles one empty trajectory without leaking "index -1" or an undefined step', async () => {
    const store = new InMemoryTraceStore()
    // Run A is empty (no spans); run B has steps.
    await seed(store, 'A', [])
    await seed(store, 'B', [llm('B', 1, 'm1'), llm('B', 2, 'm1')])
    const r = await firstDivergenceView(store, 'A', 'B')
    // Divergence is the first step itself, not minLen-1 === -1.
    expect(r.firstDivergenceIndex).toBe(0)
    expect(r.commonPrefixLen).toBe(0)
    expect(r.reason).not.toContain('index -1')
    expect(r.reason).toContain('index 0')
    // The empty side has no step at index 0; the present side does.
    expect(r.aStep).toBeUndefined()
    expect(r.bStep).toBeDefined()
    expect(r.bStep!.index).toBe(0)
  })

  it('reports identical trajectories as no divergence', async () => {
    const store = new InMemoryTraceStore()
    await seed(store, 'A', [llm('A', 1, 'm1')])
    await seed(store, 'B', [llm('B', 1, 'm1')])
    const r = await firstDivergenceView(store, 'A', 'B')
    expect(r.firstDivergenceIndex).toBeNull()
    expect(r.commonPrefixLen).toBe(1)
  })
})
