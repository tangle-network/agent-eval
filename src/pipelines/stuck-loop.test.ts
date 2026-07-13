import { describe, expect, it } from 'vitest'
import type { Run, ToolSpan } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { stuckLoopView } from './stuck-loop'

function tool(i: number, name: string, args: unknown, startedAt = 1000 + i * 1000): ToolSpan {
  return {
    spanId: `t${i}`,
    runId: 'r',
    kind: 'tool',
    name: `tool.${name}`,
    startedAt,
    toolName: name,
    args,
  }
}

async function storeWith(spans: ToolSpan[]): Promise<InMemoryTraceStore> {
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
