import { describe, expect, it } from 'vitest'
import { EvalTraceStore, runScore } from './eval-trace-store'
import type { RunRecord } from './run-record'

let runSeq = 0
function rec(
  over: Partial<RunRecord> & { candidateId: string; scenarioId: string; score: number },
): RunRecord {
  const { score, candidateId, scenarioId, ...rest } = over
  return {
    runId: `${candidateId}-${scenarioId}-${runSeq++}`,
    experimentId: 'exp-1',
    candidateId,
    seed: 1,
    model: 'gpt-4o-2024-11-20',
    promptHash: 'p',
    configHash: 'c',
    commitSha: 'sha',
    wallMs: 100,
    costUsd: 0.01,
    tokenUsage: { input: 10, output: 10 },
    outcome: { searchScore: score, raw: {} },
    splitTag: 'search',
    scenarioId,
    ...rest,
  } as RunRecord
}

describe('runScore', () => {
  it('prefers holdoutScore, falls back to searchScore', () => {
    expect(runScore(rec({ candidateId: 'a', scenarioId: 's', score: 0.5 }))).toBe(0.5)
    const holdout = rec({ candidateId: 'a', scenarioId: 's', score: 0.5 })
    holdout.outcome.holdoutScore = 0.9
    expect(runScore(holdout)).toBe(0.9)
  })
})

describe('EvalTraceStore query', () => {
  it('filters by candidate, scenario, score range, and a custom predicate', async () => {
    const store = new EvalTraceStore()
    await store.append(rec({ candidateId: 'a', scenarioId: 's1', score: 0.2 }))
    await store.append(rec({ candidateId: 'a', scenarioId: 's2', score: 0.9 }))
    await store.append(rec({ candidateId: 'b', scenarioId: 's1', score: 0.5 }))

    expect((await store.query({ candidateId: 'a' })).length).toBe(2)
    expect((await store.query({ scenarioId: 's1' })).length).toBe(2)
    expect((await store.query({ minScore: 0.5 })).length).toBe(2)
    expect((await store.query({ where: (r) => r.candidateId === 'b' })).length).toBe(1)
  })

  it('appending an invalid record fails loud', async () => {
    const store = new EvalTraceStore()
    // bare model alias (no snapshot) is rejected by the RunRecord validator
    const bad = rec({ candidateId: 'a', scenarioId: 's', score: 0.5 })
    bad.model = 'gpt-4o'
    await expect(store.append(bad)).rejects.toThrow(/snapshot/)
  })
})

describe('EvalTraceStore getBest', () => {
  it('returns the highest-scoring run for a scenario', async () => {
    const store = new EvalTraceStore()
    await store.append(rec({ candidateId: 'a', scenarioId: 's1', score: 0.3 }))
    await store.append(rec({ candidateId: 'a', scenarioId: 's1', score: 0.8 }))
    await store.append(rec({ candidateId: 'b', scenarioId: 's1', score: 0.95 }))
    const best = await store.getBest('s1')
    expect(best && runScore(best)).toBe(0.95)
    const bestA = await store.getBest('s1', { candidateId: 'a' })
    expect(bestA && runScore(bestA)).toBe(0.8)
  })

  it('returns null when no run matches', async () => {
    const store = new EvalTraceStore()
    expect(await store.getBest('nope')).toBeNull()
  })
})

describe('EvalTraceStore compareRuns', () => {
  it('compares two candidates on their matched scenarios', async () => {
    const store = new EvalTraceStore()
    await store.append(rec({ candidateId: 'a', scenarioId: 's1', score: 0.5 }))
    await store.append(rec({ candidateId: 'a', scenarioId: 's2', score: 0.6 }))
    await store.append(rec({ candidateId: 'a', scenarioId: 'only-a', score: 0.9 }))
    await store.append(rec({ candidateId: 'b', scenarioId: 's1', score: 0.7 }))
    await store.append(rec({ candidateId: 'b', scenarioId: 's2', score: 0.6 }))

    const cmp = await store.compareRuns('a', 'b')
    expect(cmp.pairedScenarioIds).toEqual(['s1', 's2'])
    expect(cmp.meanA).toBeCloseTo(0.55, 6)
    expect(cmp.meanB).toBeCloseTo(0.65, 6)
    expect(cmp.meanDelta).toBeCloseTo(0.1, 6)
    expect(cmp.bWins).toBe(1)
    expect(cmp.ties).toBe(1)
    expect(cmp.aWins).toBe(0)
  })

  it('uses each candidate best score per scenario when repeated', async () => {
    const store = new EvalTraceStore()
    await store.append(rec({ candidateId: 'a', scenarioId: 's1', score: 0.2 }))
    await store.append(rec({ candidateId: 'a', scenarioId: 's1', score: 0.8 }))
    await store.append(rec({ candidateId: 'b', scenarioId: 's1', score: 0.5 }))
    const cmp = await store.compareRuns('a', 'b')
    expect(cmp.meanA).toBe(0.8)
    expect(cmp.aWins).toBe(1)
  })

  it('throws when the candidates share no scenario', async () => {
    const store = new EvalTraceStore()
    await store.append(rec({ candidateId: 'a', scenarioId: 's1', score: 0.5 }))
    await store.append(rec({ candidateId: 'b', scenarioId: 's2', score: 0.5 }))
    await expect(store.compareRuns('a', 'b')).rejects.toThrow(/share no scenario/)
  })

  it('throws when comparing a candidate to itself', async () => {
    const store = new EvalTraceStore()
    await expect(store.compareRuns('a', 'a')).rejects.toThrow(/must differ/)
  })
})
