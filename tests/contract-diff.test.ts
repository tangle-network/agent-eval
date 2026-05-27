import { describe, expect, it } from 'vitest'
import { diffGenerations, diffRunBaselineToWinner, diffRuns } from '../src/contract/diff'
import type { EvalRunEvent, EvalRunGenerationSnapshot } from '../src/hosted/types'

function gen(
  opts: Partial<EvalRunGenerationSnapshot> & {
    index: number
    surfaceHash: string
  },
): EvalRunGenerationSnapshot {
  return {
    cells: [],
    compositeMean: 0,
    costUsd: 0,
    durationMs: 0,
    ...opts,
  }
}

function cell(
  scenarioId: string,
  rep: number,
  composite: number,
  dims: Record<string, Record<string, number>> = {},
) {
  return { scenarioId, rep, compositeMean: composite, dimensions: dims }
}

describe('diffGenerations', () => {
  it('matches cells on (scenarioId, rep) and computes composite delta', () => {
    const before = gen({
      index: 0,
      surfaceHash: 'h0',
      cells: [cell('s1', 0, 0.5), cell('s2', 0, 0.7)],
      compositeMean: 0.6,
    })
    const after = gen({
      index: 1,
      surfaceHash: 'h1',
      cells: [cell('s1', 0, 0.8), cell('s2', 0, 0.65)],
      compositeMean: 0.725,
    })
    const diff = diffGenerations(before, after)
    expect(diff.matched).toHaveLength(2)
    const s1 = diff.matched.find((d) => d.scenarioId === 's1')
    expect(s1?.compositeDelta).toBeCloseTo(0.3, 10)
    const s2 = diff.matched.find((d) => d.scenarioId === 's2')
    expect(s2?.compositeDelta).toBeCloseTo(-0.05, 10)
    expect(diff.compositeDelta).toBeCloseTo(0.125, 10)
    expect(diff.removed).toHaveLength(0)
    expect(diff.added).toHaveLength(0)
  })

  it('detects surface change', () => {
    const a = gen({ index: 0, surfaceHash: 'h0' })
    const b = gen({ index: 1, surfaceHash: 'h0' })
    expect(diffGenerations(a, b).surfaceChanged).toBe(false)
    const c = gen({ index: 1, surfaceHash: 'h1' })
    expect(diffGenerations(a, c).surfaceChanged).toBe(true)
  })

  it('classifies cells added in `after` but missing from `before`', () => {
    const before = gen({
      index: 0,
      surfaceHash: 'h0',
      cells: [cell('s1', 0, 0.5)],
    })
    const after = gen({
      index: 1,
      surfaceHash: 'h1',
      cells: [cell('s1', 0, 0.5), cell('s2', 0, 0.6)],
    })
    const diff = diffGenerations(before, after)
    expect(diff.matched).toHaveLength(1)
    expect(diff.added).toHaveLength(1)
    expect(diff.added[0]?.scenarioId).toBe('s2')
    expect(diff.removed).toHaveLength(0)
  })

  it('classifies cells removed in `after` that existed in `before`', () => {
    const before = gen({
      index: 0,
      surfaceHash: 'h0',
      cells: [cell('s1', 0, 0.5), cell('s2', 0, 0.6)],
    })
    const after = gen({
      index: 1,
      surfaceHash: 'h1',
      cells: [cell('s1', 0, 0.5)],
    })
    const diff = diffGenerations(before, after)
    expect(diff.matched).toHaveLength(1)
    expect(diff.removed).toHaveLength(1)
    expect(diff.removed[0]?.scenarioId).toBe('s2')
    expect(diff.added).toHaveLength(0)
  })

  it('distinguishes reps with the same scenarioId', () => {
    const before = gen({
      index: 0,
      surfaceHash: 'h0',
      cells: [cell('s1', 0, 0.5), cell('s1', 1, 0.4)],
    })
    const after = gen({
      index: 1,
      surfaceHash: 'h1',
      cells: [cell('s1', 0, 0.55), cell('s1', 1, 0.45)],
    })
    const diff = diffGenerations(before, after)
    expect(diff.matched).toHaveLength(2)
    expect(diff.matched.every((m) => m.compositeDelta > 0)).toBe(true)
  })

  it('captures per-judge per-dimension deltas, including dims that exist on only one side', () => {
    const before = gen({
      index: 0,
      surfaceHash: 'h0',
      cells: [cell('s1', 0, 0.5, { llm: { accuracy: 0.5, helpfulness: 0.6 } })],
    })
    const after = gen({
      index: 1,
      surfaceHash: 'h1',
      cells: [cell('s1', 0, 0.7, { llm: { accuracy: 0.7, terseness: 0.9 } })],
    })
    const diff = diffGenerations(before, after)
    const matched = diff.matched[0]
    expect(matched).toBeDefined()
    const dims = matched?.dimensions.llm
    expect(dims?.accuracy?.delta).toBeCloseTo(0.2, 10)
    // helpfulness present only in before — after side null, delta null
    expect(dims?.helpfulness?.before).toBe(0.6)
    expect(dims?.helpfulness?.after).toBe(null)
    expect(dims?.helpfulness?.delta).toBe(null)
    // terseness present only in after — before side null, delta null
    expect(dims?.terseness?.before).toBe(null)
    expect(dims?.terseness?.after).toBe(0.9)
    expect(dims?.terseness?.delta).toBe(null)
  })

  it('preserves stored aggregate fields (does NOT recompute from cells)', () => {
    const before = gen({
      index: 0,
      surfaceHash: 'h0',
      cells: [cell('s1', 0, 0.5)],
      compositeMean: 0.42,
      costUsd: 1.5,
      durationMs: 5000,
    })
    const after = gen({
      index: 1,
      surfaceHash: 'h1',
      cells: [cell('s1', 0, 0.7)],
      compositeMean: 0.71,
      costUsd: 2.0,
      durationMs: 6000,
    })
    const diff = diffGenerations(before, after)
    expect(diff.compositeBefore).toBe(0.42)
    expect(diff.compositeAfter).toBe(0.71)
    expect(diff.costUsdDelta).toBeCloseTo(0.5, 10)
    expect(diff.durationMsDelta).toBe(1000)
  })
})

