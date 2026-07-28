import { describe, expect, it } from 'vitest'
import { HeldOutGate } from '../src/held-out-gate'
import type { RunRecord } from '../src/run-record'

function record(overrides: Partial<RunRecord>): RunRecord {
  const base: RunRecord = {
    runId: `run-${Math.random()}`,
    experimentId: 'exp1',
    candidateId: 'cand',
    seed: 0,
    model: 'claude-sonnet-4-6@2025-04-15',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'deadbeef',
    wallMs: 1000,
    costUsd: 0.01,
    costProvenance: { kind: 'observed', usd: 0.01 },
    tokenUsage: { input: 100, output: 100 },
    terminalOutcome: 'succeeded',
    outcome: { holdoutScore: 0.5, raw: {} },
    splitTag: 'holdout',
    scenarioId: 'scenario',
  }
  const costUsd = overrides.costUsd ?? base.costUsd
  const costProvenance =
    overrides.costProvenance ??
    (costUsd === null ? { kind: 'uncaptured', usd: null } : { kind: 'observed', usd: costUsd })
  return {
    ...base,
    ...overrides,
    costUsd,
    costProvenance,
    outcome: { ...base.outcome, ...(overrides.outcome ?? {}) },
  }
}

function makePair(
  candidateId: string,
  seed: number,
  searchCandidate: number,
  holdoutCandidate: number,
  searchBaseline: number,
  holdoutBaseline: number,
  costOverride?: { candidate?: number; baseline?: number },
): { candidate: RunRecord[]; baseline: RunRecord[] } {
  const cCost = costOverride?.candidate
  const bCost = costOverride?.baseline
  return {
    candidate: [
      record({
        candidateId,
        seed,
        splitTag: 'search',
        outcome: { searchScore: searchCandidate, raw: {} },
        ...(cCost !== undefined ? { costUsd: cCost } : {}),
      }),
      record({
        candidateId,
        seed,
        splitTag: 'holdout',
        outcome: { holdoutScore: holdoutCandidate, raw: {} },
        ...(cCost !== undefined ? { costUsd: cCost } : {}),
      }),
    ],
    baseline: [
      record({
        candidateId: 'baseline',
        seed,
        splitTag: 'search',
        outcome: { searchScore: searchBaseline, raw: {} },
        ...(bCost !== undefined ? { costUsd: bCost } : {}),
      }),
      record({
        candidateId: 'baseline',
        seed,
        splitTag: 'holdout',
        outcome: { holdoutScore: holdoutBaseline, raw: {} },
        ...(bCost !== undefined ? { costUsd: bCost } : {}),
      }),
    ],
  }
}

function joinPairs(...pairs: ReturnType<typeof makePair>[]): {
  candidate: RunRecord[]
  baseline: RunRecord[]
} {
  return {
    candidate: pairs.flatMap((p) => p.candidate),
    baseline: pairs.flatMap((p) => p.baseline),
  }
}

describe('HeldOutGate — config', () => {
  it('throws when baselineKey is missing', () => {
    expect(() => new HeldOutGate({} as never)).toThrow(/baselineKey/)
  })

  it('uses sensible defaults', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline' })
    // Smoke: with two productive runs and a strong delta, the
    // few_runs gate should still fire because default min is 3.
    const pairs = joinPairs(
      makePair('cand', 0, 0.9, 0.9, 0.5, 0.5),
      makePair('cand', 1, 0.9, 0.9, 0.5, 0.5),
    )
    const decision = g.evaluate(pairs.candidate, pairs.baseline)
    expect(decision.promote).toBe(false)
    expect(decision.rejectionCode).toBe('few_runs')
  })
})

