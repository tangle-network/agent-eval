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
    expect(d.evidence.deltaStatistic).toBe('paired_risk_difference')
    expect(d.evidence.pairedCI!.low).toBeGreaterThan(0)
    expect(d.evidence.mcnemar).toMatchObject({ b: 15, c: 5, nDiscordant: 20 })
    expect(d.evidence.mcnemar!.pValue).toBeLessThan(0.05)
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

  it('keeps CONTINUOUS outcomes on the median bootstrap, byte-identical', () => {
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
    expect(d.evidence.deltaStatistic).toBe('median_bootstrap')
    expect(d.evidence.mcnemar).toBeNull()
    // Exact numbers pinned from the pre-fix gate so a future change to the
    // continuous path cannot pass silently.
    expect(d.evidence.medianPairedDelta).toBe(0.22999999999999998)
    expect(d.evidence.decidingDelta).toBe(0.22999999999999998)
    expect(d.evidence.pairedCI).toEqual({ low: 0.20999999999999996, high: 0.24 })
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
    expect(d.evidence.deltaStatistic).toBe('paired_risk_difference')
    expect(d.evidence.mcnemar).toMatchObject({ b: 2, c: 0, nDiscordant: 2 })
    expect(d.evidence.mcnemar!.pValue).toBeCloseTo(0.5, 12)
    expect(d.evidence.pairedCI!.low).toBeLessThan(0)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
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
    expect(first!.evidence.deltaStatistic).toBe('paired_risk_difference')
    // The threshold is read in the outcome's NATIVE units, so the deciding
    // delta is −13.16 POINTS, not a −0.13 rate.
    expect(first!.evidence.binaryScale).toBe(100)
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
    expect(d.evidence.productiveRuns).toBe(76)
    expect(d.evidence.deltaStatistic).toBe('mean_bootstrap')
    expect(d.evidence.medianPairedDelta).toBe(0)
    expect(d.evidence.decidingDelta).toBeCloseTo((20 * -0.6) / 76, 6)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
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
    expect(d.evidence.deltaStatistic).toBe('mean_bootstrap')
    expect(d.evidence.tieFraction).toBeCloseTo(56 / 76, 12)
    expect(d.evidence.decidingDelta).toBeCloseTo((20 * -(1 / 3)) / 76, 6)
    expect(d.promote).toBe(false)
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
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('indeterminate_delta')
    expect(d.reason).toMatch(/concordant/)
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
    expect(d.evidence.deltaStatistic).toBe('median_bootstrap')
    // The escape hatch reproduces the pre-fix verdict — including its blindness,
    // which is now caught by the fail-closed rule instead of silently refusing.
    expect(d.evidence.pairedCI).toEqual({ low: 0, high: 0 })
    expect(d.promote).toBe(false)
  })
})