function run(opts: Partial<EvalRunEvent> & { runId: string }): EvalRunEvent {
  return {
    runDir: '/tmp/run',
    timestamp: '2026-05-27T00:00:00Z',
    status: 'finished',
    labels: {},
    generations: [],
    totalCostUsd: 0,
    totalDurationMs: 0,
    ...opts,
  }
}

describe('diffRuns', () => {
  it('diffs run-level cost + lift + gate decision', () => {
    const before = run({
      runId: 'r1',
      timestamp: '2026-05-27T00:00:00Z',
      gateDecision: 'hold',
      holdoutLift: 0.02,
      totalCostUsd: 5,
      totalDurationMs: 10000,
    })
    const after = run({
      runId: 'r2',
      timestamp: '2026-05-27T01:00:00Z',
      gateDecision: 'ship',
      holdoutLift: 0.08,
      totalCostUsd: 6,
      totalDurationMs: 11000,
    })
    const diff = diffRuns(before, after)
    expect(diff.beforeGateDecision).toBe('hold')
    expect(diff.afterGateDecision).toBe('ship')
    expect(diff.holdoutLiftDelta).toBeCloseTo(0.06, 10)
    expect(diff.totalCostUsdDelta).toBe(1)
    expect(diff.totalDurationMsDelta).toBe(1000)
  })

  it('returns null for baselineDiff when either side has no baseline', () => {
    const before = run({ runId: 'r1' })
    const after = run({
      runId: 'r2',
      baseline: gen({ index: 0, surfaceHash: 'h0' }),
    })
    expect(diffRuns(before, after).baselineDiff).toBeNull()
    expect(diffRuns(after, before).baselineDiff).toBeNull()
  })

  it('computes baselineDiff when both sides expose a baseline', () => {
    const before = run({
      runId: 'r1',
      baseline: gen({
        index: 0,
        surfaceHash: 'h0',
        cells: [cell('s1', 0, 0.5)],
        compositeMean: 0.5,
      }),
    })
    const after = run({
      runId: 'r2',
      baseline: gen({
        index: 0,
        surfaceHash: 'h0',
        cells: [cell('s1', 0, 0.6)],
        compositeMean: 0.6,
      }),
    })
    const diff = diffRuns(before, after)
    expect(diff.baselineDiff).not.toBeNull()
    expect(diff.baselineDiff?.compositeDelta).toBeCloseTo(0.1, 10)
  })

  it('uses the highest-index generation as the winner on each side', () => {
    const before = run({
      runId: 'r1',
      generations: [
        gen({ index: 0, surfaceHash: 'h0a', compositeMean: 0.5 }),
        gen({ index: 1, surfaceHash: 'h1a', compositeMean: 0.6 }),
      ],
    })
    const after = run({
      runId: 'r2',
      generations: [
        gen({ index: 0, surfaceHash: 'h0b', compositeMean: 0.55 }),
        gen({ index: 1, surfaceHash: 'h1b', compositeMean: 0.65 }),
        gen({ index: 2, surfaceHash: 'h2b', compositeMean: 0.75 }),
      ],
    })
    const diff = diffRuns(before, after)
    expect(diff.winnersDiff?.beforeIndex).toBe(1)
    expect(diff.winnersDiff?.afterIndex).toBe(2)
    expect(diff.winnersDiff?.compositeDelta).toBeCloseTo(0.15, 10)
  })

  it('returns null winnersDiff when either side has no generations', () => {
    const before = run({ runId: 'r1' })
    const after = run({
      runId: 'r2',
      generations: [gen({ index: 0, surfaceHash: 'h' })],
    })
    expect(diffRuns(before, after).winnersDiff).toBeNull()
  })

  it('passes through null when a holdout lift is missing on either side', () => {
    const before = run({ runId: 'r1', holdoutLift: 0.04 })
    const after = run({ runId: 'r2' })
    const diff = diffRuns(before, after)
    expect(diff.beforeHoldoutLift).toBe(0.04)
    expect(diff.afterHoldoutLift).toBeNull()
    expect(diff.holdoutLiftDelta).toBeNull()
  })
})

