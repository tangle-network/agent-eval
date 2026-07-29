import { describe, expect, it } from 'vitest'
import { HeldOutGate } from '../src/held-out-gate'
import type { RunRecord } from '../src/run-record'
import {
  pairedRiskDifference,
  pairedRiskDifferenceExact,
  pairedRiskDifferenceScore,
} from '../src/statistics'

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

  it('MEASURES a tie-pinned regression at a negative threshold, no longer just refuses it', () => {
    // 5 candidate wins, 15 candidate losses, 56 ties over 76 held-out items:
    // a real −13.2pp drop whose MEDIAN paired delta is exactly 0. The gate used
    // to see a [0, 0] median CI here and refuse only for want of any direction
    // at all. On a two-point outcome it now decides on the exact paired risk
    // difference, so the same data is REJECTED BY NAME with the size of the
    // drop attached. Refusal is preserved; blindness is not.
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

    // The number that used to make the gate blind is still reported.
    expect(decision.evidence.medianPairedDelta).toBe(0)
    expect(decision.evidence.tieFraction).toBeCloseTo(56 / 76, 12)
    expect(decision.evidence.deltaStatistic).toBe('paired_risk_difference')
    expect(decision.evidence.decidingDelta).toBeCloseTo(-10 / 76, 12)
    expect(decision.evidence.mcnemar).toMatchObject({ b: 5, c: 15, nDiscordant: 20 })
    // The whole interval is below zero: the drop is credible, not a [0, 0] shrug.
    expect(decision.evidence.pairedCI!.high).toBeLessThan(0)
    expect(decision.promote).toBe(false)
    expect(decision.rejectionCode).toBe('negative_delta')
    expect(decision.reason).toContain('success-rate')
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
    // search≈0.95, holdout≈0.55 (gap≈0.40); baseline search=0.55, holdout=0.50
    // (gap=0.05). The holdout scores carry a little spread on purpose: six
    // pairs improving by an identical amount give a zero-width CI, which the
    // gate refuses as `indeterminate_delta` before it ever reaches the overfit
    // check, and this test is about the overfit check.
    const pairs = joinPairs(
      ...[0.54, 0.55, 0.56, 0.55, 0.54, 0.56].map((holdout, i) =>
        makePair('cand', i, 0.95, holdout, 0.55, 0.5),
      ),
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
    // Spread on the candidate holdout for the same reason as the test above:
    // identical paired deltas are refused for zero CI width, which would mask
    // the overfit rejection this test is asserting.
    const pairs = joinPairs(
      ...[0.59, 0.6, 0.61, 0.6, 0.59, 0.61].map((holdout, i) =>
        makePair('cand', i, 0.9, holdout, 0.5, 0.5),
      ),
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
      // Holdout scores vary by scenario. A fixture where every pair improves by
      // an identical amount produces a zero-width bootstrap interval, which the
      // gate refuses as a certainty claim with no variance behind it — so a
      // constant fixture would test that refusal instead of the coverage rule
      // these cases are about.
      const score = split === 'search' ? 0.96 : candidateHoldout + ((i % 5) - 2) / 100
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
    //
    // ONE number moved since, deliberately: `pairedCI` is now the interval on
    // the MEAN paired delta, not the median, so its upper bound reads 0.195
    // instead of 0.190. The deltas here are continuous (0.17-0.21) and the
    // verdict, the lower bound and the p-value are all unchanged — the switch
    // exists for the shapes where the median is pinned at 0, and this pin is
    // what proves it does not disturb the shapes where it was not.
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
    expect(d.evidence.deltaStatistic).toBe('mean_bootstrap')
    expect(d.evidence.pairedCI).toEqual({
      low: 0.18000000000000005,
      high: 0.19500000000000006,
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
    expect(d.evidence.deltaStatistic).toBe('median_bootstrap')
    expect(d.evidence.mcnemar).toBeNull()
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
    expect(d.evidence.deltaStatistic).toBe('mean_bootstrap')
    expect(d.evidence.mcnemar).toBeNull()
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
  it('REFUSES 5-of-6 wins: the Wald interval promotes it, the exact one does not', () => {
    // n=6, b=5, c=0, 1 tie — the SMALLEST sample the gate will decide at all
    // (`minProductiveRuns` is floored at `minimumPairsForPairedDeltaTest(0.95)`
    // = 6), so this is reachable on defaults. McNemar's exact test on these
    // discordant counts gives p = 0.0625, above α = 0.05.
    const pairs = twoPointPairs(5, 0, 1)
    const d = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(
      pairs.candidate,
      pairs.baseline,
    )
    expect(d.evidence.productiveRuns).toBe(6)
    expect(d.evidence.deltaStatistic).toBe('paired_risk_difference')
    expect(d.evidence.mcnemar).toMatchObject({ b: 5, c: 0, nDiscordant: 5 })
    expect(d.evidence.mcnemar!.pValue).toBeCloseTo(0.0625, 12)

    // Three intervals on the SAME discordant counts, so the divergence is
    // shown rather than asserted from a comment. TWO of them clear 0 at this
    // sample size and would promote on their own — the Wald normal
    // approximation, and the asymptotic score interval the gate decides on.
    // Only the exact conditional interval straddles 0.
    //
    // This is exactly why McNemar's exact test is kept as a VETO at every
    // non-negative threshold rather than as decoration: 5 improvements out of 6
    // cannot reach α = 0.05 by any exact argument (the two-sided floor at 5
    // discordant pairs is 2/2^5 = 0.0625), and the veto is what enforces that
    // when the interval is willing to be talked into it.
    const wald = pairedRiskDifference([0, 0, 0, 0, 0, 1], [1, 1, 1, 1, 1, 1])
    const exact = pairedRiskDifferenceExact([0, 0, 0, 0, 0, 1], [1, 1, 1, 1, 1, 1])
    const score = pairedRiskDifferenceScore([0, 0, 0, 0, 0, 1], [1, 1, 1, 1, 1, 1])
    expect(wald.lower).toBeGreaterThan(0)
    expect(score.lower).toBeGreaterThan(0)
    expect(exact.lower).toBeLessThan(0)
    expect(d.evidence.pairedCI!.low).toBeCloseTo(score.lower, 12)

    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
    expect(d.reason).toMatch(/McNemar exact p=/)
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
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
    expect(d.evidence.productiveRuns).toBe(76)
    expect(d.evidence.deltaStatistic).toBe('mean_bootstrap')
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
    expect(d.evidence.deltaStatistic).toBe('mean_bootstrap')
    expect(d.evidence.tieFraction).toBeCloseTo(56 / 76, 12)
    expect(d.evidence.decidingDelta).toBeCloseTo((20 * -(1 / 3)) / 76, 6)
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
    expect(d.evidence.deltaStatistic).toBe('mean_bootstrap')
    expect(d.evidence.decidingDelta).toBeCloseTo(10 / 3 / 26, 10)

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

  it('REFUSES an all-concordant sample too small to bound the margin it is judged at', () => {
    // 40 identical pairs, judged at a −5pp noninferiority margin. Zero
    // discordant pairs out of 40 only bounds the drop at ~8.8pp, which is
    // wider than the margin, so the sample cannot answer the question asked.
    const pairs = twoPointPairs(0, 0, 40)
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      pairedDeltaThreshold: -0.05,
    }).evaluate(pairs.candidate, pairs.baseline)
    expect(d.evidence.mcnemar).toMatchObject({ b: 0, c: 0, nDiscordant: 0 })
    expect(d.evidence.pairedCI!.low).toBeCloseTo(-0.0876216, 6)
    expect(d.evidence.pairedCI!.low).toBeLessThan(-0.05)
    expect(d.promote).toBe(false)
    expect(d.rejectionCode).toBe('negative_delta')
  })

  it('REFUSES an all-concordant sample at threshold 0 — no ties can prove a gain', () => {
    for (const n of [40, 76, 200, 500]) {
      const pairs = twoPointPairs(0, 0, n)
      const d = new HeldOutGate({ baselineKey: 'baseline', seed: 1337 }).evaluate(
        pairs.candidate,
        pairs.baseline,
      )
      expect(d.promote).toBe(false)
      expect(d.evidence.pairedCI!.low).toBeLessThan(0)
    }
  })

  it('a large all-concordant sample DOES clear a noninferiority margin it can bound', () => {
    // The deliberate consequence of deciding on an interval that is valid at a
    // nonzero margin: 76 pairs with not one difference bounds the drop at
    // 4.81pp, which does clear a −5pp margin. That is the answer a
    // noninferiority question has, and it is what the exact conditional
    // interval could never say because [0,0] carried no width at all.
    const pairs = twoPointPairs(0, 0, 76)
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      pairedDeltaThreshold: -0.05,
    }).evaluate(pairs.candidate, pairs.baseline)
    expect(d.evidence.pairedCI!.low).toBeCloseTo(-0.0481136, 6)
    expect(d.promote).toBe(true)
  })

  it('FAILS CLOSED on an all-tie CONTINUOUS holdout too', () => {
    // Genuinely continuous — the scores differ across scenarios, so this does
    // not collapse into the two-point path — but every PAIR ties, so the mean
    // paired delta and its whole bootstrap interval are exactly [0, 0].
    const pairs = joinPairs(
      ...Array.from({ length: 12 }, (_, i) => {
        const score = 0.3 + i / 50
        return makePair('cand', i, score, score, score, score)
      }),
    )
    const d = new HeldOutGate({
      baselineKey: 'baseline',
      seed: 1337,
      pairedDeltaThreshold: -0.05,
    }).evaluate(pairs.candidate, pairs.baseline)
    expect(d.evidence.deltaStatistic).toBe('mean_bootstrap')
    expect(d.evidence.pairedCI).toEqual({ low: 0, high: 0 })
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
