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
    expect(decision.promote).toBe(false)
    // Still refused, and now for a STRONGER reason than #459's: the interval is
    // no longer the directionless [0,0] a tie-pinned median produced, it is
    // measurably negative, so the gate can say the candidate is worse rather
    // than only that it cannot tell.
    expect(decision.rejectionCode).toBe('negative_delta')
    expect(decision.evidence.pairedCI!.high).toBeLessThan(0)
    expect(decision.evidence.decidingDelta).toBeCloseTo(-10 / 76, 6)
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
    // Holdout deltas vary and there are six of them: the delta gate PASSES
    // (sign-flip p = 2/64 = 0.031, interval strictly above 0), so the rejection
    // this test is named for is the one that actually fires. Six identical
    // deltas would instead give a zero-width interval and be refused as
    // indeterminate before the overfit check was ever reached.
    const pairs = joinPairs(
      // search=0.95, holdout≈0.55 (gap≈0.40); baseline search=0.55, holdout=0.50 (gap=0.05).
      makePair('cand', 0, 0.95, 0.54, 0.55, 0.5),
      makePair('cand', 1, 0.95, 0.55, 0.55, 0.5),
      makePair('cand', 2, 0.95, 0.56, 0.55, 0.5),
      makePair('cand', 3, 0.95, 0.57, 0.55, 0.5),
      makePair('cand', 4, 0.95, 0.53, 0.55, 0.5),
      makePair('cand', 5, 0.95, 0.58, 0.55, 0.5),
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
    // Six varied pairs so the delta gate passes and `overfit_gap` is the
    // rejection under test (see the note on the previous case).
    const pairs = joinPairs(
      makePair('cand', 0, 0.9, 0.59, 0.5, 0.5),
      makePair('cand', 1, 0.9, 0.6, 0.5, 0.5),
      makePair('cand', 2, 0.9, 0.61, 0.5, 0.5),
      makePair('cand', 3, 0.9, 0.62, 0.5, 0.5),
      makePair('cand', 4, 0.9, 0.58, 0.5, 0.5),
      makePair('cand', 5, 0.9, 0.63, 0.5, 0.5),
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
    // Candidate is strictly better on quality but costs 4x baseline. Eight
    // pairs, not five: five all-positive paired observations have exact
    // sign-flip p = 2/2^5 = 0.0625, so the delta veto would refuse before the
    // cost check and this test would pass for the wrong reason.
    const pairs = joinPairs(
      makePair('cand', 0, 0.7, 0.7, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 1, 0.72, 0.72, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 2, 0.71, 0.71, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 3, 0.73, 0.73, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 4, 0.74, 0.74, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 5, 0.75, 0.75, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 6, 0.69, 0.69, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
      makePair('cand', 7, 0.76, 0.76, 0.5, 0.5, { candidate: 0.08, baseline: 0.02 }),
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
      makePair('cand', 6, 0.69, 0.69, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 7, 0.76, 0.76, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
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
    // Eight pairs so the delta gate passes and `missing_cost` is what fires.
    const pairs = joinPairs(
      makePair('cand', 0, 0.7, 0.7, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 1, 0.72, 0.72, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 2, 0.71, 0.71, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 3, 0.73, 0.73, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 4, 0.74, 0.74, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 5, 0.75, 0.75, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 6, 0.69, 0.69, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
      makePair('cand', 7, 0.76, 0.76, 0.5, 0.5, { candidate: 0.03, baseline: 0.02 }),
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

/**
 * Binary (0/1) per-item outcomes — the regime a pass/fail eval produces.
 *
 * The paired delta vector then lives in {-1, 0, +1} and is dominated by zeros
 * (both arms solve or both arms miss most items). Its MEDIAN is pinned at
 * exactly 0 in essentially every bootstrap resample, so a gate that decides on
 * the median CI can neither see a real gain nor a real regression.
 *
 * Shape used below is the one measured in supervisor-lab: 76 held-out items,
 * 15 candidate wins, 5 candidate losses, 56 ties ⇒ a real +13.2pp lift
 * (mean paired Δ = 10/76 = 0.1316) whose median paired Δ is 0.
 */
function binaryPairs(
  wins: number,
  losses: number,
  ties: number,
): { candidate: RunRecord[]; baseline: RunRecord[] } {
  const pairs: ReturnType<typeof makePair>[] = []
  let seed = 0
  for (let i = 0; i < wins; i++, seed++) pairs.push(makePair('cand', seed, 1, 1, 0, 0))
  for (let i = 0; i < losses; i++, seed++) pairs.push(makePair('cand', seed, 0, 0, 1, 1))
  for (let i = 0; i < ties; i++, seed++) pairs.push(makePair('cand', seed, 1, 1, 1, 1))
  return joinPairs(...pairs)
}

describe('HeldOutGate — binary (pass/fail) held-out outcomes', () => {
  it('PROMOTES a real +13.2pp binary lift that the median paired delta cannot see', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 })
    const pairs = binaryPairs(15, 5, 56)
    const d = g.evaluate(pairs.candidate, pairs.baseline)

    expect(d.promote).toBe(true)
    expect(d.rejectionCode).toBeNull()
    expect(d.evidence.productiveRuns).toBe(76)
    // The median IS 0 — that is the whole point; it is reported as a diagnostic
    // and must NOT be the statistic the promotion decision keys on.
    expect(d.evidence.medianPairedDelta).toBe(0)
    // 15 wins vs 5 losses out of 76 paired items = +0.1316 success-rate lift.
    expect(d.evidence.decidingDelta).toBeCloseTo(10 / 76, 6)
    expect(d.evidence.deltaStatistic).toBe('mean')
    expect(d.evidence.pairedCI!.low).toBeGreaterThan(0)
    expect(d.evidence.mcnemar).toMatchObject({ b: 15, c: 5, nDiscordant: 20 })
    expect(d.evidence.mcnemar!.pValue).toBeLessThan(0.05)
    // A pass/fail outcome is recognised by its DELTA step, not by its levels,
    // and on such data the sign-flip veto IS McNemar's exact test.
    expect(d.evidence.deltaMagnitude).toBe(1)
    expect(d.evidence.signFlip!.method).toBe('exact')
    expect(d.evidence.signFlip!.pValue).toBeCloseTo(d.evidence.mcnemar!.pValue, 15)
    expect(d.evidence.signFlip).toMatchObject({ improved: 15, worsened: 5, tied: 56 })
  })

  it('still REFUSES a binary regression, including at a negative threshold', () => {
    // The block-aggregation workaround callers reach for is `pairedDeltaThreshold < 0`.
    // Pre-fix that made the gate fail OPEN: a median CI pinned at [0,0] clears any
    // negative threshold, so a −13.2pp regression PROMOTED.
    const pairs = binaryPairs(5, 15, 56)
    const decisions = [0, -0.05, -0.1].map((pairedDeltaThreshold) =>
      new HeldOutGate({ baselineKey: 'baseline', seed: 1337, pairedDeltaThreshold }).evaluate(
        pairs.candidate,
        pairs.baseline,
      ),
    )
    expect(decisions.map((d) => d.promote)).toEqual([false, false, false])
    expect(decisions.map((d) => d.rejectionCode)).toEqual([
      'negative_delta',
      'negative_delta',
      'negative_delta',
    ])
    for (const d of decisions) expect(d.evidence.decidingDelta).toBeCloseTo(-10 / 76, 6)
  })

  it('REFUSES binary noise (equal wins and losses)', () => {
    const g = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 })
    const pairs = binaryPairs(8, 8, 60)
    const d = g.evaluate(pairs.candidate, pairs.baseline)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
    expect(d.evidence.decidingDelta).toBeCloseTo(0, 12)
  })

  it('keeps CONTINUOUS outcomes byte-identical under deltaStatistic:"median"', () => {
    // The pre-0.134 median verdict, pinned to the digit. The default is now the
    // mean (see the next test) because the median cannot resolve the lattice
    // shapes eval data lands in; this asserts the old path is still exactly
    // reachable, so no verdict capability was lost.
    const g = new HeldOutGate({
      baselineKey: 'baseline',
      minProductiveRuns: 3,
      pairedDeltaThreshold: 0,
      overfitGapThreshold: 0.5,
      seed: 1,
      deltaStatistic: 'median',
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
    expect(d.evidence.deltaStatistic).toBe('median')
    expect(d.evidence.intervalMethods.map((m) => m.method)).toEqual(['median_bootstrap'])
    // Exact numbers pinned from the pre-fix gate so a future change to the
    // median path cannot pass silently.
    expect(d.evidence.medianPairedDelta).toBe(0.22999999999999998)
    expect(d.evidence.decidingDelta).toBe(0.22999999999999998)
    expect(d.evidence.pairedCI).toEqual({ low: 0.20999999999999996, high: 0.24 })
    expect(d.promote).toBe(true)
  })

  it('decides CONTINUOUS outcomes on the mean by default, same verdict', () => {
    const g = new HeldOutGate({
      baselineKey: 'baseline',
      minProductiveRuns: 3,
      pairedDeltaThreshold: 0,
      overfitGapThreshold: 0.5,
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
    expect(d.evidence.deltaStatistic).toBe('mean')
    // Both applicable interval methods ran; the decision took the lower of them.
    expect(d.evidence.intervalMethods.map((m) => m.method).sort()).toEqual([
      'empirical_likelihood',
      'percentile_bootstrap',
    ])
    expect(d.evidence.pairedCI!.low).toBe(Math.min(...d.evidence.intervalMethods.map((m) => m.low)))
    // The literal median is still reported as a diagnostic, unchanged.
    expect(d.evidence.medianPairedDelta).toBe(0.22999999999999998)
    expect(d.evidence.decidingDelta).toBeCloseTo(0.22749999999999998, 12)
    expect(d.evidence.pairedCI!.low).toBeGreaterThan(0)
    expect(d.promote).toBe(true)
  })
})

/**
 * Every shape that a {0,1}-only detector let through. Each of these was
 * measured promoting-what-it-should-refuse (or refusing-what-it-should-see)
 * against the first binary fix; they are the regression suite for the
 * *neighbourhood* of the binary case, not just the case itself.
 *
 * Paired holdout outcomes on an arbitrary two-point encoding {0, level}:
 * `wins` items the candidate flips 0→level, `losses` it flips level→0, `ties`
 * both solve. Search mirrors holdout so the overfit gap is 0 on both arms and
 * only the delta gate is under test.
 */
function twoPointPairs(
  wins: number,
  losses: number,
  ties: number,
  level = 1,
): { candidate: RunRecord[]; baseline: RunRecord[] } {
  const pairs: ReturnType<typeof makePair>[] = []
  let seed = 0
  for (let i = 0; i < wins; i++, seed++) pairs.push(makePair('cand', seed, level, level, 0, 0))
  for (let i = 0; i < losses; i++, seed++) pairs.push(makePair('cand', seed, 0, 0, level, level))
  for (let i = 0; i < ties; i++, seed++)
    pairs.push(makePair('cand', seed, level, level, level, level))
  return joinPairs(...pairs)
}

describe('HeldOutGate — shapes a {0,1}-only detector missed', () => {
  it('REFUSES 2-of-3 wins: the Wald interval promotes it, the exact test does not', () => {
    // n=3, b=2, c=0, 1 tie. minProductiveRuns defaults to 3, so this is the
    // smallest promotable sample and it is reachable on defaults. The Wald
    // normal-approximation CI gives [0.133, 1.000] and promotes; McNemar's
    // exact test on the same discordant counts gives p=0.50.
    const pairs = twoPointPairs(2, 0, 1)
    const d = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(
      pairs.candidate,
      pairs.baseline,
    )
    expect(d.evidence.productiveRuns).toBe(3)
    expect(d.evidence.deltaStatistic).toBe('mean')
    expect(d.evidence.mcnemar).toMatchObject({ b: 2, c: 0, nDiscordant: 2 })
    expect(d.evidence.mcnemar!.pValue).toBeCloseTo(0.5, 12)
    expect(d.evidence.signFlip!.pValue).toBeCloseTo(0.5, 12)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
    expect(d.reason).toMatch(/Sign-flip exact p=/)
  })

  it('never promotes what McNemar refuses — over every (wins, losses) shape up to 8', () => {
    const promoted: string[] = []
    for (let wins = 0; wins <= 8; wins++) {
      for (let losses = 0; losses <= 8; losses++) {
        const pairs = twoPointPairs(wins, losses, 5)
        const d = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(
          pairs.candidate,
          pairs.baseline,
        )
        if (!d.promote) continue
        promoted.push(`${wins}w/${losses}l`)
        // α = 1 − confidence = 0.05. A promotion the exact test cannot support
        // is exactly the hole the Wald CI opened.
        expect(d.evidence.mcnemar!.pValue).toBeLessThan(0.05)
        expect(d.evidence.pairedCI!.low).toBeGreaterThan(0)
      }
    }
    // Not vacuous: the gate must still promote the shapes that ARE significant.
    expect(promoted).toEqual(['6w/0l', '7w/0l', '8w/0l', '8w/1l'])
  })

  it('one partial-credit pair does NOT re-open the fail-open', () => {
    // The −13.2pp regression with ONE 0.5/0.5 pair added: the mean paired delta
    // is unchanged (that pair's delta is 0) but the vector is no longer {0,1},
    // so a literal-{0,1} detector fell back to the median, got CI [0,0], and
    // promoted the regression at every negative threshold.
    const clean = twoPointPairs(5, 15, 56)
    const contaminated = joinPairs(
      { candidate: clean.candidate, baseline: clean.baseline },
      makePair('cand', 999, 0.5, 0.5, 0.5, 0.5),
    )
    const decisions = [-0.01, -0.05, -0.1, -0.2].map((pairedDeltaThreshold) =>
      new HeldOutGate({ baselineKey: 'baseline', seed: 1337, pairedDeltaThreshold }).evaluate(
        contaminated.candidate,
        contaminated.baseline,
      ),
    )
    expect(decisions.map((d) => d.promote)).toEqual([false, false, false, false])
    expect(decisions[0]!.evidence.productiveRuns).toBe(77)
    expect(decisions[0]!.evidence.deltaStatistic).not.toBe('median_bootstrap')
    expect(decisions[0]!.evidence.medianPairedDelta).toBe(0)
    expect(decisions[0]!.evidence.decidingDelta).toBeCloseTo(-10 / 77, 6)
    expect(decisions[0]!.evidence.pairedCI!.low).toBeLessThan(-0.2)
  })

  it('sees a regression encoded on 0-100, not only on {0,1}', () => {
    // `detectScale` exists because judges emit dimensions on 0-100 as well as
    // [0,1]. A {0,1}-only detector read this −13.16-POINT drop as continuous,
    // collapsed to CI [0,0], and promoted it at −1, −5 and −10.
    const pairs = twoPointPairs(5, 15, 56, 100)
    const decisions = [0, -1, -5, -10].map((pairedDeltaThreshold) =>
      new HeldOutGate({
        baselineKey: 'baseline',
        seed: 1337,
        pairedDeltaThreshold,
        overfitGapThreshold: 15,
      }).evaluate(pairs.candidate, pairs.baseline),
    )
    expect(decisions.map((d) => d.promote)).toEqual([false, false, false, false])
    const [first] = decisions
    expect(first!.evidence.deltaStatistic).toBe('mean')
    // The threshold is read in the outcome's NATIVE units, so the deciding
    // delta is −13.16 POINTS, not a −0.13 rate. Nothing rescales anything: the
    // mean paired delta is already in points because the deltas are.
    expect(first!.evidence.deltaMagnitude).toBe(100)
    expect(first!.evidence.decidingDelta).toBeCloseTo((-10 / 76) * 100, 6)
    expect(first!.evidence.pairedCI!.low).toBeLessThan(-10)
  })

  it('promotes a real +13.16-point lift encoded on 0-100', () => {
    const pairs = twoPointPairs(15, 5, 56, 100)
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      overfitGapThreshold: 15,
    }).evaluate(pairs.candidate, pairs.baseline)
    expect(d.promote).toBe(true)
    expect(d.evidence.decidingDelta).toBeCloseTo((10 / 76) * 100, 6)
    expect(d.evidence.mcnemar!.pValue).toBeLessThan(0.05)
  })

  it('REFUSES an asymmetric-arm regression (pass/fail baseline, partial-credit candidate)', () => {
    // 20 items drop 1 → 0.4, 56 tie: a real −15.8pp mean drop. The arms are not
    // a common two-point encoding, so this is NOT the binary path — and it must
    // not land on the blind median either.
    const pairs = joinPairs(
      ...Array.from({ length: 20 }, (_, i) => makePair('cand', i, 0.4, 0.4, 1, 1)),
      ...Array.from({ length: 56 }, (_, i) => makePair('cand', 100 + i, 1, 1, 1, 1)),
    )
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      pairedDeltaThreshold: -0.05,
    }).evaluate(pairs.candidate, pairs.baseline)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
    expect(d.evidence.productiveRuns).toBe(76)
    expect(d.evidence.deltaStatistic).toBe('mean')
    expect(d.evidence.medianPairedDelta).toBe(0)
    expect(d.evidence.decidingDelta).toBeCloseTo((20 * -0.6) / 76, 6)
  })

  it('reaches the bench/rung2 caller: block scores in {2/3, 1}', () => {
    // ratchet.ts deals leaves into blocks of 3 and scores a block as the MEAN
    // of its leaves, so block scores land in {0, 1/3, 2/3, 1} — never {0,1}.
    // 20 blocks lose one leaf (1 → 2/3), 56 tie: a real −8.8pp drop that the
    // median cannot see, at the exact `pairedDeltaThreshold: -0.05` that
    // bench/rung2/report.ts ships.
    const third = 2 / 3
    const pairs = joinPairs(
      ...Array.from({ length: 20 }, (_, i) => makePair('cand', i, third, third, 1, 1)),
      ...Array.from({ length: 56 }, (_, i) => makePair('cand', 100 + i, 1, 1, 1, 1)),
    )
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      pairedDeltaThreshold: -0.05,
    }).evaluate(pairs.candidate, pairs.baseline)
    expect(d.promote).toBe(false)
    expect(d.evidence.deltaStatistic).toBe('mean')
    expect(d.evidence.tieFraction).toBeCloseTo(56 / 76, 12)
    expect(d.evidence.decidingDelta).toBeCloseTo((20 * -(1 / 3)) / 76, 6)
    // {2/3, 1} contains no zero, and it is still recognised as pass/fail-shaped
    // because the recognition is on the delta STEP.
    expect(d.evidence.deltaMagnitude).toBeCloseTo(1 / 3, 15)
  })

  it('promotes a real +12.8pp lift on a lattice the median cannot resolve', () => {
    // bench/rung2 deals leaves into blocks of 3 and scores a block as the MEAN
    // of its leaves, so block scores live in {2/3, 1}. 26 blocks: 15 up, 5
    // down, 6 tied — a real +12.8pp lift at only 23% ties, i.e. BELOW any
    // tie-fraction cutoff. The median's bootstrap percentiles land on the
    // lattice: its CI lower bound is exactly 0, so a median-decided gate
    // refuses this lift at threshold 0. That is the original bug, one lattice
    // over, in the direction that silently holds real improvements.
    const two3 = 2 / 3
    const pairs = joinPairs(
      ...Array.from({ length: 15 }, (_, i) => makePair('cand', i, 1, 1, two3, two3)),
      ...Array.from({ length: 5 }, (_, i) => makePair('cand', 100 + i, two3, two3, 1, 1)),
      ...Array.from({ length: 6 }, (_, i) => makePair('cand', 200 + i, 1, 1, 1, 1)),
    )
    const cfg = { baselineKey: 'baseline', seed: 1337, pairedDeltaThreshold: 0 }
    const d = new HeldOutGate(cfg).evaluate(pairs.candidate, pairs.baseline)
    // The verdict first — a real lift must not be held.
    expect(d.promote).toBe(true)
    expect(d.evidence.productiveRuns).toBe(26)
    expect(d.evidence.tieFraction).toBeCloseTo(6 / 26, 12)
    expect(d.evidence.deltaStatistic).toBe('mean')
    expect(d.evidence.decidingDelta).toBeCloseTo(10 / 3 / 26, 10)
    // and the veto agreed it was significant rather than being absent
    expect(d.evidence.signFlip!.pValue).toBeLessThan(0.05)

    // ...and the median path on the SAME data is exactly the refusal: this pins
    // the reason, so the test cannot silently start passing for another one.
    const median = new HeldOutGate({ ...cfg, deltaStatistic: 'median' }).evaluate(
      pairs.candidate,
      pairs.baseline,
    )
    expect(median.evidence.pairedCI!.low).toBe(0)
    expect(median.promote).toBe(false)
    expect(median.rejectionCode).toBe('negative_delta')
  })

  it('FAILS CLOSED when every pair ties — a [0,0] CI decides nothing', () => {
    // 40 identical pairs. The CI is [0,0], which clears any negative threshold
    // by arithmetic while containing no evidence of anything. Absence of
    // evidence must not be laundered into a promotion.
    const pairs = twoPointPairs(0, 0, 40)
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      pairedDeltaThreshold: -0.05,
    }).evaluate(pairs.candidate, pairs.baseline)
    expect(d.evidence.pairedCI).toEqual({ low: 0, high: 0 })
    expect(d.evidence.mcnemar).toMatchObject({ b: 0, c: 0, nDiscordant: 0 })
    expect(d.evidence.signFlip).toMatchObject({ improved: 0, worsened: 0, tied: 40, pValue: 1 })
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('indeterminate_delta')
    expect(d.reason).toMatch(/every paired delta is an exact tie/)
  })

  it('FAILS CLOSED on an all-tie CONTINUOUS holdout too', () => {
    const pairs = joinPairs(
      ...Array.from({ length: 12 }, (_, i) => makePair('cand', i, 0.42, 0.42, 0.42, 0.42)),
    )
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      pairedDeltaThreshold: -0.05,
    }).evaluate(pairs.candidate, pairs.baseline)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('indeterminate_delta')
    expect(d.evidence.tieFraction).toBe(1)
  })

  it('deltaStatistic:"median" still forces the old, blind behaviour on demand', () => {
    const pairs = twoPointPairs(15, 5, 56)
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      deltaStatistic: 'median',
    }).evaluate(pairs.candidate, pairs.baseline)
    expect(d.evidence.deltaStatistic).toBe('median')
    expect(d.evidence.intervalMethods.map((m) => m.method)).toEqual(['median_bootstrap'])
    // The escape hatch reproduces the pre-fix verdict — including its blindness,
    // which is now caught by the fail-closed rule instead of silently refusing.
    expect(d.evidence.pairedCI).toEqual({ low: 0, high: 0 })
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('indeterminate_delta')
  })
})