describe('HeldOutGate — rejection paths', () => {
  it('rejects on few productive runs', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 3 })
    const pairs = joinPairs(
      makePair('cand', 0, 0.95, 0.95, 0.5, 0.5),
      makePair('cand', 1, 0.95, 0.95, 0.5, 0.5),
    )
    const d = g.evaluate(pairs.candidate, pairs.baseline)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('few_runs')
    expect(d.evidence.productiveRuns).toBe(2)
    expect(d.reason).toMatch(/few_runs/)
  })

  it('rejects on negative paired delta on holdout', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 3, seed: 1 })
    // Candidate worse than baseline on holdout.
    const pairs = joinPairs(
      makePair('cand', 0, 0.7, 0.4, 0.6, 0.6),
      makePair('cand', 1, 0.72, 0.42, 0.61, 0.62),
      makePair('cand', 2, 0.74, 0.43, 0.62, 0.61),
      makePair('cand', 3, 0.71, 0.41, 0.6, 0.6),
      makePair('cand', 4, 0.73, 0.4, 0.62, 0.61),
      makePair('cand', 5, 0.75, 0.42, 0.61, 0.6),
    )
    const d = g.evaluate(pairs.candidate, pairs.baseline)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
    expect(d.evidence.medianPairedDelta!).toBeLessThan(0)
    expect(d.evidence.pairedCI!.high).toBeLessThanOrEqual(0)
  })

  it('rejects a tie-pinned regression at a negative threshold', () => {
    const pairs = joinPairs(
      ...Array.from({ length: 5 }, (_, seed) => makePair('cand', seed, 1, 1, 0, 0)),
      ...Array.from({ length: 15 }, (_, index) => makePair('cand', 5 + index, 0, 0, 1, 1)),
      ...Array.from({ length: 56 }, (_, index) => makePair('cand', 20 + index, 1, 1, 1, 1)),
    )
    const decision = new HeldOutGate({
      baselineKey: 'baseline',
      pairedDeltaThreshold: -0.05,
      seed: 1337,
    }).evaluate(pairs.candidate, pairs.baseline)

    expect(decision.evidence.medianPairedDelta).toBe(0)
    expect(decision.evidence.pairedCI).toEqual({ low: 0, high: 0 })
    expect(decision.promote).toBe(false)
    expect(decision.rejectionCode).toBe('indeterminate_delta')
  })

  it('rejects on excessive overfit gap', () => {
    // Candidate clears holdout delta, but search-vs-holdout gap is
    // far worse than baseline's gap.
    const g = new HeldOutGate({
      baselineKey: 'baseline',
      minProductiveRuns: 3,
      overfitGapThreshold: 0.05,
      pairedDeltaThreshold: 0,
      seed: 1,
    })
    const pairs = joinPairs(
      // search=0.95, holdout=0.55 (gap=0.40); baseline search=0.55, holdout=0.50 (gap=0.05).
      makePair('cand', 0, 0.95, 0.55, 0.55, 0.5),
      makePair('cand', 1, 0.95, 0.55, 0.55, 0.5),
      makePair('cand', 2, 0.95, 0.55, 0.55, 0.5),
      makePair('cand', 3, 0.95, 0.55, 0.55, 0.5),
      makePair('cand', 4, 0.95, 0.55, 0.55, 0.5),
      makePair('cand', 5, 0.95, 0.55, 0.55, 0.5),
    )
    const d = g.evaluate(pairs.candidate, pairs.baseline)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('overfit_gap')
    expect(d.evidence.overfitGap!).toBeGreaterThan(d.evidence.baselineOverfitGap!)
  })

  it('rejects when search scores are missing instead of skipping the overfit check', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 3, seed: 1 })
    const pairs = joinPairs(
      makePair('cand', 0, 0.9, 0.8, 0.5, 0.5),
      makePair('cand', 1, 0.9, 0.8, 0.5, 0.5),
      makePair('cand', 2, 0.9, 0.8, 0.5, 0.5),
      makePair('cand', 3, 0.9, 0.8, 0.5, 0.5),
    )
    const candidate = pairs.candidate.filter((run) => run.splitTag !== 'search')
    const baseline = pairs.baseline.filter((run) => run.splitTag !== 'search')

    const d = g.evaluate(candidate, baseline)

    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('missing_split_scores')
    expect(d.evidence.searchScore).toBeNull()
    expect(d.evidence.overfitGap).toBeNull()
  })

  it('reports missing holdout evidence before checking the pair count', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 3, seed: 1 })
    const pairs = joinPairs(
      makePair('cand', 0, 0.9, 0.8, 0.5, 0.5),
      makePair('cand', 1, 0.9, 0.8, 0.5, 0.5),
    )
    const candidate = pairs.candidate.filter((run) => run.splitTag === 'search')
    const baseline = pairs.baseline.filter((run) => run.splitTag === 'search')

    const decision = g.evaluate(candidate, baseline)

    expect(decision.promote).toBe(false)
    expect(decision.rejectionCode).toBe('missing_split_scores')
    expect(decision.reason).toContain('candidate holdout')
    expect(decision.reason).toContain('baseline holdout')
    expect(decision.evidence.productiveRuns).toBe(0)
  })

  it('computes overfit gaps from matched scenarios only', () => {
    const g = new HeldOutGate({
      baselineKey: 'baseline',
      minProductiveRuns: 3,
      pairedDeltaThreshold: 0,
      overfitGapThreshold: 0.05,
      seed: 1,
    })
    const pairs = joinPairs(
      makePair('cand', 0, 0.9, 0.6, 0.5, 0.5),
      makePair('cand', 1, 0.9, 0.6, 0.5, 0.5),
      makePair('cand', 2, 0.9, 0.6, 0.5, 0.5),
      makePair('cand', 3, 0.9, 0.6, 0.5, 0.5),
      makePair('cand', 4, 0.9, 0.6, 0.5, 0.5),
      makePair('cand', 5, 0.9, 0.6, 0.5, 0.5),
    )
    const matchedOnly = g.evaluate(pairs.candidate, pairs.baseline)
    const unmatchedCandidateRows = Array.from({ length: 10 }, (_, index) =>
      record({
        candidateId: 'cand',
        scenarioId: `unmatched-${index}`,
        seed: 100 + index,
        splitTag: 'holdout',
        outcome: { holdoutScore: 0.95, raw: {} },
      }),
    )

    // At the default coverage requirement the 10 unmatched rows are themselves
    // disqualifying — 3 of 13 dealt holdout items scored on both arms.
    expect(
      g.evaluate([...pairs.candidate, ...unmatchedCandidateRows], pairs.baseline),
    ).toMatchObject({ promote: false, rejectionCode: 'incomplete_coverage' })
    // The arithmetic this test is about — unmatched rows never move the gap —
    // is checked with the ragged set explicitly declared acceptable.
    const withUnmatched = new HeldOutGate({
      baselineKey: 'baseline',
      minProductiveRuns: 3,
      pairedDeltaThreshold: 0,
      overfitGapThreshold: 0.05,
      seed: 1,
      minCoverage: 0,
    }).evaluate([...pairs.candidate, ...unmatchedCandidateRows], pairs.baseline)

    expect(matchedOnly.rejectionCode).toBe('overfit_gap')
    expect(withUnmatched.rejectionCode).toBe('overfit_gap')
    expect(withUnmatched.evidence.overfitGap).toBeCloseTo(matchedOnly.evidence.overfitGap!)
    expect(withUnmatched.evidence.unpairedCandidateRuns).toBe(10)
  })
})

