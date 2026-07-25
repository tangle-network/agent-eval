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

    const withUnmatched = g.evaluate(
      [...pairs.candidate, ...unmatchedCandidateRows],
      pairs.baseline,
    )

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
    )
    const a = g1.evaluate(pairs.candidate, pairs.baseline)
    const b = g2.evaluate(pairs.candidate, pairs.baseline)
    expect(a.evidence.pairedCI!.low).toBe(b.evidence.pairedCI!.low)
    expect(a.evidence.pairedCI!.high).toBe(b.evidence.pairedCI!.high)
  })

  it('drops candidate runs that have no matching baseline pair', () => {
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
    expect(d.rejectionCode).toBe('few_runs')
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
    expect(decision.rejectionCode).toBe('few_runs')
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