/**
 * THE PROPERTY THAT WOULD HAVE CAUGHT ALL THREE ROUNDS OF THIS BUG.
 *
 * A promotion gate answers "did the candidate score HIGHER than the baseline,
 * and by enough". That question is about a difference, so adding the same
 * constant to every score on both arms cannot change its answer — the paired
 * deltas are byte-identical and nothing else is evidence. Each earlier version
 * violated it in a way that looked like a different bug (median blindness, a
 * {0,1}-literal detector, a {0,s} detector that still needs a zero present);
 * this asserts the invariant itself rather than the shapes that broke it.
 */
function shiftedPairs(
  holdoutBaseline: number[],
  holdoutCandidate: number[],
  offset: number,
): { candidate: RunRecord[]; baseline: RunRecord[] } {
  return joinPairs(
    ...holdoutBaseline.map((b, i) =>
      // search mirrors holdout, so overfit gaps are 0 on both arms and shift too
      makePair(
        'cand',
        i,
        holdoutCandidate[i]! + offset,
        holdoutCandidate[i]! + offset,
        b + offset,
        b + offset,
      ),
    ),
  )
}

describe('HeldOutGate — the verdict is a function of the DELTAS, not of the values', () => {
  const OFFSETS = [0, 1 / 3, 2 / 3, 1, 10, -7.25, 1e4]

  /** Randomised paired outcomes covering every shape the three rounds hit. */
  function* datasets(): Generator<{ label: string; before: number[]; after: number[] }> {
    const shapes: Array<[string, number[], number]> = [
      ['pass/fail {0,1}', [0, 1], 1],
      ['blocks of 3 {0,1/3,2/3,1}', [0, 1 / 3, 2 / 3, 1], 1],
      ['0-100 judge dimension', [0, 100], 1],
      ['continuous', [0.11, 0.37, 0.52, 0.68, 0.94], 1],
    ]
    // deterministic LCG so the property test is reproducible, not flaky
    let seed = 2026_07_27
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    for (const [label, levels] of shapes) {
      for (const n of [3, 6, 12, 26]) {
        for (let trial = 0; trial < 6; trial++) {
          const before: number[] = []
          const after: number[] = []
          for (let i = 0; i < n; i++) {
            before.push(levels[Math.floor(rand() * levels.length)]!)
            after.push(levels[Math.floor(rand() * levels.length)]!)
          }
          yield { label: `${label} n=${n} trial=${trial}`, before, after }
        }
      }
    }
  }

  for (const threshold of [0, -0.05, 0.02]) {
    it(`adding a constant to both arms never changes the verdict (threshold ${threshold})`, {
      timeout: 60_000,
    }, () => {
      const mismatches: string[] = []
      let promotes = 0
      let refusals = 0
      let cases = 0
      for (const { label, before, after } of datasets()) {
        const decide = (offset: number) =>
          new HeldOutGate({
            baselineKey: 'baseline',
            seed: 1337,
            pairedDeltaThreshold: threshold,
            overfitGapThreshold: 1e9,
          }).evaluate(
            ...((p) => [p.candidate, p.baseline] as const)(shiftedPairs(before, after, offset)),
          )
        const base = decide(0)
        cases++
        if (base.promote) promotes++
        else refusals++
        for (const offset of OFFSETS.slice(1)) {
          const shifted = decide(offset)
          // The VERDICT must be exactly equal — no tolerance, because nothing
          // about it is a function of the score values.
          const exactlySame =
            shifted.promote === base.promote && shifted.rejectionCode === base.rejectionCode
          // The numbers are recomputed from shifted floats (1/3 + 10 - 10 is not
          // 1/3), so they agree to float precision rather than bit-for-bit.
          const near = (a: number | null | undefined, b: number | null | undefined) =>
            a == null || b == null ? a === b : Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(b))
          const numbersSame =
            near(shifted.evidence.signFlip?.pValue, base.evidence.signFlip?.pValue) &&
            near(shifted.evidence.decidingDelta, base.evidence.decidingDelta) &&
            near(shifted.evidence.pairedCI?.low, base.evidence.pairedCI?.low) &&
            near(shifted.evidence.pairedCI?.high, base.evidence.pairedCI?.high) &&
            near(shifted.evidence.deltaMagnitude, base.evidence.deltaMagnitude) &&
            near(shifted.evidence.tieFraction, base.evidence.tieFraction)
          if (!exactlySame || !numbersSame) {
            mismatches.push(
              `${label} offset=${offset}: ${base.promote}/${base.rejectionCode}` +
                `/p=${base.evidence.signFlip?.pValue}/Δ=${base.evidence.decidingDelta}` +
                ` -> ${shifted.promote}/${shifted.rejectionCode}` +
                `/p=${shifted.evidence.signFlip?.pValue}/Δ=${shifted.evidence.decidingDelta}`,
            )
          }
        }
      }
      expect(mismatches).toEqual([])
      // Not vacuous: the sweep must contain both verdicts, or invariance is free.
      expect(cases).toBeGreaterThan(90)
      expect(promotes).toBeGreaterThan(0)
      expect(refusals).toBeGreaterThan(0)
    })
  }

  it('THE ROUND-3 BREAK: 4 of 26 pairs improve by 1/3 — same verdict at every offset', () => {
    // Measured on the previous fix: REFUSED at offset 0 and PROMOTED at 1/3,
    // 2/3, 1 and 10, with byte-identical paired deltas in all five. The gate
    // was answering "is there a zero in the data", not "did the score move".
    const before = Array.from({ length: 26 }, () => 0)
    const after = before.map((_, i) => (i < 4 ? 1 / 3 : 0))
    const decisions = [0, 1 / 3, 2 / 3, 1, 10].map((offset) =>
      new HeldOutGate({ baselineKey: 'baseline', seed: 1337, overfitGapThreshold: 1e9 }).evaluate(
        ...((p) => [p.candidate, p.baseline] as const)(shiftedPairs(before, after, offset)),
      ),
    )
    expect(decisions.map((d) => d.promote)).toEqual([false, false, false, false, false])
    expect(decisions.map((d) => d.rejectionCode)).toEqual(Array(5).fill('negative_delta'))
    // and it is refused for the RIGHT reason: 4 improvements out of 26 with no
    // regressions is exact sign-flip p = 2/2^4 = 0.125, which does not reject.
    for (const d of decisions) {
      expect(d.evidence.signFlip!.pValue).toBeCloseTo(0.125, 12)
      expect(d.evidence.deltaMagnitude).toBeCloseTo(1 / 3, 12)
    }
  })

  it('THE NEIGHBOUR OF THAT BREAK: multi-magnitude improvements cannot skip the veto', () => {
    // Same 4 improvements out of 26 and the same exact p = 0.125, but the
    // winners move by TWO different amounts, so NO single-magnitude or
    // two-point detector can fire on it. Without a veto that every shape
    // reaches, the interval alone promotes this: its bootstrap lower bound sits
    // one lattice atom above zero because only 1.3% of resamples draw no winner.
    const before = Array.from({ length: 26 }, () => 0)
    const after = before.map((_, i) => (i < 3 ? 1 / 3 : i === 3 ? 2 / 3 : 0))
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      overfitGapThreshold: 1e9,
    }).evaluate(...((p) => [p.candidate, p.baseline] as const)(shiftedPairs(before, after, 0)))
    expect(d.evidence.deltaMagnitude).toBeNull() // no single magnitude to detect
    expect(d.evidence.signFlip!.pValue).toBeCloseTo(0.125, 12)
    expect(d.evidence.pairedCI!.low).toBeGreaterThan(0) // the interval alone would promote
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
    expect(d.reason).toMatch(/Sign-flip exact p=/)
  })
})