describe('HeldOutGate — promotion path', () => {
  it('promotes a clean win with positive lower CI', () => {
    const g = new HeldOutGate({
      baselineKey: 'baseline',
      minProductiveRuns: 3,
      pairedDeltaThreshold: 0,
      overfitGapThreshold: 0.5, // wide overfit budget
      seed: 1,
    })
    const pairs = joinPairs(
      makePair('cand', 0, 0.7, 0.7, 0.5, 0.5),
      makePair('cand', 1, 0.72, 0.72, 0.5, 0.51),
      makePair('cand', 2, 0.74, 0.74, 0.51, 0.5),
      makePair('cand', 3, 0.71, 0.71, 0.5, 0.5),
      makePair('cand', 4, 0.73, 0.73, 0.51, 0.5),
      makePair('cand', 5, 0.75, 0.75, 0.5, 0.51),
      makePair('cand', 6, 0.76, 0.76, 0.51, 0.5),
      makePair('cand', 7, 0.74, 0.74, 0.5, 0.51),
    )
    const d = g.evaluate(pairs.candidate, pairs.baseline)
    expect(d.promote).toBe(true)
    expect(d.rejectionCode).toBeNull()
    expect(d.evidence.medianPairedDelta!).toBeGreaterThan(0)
    expect(d.evidence.pairedCI!.low).toBeGreaterThan(0)
    expect(d.candidateId).toBe('cand')
    expect(d.baselineId).toBe('baseline')
  })

  it('decision is deterministic given a seed', () => {
    const g1 = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 3, seed: 7 })
    const g2 = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 3, seed: 7 })
    const pairs = joinPairs(
      makePair('cand', 0, 0.6, 0.61, 0.5, 0.5),
      makePair('cand', 1, 0.61, 0.62, 0.5, 0.5),
      makePair('cand', 2, 0.62, 0.63, 0.5, 0.5),
      makePair('cand', 3, 0.63, 0.6, 0.5, 0.5),
      makePair('cand', 4, 0.64, 0.61, 0.5, 0.5),
      makePair('cand', 5, 0.65, 0.62, 0.5, 0.5),
    )
    const a = g1.evaluate(pairs.candidate, pairs.baseline)
    const b = g2.evaluate(pairs.candidate, pairs.baseline)
    expect(a.evidence.pairedCI!.low).toBe(b.evidence.pairedCI!.low)
    expect(a.evidence.pairedCI!.high).toBe(b.evidence.pairedCI!.high)
  })

  it('refuses — rather than silently drops — candidate runs with no matching baseline pair', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 3, seed: 1 })
    // Five candidate runs but baseline only paired on 2 of them.
    const candidate: RunRecord[] = []
    const baseline: RunRecord[] = []
    for (let i = 0; i < 5; i++) {
      candidate.push(
        record({
          candidateId: 'cand',
          seed: i,
          splitTag: 'holdout',
          outcome: { holdoutScore: 0.7, raw: {} },
        }),
      )
    }
    for (let i = 0; i < 2; i++) {
      baseline.push(
        record({
          candidateId: 'baseline',
          seed: i,
          splitTag: 'holdout',
          outcome: { holdoutScore: 0.5, raw: {} },
        }),
      )
    }
    candidate.push(
      record({
        candidateId: 'cand',
        seed: 0,
        splitTag: 'search',
        outcome: { searchScore: 0.7, raw: {} },
      }),
    )
    baseline.push(
      record({
        candidateId: 'baseline',
        seed: 0,
        splitTag: 'search',
        outcome: { searchScore: 0.5, raw: {} },
      }),
    )
    const d = g.evaluate(candidate, baseline)
    expect(d.evidence.productiveRuns).toBe(2)
    expect(d.evidence.unpairedCandidateRuns).toBe(3)
    expect(d.evidence.unpairedBaselineRuns).toBe(0)
    expect(d.rejectionCode).toBe('incomplete_coverage')
    expect(d.evidence.holdoutCoverage).toEqual({
      dealt: 5,
      answered: 2,
      unscoredPairs: 0,
      candidateOnly: 3,
      baselineOnly: 0,
      coverage: 2 / 5,
    })
    // Declaring the ragged set acceptable puts the old `few_runs` verdict back —
    // 2 paired observations is still below the minimum.
    expect(
      new HeldOutGate({
        baselineKey: 'baseline',
        minProductiveRuns: 3,
        seed: 1,
        minCoverage: 0,
      }).evaluate(candidate, baseline).rejectionCode,
    ).toBe('few_runs')
  })

  it('does not pair different scenarios that share the same seed', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 1, seed: 1 })
    const candidate = [
      record({
        candidateId: 'cand',
        scenarioId: 'shared-search-scenario',
        seed: 7,
        splitTag: 'search',
        outcome: { searchScore: 0.9, raw: {} },
      }),
      record({
        candidateId: 'cand',
        scenarioId: 'candidate-scenario',
        seed: 7,
        outcome: { holdoutScore: 0.9, raw: {} },
      }),
    ]
    const baseline = [
      record({
        candidateId: 'baseline',
        scenarioId: 'shared-search-scenario',
        seed: 7,
        splitTag: 'search',
        outcome: { searchScore: 0.5, raw: {} },
      }),
      record({
        candidateId: 'baseline',
        scenarioId: 'baseline-scenario',
        seed: 7,
        outcome: { holdoutScore: 0.1, raw: {} },
      }),
    ]

    const decision = g.evaluate(candidate, baseline)

    expect(decision.evidence.productiveRuns).toBe(0)
    expect(decision.evidence.unpairedCandidateRuns).toBe(1)
    expect(decision.evidence.unpairedBaselineRuns).toBe(1)
    expect(decision.rejectionCode).toBe('incomplete_coverage')
    expect(decision.evidence.holdoutCoverage.coverage).toBe(0)
    expect(
      new HeldOutGate({
        baselineKey: 'baseline',
        minProductiveRuns: 1,
        seed: 1,
        minCoverage: 0,
      }).evaluate(candidate, baseline).rejectionCode,
    ).toBe('few_runs')
  })

  it('is invariant to input order and rejects duplicate pair identities', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 3, seed: 1 })
    const pairs = joinPairs(
      makePair('cand', 0, 0.7, 0.7, 0.5, 0.5),
      makePair('cand', 1, 0.72, 0.72, 0.5, 0.5),
      makePair('cand', 2, 0.74, 0.74, 0.5, 0.5),
    )

    const forward = g.evaluate(pairs.candidate, pairs.baseline)
    const reversed = g.evaluate([...pairs.candidate].reverse(), [...pairs.baseline].reverse())
    expect(reversed).toEqual(forward)

    expect(() => g.evaluate([...pairs.candidate, pairs.candidate[1]!], pairs.baseline)).toThrow(
      /duplicate repKey/,
    )
  })

  it('rejects records without an explicit scenario identity', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 1 })
    const pair = makePair('cand', 0, 0.7, 0.7, 0.5, 0.5)
    delete pair.candidate[0]!.scenarioId
    delete pair.candidate[1]!.scenarioId

    expect(() => g.evaluate(pair.candidate, pair.baseline)).toThrow(/missing scenarioId/)
  })
})

