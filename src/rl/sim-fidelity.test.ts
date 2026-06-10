import { describe, expect, it } from 'vitest'
import type { RunRecord } from '../run-record'
import {
  ABSENT_CATEGORY,
  type BehaviorFeatures,
  bucketLabel,
  defaultBehaviorFeatures,
  easyModeCheck,
  jsDivergence,
  quantileEdges,
  simFidelityReport,
} from './sim-fidelity'

function mulberry32(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface RecOverrides {
  score?: number
  wallMs?: number
  outputTokens?: number
  raw?: Record<string, number>
  failureClass?: RunRecord['failureClass']
  completion?: string
}

let nextId = 0
function rec(overrides: RecOverrides = {}): RunRecord {
  nextId++
  const record: RunRecord & { completion?: string } = {
    runId: `run-${nextId}`,
    experimentId: 'exp',
    candidateId: 'cand',
    seed: nextId,
    model: 'deepseek-v4-pro@2026-05-31',
    promptHash: `sha256:p${nextId}`,
    configHash: 'sha256:cfg',
    commitSha: 'abc1234',
    wallMs: overrides.wallMs ?? 1000,
    costUsd: 0.01,
    tokenUsage: { input: 100, output: overrides.outputTokens ?? 50 },
    outcome: {
      holdoutScore: overrides.score ?? 0.8,
      raw: overrides.raw ?? {},
    },
    splitTag: 'holdout',
    ...(overrides.failureClass ? { failureClass: overrides.failureClass } : {}),
  }
  if (overrides.completion !== undefined) record.completion = overrides.completion
  return record
}

/** Draws records from a parameterized distribution via a seeded RNG. */
function sample(rng: () => number, n: number, easy: boolean): RunRecord[] {
  const records: RunRecord[] = []
  for (let i = 0; i < n; i++) {
    const failed = rng() < (easy ? 0.1 : 0.4)
    records.push(
      rec({
        score: easy ? 0.7 + rng() * 0.3 : 0.2 + rng() * 0.6,
        wallMs: easy ? 500 + rng() * 500 : 2000 + rng() * 4000,
        outputTokens: Math.floor((easy ? 40 : 300) + rng() * 100),
        raw: {
          turns_completed: 1 + Math.floor(rng() * (easy ? 3 : 9)),
          tool_errors: failed ? 1 + Math.floor(rng() * 3) : 0,
          turns_aborted: 0,
        },
        ...(failed ? { failureClass: 'tool_recovery_failure' as const } : {}),
      }),
    )
  }
  return records
}

describe('jsDivergence', () => {
  it('is 0 for identical histograms and 1 for disjoint support', () => {
    expect(jsDivergence({ a: 10, b: 30 }, { a: 10, b: 30 })).toBe(0)
    expect(jsDivergence({ a: 5, b: 5 }, { c: 5, d: 5 })).toBe(1)
  })

  it('is symmetric and scale-invariant over counts', () => {
    const p = { a: 1, b: 3 }
    const q = { a: 30, b: 10 }
    expect(jsDivergence(p, q)).toBeCloseTo(jsDivergence(q, p), 12)
    expect(jsDivergence(p, q)).toBeCloseTo(jsDivergence({ a: 10, b: 30 }, q), 12)
  })

  it('throws on zero-mass and negative counts', () => {
    expect(() => jsDivergence({}, {})).toThrow(/empty/)
    expect(() => jsDivergence({ a: 0 }, { a: 5 })).toThrow(/zero total mass/)
    expect(() => jsDivergence({ a: -1, b: 2 }, { a: 1 })).toThrow(/negative/)
  })
})

describe('quantile bucketing', () => {
  it('computes deterministic interpolated edges', () => {
    const values = [8, 1, 5, 2, 7, 3, 6, 4]
    expect(quantileEdges(values, 4)).toEqual([2.75, 4.5, 6.25])
    // same input → same edges, input order irrelevant
    expect(quantileEdges([...values].reverse(), 4)).toEqual([2.75, 4.5, 6.25])
  })

  it('collapses duplicate edges under heavy ties', () => {
    expect(quantileEdges([5, 5, 5, 5, 5], 4)).toEqual([5])
  })

  it('labels half-open buckets with open tails', () => {
    const edges = [2.75, 4.5, 6.25]
    expect(bucketLabel(1, edges)).toBe('[-inf,2.75)')
    expect(bucketLabel(2.75, edges)).toBe('[2.75,4.5)')
    expect(bucketLabel(5, edges)).toBe('[4.5,6.25)')
    expect(bucketLabel(99, edges)).toBe('[6.25,+inf)')
  })

  it('rejects empty input and bad bucket counts', () => {
    expect(() => quantileEdges([], 4)).toThrow(/at least one value/)
    expect(() => quantileEdges([1, 2], 1)).toThrow(/bucketCount/)
  })
})

describe('simFidelityReport', () => {
  it('scores identical record sets as fidelity 1, representative', () => {
    const records = sample(mulberry32(42), 50, true)
    const report = simFidelityReport(records, records)
    expect(report.fidelity).toBe(1)
    expect(report.verdict).toBe('representative')
    for (const dim of report.perDimension) expect(dim.divergence).toBe(0)
  })

  it('scores same-distribution different-sample sets as high fidelity', () => {
    const sim = sample(mulberry32(1), 200, true)
    const prod = sample(mulberry32(2), 200, true)
    const report = simFidelityReport(sim, prod)
    expect(report.fidelity).toBeGreaterThan(0.85)
    expect(report.verdict).toBe('representative')
  })

  it('scores disjoint distributions as low fidelity, skewed', () => {
    const sim = sample(mulberry32(3), 100, true)
    const prod = sample(mulberry32(4), 100, false)
    const report = simFidelityReport(sim, prod)
    expect(report.fidelity).toBeLessThan(0.6)
    expect(report.verdict).toBe('skewed')
    const wallMs = report.perDimension.find((d) => d.feature === 'wall_ms')
    expect(wallMs).toBeDefined()
    expect(wallMs!.divergence).toBeGreaterThan(0.9)
  })

  it('is deterministic — same inputs produce a deep-equal report', () => {
    const sim = sample(mulberry32(5), 60, true)
    const prod = sample(mulberry32(6), 60, false)
    expect(simFidelityReport(sim, prod)).toEqual(simFidelityReport(sim, prod))
  })

  it('names every feature below minN and verdicts insufficient-data', () => {
    const sim = sample(mulberry32(7), 10, true)
    const prod = sample(mulberry32(8), 10, false)
    const report = simFidelityReport(sim, prod)
    expect(report.perDimension).toEqual([])
    expect(report.verdict).toBe('insufficient-data')
    expect(Number.isNaN(report.fidelity)).toBe(true)
    expect(report.insufficientData).toContain('score')
    expect(report.insufficientData).toContain('wall_ms')
  })

  it('respects a custom minNPerFeature', () => {
    const sim = sample(mulberry32(9), 10, true)
    const prod = sample(mulberry32(10), 10, true)
    const report = simFidelityReport(sim, prod, { minNPerFeature: 5 })
    expect(report.perDimension.length).toBeGreaterThan(0)
  })

  it('counts nulls explicitly as the absent category', () => {
    const features: BehaviorFeatures = (record) => ({
      tag: record.outcome.holdoutScore! >= 0.5 ? 'pass' : null,
    })
    // sim: all pass (no nulls); prod: half null
    const sim = Array.from({ length: 30 }, () => rec({ score: 0.9 }))
    const prod = [
      ...Array.from({ length: 15 }, () => rec({ score: 0.9 })),
      ...Array.from({ length: 15 }, () => rec({ score: 0.1 })),
    ]
    const report = simFidelityReport(sim, prod, { features, minNPerFeature: 15 })
    const dim = report.perDimension.find((d) => d.feature === 'tag')
    expect(dim).toBeDefined()
    // n counts only non-null observations
    expect(dim!.nSim).toBe(30)
    expect(dim!.nProd).toBe(15)
    // probabilities are over ALL records, absent included
    const absent = dim!.topShifts.find((s) => s.value === ABSENT_CATEGORY)
    expect(absent).toEqual({ value: ABSENT_CATEGORY, pSim: 0, pProd: 0.5 })
  })

  it('excludes a feature absent on one whole side as insufficient', () => {
    const features: BehaviorFeatures = (record) => ({
      completion_len:
        typeof (record as { completion?: string }).completion === 'string'
          ? (record as { completion?: string }).completion!.length
          : null,
    })
    const sim = Array.from({ length: 25 }, () => rec({ completion: 'hello world' }))
    const prod = Array.from({ length: 25 }, () => rec())
    const report = simFidelityReport(sim, prod, { features })
    expect(report.verdict).toBe('insufficient-data')
    expect(report.insufficientData).toEqual(['completion_len'])
  })

  it('throws on mixed string/number values within one feature', () => {
    const features: BehaviorFeatures = (record) =>
      record.outcome.holdoutScore! >= 0.5 ? { f: 'pass' } : { f: 0 }
    const sim = Array.from({ length: 25 }, () => rec({ score: 0.9 }))
    const prod = Array.from({ length: 25 }, () => rec({ score: 0.1 }))
    expect(() => simFidelityReport(sim, prod, { features, minNPerFeature: 10 })).toThrow(/mixes/)
  })

  it('throws on empty inputs', () => {
    const records = [rec()]
    expect(() => simFidelityReport([], records)).toThrow(/simulated records are empty/)
    expect(() => simFidelityReport(records, [])).toThrow(/production records are empty/)
  })
})

describe('defaultBehaviorFeatures', () => {
  it('derives only verified-present fields, null for missing counters', () => {
    const bare = defaultBehaviorFeatures(rec({ score: 0.7, wallMs: 1234 }))
    expect(bare.score).toBe(0.7)
    expect(bare.wall_ms).toBe(1234)
    expect(bare.turn_count).toBeNull()
    expect(bare.tool_errors).toBeNull()
    expect(bare.tool_error_recovery).toBeNull()
    expect(bare.completion_length).toBeNull()
    expect(bare.failure_class).toBeNull()
  })

  it('classifies counts-only tool-error recovery', () => {
    const recovered = defaultBehaviorFeatures(rec({ raw: { tool_errors: 2, turns_aborted: 0 } }))
    expect(recovered.tool_error_recovery).toBe('recovered')
    const aborted = defaultBehaviorFeatures(rec({ raw: { tool_errors: 1, turns_aborted: 1 } }))
    expect(aborted.tool_error_recovery).toBe('unrecovered')
    const classified = defaultBehaviorFeatures(
      rec({ raw: { tool_errors: 1 }, failureClass: 'timeout' }),
    )
    expect(classified.tool_error_recovery).toBe('unrecovered')
    const clean = defaultBehaviorFeatures(rec({ raw: { tool_errors: 0 } }))
    expect(clean.tool_error_recovery).toBe('no-tool-errors')
  })

  it('reads completion length from corpus trajectory text', () => {
    const features = defaultBehaviorFeatures(rec({ completion: 'abcdef' }))
    expect(features.completion_length).toBe(6)
  })
})

describe('easyModeCheck', () => {
  it('flags an inflated simulator', () => {
    const sim = Array.from({ length: 40 }, (_, i) => rec({ score: i < 36 ? 0.9 : 0.1 }))
    const prod = Array.from({ length: 40 }, (_, i) => rec({ score: i < 16 ? 0.9 : 0.1 }))
    const report = easyModeCheck(sim, prod)
    expect(report.simPassRate).toBeCloseTo(0.9, 12)
    expect(report.prodPassRate).toBeCloseTo(0.4, 12)
    expect(report.gap).toBeCloseTo(0.5, 12)
    expect(report.inflated).toBe(true)
  })

  it('passes an honest simulator within tolerance', () => {
    const sim = Array.from({ length: 40 }, (_, i) => rec({ score: i < 24 ? 0.9 : 0.1 }))
    const prod = Array.from({ length: 40 }, (_, i) => rec({ score: i < 22 ? 0.9 : 0.1 }))
    const report = easyModeCheck(sim, prod)
    expect(report.gap).toBeCloseTo(0.05, 12)
    expect(report.inflated).toBe(false)
  })

  it('a deflated (harder-than-reality) sim is not flagged inflated', () => {
    const sim = Array.from({ length: 20 }, () => rec({ score: 0.1 }))
    const prod = Array.from({ length: 20 }, () => rec({ score: 0.9 }))
    expect(easyModeCheck(sim, prod).inflated).toBe(false)
  })

  it('respects custom threshold and tolerance', () => {
    const sim = Array.from({ length: 10 }, () => rec({ score: 0.65 }))
    const prod = Array.from({ length: 10 }, () => rec({ score: 0.55 }))
    // at passThreshold 0.6 sim passes 100%, prod 0% → inflated
    expect(easyModeCheck(sim, prod, { passThreshold: 0.6 }).inflated).toBe(true)
    // with a huge tolerance the same gap is accepted
    expect(easyModeCheck(sim, prod, { passThreshold: 0.6, inflationTolerance: 1 }).inflated).toBe(
      false,
    )
  })

  it('throws on records without scores and on empty inputs', () => {
    const noScore = rec()
    // strip both scores — easyModeCheck must fail loud, not skip
    ;(noScore.outcome as { holdoutScore?: number }).holdoutScore = undefined
    expect(() => easyModeCheck([noScore], [rec()])).toThrow(/neither holdoutScore nor searchScore/)
    expect(() => easyModeCheck([], [rec()])).toThrow(/simulated records are empty/)
    expect(() => easyModeCheck([rec()], [])).toThrow(/production records are empty/)
  })
})