/**
 * A NONZERO `pairedDeltaThreshold` IS A DIFFERENT QUESTION, and the interval has
 * to be calibrated for it. `bench/rung2` ships `pairedDeltaThreshold: -0.05`,
 * so this is the live path, not a corner.
 */
describe('HeldOutGate — calibration at a nonzero margin', () => {
  it('refuses the boundary case an exact CONDITIONAL interval promotes', () => {
    // 76 pairs, 0 candidate wins, 3 baseline wins, 73 ties, threshold −0.05.
    // The conditional Clopper-Pearson interval returns [−0.0395, 0.0164] and
    // PROMOTES, because conditioning on the 3 discordant pairs throws away the
    // variability in how many discordant pairs there were.
    const before = Array.from({ length: 76 }, (_, i) => (i < 3 ? 1 : 0))
    const after = Array.from({ length: 76 }, () => 0)
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      pairedDeltaThreshold: -0.05,
      overfitGapThreshold: 1e9,
    }).evaluate(...((p) => [p.candidate, p.baseline] as const)(shiftedPairs(before, after, 0)))
    expect(d.evidence.decidingDelta).toBeCloseTo(-3 / 76, 12)
    expect(d.evidence.pairedCI!.low).toBeLessThan(-0.05)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
  })

  it('promotes at most the nominal 5% under repeated sampling AT the boundary', {
    timeout: 60_000,
  }, () => {
    // The decisive check the duality test could not make: draw from a process
    // whose TRUE risk difference equals the margin exactly and count how often a
    // nominal-95% gate says "not worse". Deterministic PRNG, so this is a fixed
    // number, not a flaky one.
    let s = 987654321 >>> 0
    const rnd = () => {
      s ^= s << 13
      s >>>= 0
      s ^= s >> 17
      s ^= s << 5
      s >>>= 0
      return s / 4294967296
    }
    const reps = 300
    let promoted = 0
    for (let r = 0; r < reps; r++) {
      const before: number[] = []
      const after: number[] = []
      for (let i = 0; i < 76; i++) {
        before.push(rnd() < 0.05 ? 1 : 0) // true RD = -0.05 = the margin
        after.push(0)
      }
      const d = new HeldOutGate({
        baselineKey: 'baseline',
        seed: 1337,
        pairedDeltaThreshold: -0.05,
        overfitGapThreshold: 1e9,
      }).evaluate(...((p) => [p.candidate, p.baseline] as const)(shiftedPairs(before, after, 0)))
      if (d.promote) promoted++
    }
    // Published 0.125.0 promotes 95.2% of these and the exact conditional
    // interval 44.8%; nominal is 5%.
    expect(promoted / reps).toBeLessThanOrEqual(0.05)
  })
})