describe('HeldOutGate — cost ceiling', () => {
  it('rejects with cost_ceiling when candidate clears quality but blows the budget', () => {
    const g = new HeldOutGate({
      baselineKey: 'baseline',
      minProductiveRuns: 3,
      seed: 1,
      costPerTaskCeiling: 0.02,
    })
    // Candidate is strictly better on quality but costs 4x baseline.
    const pairs = joinPairs(
      makePair('cand', 0, 0.7, 0.7, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 1, 0.72, 0.72, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 2, 0.71, 0.71, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 3, 0.73, 0.73, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 4, 0.74, 0.74, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 5, 0.75, 0.75, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
    )
    const d = g.evaluate(pairs.candidate, pairs.baseline)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('cost_ceiling')
    expect(d.evidence.medianCandidateCost!).toBeCloseTo(0.08, 6)
    expect(d.evidence.medianBaselineCost!).toBeCloseTo(0.02, 6)
    expect(d.reason).toMatch(/cost_ceiling/)
  })

  it('promotes when candidate clears quality AND fits the cost ceiling', () => {
    const g = new HeldOutGate({
      baselineKey: 'baseline',
      minProductiveRuns: 3,
      seed: 1,
      costPerTaskCeiling: 0.05,
    })
    const pairs = joinPairs(
      makePair('cand', 0, 0.7, 0.7, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 1, 0.72, 0.72, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 2, 0.71, 0.71, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 3, 0.73, 0.73, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 4, 0.74, 0.74, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 5, 0.75, 0.75, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
    )
    const d = g.evaluate(pairs.candidate, pairs.baseline)
    expect(d.promote).toBe(true)
    expect(d.rejectionCode).toBeNull()
    expect(d.evidence.medianCandidateCost!).toBeCloseTo(0.03, 6)
  })

  it('records cost in evidence regardless of whether costPerTaskCeiling is set', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 3, seed: 1 })
    const pairs = joinPairs(
      makePair('cand', 0, 0.7, 0.7, 0.5, 0.5, { candidate: 0.05, baseline: 0.01 }),
      makePair('cand', 1, 0.72, 0.72, 0.5, 0.5, { candidate: 0.05, baseline: 0.01 }),
      makePair('cand', 2, 0.71, 0.71, 0.5, 0.5, { candidate: 0.05, baseline: 0.01 }),
    )
    const d = g.evaluate(pairs.candidate, pairs.baseline)
    // No ceiling configured → promote-or-reject depends only on quality;
    // cost is informational and surfaces unconditionally.
    expect(d.evidence.medianCandidateCost!).toBeCloseTo(0.05, 6)
    expect(d.evidence.medianBaselineCost!).toBeCloseTo(0.01, 6)
  })

  it('rejects a cost-bounded candidate when any cost is uncaptured', () => {
    const g = new HeldOutGate({
      baselineKey: 'baseline',
      minProductiveRuns: 3,
      seed: 1,
      costPerTaskCeiling: 0.05,
    })
    const pairs = joinPairs(
      makePair('cand', 0, 0.7, 0.7, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 1, 0.72, 0.72, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 2, 0.71, 0.71, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 3, 0.73, 0.73, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 4, 0.74, 0.74, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 5, 0.75, 0.75, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
    )
    pairs.candidate[0] = record({
      ...pairs.candidate[0],
      costUsd: null,
      costProvenance: { kind: 'uncaptured', usd: null },
    })

    const decision = g.evaluate(pairs.candidate, pairs.baseline)

    expect(decision.promote).toBe(false)
    expect(decision.rejectionCode).toBe('missing_cost')
    expect(decision.evidence.medianCandidateCost).toBeNull()
  })

  it('reports incomplete optional cost evidence as null', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', minProductiveRuns: 3, seed: 1 })
    const pairs = joinPairs(
      makePair('cand', 0, 0.7, 0.7, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 1, 0.72, 0.72, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 2, 0.71, 0.71, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
    )
    pairs.candidate[0] = record({
      ...pairs.candidate[0],
      costUsd: null,
      costProvenance: { kind: 'uncaptured', usd: null },
    })

    const decision = g.evaluate(pairs.candidate, pairs.baseline)

    expect(decision.evidence.medianCandidateCost).toBeNull()
  })

  it('throws on non-positive costPerTaskCeiling', () => {
    expect(() => new HeldOutGate({ baselineKey: 'baseline', costPerTaskCeiling: 0 })).toThrow(
      /costPerTaskCeiling/,
    )
    expect(() => new HeldOutGate({ baselineKey: 'baseline', costPerTaskCeiling: -1 })).toThrow(
      /costPerTaskCeiling/,
    )
    expect(
      () =>
        new HeldOutGate({
          baselineKey: 'baseline',
          costPerTaskCeiling: Number.POSITIVE_INFINITY,
        }),
    ).toThrow(/costPerTaskCeiling/)
  })
})

