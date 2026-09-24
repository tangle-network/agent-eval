import { describe, expect, it } from 'vitest'
import { ingestSpans } from '../diagnosis/spans'
import type { Span } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { diffSteps, diffStepsFromSpans, firstDivergenceView } from './first-divergence'

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

function tool(runId: string, n: number, name: string, status: 'ok' | 'error' = 'ok'): Span {
  return {
    spanId: `${runId}-tool-${n}`,
    runId,
    kind: 'tool',
    name,
    toolName: name,
    args: {},
    status,
    startedAt: n * 1000,
    endedAt: n * 1000 + 100,
  }
}

async function diffOf(a: string[], b: string[]) {
  const store = new InMemoryTraceStore()
  await seed(
    store,
    'A',
    a.map((name, n) => tool('A', n, name)),
  )
  await seed(
    store,
    'B',
    b.map((name, n) => tool('B', n, name)),
  )
  return firstDivergenceView(store, 'A', 'B')
}

describe('firstDivergenceView step pairing', () => {
  it('marks an inserted step and pairs the steps after it by name', async () => {
    const r = await diffOf(['read', 'edit', 'test'], ['read', 'search', 'edit', 'test'])
    expect(r.firstDivergenceIndex).toBe(1)
    expect(r.diff.firstDivergence?.kind).toBe('only-in-b')
    expect(r.reason).toBe('at index 1, only B has tool "search"')
    expect(r.diff.onlyInB).toEqual([1])
    expect(r.diff.onlyInA).toEqual([])
    expect(r.diff.pairs.map((p) => [p.a, p.b, p.pairedBy])).toEqual([
      [0, 0, 'position'],
      [1, 2, 'name'],
      [2, 3, 'name'],
    ])
  })

  it('marks a removed step', async () => {
    const r = await diffOf(['read', 'edit', 'test'], ['read', 'test'])
    expect(r.diff.firstDivergence).toMatchObject({ index: 1, kind: 'only-in-a', a: 1, b: 1 })
    expect(r.diff.onlyInA).toEqual([1])
  })

  it('marks the same steps run in a different order', async () => {
    const r = await diffOf(['edit', 'test'], ['test', 'edit'])
    expect(r.diff.firstDivergence?.kind).toBe('reordered')
    expect(r.diff.onlyInA).toEqual([])
    expect(r.diff.onlyInB).toEqual([])
  })

  it('reports a step that failed in one run and succeeded in the other', async () => {
    const store = new InMemoryTraceStore()
    await seed(store, 'A', [tool('A', 0, 'read'), tool('A', 1, 'test')])
    await seed(store, 'B', [tool('B', 0, 'read'), tool('B', 1, 'test', 'error')])
    const r = await firstDivergenceView(store, 'A', 'B')
    expect(r.diff.firstDivergence).toMatchObject({
      index: 1,
      kind: 'changed',
      differences: [{ field: 'status', a: 'ok', b: 'error' }],
    })
    expect(r.reason).toBe('at index 1, tool "test" changed: status ok vs error')
  })

  it('pairs steps by id first, so a renamed step in a forked run reads as changed', async () => {
    const store = new InMemoryTraceStore()
    await seed(store, 'A', [{ ...tool('A', 0, 'plan'), spanId: 'shared' }])
    await seed(store, 'B', [{ ...tool('B', 0, 'plan'), spanId: 'shared', name: 'plan-v2' }])
    const r = await firstDivergenceView(store, 'A', 'B')
    expect(r.diff.pairs).toEqual([
      { a: 0, b: 0, pairedBy: 'id', differences: [{ field: 'name', a: 'plan', b: 'plan-v2' }] },
    ])
    expect(r.diff.firstDivergence?.kind).toBe('changed')
  })
})

describe('diffSteps over flat spans', () => {
  it('orders spans depth first and diffs two OTLP runs', () => {
    const at = (ms: number) => `${BigInt(Date.parse('2026-09-24T00:00:00Z') + ms) * 1_000_000n}`
    const run = (trace: string, tools: string[], failLast = false) =>
      ingestSpans(
        [
          {
            trace_id: trace,
            span_id: `${trace}-root`,
            parent_span_id: null,
            name: 'session',
            start_time: at(0),
            end_time: at(1000),
            attributes: { 'openinference.span.kind': 'AGENT' },
          },
          ...tools.map((name, n) => ({
            trace_id: trace,
            span_id: `${trace}-${n}`,
            parent_span_id: `${trace}-root`,
            name,
            start_time: at(100 * (tools.length - n)),
            end_time: at(100 * (tools.length - n) + 10),
            status_code: failLast && n === 0 ? 'STATUS_CODE_ERROR' : 'STATUS_CODE_OK',
            attributes: { 'openinference.span.kind': 'TOOL', 'gen_ai.tool.name': name },
          })),
        ],
        { contentIncluded: false },
      ).spans
    const a = diffStepsFromSpans(run('ta', ['test', 'edit']))
    const b = diffStepsFromSpans(run('tb', ['test', 'edit'], true))
    // Children sort by start time, so the later-listed span that started first comes first.
    expect(a.map((step) => step.name)).toEqual(['session', 'edit', 'test'])
    const diff = diffSteps(a, b)
    expect(diff.firstDivergence).toMatchObject({
      index: 2,
      kind: 'changed',
      differences: [{ field: 'status', a: 'OK', b: 'ERROR' }],
    })
  })

  it('keeps spans whose parents form a cycle', () => {
    const spans = ingestSpans(
      [
        { trace_id: 't', span_id: 'a', parent_span_id: 'b', name: 'a', start_time: '1' },
        { trace_id: 't', span_id: 'b', parent_span_id: 'a', name: 'b', start_time: '2' },
      ],
      { contentIncluded: false },
    ).spans
    expect(diffStepsFromSpans(spans).map((step) => step.id)).toEqual(['a', 'b'])
  })
})