describe('HeldOutGate — fail closed on a directionless interval, at ANY location', () => {
  it('refuses a zero-width interval that is not at zero', () => {
    // Three pairs all improving by exactly 1/3. The percentile bootstrap of
    // identical deltas has zero width — CI [0.3333, 0.3333] — which is a claim
    // of certainty from three observations, and the previous rule only caught
    // zero width AT zero.
    const before = [0, 0, 0]
    const after = [1 / 3, 1 / 3, 1 / 3]
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      overfitGapThreshold: 1e9,
    }).evaluate(...((p) => [p.candidate, p.baseline] as const)(shiftedPairs(before, after, 0)))
    expect(d.evidence.pairedCI!.low).toBe(d.evidence.pairedCI!.high)
    expect(d.evidence.pairedCI!.low).toBeCloseTo(1 / 3, 12)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('indeterminate_delta')
    expect(d.reason).toMatch(/no spread for any interval to measure/)
  })

  it('refuses identical continuous deltas however many of them there are', () => {
    const before = Array.from({ length: 12 }, () => 0.5)
    const after = Array.from({ length: 12 }, () => 0.55)
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      overfitGapThreshold: 1e9,
    }).evaluate(...((p) => [p.candidate, p.baseline] as const)(shiftedPairs(before, after, 0)))
    // The sign-flip test alone WOULD accept this (p = 2/2^12), so the
    // fail-closed rule is doing independent work here.
    expect(d.evidence.signFlip!.pValue).toBeLessThan(0.05)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('indeterminate_delta')
  })
})

