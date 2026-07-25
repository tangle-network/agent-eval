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
    costProvenance: { kind: 'observed', usd: 0.01 },
    tokenUsage: { input: 10, output: 10 },
    terminalOutcome: 'succeeded',
    outcome: { searchScore: score, raw: {} },
    splitTag: 'search',
    scenarioId,
    ...rest,
  }
}

function unscored(candidateId: string, scenarioId: string): RunRecord {
  const record = rec({ candidateId, scenarioId, score: 0 })
  record.terminalOutcome = 'succeeded'
  record.outcome = { raw: { score: 0.99 } }
  return record
}

describe('runScore', () => {
  it('prefers holdoutScore, falls back to searchScore', () => {
    expect(runScore(rec({ candidateId: 'a', scenarioId: 's', score: 0.5 }))).toBe(0.5)
    const holdout = rec({ candidateId: 'a', scenarioId: 's', score: 0.5 })
    holdout.outcome.holdoutScore = 0.9
    expect(runScore(holdout)).toBe(0.9)
  })

  it('does not treat raw metrics as a task score', () => {
    expect(runScore(unscored('a', 's'))).toBeUndefined()
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

  it('retains unlabeled runs but excludes them from score filters', async () => {
    const store = new EvalTraceStore()
    await store.append(unscored('a', 's1'))

    expect(await store.query({ candidateId: 'a' })).toHaveLength(1)
    expect(await store.query({ minScore: 0 })).toHaveLength(0)
    expect(await store.query({ maxScore: 1 })).toHaveLength(0)
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

  it('skips unlabeled runs and returns null when no scored run remains', async () => {
    const store = new EvalTraceStore()
    await store.append(unscored('a', 's1'))
    await store.append(rec({ candidateId: 'a', scenarioId: 's1', score: 0.4 }))
    expect(runScore((await store.getBest('s1'))!)).toBe(0.4)

    const unlabeledOnly = new EvalTraceStore()
    await unlabeledOnly.append(unscored('a', 's1'))
    expect(await unlabeledOnly.getBest('s1')).toBeNull()
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

  it('ignores unlabeled rows when finding paired scenarios', async () => {
    const store = new EvalTraceStore()
    await store.append(unscored('a', 'unlabeled-shared'))
    await store.append(unscored('b', 'unlabeled-shared'))
    await store.append(rec({ candidateId: 'a', scenarioId: 'scored', score: 0.4 }))
    await store.append(rec({ candidateId: 'b', scenarioId: 'scored', score: 0.6 }))

    const cmp = await store.compareRuns('a', 'b')
    expect(cmp.pairedScenarioIds).toEqual(['scored'])
    expect(cmp.meanDelta).toBeCloseTo(0.2)
  })

  it('rejects a comparison backed only by unlabeled rows', async () => {
    const store = new EvalTraceStore()
    await store.append(unscored('a', 's1'))
    await store.append(unscored('b', 's1'))
    await expect(store.compareRuns('a', 'b')).rejects.toThrow(/share no scenario/)
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
