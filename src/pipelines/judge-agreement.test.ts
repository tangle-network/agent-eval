import { describe, expect, it } from 'vitest'
import type { JudgeSpan } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { judgeAgreementView } from './judge-agreement'

let seq = 0
function judge(judgeId: string, targetSpanId: string, dimension: string, score: number): JudgeSpan {
  return {
    spanId: `j${seq++}`,
    runId: 'r',
    kind: 'judge',
    name: 'judge.score',
    startedAt: 1000,
    judgeId,
    targetSpanId,
    dimension,
    score,
  }
}

async function storeWith(spans: JudgeSpan[]): Promise<InMemoryTraceStore> {
  seq = 0
  const store = new InMemoryTraceStore()
  await store.appendRun({ runId: 'r', scenarioId: 's', startedAt: 1, status: 'completed' })
  for (const s of spans) await store.appendSpan(s)
  return store
}

describe('judgeAgreementView', () => {
  it('skips a pair with fewer than 2 common items', async () => {
    // A and B only co-score ONE target (t1); t2 is A-only, t3 is B-only.
    const store = await storeWith([
      judge('A', 't1', 'quality', 0.5),
      judge('A', 't2', 'quality', 0.9),
      judge('B', 't1', 'quality', 0.5),
      judge('B', 't3', 'quality', 0.1),
    ])
    const report = await judgeAgreementView(store)
    expect(report.pairs).toHaveLength(0)
    expect(report.judgeIds).toEqual(['A', 'B'])
  })

  it('identical varying scores across common targets => pearson 1', async () => {
    const store = await storeWith([
      judge('A', 't1', 'quality', 0.3),
      judge('A', 't2', 'quality', 0.7),
      judge('B', 't1', 'quality', 0.3),
      judge('B', 't2', 'quality', 0.7),
    ])
    const report = await judgeAgreementView(store)
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]!.commonItems).toBe(2)
    expect(report.pairs[0]!.pearson).toBe(1)
  })

  it('pearson is 1 when BOTH judges have zero variance (constant scores)', async () => {
    const store = await storeWith([
      judge('A', 't1', 'quality', 0.5),
      judge('A', 't2', 'quality', 0.5),
      judge('B', 't1', 'quality', 0.5),
      judge('B', 't2', 'quality', 0.5),
    ])
    const report = await judgeAgreementView(store)
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]!.pearson).toBe(1)
  })

  it('pearson is 0 when EXACTLY one judge has zero variance', async () => {
    const store = await storeWith([
      judge('A', 't1', 'quality', 0.5), // A constant -> variance 0
      judge('A', 't2', 'quality', 0.5),
      judge('B', 't1', 'quality', 0.2), // B varies -> variance > 0
      judge('B', 't2', 'quality', 0.8),
    ])
    const report = await judgeAgreementView(store)
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0]!.pearson).toBe(0)
  })

  it('sorts pairs by descending commonItems', async () => {
    const store = await storeWith([
      // A/B share 3 targets
      judge('A', 't1', 'd', 0.1),
      judge('A', 't2', 'd', 0.2),
      judge('A', 't3', 'd', 0.3),
      judge('B', 't1', 'd', 0.1),
      judge('B', 't2', 'd', 0.2),
      judge('B', 't3', 'd', 0.3),
      // C shares 2 targets with A and B on a different dimension
      judge('A', 'u1', 'e', 0.1),
      judge('A', 'u2', 'e', 0.2),
      judge('C', 'u1', 'e', 0.1),
      judge('C', 'u2', 'e', 0.2),
    ])
    const report = await judgeAgreementView(store)
    const items = report.pairs.map((p) => p.commonItems)
    // descending order
    expect(items).toEqual([...items].sort((a, b) => b - a))
    expect(items[0]).toBe(3)
    expect(report.dimensions).toEqual(['d', 'e'])
  })

  it('returns empty report when there are no judge spans', async () => {
    const store = await storeWith([])
    const report = await judgeAgreementView(store)
    expect(report).toEqual({ pairs: [], dimensions: [], judgeIds: [] })
  })
})