// ── Coverage: a candidate that produced NO SCORE on most held-out items ──

/**
 * A held-out comparison over `n` scenarios where the candidate produced a real
 * score on only the first `answered` of them.
 *
 * `mode` is HOW the other items came back empty — the three shapes a real
 * harness produces, all of which used to shrink the denominator silently:
 *   'no-row'       the harness wrote nothing for the crashed item
 *   'unscored-row' the harness wrote a row with no score on it
 *   'scored-zero'  the CONTROL — the same failures scored as the 0 they earned
 */
function partialCoverage(opts: {
  n: number
  answered: number
  mode: 'no-row' | 'unscored-row' | 'scored-zero'
  /** Which split the candidate went dark on. Default 'holdout'. */
  darkSplit?: 'holdout' | 'search'
  candidateHoldout?: number
  baselineHoldout?: number
}): { candidate: RunRecord[]; baseline: RunRecord[] } {
  const darkSplit = opts.darkSplit ?? 'holdout'
  const candidateHoldout = opts.candidateHoldout ?? 0.95
  const baselineHoldout = opts.baselineHoldout ?? 0.6
  const candidate: RunRecord[] = []
  const baseline: RunRecord[] = []
  for (let i = 0; i < opts.n; i += 1) {
    const scenarioId = `s${String(i).padStart(2, '0')}`
    baseline.push(
      record({
        candidateId: 'baseline',
        scenarioId,
        seed: i,
        splitTag: 'search',
        outcome: { searchScore: 0.62, raw: {} },
      }),
      record({
        candidateId: 'baseline',
        scenarioId,
        seed: i,
        splitTag: 'holdout',
        outcome: { holdoutScore: baselineHoldout, raw: {} },
      }),
    )
    const answered = i < opts.answered
    for (const split of ['search', 'holdout'] as const) {
      const live = answered || split !== darkSplit
      const score = split === 'search' ? 0.96 : candidateHoldout
      if (live) {
        candidate.push(
          record({
            candidateId: 'cand',
            scenarioId,
            seed: i,
            splitTag: split,
            outcome:
              split === 'search'
                ? { searchScore: score, raw: {} }
                : { holdoutScore: score, raw: {} },
          }),
        )
        continue
      }
      if (opts.mode === 'no-row') continue
      const crashed = record({
        candidateId: 'cand',
        scenarioId,
        seed: i,
        splitTag: split,
        terminalOutcome: 'failed',
        terminalFailureReason: 'process crashed before producing a score',
        outcome:
          opts.mode === 'scored-zero'
            ? split === 'search'
              ? { searchScore: 0, raw: {} }
              : { holdoutScore: 0, raw: {} }
            : { raw: {} },
      })
      if (opts.mode === 'unscored-row') {
        // A crashed run carries NO score — `record()`'s defaults must not leak
        // one back in, or the fixture would silently stop testing the bug.
        const { searchScore: _s, holdoutScore: _h, ...unscored } = crashed.outcome
        candidate.push({ ...crashed, outcome: unscored })
        continue
      }
      candidate.push(crashed)
    }
  }
  return { candidate, baseline }
}

