import { describe, expect, it } from 'vitest'
import type { Run, Span, ToolSpan } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { stuckLoopView } from './stuck-loop'

function tool(i: number, name: string, args: unknown, startedAt = 1000 + i * 1000): ToolSpan {
  return {
    spanId: `t${i}`,
    runId: 'r',
    kind: 'tool',
    name: `tool.${name}`,
    startedAt,
    endedAt: startedAt + 100,
    toolName: name,
    args,
  }
}

async function storeWith(spans: Span[]): Promise<InMemoryTraceStore> {
  const store = new InMemoryTraceStore()
  await store.appendRun({ runId: 'r', scenarioId: 's' } as Run)
  for (const s of spans) await store.appendSpan(s)
  return store
}

describe('stuckLoopView', () => {
  it('flags a loop at exactly minOccurrences, windowMs spans first→last', async () => {
    const store = await storeWith([
      tool(0, 'bash', { cmd: 'x' }),
      tool(1, 'bash', { cmd: 'x' }),
      tool(2, 'bash', { cmd: 'x' }),
    ])
    const r = await stuckLoopView(store, { minOccurrences: 3 })
    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.occurrences).toBe(3)
    expect(r.findings[0]!.windowMs).toBe(2000)
    expect(r.affectedRunRatio).toBe(1)
  })

  it('preserves a tool name containing the delimiter (regression: split("|") mislabel)', async () => {
    const store = await storeWith([
      tool(0, 'shell|grep', { q: 'x' }),
      tool(1, 'shell|grep', { q: 'x' }),
      tool(2, 'shell|grep', { q: 'x' }),
    ])
    const r = await stuckLoopView(store, { minOccurrences: 3 })
    expect(r.findings[0]!.toolName).toBe('shell|grep')
  })

  it('does not collapse two distinct tools whose names+hashes alias across the delimiter', async () => {
    // "a|b" with hash "c" vs "a" with hash "b|c" used to share a key.
    const store = await storeWith([
      tool(0, 'a|b', { k: 'c' }),
      tool(1, 'a|b', { k: 'c' }),
      tool(2, 'a|b', { k: 'c' }),
      tool(3, 'a', { k: 'b|c' }),
      tool(4, 'a', { k: 'b|c' }),
      tool(5, 'a', { k: 'b|c' }),
    ])
    const r = await stuckLoopView(store, { minOccurrences: 3 })
    const names = r.findings.map((f) => f.toolName).sort()
    expect(names).toEqual(['a', 'a|b'])
  })

  it('does not flag distinct args as a loop', async () => {
    const store = await storeWith([
      tool(0, 'bash', { cmd: 'a' }),
      tool(1, 'bash', { cmd: 'b' }),
      tool(2, 'bash', { cmd: 'c' }),
    ])
    const r = await stuckLoopView(store, { minOccurrences: 3 })
    expect(r.findings).toHaveLength(0)
  })

  it('does not treat uncaptured arguments as identical calls', async () => {
    const calls = [0, 1, 2].map((index) => ({
      ...tool(index, 'bash', undefined),
      argsCaptured: false,
    }))

    const r = await stuckLoopView(await storeWith(calls))

    expect(r.findings).toHaveLength(0)
  })

  it('does not treat identical calls spread across a long run as a loop', async () => {
    const store = await storeWith([
      tool(0, 'bash', { cmd: 'status' }, 0),
      tool(1, 'bash', { cmd: 'status' }, 61_000),
      tool(2, 'bash', { cmd: 'status' }, 122_000),
    ])

    const r = await stuckLoopView(store)

    expect(r.findings).toHaveLength(0)
  })

  it('does not join periodic identical calls through intervening work', async () => {
    const store = await storeWith([
      tool(0, 'status', { scope: 'project' }, 0),
      tool(1, 'edit', { file: 'a.ts' }, 1000),
      tool(2, 'status', { scope: 'project' }, 2000),
      tool(3, 'test', { file: 'a.ts' }, 3000),
      tool(4, 'status', { scope: 'project' }, 4000),
    ])

    const r = await stuckLoopView(store)

    expect(r.findings).toHaveLength(0)
  })

  it('still detects a real contiguous tight loop', async () => {
    const store = await storeWith([
      tool(0, 'status', { scope: 'project' }, 0),
      tool(1, 'status', { scope: 'project' }, 1000),
      tool(2, 'status', { scope: 'project' }, 2000),
    ])

    const r = await stuckLoopView(store)

    expect(r.findings[0]).toMatchObject({
      occurrences: 3,
      spanIds: ['t0', 't1', 't2'],
      windowMs: 2000,
    })
  })

  it('can opt into one intervening call for alternating loops', async () => {
    const store = await storeWith([
      tool(0, 'status', { scope: 'project' }, 0),
      tool(1, 'inspect', { target: 'worker' }, 1000),
      tool(2, 'status', { scope: 'project' }, 2000),
      tool(3, 'inspect', { target: 'worker' }, 3000),
      tool(4, 'status', { scope: 'project' }, 4000),
    ])

    const r = await stuckLoopView(store, { maxInterveningToolCalls: 1 })

    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.spanIds).toEqual(['t0', 't2', 't4'])
  })

  it('preserves tight episodes separated by intervening work', async () => {
    const store = await storeWith([
      tool(0, 'status', { scope: 'project' }, 0),
      tool(1, 'status', { scope: 'project' }, 1000),
      tool(2, 'status', { scope: 'project' }, 2000),
      tool(3, 'edit', { file: 'a.ts' }, 3000),
      tool(4, 'status', { scope: 'project' }, 4000),
      tool(5, 'status', { scope: 'project' }, 5000),
      tool(6, 'status', { scope: 'project' }, 6000),
    ])

    const r = await stuckLoopView(store)

    expect(r.findings.map((finding) => finding.spanIds)).toEqual([
      ['t0', 't1', 't2'],
      ['t4', 't5', 't6'],
    ])
  })

  it('uses source order to resolve equal timestamps', async () => {
    const store = await storeWith([
      tool(0, 'status', { scope: 'project' }, 1000),
      tool(1, 'edit', { file: 'a.ts' }, 1000),
      tool(2, 'status', { scope: 'project' }, 1000),
      tool(3, 'status', { scope: 'project' }, 1000),
    ])

    const r = await stuckLoopView(store)

    expect(r.findings).toHaveLength(0)
  })

  it('does not combine one identical call from each parallel agent', async () => {
    const workers: Span[] = [0, 1, 2].map((index) => ({
      spanId: `worker-${index}`,
      runId: 'r',
      kind: 'agent',
      name: `worker.${index}`,
      startedAt: 0,
    }))
    const calls = [0, 1, 2].map((index) => ({
      ...tool(index, 'status', { scope: 'project' }, 1000),
      parentSpanId: `worker-${index}`,
    }))

    const r = await stuckLoopView(await storeWith([...workers, ...calls]))

    expect(r.findings).toHaveLength(0)
  })

  it('does not combine overlapping branches under one parent agent', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
      endedAt: 3000,
    }
    const branches: Span[] = [0, 1, 2].map((index) => ({
      spanId: `llm-${index}`,
      parentSpanId: 'agent',
      runId: 'r',
      kind: 'llm',
      name: `llm.${index}`,
      startedAt: 0,
      endedAt: 2000,
      model: 'model',
      messages: [],
    }))
    const calls = [0, 1, 2].map((index) => ({
      ...tool(index, 'status', { scope: 'project' }, 1000),
      parentSpanId: `llm-${index}`,
      endedAt: 1500,
    }))

    const r = await stuckLoopView(await storeWith([agent, ...branches, ...calls]))

    expect(r.findings).toHaveLength(0)
  })

  it('does not let parallel branch work hide a real loop on one branch', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
      endedAt: 10_000,
    }
    const branches: Span[] = ['a', 'b'].map((id) => ({
      spanId: `branch-${id}`,
      parentSpanId: 'agent',
      runId: 'r',
      kind: 'custom',
      name: `branch.${id}`,
      startedAt: 0,
      endedAt: 10_000,
    }))
    const looping = [0, 1, 2].map((index) => ({
      ...tool(index, 'status', { scope: 'project' }, 1000 + index * 2000),
      spanId: `status-${index}`,
      parentSpanId: 'branch-a',
      endedAt: 1100 + index * 2000,
    }))
    const parallel = [0, 1].map((index) => ({
      ...tool(index, 'inspect', { target: index }, 2000 + index * 2000),
      spanId: `inspect-${index}`,
      parentSpanId: 'branch-b',
      endedAt: 2100 + index * 2000,
    }))

    const r = await stuckLoopView(await storeWith([agent, ...branches, ...looping, ...parallel]))

    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.spanIds).toEqual(['status-0', 'status-1', 'status-2'])
  })

  it('keeps identical loops on parallel branches separate', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
      endedAt: 10_000,
    }
    const branches: Span[] = ['a', 'b'].map((id) => ({
      spanId: `branch-${id}`,
      parentSpanId: 'agent',
      runId: 'r',
      kind: 'custom',
      name: `branch.${id}`,
      startedAt: 0,
      endedAt: 10_000,
    }))
    const calls = ['a', 'b'].flatMap((branch) =>
      [0, 1, 2].map((index) => ({
        ...tool(index, 'status', { scope: 'project' }, 1000 + index * 1000),
        spanId: `${branch}-${index}`,
        parentSpanId: `branch-${branch}`,
        endedAt: 1100 + index * 1000,
      })),
    )

    const r = await stuckLoopView(await storeWith([agent, ...branches, ...calls]))

    expect(r.findings.map((finding) => finding.spanIds)).toEqual([
      ['a-0', 'a-1', 'a-2'],
      ['b-0', 'b-1', 'b-2'],
    ])
  })

  it('does not infer serial order across branches with incomplete timing', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
    }
    const branches: Span[] = [0, 1, 2].map((index) => ({
      spanId: `llm-${index}`,
      parentSpanId: 'agent',
      runId: 'r',
      kind: 'llm',
      name: `llm.${index}`,
      startedAt: 1000,
      model: 'model',
      messages: [],
    }))
    const calls = [0, 1, 2].map((index) => ({
      ...tool(index, 'status', { scope: 'project' }, 1000),
      parentSpanId: `llm-${index}`,
    }))

    const r = await stuckLoopView(await storeWith([agent, ...branches, ...calls]))

    expect(r.findings).toHaveLength(0)
  })

  it('does not infer serial order across zero-duration branches', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
      endedAt: 2000,
    }
    const branches: Span[] = [0, 1, 2].map((index) => ({
      spanId: `llm-${index}`,
      parentSpanId: 'agent',
      runId: 'r',
      kind: 'llm',
      name: `llm.${index}`,
      startedAt: 1000,
      endedAt: 1000,
      model: 'model',
      messages: [],
    }))
    const calls = [0, 1, 2].map((index) => ({
      ...tool(index, 'status', { scope: 'project' }, 1000),
      parentSpanId: `llm-${index}`,
      endedAt: 1000,
    }))

    const r = await stuckLoopView(await storeWith([agent, ...branches, ...calls]))

    expect(r.findings).toHaveLength(0)
  })

  it('detects serial repeats under one unresolved parent when time proves order', async () => {
    const calls = [0, 1, 2].map((index) => ({
      ...tool(index, 'status', { scope: 'project' }, 1000 + index * 1000),
      parentSpanId: 'missing-parent',
    }))

    const r = await stuckLoopView(await storeWith(calls))

    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({
      scopeSpanId: 'missing-parent',
      spanIds: ['t0', 't1', 't2'],
    })
  })

  it('does not combine overlapping direct tool calls', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
      endedAt: 3000,
    }
    const calls = [0, 1, 2].map((index) => ({
      ...tool(index, 'status', { scope: 'project' }, 1000),
      parentSpanId: 'agent',
      endedAt: 1500,
    }))

    const r = await stuckLoopView(await storeWith([agent, ...calls]))

    expect(r.findings).toHaveLength(0)
  })

  it('does not infer serial order from zero-duration direct calls', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
      endedAt: 3000,
    }
    const calls = [0, 1, 2].map((index) => ({
      ...tool(index, 'status', { scope: 'project' }, 1000),
      parentSpanId: 'agent',
      endedAt: 1000,
    }))

    const r = await stuckLoopView(await storeWith([agent, ...calls]))

    expect(r.findings).toHaveLength(0)
  })

  it('does not infer serial order from direct tool starts without end times', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
    }
    const calls = [0, 1, 2].map((index) => {
      const { endedAt: _endedAt, ...call } = tool(
        index,
        'status',
        { scope: 'project' },
        1000 + index,
      )
      return { ...call, parentSpanId: 'agent' }
    })

    const r = await stuckLoopView(await storeWith([agent, ...calls]))

    expect(r.findings).toHaveLength(0)
  })

  it('does not reconnect serial calls across a direct call without an end time', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
      endedAt: 10_000,
    }
    const calls = [0, 1, 2, 3].map((index) => ({
      ...tool(index, 'status', { scope: 'project' }, 1000 + index * 1000),
      parentSpanId: 'agent',
    }))
    delete calls[1]!.endedAt

    const r = await stuckLoopView(await storeWith([agent, ...calls]))

    expect(r.findings).toHaveLength(0)
  })

  it('joins sequential calls with distinct LLM parents under one agent', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
    }
    const llmParents: Span[] = [0, 1, 2].map((index) => ({
      spanId: `llm-${index}`,
      parentSpanId: 'agent',
      runId: 'r',
      kind: 'llm',
      name: `llm.${index}`,
      startedAt: index * 1000,
      endedAt: index * 1000 + 900,
      model: 'model',
      messages: [],
    }))
    const calls = [0, 1, 2].map((index) => ({
      ...tool(index, 'status', { scope: 'project' }, 1000 + index * 1000),
      parentSpanId: `llm-${index}`,
    }))

    const r = await stuckLoopView(await storeWith([agent, ...llmParents, ...calls]))

    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]).toMatchObject({
      scopeSpanId: 'agent',
      spanIds: ['t0', 't1', 't2'],
    })
  })

  it('joins a direct call with later child calls when timing proves order', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
      endedAt: 10_000,
    }
    const phase: Span = {
      spanId: 'phase',
      parentSpanId: 'agent',
      runId: 'r',
      kind: 'custom',
      name: 'phase',
      startedAt: 2000,
      endedAt: 4000,
    }
    const calls = [
      {
        ...tool(0, 'status', { scope: 'project' }, 1000),
        spanId: 'direct',
        parentSpanId: 'agent',
      },
      {
        ...tool(1, 'status', { scope: 'project' }, 2100),
        spanId: 'phase-1',
        parentSpanId: 'phase',
      },
      {
        ...tool(2, 'status', { scope: 'project' }, 3100),
        spanId: 'phase-2',
        parentSpanId: 'phase',
      },
    ]

    const r = await stuckLoopView(await storeWith([agent, phase, ...calls]))

    expect(r.findings).toHaveLength(1)
    expect(r.findings[0]!.spanIds).toEqual(['direct', 'phase-1', 'phase-2'])
  })

  it('counts work in a sequential branch between repeated calls', async () => {
    const agent: Span = {
      spanId: 'agent',
      runId: 'r',
      kind: 'agent',
      name: 'agent',
      startedAt: 0,
    }
    const branches: Span[] = [0, 1, 2, 3].map((index) => ({
      spanId: `branch-${index}`,
      parentSpanId: 'agent',
      runId: 'r',
      kind: 'custom',
      name: `branch.${index}`,
      startedAt: index * 1000,
      endedAt: index * 1000 + 900,
    }))
    const calls = [
      { ...tool(0, 'status', { scope: 'project' }, 100), parentSpanId: 'branch-0' },
      { ...tool(1, 'status', { scope: 'project' }, 1100), parentSpanId: 'branch-1' },
      { ...tool(2, 'edit', { file: 'a.ts' }, 2100), parentSpanId: 'branch-2' },
      { ...tool(3, 'status', { scope: 'project' }, 3100), parentSpanId: 'branch-3' },
    ]

    const r = await stuckLoopView(await storeWith([agent, ...branches, ...calls]))

    expect(r.findings).toHaveLength(0)
  })

  it('returns only the repeated cluster inside the configured window', async () => {
    const store = await storeWith([
      tool(0, 'bash', { cmd: 'status' }, 0),
      tool(1, 'bash', { cmd: 'status' }, 1000),
      tool(2, 'bash', { cmd: 'status' }, 2000),
      tool(3, 'bash', { cmd: 'status' }, 120_000),
      tool(4, 'bash', { cmd: 'status' }, 121_000),
    ])

    const r = await stuckLoopView(store, { maxWindowMs: 5000 })

    expect(r.findings[0]).toMatchObject({
      occurrences: 3,
      spanIds: ['t0', 't1', 't2'],
      windowMs: 2000,
    })
  })

  it('preserves repeated clusters from separate episodes', async () => {
    const store = await storeWith([
      tool(0, 'bash', { cmd: 'status' }, 0),
      tool(1, 'bash', { cmd: 'status' }, 1000),
      tool(2, 'bash', { cmd: 'status' }, 2000),
      tool(3, 'bash', { cmd: 'status' }, 1_200_000),
      tool(4, 'bash', { cmd: 'status' }, 1_201_000),
      tool(5, 'bash', { cmd: 'status' }, 1_202_000),
    ])

    const r = await stuckLoopView(store, { maxWindowMs: 5000 })

    expect(
      r.findings.map(({ occurrences, spanIds, windowMs }) => ({ occurrences, spanIds, windowMs })),
    ).toEqual([
      { occurrences: 3, spanIds: ['t0', 't1', 't2'], windowMs: 2000 },
      { occurrences: 3, spanIds: ['t3', 't4', 't5'], windowMs: 2000 },
    ])
  })

  it.each([
    -1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid time window %s', async (value) => {
    const store = await storeWith([])

    await expect(stuckLoopView(store, { maxWindowMs: value })).rejects.toThrow(
      'maxWindowMs must be a finite non-negative number',
    )
  })

  it.each([0, -1, 1.5, Number.NaN])('rejects invalid minOccurrences %s', async (value) => {
    const store = await storeWith([])

    await expect(stuckLoopView(store, { minOccurrences: value })).rejects.toThrow(
      'minOccurrences must be a positive integer',
    )
  })

  it.each([
    -1,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
  ])('rejects invalid maxInterveningToolCalls %s', async (value) => {
    const store = await storeWith([])

    await expect(stuckLoopView(store, { maxInterveningToolCalls: value })).rejects.toThrow(
      'maxInterveningToolCalls must be a non-negative integer',
    )
  })
})
