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

  it('never returns a realness-gated run as the exemplar, even on a tie', async () => {
    // getBest seeds few-shot prompting: whatever it returns is pasted into the
    // next agent's context as an example to imitate. Ranking on the ungated
    // number handed the highest-scoring GAMED trajectory to every subsequent
    // run — propagation through the context window rather than a gradient, but
    // propagation all the same.
    //
    // Zeroing the gamed run is not enough on its own, which is why it is
    // DROPPED. Scored 0 it still ties every honest run that also scored 0, and
    // ties resolve to the earliest-appended row — so a gamed run that ran first
    // is handed back as the exemplar on the strength of its arrival order.
    const store = new EvalTraceStore()
    await store.append(
      rec({
        candidateId: 'gamed',
        scenarioId: 's1',
        score: 1,
        outcome: { searchScore: 1, raw: {}, realness: { score: 0, gated: true, reason: 'faked' } },
      }),
    )
    await store.append(rec({ candidateId: 'honest', scenarioId: 's1', score: 0 }))
    const best = await store.getBest('s1')
    expect(best?.candidateId).toBe('honest')
    expect(best && runScore(best)).toBe(0)
  })

  it('returns null rather than the least-bad fake when every run is gated', async () => {
    const store = new EvalTraceStore()
    await store.append(
      rec({
        candidateId: 'a',
        scenarioId: 'all-gamed',
        score: 1,
        outcome: { searchScore: 1, raw: {}, realness: { score: 0, gated: true, reason: 'faked' } },
      }),
    )
    expect(await store.getBest('all-gamed')).toBeNull()
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

  it('excludes realness-gated runs and surfaces the count, never a silent zero', async () => {
    // `runScore` is gated, so leaving these in would enter a gamed run as 0 —
    // which reads as "this candidate failed the scenario" when what happened is
    // "this candidate's result is not evidence". A comparison drawn over a
    // shrunken scenario set has to say the set shrank.
    const store = new EvalTraceStore()
    await store.append(rec({ candidateId: 'a', scenarioId: 's1', score: 0.5 }))
    await store.append(rec({ candidateId: 'a', scenarioId: 's2', score: 0.5 }))
    await store.append(rec({ candidateId: 'b', scenarioId: 's1', score: 0.7 }))
    await store.append(
      rec({
        candidateId: 'b',
        scenarioId: 's2',
        score: 1,
        outcome: { searchScore: 1, raw: {}, realness: { score: 0, gated: true, reason: 'faked' } },
      }),
    )
    const cmp = await store.compareRuns('a', 'b')
    expect(cmp.realnessGatedRuns).toBe(1)
    expect(cmp.pairedScenarioIds).toEqual(['s1'])
    expect(cmp.meanB).toBe(0.7)
    expect(cmp.bWins).toBe(1)
    expect(cmp.aWins).toBe(0)
  })

  it('drops a scenario where BOTH candidates are gated and counts each gated run', async () => {
    // The dual-count + drop-out semantic: s2 contributes two gated runs to the
    // count and vanishes from the paired set — never a manufactured 0-vs-0 pair.
    const gated = (candidateId: string, scenarioId: string) =>
      rec({
        candidateId,
        scenarioId,
        score: 1,
        outcome: { searchScore: 1, raw: {}, realness: { score: 0, gated: true, reason: 'faked' } },
      })
    const store = new EvalTraceStore()
    await store.append(rec({ candidateId: 'a', scenarioId: 's1', score: 0.5 }))
    await store.append(rec({ candidateId: 'b', scenarioId: 's1', score: 0.7 }))
    await store.append(gated('a', 's2'))
    await store.append(gated('b', 's2'))
    const cmp = await store.compareRuns('a', 'b')
    expect(cmp.realnessGatedRuns).toBe(2)
    expect(cmp.pairedScenarioIds).toEqual(['s1'])
  })

  it('names the realness gate when the only shared scenarios lost a side to it', async () => {
    // The candidates DO share a scenario — s1 — but not one with honest runs
    // on both sides. The generic "share no scenario" message would send the
    // operator hunting for a corpus labeling bug; the precise one points at
    // the gated runs.
    const store = new EvalTraceStore()
    await store.append(rec({ candidateId: 'a', scenarioId: 's1', score: 0.5 }))
    await store.append(
      rec({
        candidateId: 'b',
        scenarioId: 's1',
        score: 1,
        outcome: { searchScore: 1, raw: {}, realness: { score: 0, gated: true, reason: 'faked' } },
      }),
    )
    await expect(store.compareRuns('a', 'b')).rejects.toThrow(
      /share no scenario with honest runs on both sides \(1 run\(s\) were realness-gated\)/,
    )
  })

  it('throws when comparing a candidate to itself', async () => {
    const store = new EvalTraceStore()
    await expect(store.compareRuns('a', 'a')).rejects.toThrow(/must differ/)
  })
})
