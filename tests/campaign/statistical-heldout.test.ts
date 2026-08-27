import { describe, expect, it } from 'vitest'
import { defaultProductionGate } from '../../src/campaign/gates/default-production-gate'
import { detectScale, pairHoldout } from '../../src/campaign/gates/statistical-heldout'
import type { GateContext, JudgeScore, Scenario } from '../../src/campaign/types'

type Cell = { composite: number; dimensions?: Record<string, number> }

function cellMap(perCell: Record<string, Cell>): Map<string, Record<string, JudgeScore>> {
  const m = new Map<string, Record<string, JudgeScore>>()
  for (const [cellId, v] of Object.entries(perCell)) {
    m.set(cellId, { judge: { composite: v.composite, dimensions: v.dimensions ?? {} } })
  }
  return m
}
const scen = (ids: string[]): Scenario[] => ids.map((id) => ({ id, kind: 'test' }))

async function decide(opts: {
  baseline: Record<string, Cell>
  candidate: Record<string, Cell>
  scenarioIds: string[]
  deltaThreshold?: number
  criticalDimensions?: string[]
  regressionTolerance?: number
  minProductiveRuns?: number
}) {
  const gate = defaultProductionGate<{ text: string }, Scenario>({
    holdoutScenarios: scen(opts.scenarioIds),
    deltaThreshold: opts.deltaThreshold,
    criticalDimensions: opts.criticalDimensions,
    regressionTolerance: opts.regressionTolerance,
    minProductiveRuns: opts.minProductiveRuns,
  })
  const ctx: GateContext<{ text: string }, Scenario> = {
    candidateArtifacts: new Map(Object.keys(opts.candidate).map((c) => [c, { text: 'cand' }])),
    baselineArtifacts: new Map(Object.keys(opts.baseline).map((c) => [c, { text: 'base' }])),
    judgeScores: cellMap(opts.candidate),
    baselineJudgeScores: cellMap(opts.baseline),
    scenarios: scen(opts.scenarioIds),
    cost: { candidate: 0, baseline: 0 },
    signal: new AbortController().signal,
  }
  return gate.decide(ctx)
}
const gateDetail = (r: Awaited<ReturnType<typeof decide>>, name: string) =>
  // biome-ignore lint/suspicious/noExplicitAny: test reads opaque contributingGate detail
  r.contributingGates.find((c) => c.name === name)?.detail as any

describe('pairHoldout — full-cellId pairing (the trap that fakes a tight CI)', () => {
  it('pairs by FULL cellId so reps multiply n — never averaged to one-per-scenario', () => {
    const cand = cellMap({ 'h1:0': { composite: 5 }, 'h1:1': { composite: 7 } })
    const base = cellMap({ 'h1:0': { composite: 4 }, 'h1:1': { composite: 6 } })
    const p = pairHoldout(cand, base, new Set(['h1']), (s) => s.composite)
    expect(p.cellIds).toEqual(['h1:0', 'h1:1'])
    expect(p.before).toEqual([4, 6])
    expect(p.after).toEqual([5, 7])
    expect(p.before.length).toBe(2) // n=2 from reps, NOT collapsed to n=1 per scenario
  })

  it('throws when candidate/baseline holdout cells do not align (load-bearing invariant)', () => {
    const cand = cellMap({ 'h1:0': { composite: 5 } })
    const base = cellMap({ 'h1:1': { composite: 4 } })
    expect(() => pairHoldout(cand, base, new Set(['h1']), (s) => s.composite)).toThrow(
      /do not align/,
    )
  })

  it('detectScale distinguishes [0,1] from 0-100', () => {
    expect(detectScale([0.9, 0.72, 0.85])).toBe(1)
    expect(detectScale([91, 95, 78])).toBe(100)
  })
})