describe('diffRunBaselineToWinner', () => {
  it('returns null when the run has no baseline', () => {
    const r = run({
      runId: 'r1',
      generations: [gen({ index: 1, surfaceHash: 'h1' })],
    })
    expect(diffRunBaselineToWinner(r)).toBeNull()
  })

  it('returns null when the winner IS the baseline (no improvement attempted)', () => {
    const r = run({
      runId: 'r1',
      baseline: gen({ index: 0, surfaceHash: 'h0' }),
      generations: [],
    })
    expect(diffRunBaselineToWinner(r)).toBeNull()
  })

  it('returns the baseline→winner diff when a winning generation exists past baseline', () => {
    const r = run({
      runId: 'r1',
      baseline: gen({
        index: 0,
        surfaceHash: 'h0',
        cells: [cell('s1', 0, 0.5)],
        compositeMean: 0.5,
      }),
      generations: [
        gen({
          index: 1,
          surfaceHash: 'h1',
          cells: [cell('s1', 0, 0.8)],
          compositeMean: 0.8,
        }),
      ],
    })
    const diff = diffRunBaselineToWinner(r)
    expect(diff).not.toBeNull()
    expect(diff?.beforeIndex).toBe(0)
    expect(diff?.afterIndex).toBe(1)
    expect(diff?.compositeDelta).toBeCloseTo(0.3, 10)
    expect(diff?.surfaceChanged).toBe(true)
  })
})