describe('HeldOutGate — held-out coverage', () => {
  const thresholds = [-0.05, 0, 0.01, 0.05, 0.1, 0.2, 0.3]

  for (const mode of ['no-row', 'unscored-row'] as const) {
    it(`REFUSES a candidate that scored 6 of 26 dealt holdout items (${mode}), at every threshold`, () => {
      const runs = partialCoverage({ n: 26, answered: 6, mode })
      const verdicts = thresholds.map((pairedDeltaThreshold) =>
        new HeldOutGate({ baselineKey: 'baseline', pairedDeltaThreshold, seed: 1337 }).evaluate(
          runs.candidate,
          runs.baseline,
        ),
      )
      expect(verdicts.map((v) => v.promote)).toEqual(thresholds.map(() => false))
      expect(verdicts.map((v) => v.rejectionCode)).toEqual(
        thresholds.map(() => 'incomplete_coverage'),
      )
      expect(verdicts[0]!.reason).toMatch(/6 of 26/)
    })
  }

  it('REPORTS the coverage it decided on, so a shrunken denominator is visible', () => {
    const noRow = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(
      ...(([r]) => [r.candidate, r.baseline] as const)([
        partialCoverage({ n: 26, answered: 6, mode: 'no-row' }),
      ]),
    )
    expect(noRow.evidence.holdoutCoverage).toEqual({
      dealt: 26,
      answered: 6,
      unscoredPairs: 0,
      candidateOnly: 0,
      baselineOnly: 20,
      coverage: 6 / 26,
    })

    const unscored = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(
      ...(([r]) => [r.candidate, r.baseline] as const)([
        partialCoverage({ n: 26, answered: 6, mode: 'unscored-row' }),
      ]),
    )
    expect(unscored.evidence.holdoutCoverage).toEqual({
      dealt: 26,
      answered: 6,
      unscoredPairs: 20,
      candidateOnly: 0,
      baselineOnly: 0,
      coverage: 6 / 26,
    })
    // The search split is fully covered in both — reported separately, not lumped.
    expect(noRow.evidence.searchCoverage.coverage).toBe(1)
    expect(unscored.evidence.searchCoverage.coverage).toBe(1)
  })

  it('CONTROL: the same failures scored as the 0 they earned are refused on the delta, not on coverage', () => {
    const runs = partialCoverage({ n: 26, answered: 6, mode: 'scored-zero' })
    const d = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(
      runs.candidate,
      runs.baseline,
    )
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
    expect(d.evidence.holdoutCoverage.coverage).toBe(1)
    expect(d.evidence.productiveRuns).toBe(26)
  })

  it('a candidate the BASELINE went dark on is refused too — coverage is symmetric', () => {
    const runs = partialCoverage({ n: 26, answered: 6, mode: 'no-row' })
    // Swap the arms: now the BASELINE is the one missing 20 holdout rows.
    const swapped = {
      candidate: runs.baseline.map((r) => record({ ...r, candidateId: 'cand' })),
      baseline: runs.candidate.map((r) => record({ ...r, candidateId: 'baseline' })),
    }
    const d = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(
      swapped.candidate,
      swapped.baseline,
    )
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('incomplete_coverage')
    expect(d.evidence.holdoutCoverage.candidateOnly).toBe(20)
    expect(d.evidence.holdoutCoverage.baselineOnly).toBe(0)
  })

  it('REFUSES when the SEARCH split is the shrunken one — the overfit gap reads it', () => {
    const runs = partialCoverage({ n: 26, answered: 6, mode: 'no-row', darkSplit: 'search' })
    const d = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(
      runs.candidate,
      runs.baseline,
    )
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('incomplete_coverage')
    expect(d.evidence.searchCoverage.coverage).toBe(6 / 26)
    expect(d.evidence.holdoutCoverage.coverage).toBe(1)
  })

  it('full coverage with a real lift still PROMOTES — the check adds no false refusal', () => {
    const runs = partialCoverage({ n: 26, answered: 26, mode: 'no-row' })
    const d = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(
      runs.candidate,
      runs.baseline,
    )
    expect(d.rejectionCode).toBeNull()
    expect(d.promote).toBe(true)
    expect(d.evidence.holdoutCoverage.coverage).toBe(1)
  })

  it('a caller may accept a shrunken denominator only by DECLARING it', () => {
    const runs = partialCoverage({ n: 26, answered: 6, mode: 'no-row' })
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      minCoverage: 6 / 26,
    }).evaluate(runs.candidate, runs.baseline)
    expect(d.promote).toBe(true)
    // …and the declaration does not hide the shrink: it is still in the evidence.
    expect(d.evidence.holdoutCoverage).toMatchObject({ dealt: 26, answered: 6, baselineOnly: 20 })
  })

  it('rejects an out-of-range minCoverage instead of silently clamping', () => {
    for (const minCoverage of [-0.1, 1.1, Number.NaN]) {
      expect(() => new HeldOutGate({ baselineKey: 'baseline', minCoverage })).toThrow(/minCoverage/)
    }
  })
})

