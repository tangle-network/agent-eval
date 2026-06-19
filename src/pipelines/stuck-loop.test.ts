import { describe, expect, it } from 'vitest'
import type { Run } from '../trace/schema'
import type { ToolSpan } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { stuckLoopView } from './stuck-loop'

function tool(i: number, name: string, args: unknown): ToolSpan {
  return {
    spanId: `t${i}`,
    runId: 'r',
    kind: 'tool',
    name: `tool.${name}`,
    startedAt: 1000 + i * 1000,
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
})