describe('HeldOutGate — cannot be talked into a promotion', () => {
  it('adding TIED pairs never turns a refusal into a promotion', () => {
    // Padding a holdout set with items both arms already solve adds no evidence.
    // A rule keyed on a percentile of a resampled mean can be nudged by it; the
    // sign-flip test cannot, because a tie contributes 0 to every sign pattern.
    const bases: Array<[number[], number[]]> = [
      [
        [0, 0, 0, 0, 0],
        [1, 1, 1, 1, 1],
      ],
      [
        [0, 0, 0, 0],
        [1, 1, 1, 0],
      ],
      [
        [0, 0, 0, 0, 0, 0],
        [1, 1, 1, 1, 1, 0],
      ],
    ]
    const flips: string[] = []
    for (const [b0, a0] of bases) {
      let previous = false
      for (let padding = 0; padding <= 40; padding++) {
        const before = [...b0, ...Array.from({ length: padding }, () => 1)]
        const after = [...a0, ...Array.from({ length: padding }, () => 1)]
        const decision = new HeldOutGate({
          baselineKey: 'baseline',
          seed: 1337,
          overfitGapThreshold: 1e9,
        }).evaluate(...((p) => [p.candidate, p.baseline] as const)(shiftedPairs(before, after, 0)))
        if (decision.promote && !previous && padding > 0) {
          flips.push(`base ${a0.length} + ${padding} ties`)
        }
        previous = decision.promote
      }
    }
    expect(flips).toEqual([])
  })

  it('needs six concordant pairs however the improvement is split up', () => {
    // The same total lift spread over more pairs is genuinely more evidence, and
    // the exact permutation floor is 2/2^m — so five all-improving pairs can
    // never reach α = 0.05 and six can. This pins the boundary so a future
    // estimator swap cannot quietly move it.
    const verdicts = [3, 4, 5, 6, 8].map((k) => {
      const before = Array.from({ length: 26 }, () => 0)
      const after = before.map((_, i) => (i < k ? 2 / k : 0))
      return new HeldOutGate({
        baselineKey: 'baseline',
        seed: 1337,
        overfitGapThreshold: 1e9,
      }).evaluate(...((p) => [p.candidate, p.baseline] as const)(shiftedPairs(before, after, 0)))
        .promote
    })
    expect(verdicts).toEqual([false, false, false, true, true])
  })
})