describe('defaultProductionGate — bootstrap-CI held-out (kills the point-estimate noise ship)', () => {
  it('HOLDS a noisy same-mean holdout — the exact +4 model-noise false positive', async () => {
    // Baseline & candidate are two noisy samples of the SAME surface: deltas
    // straddle zero, so no real lift. The old point-estimate gate shipped this.
    const r = await decide({
      baseline: {
        'h1:0': { composite: 91 },
        'h2:0': { composite: 88 },
        'h3:0': { composite: 95 },
        'h4:0': { composite: 90 },
      },
      candidate: {
        'h1:0': { composite: 95 },
        'h2:0': { composite: 84 },
        'h3:0': { composite: 93 },
        'h4:0': { composite: 92 },
      },
      scenarioIds: ['h1', 'h2', 'h3', 'h4'],
    })
    expect(r.decision).toBe('hold')
    expect(gateDetail(r, 'heldout-significance').ciLow).toBeLessThanOrEqual(0)
  })

  it('SHIPS a uniform real lift — CI.low strictly above the threshold', async () => {
    const r = await decide({
      baseline: {
        'h1:0': { composite: 80 },
        'h2:0': { composite: 82 },
        'h3:0': { composite: 78 },
        'h4:0': { composite: 81 },
      },
      candidate: {
        'h1:0': { composite: 86 },
        'h2:0': { composite: 88 },
        'h3:0': { composite: 84 },
        'h4:0': { composite: 87 },
      },
      scenarioIds: ['h1', 'h2', 'h3', 'h4'],
    })
    expect(r.decision).toBe('ship')
    expect(gateDetail(r, 'heldout-significance').ciLow).toBeGreaterThan(0)
  })

  it('HOLDS with few_runs when paired n < minProductiveRuns (no degenerate-CI ship)', async () => {
    const r = await decide({
      baseline: { 'h1:0': { composite: 80 }, 'h2:0': { composite: 80 } },
      candidate: { 'h1:0': { composite: 90 }, 'h2:0': { composite: 90 } },
      scenarioIds: ['h1', 'h2'], // n=2 < default minProductiveRuns 3
    })
    expect(r.decision).toBe('hold')
    expect(gateDetail(r, 'heldout-significance').fewRuns).toBe(true)
  })
})

describe('defaultProductionGate — per-dimension regression guard (anti-Goodhart)', () => {
  it('HOLDS a net composite gain that significantly regresses a critical dimension', async () => {
    // +6 composite everywhere, but hallucination_free drops ~28 (the verified
    // legal pattern: gain on gameable dims, loss on the safety dim).
    const r = await decide({
      baseline: {
        'h1:0': { composite: 80, dimensions: { hallucination_free: 100 } },
        'h2:0': { composite: 82, dimensions: { hallucination_free: 100 } },
        'h3:0': { composite: 78, dimensions: { hallucination_free: 95 } },
        'h4:0': { composite: 81, dimensions: { hallucination_free: 100 } },
      },
      candidate: {
        'h1:0': { composite: 86, dimensions: { hallucination_free: 72 } },
        'h2:0': { composite: 88, dimensions: { hallucination_free: 70 } },
        'h3:0': { composite: 84, dimensions: { hallucination_free: 68 } },
        'h4:0': { composite: 87, dimensions: { hallucination_free: 71 } },
      },
      scenarioIds: ['h1', 'h2', 'h3', 'h4'],
      criticalDimensions: ['hallucination_free'],
    })
    expect(r.decision).toBe('hold')
    const reg = gateDetail(r, 'dimension-regression').regressions[0]
    expect(reg.dimension).toBe('hallucination_free')
    expect(reg.regressed).toBe(true)
  })

  it('SHIPS when the composite rises and the critical dimension holds flat', async () => {
    const r = await decide({
      baseline: {
        'h1:0': { composite: 80, dimensions: { hallucination_free: 100 } },
        'h2:0': { composite: 82, dimensions: { hallucination_free: 100 } },
        'h3:0': { composite: 78, dimensions: { hallucination_free: 100 } },
        'h4:0': { composite: 81, dimensions: { hallucination_free: 99 } },
      },
      candidate: {
        'h1:0': { composite: 86, dimensions: { hallucination_free: 100 } },
        'h2:0': { composite: 88, dimensions: { hallucination_free: 100 } },
        'h3:0': { composite: 84, dimensions: { hallucination_free: 99 } },
        'h4:0': { composite: 87, dimensions: { hallucination_free: 100 } },
      },
      scenarioIds: ['h1', 'h2', 'h3', 'h4'],
      criticalDimensions: ['hallucination_free'],
    })
    expect(r.decision).toBe('ship')
    expect(gateDetail(r, 'dimension-regression').regressions[0].regressed).toBe(false)
  })
})