describe('HeldOutGate — coverage cannot be laundered', () => {
  /** 26 items; the candidate answers 6 and disposes of the other 20 via `hide`. */
  function laundered(hide: (scenarioId: string, seed: number) => RunRecord | null): {
    candidate: RunRecord[]
    baseline: RunRecord[]
  } {
    const candidate: RunRecord[] = []
    const baseline: RunRecord[] = []
    for (let i = 0; i < 26; i += 1) {
      const scenarioId = `s${String(i).padStart(2, '0')}`
      baseline.push(
        record({
          candidateId: 'baseline',
          scenarioId,
          seed: i,
          splitTag: 'search',
          outcome: { searchScore: 0.62, raw: {} },
        }),
        record({
          candidateId: 'baseline',
          scenarioId,
          seed: i,
          splitTag: 'holdout',
          outcome: { holdoutScore: 0.6, raw: {} },
        }),
      )
      candidate.push(
        record({
          candidateId: 'cand',
          scenarioId,
          seed: i,
          splitTag: 'search',
          outcome: { searchScore: 0.96, raw: {} },
        }),
      )
      if (i < 6) {
        candidate.push(
          record({
            candidateId: 'cand',
            scenarioId,
            seed: i,
            splitTag: 'holdout',
            outcome: { holdoutScore: 0.95, raw: {} },
          }),
        )
        continue
      }
      const hidden = hide(scenarioId, i)
      if (hidden !== null) candidate.push(hidden)
    }
    return { candidate, baseline }
  }

  const decide = (runs: { candidate: RunRecord[]; baseline: RunRecord[] }) =>
    new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(runs.candidate, runs.baseline)

  it("re-tagging the failures splitTag:'dev' does not remove them from the denominator", () => {
    const d = decide(
      laundered((scenarioId, seed) =>
        record({
          candidateId: 'cand',
          scenarioId,
          seed,
          splitTag: 'dev',
          terminalOutcome: 'failed',
          outcome: { raw: {} },
        }),
      ),
    )
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('incomplete_coverage')
    // The baseline's 20 holdout rows keep the items in the dealt set — a
    // candidate cannot shrink the denominator by relabelling its own rows.
    expect(d.evidence.holdoutCoverage).toMatchObject({ dealt: 26, answered: 6, baselineOnly: 20 })
  })

  it('gamed "successes" removed by the authenticity filter still count as dealt', () => {
    const runs = laundered((scenarioId, seed) =>
      record({
        candidateId: 'cand',
        scenarioId,
        seed,
        splitTag: 'holdout',
        outcome: { holdoutScore: 1, raw: {}, realness: { score: 0, gated: true, reason: 'faked' } },
      }),
    )
    const decision = decide(runs)
    expect(decision.promote).toBe(false)
    expect(decision.rejectionCode).toBe('incomplete_coverage')
    expect(decision.evidence.realnessGatedRuns).toBe(20)
    expect(decision.evidence.holdoutCoverage).toMatchObject({
      dealt: 26,
      answered: 6,
      baselineOnly: 20,
    })
  })

  for (const [label, bad] of [
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
  ] as const) {
    it(`a ${label} score is missing data, not a measurement`, () => {
      const d = decide(
        laundered((scenarioId, seed) =>
          record({
            candidateId: 'cand',
            scenarioId,
            seed,
            splitTag: 'holdout',
            outcome: { holdoutScore: bad, raw: {} },
          }),
        ),
      )
      expect(d.promote).toBe(false)
      expect(d.rejectionCode).toBe('incomplete_coverage')
      expect(d.evidence.holdoutCoverage).toMatchObject({
        dealt: 26,
        answered: 6,
        unscoredPairs: 20,
      })
    })
  }

  it('a holdout row carrying only a SEARCH score is unscored on holdout', () => {
    const d = decide(
      laundered((scenarioId, seed) => {
        const row = record({
          candidateId: 'cand',
          scenarioId,
          seed,
          splitTag: 'holdout',
          outcome: { searchScore: 0.95, raw: {} },
        })
        const { holdoutScore: _drop, ...searchOnly } = row.outcome
        return { ...row, outcome: searchOnly }
      }),
    )
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('incomplete_coverage')
    expect(d.evidence.holdoutCoverage).toMatchObject({ dealt: 26, answered: 6, unscoredPairs: 20 })
  })

  it('is deterministic: 200 evaluations of the same rows in shuffled order agree', () => {
    const runs = laundered(() => null)
    const shuffle = <T>(xs: T[]): T[] => {
      const a = [...xs]
      for (let i = a.length - 1; i > 0; i -= 1) {
        const j = Math.floor(Math.random() * (i + 1))
        ;[a[i], a[j]] = [a[j] as T, a[i] as T]
      }
      return a
    }
    const verdicts = new Set<string>()
    for (let k = 0; k < 200; k += 1) {
      const d = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(
        shuffle(runs.candidate),
        shuffle(runs.baseline),
      )
      verdicts.add(`${d.promote}/${d.rejectionCode}/${JSON.stringify(d.evidence.holdoutCoverage)}`)
    }
    expect([...verdicts]).toEqual([
      `false/incomplete_coverage/${JSON.stringify({
        dealt: 26,
        answered: 6,
        unscoredPairs: 0,
        candidateOnly: 0,
        baselineOnly: 20,
        coverage: 6 / 26,
      })}`,
    ])
  })

  it('a crashed attempt and a scored retry at the SAME identity throw, exactly as two scored rows do', () => {
    const runs = laundered(() => null)
    // Attach an unscored duplicate of an item the candidate DID answer.
    const answered = runs.candidate.find(
      (r) => r.splitTag === 'holdout' && r.scenarioId === 's00',
    ) as RunRecord
    const crashedAttempt = record({
      ...answered,
      runId: 'first-attempt',
      terminalOutcome: 'failed',
      outcome: { raw: {} },
    })
    const { holdoutScore: _drop, ...unscoredOutcome } = crashedAttempt.outcome
    const g = new HeldOutGate({ baselineKey: 'baseline', seed: 1337, minCoverage: 0 })
    expect(() =>
      g.evaluate(
        [...runs.candidate, { ...crashedAttempt, outcome: unscoredOutcome }],
        runs.baseline,
      ),
    ).toThrow(/duplicate repKey/)
    // Same shape with the duplicate SCORED — the pre-existing contract.
    expect(() => g.evaluate([...runs.candidate, crashedAttempt], runs.baseline)).toThrow(
      /duplicate repKey/,
    )
  })
})

describe('HeldOutGate — the coverage check does not move a COMPLETE verdict', () => {
  it('pins the pre-coverage numbers byte-for-byte on a fully covered comparison', () => {
    // Every number asserted here was produced by the gate on `origin/main`
    // (2789970, published 0.133.3) with the identical fixture and seed. The
    // coverage check must not move any of them.
    const pairs = joinPairs(
      makePair('cand', 0, 0.82, 0.78, 0.65, 0.6),
      makePair('cand', 1, 0.82, 0.81, 0.65, 0.62),
      makePair('cand', 2, 0.82, 0.79, 0.65, 0.61),
      makePair('cand', 3, 0.82, 0.8, 0.65, 0.59),
      makePair('cand', 4, 0.82, 0.77, 0.65, 0.6),
      makePair('cand', 5, 0.82, 0.82, 0.65, 0.63),
      makePair('cand', 6, 0.82, 0.8, 0.65, 0.61),
      makePair('cand', 7, 0.82, 0.79, 0.65, 0.6),
    )
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      minProductiveRuns: 3,
      pairedDeltaThreshold: 0,
      overfitGapThreshold: 0.15,
      bootstrapResamples: 500,
      seed: 42,
    }).evaluate(pairs.candidate, pairs.baseline)

    expect(d.promote).toBe(true)
    expect(d.rejectionCode).toBeNull()
    expect(d.evidence.productiveRuns).toBe(8)
    expect(d.evidence.medianPairedDelta).toBe(0.19)
    expect(d.evidence.pairedCI).toEqual({
      low: 0.18000000000000005,
      high: 0.19000000000000006,
    })
    expect(d.evidence.pairedPValue).toBe(0.0078125)
    expect(d.evidence.holdoutCoverage.coverage).toBe(1)
    expect(d.evidence.searchCoverage.coverage).toBe(1)
  })
})