describe('HeldOutGate — relaxing the bar never costs you a promotion', () => {
  it('is monotone in pairedDeltaThreshold across every shape', () => {
    // Lowering the threshold asks a strictly weaker question. If a promotion
    // could vanish when the bar drops, some rule would be keyed on the
    // threshold's SIGN rather than on the evidence — which is what the
    // non-inferiority carve-out (no significance veto below zero) would be if it
    // were a hole rather than a deliberate weakening.
    const thresholds = [0.2, 0.05, 0.01, 0, -0.01, -0.05, -0.2, -1]
    let seed = 99991
    const rand = () => {
      seed = (seed * 1664525 + 1013904223) % 4294967296
      return seed / 4294967296
    }
    const violations: string[] = []
    let promotedSomewhere = 0
    let cases = 0
    for (const levels of [
      [0, 1],
      [0, 1 / 3, 2 / 3, 1],
      [0, 100],
      [0.11, 0.37, 0.52, 0.94],
    ]) {
      for (const n of [3, 6, 12, 26]) {
        for (let trial = 0; trial < 6; trial++) {
          const before = Array.from(
            { length: n },
            () => levels[Math.floor(rand() * levels.length)]!,
          )
          const after = Array.from({ length: n }, () => levels[Math.floor(rand() * levels.length)]!)
          const verdicts = thresholds.map(
            (pairedDeltaThreshold) =>
              new HeldOutGate({
                baselineKey: 'baseline',
                seed: 1337,
                pairedDeltaThreshold,
                overfitGapThreshold: 1e9,
              }).evaluate(
                ...((p) => [p.candidate, p.baseline] as const)(shiftedPairs(before, after, 0)),
              ).promote,
          )
          cases++
          if (verdicts.some(Boolean)) promotedSomewhere++
          for (let i = 1; i < verdicts.length; i++) {
            if (verdicts[i - 1] && !verdicts[i]) {
              violations.push(
                `n=${n} trial=${trial}: ${thresholds[i - 1]} promotes, ${thresholds[i]} does not`,
              )
            }
          }
        }
      }
    }
    expect(violations).toEqual([])
    expect(cases).toBe(96)
    expect(promotedSomewhere).toBeGreaterThan(20) // not vacuous
  })
})