describe('HeldOutGate — coverage accounting is complete', () => {
  it('partitions every dealt item and never disagrees with productiveRuns, over 400 randomised ragged shapes', () => {
    // Deterministic PRNG so a failure reproduces.
    let state = 0x5eed1
    const rnd = () => {
      state = (state * 1664525 + 1013904223) >>> 0
      return state / 0x100000000
    }
    for (let trial = 0; trial < 400; trial += 1) {
      const n = 1 + Math.floor(rnd() * 14)
      const candidate: RunRecord[] = []
      const baseline: RunRecord[] = []
      for (let i = 0; i < n; i += 1) {
        const scenarioId = `s${i}`
        for (const split of ['search', 'holdout'] as const) {
          const emit = (arm: 'cand' | 'baseline', score: number | null): RunRecord | null => {
            if (score === null) return null
            const row = record({
              candidateId: arm,
              scenarioId,
              seed: i,
              splitTag: split,
              outcome:
                split === 'search'
                  ? { searchScore: score, raw: {} }
                  : { holdoutScore: score, raw: {} },
            })
            if (!Number.isNaN(score)) return row
            const { searchScore: _s, holdoutScore: _h, ...blank } = row.outcome
            return { ...row, outcome: blank }
          }
          // 0 = no row, NaN = a row with no score, else a real score
          const roll = (): number | null => {
            const r = rnd()
            if (r < 0.25) return null
            if (r < 0.5) return Number.NaN
            return Number(r.toFixed(3))
          }
          const c = emit('cand', roll())
          const b = emit('baseline', roll())
          if (c !== null) candidate.push(c)
          if (b !== null) baseline.push(b)
        }
      }
      let d: ReturnType<HeldOutGate['evaluate']>
      try {
        d = new HeldOutGate({
          baselineKey: 'baseline',
          seed: 1337,
          minCoverage: 0,
          minProductiveRuns: 1,
        }).evaluate(candidate, baseline)
      } catch {
        continue // fail-loud inputs (duplicate identities) are not this test's subject
      }
      for (const cov of [d.evidence.holdoutCoverage, d.evidence.searchCoverage]) {
        expect(cov.answered + cov.unscoredPairs + cov.candidateOnly + cov.baselineOnly).toBe(
          cov.dealt,
        )
        expect(cov.coverage).toBe(cov.dealt === 0 ? 0 : cov.answered / cov.dealt)
      }
      // The dealt pairing and the decision pairing key on the same identity, so
      // the count the coverage reports IS the n the statistics ran on.
      expect(d.evidence.holdoutCoverage.answered).toBe(d.evidence.productiveRuns)
    }
  })
})

describe('HeldOutGate — the cost median has a denominator too', () => {
  /** 12 fully-covered items at a real $5.00/task, plus `padRows` cheap rows on a
   *  split the gate never scores. */
  function padded(
    padRows: number,
    padSplit: 'dev' | 'holdout',
  ): {
    candidate: RunRecord[]
    baseline: RunRecord[]
  } {
    const candidate: RunRecord[] = []
    const baseline: RunRecord[] = []
    for (let i = 0; i < 12; i += 1) {
      const scenarioId = `s${String(i).padStart(2, '0')}`
      baseline.push(
        record({
          candidateId: 'baseline',
          scenarioId,
          seed: i,
          splitTag: 'search',
          costUsd: 0.02,
          outcome: { searchScore: 0.62, raw: {} },
        }),
        record({
          candidateId: 'baseline',
          scenarioId,
          seed: i,
          splitTag: 'holdout',
          costUsd: 0.02,
          outcome: { holdoutScore: 0.6, raw: {} },
        }),
      )
      candidate.push(
        record({
          candidateId: 'cand',
          scenarioId,
          seed: i,
          splitTag: 'search',
          costUsd: 5,
          outcome: { searchScore: 0.96, raw: {} },
        }),
        record({
          candidateId: 'cand',
          scenarioId,
          seed: i,
          splitTag: 'holdout',
          costUsd: 5,
          outcome: { holdoutScore: 0.95 + (i % 3) * 0.01, raw: {} },
        }),
      )
    }
    for (let k = 0; k < padRows; k += 1) {
      candidate.push(
        record({
          candidateId: 'cand',
          scenarioId: `pad${k}`,
          seed: 9000 + k,
          splitTag: padSplit,
          costUsd: 0.0001,
          outcome: { raw: {} },
        }),
      )
    }
    return { candidate, baseline }
  }

  const decide = (runs: { candidate: RunRecord[]; baseline: RunRecord[] }) =>
    new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      costPerTaskCeiling: 1,
      minProductiveRuns: 3,
    }).evaluate(runs.candidate, runs.baseline)

  it('cannot be dragged under the ceiling by rows the gate never scored', () => {
    // 48 cheap `dev` rows used to move the median from $5.00 to $0.0001 and
    // promote a candidate costing five times the ceiling.
    for (const padRows of [0, 12, 24, 48, 200]) {
      const d = decide(padded(padRows, 'dev'))
      expect(d.evidence.medianCandidateCost).toBe(5)
      expect(d.promote).toBe(false)
      expect(d.rejectionCode).toBe('cost_ceiling')
    }
  })

  it('padding on a SCORED split is caught by coverage instead', () => {
    const d = decide(padded(48, 'holdout'))
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('incomplete_coverage')
    expect(d.evidence.holdoutCoverage.candidateOnly).toBe(48)
  })

  it('reports the cost of the runs that decided the verdict, unpadded', () => {
    const d = decide(padded(0, 'dev'))
    expect(d.evidence.medianCandidateCost).toBe(5)
    expect(d.evidence.medianBaselineCost).toBe(0.02)
  })
})
