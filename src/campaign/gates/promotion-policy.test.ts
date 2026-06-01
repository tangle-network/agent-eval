import { describe, expect, it } from 'vitest'
import type { GateContext, JudgeScore, Scenario } from '../types'
import {
  buildEvidenceVector,
  type EvidenceVector,
  type PromotionObjective,
  paretoPolicy,
  paretoSignificanceGate,
} from './promotion-policy'

// ── Fixture builder ───────────────────────────────────────────────────
// Build a GateContext whose candidate/baseline judge scores are crafted so the
// paired bootstrap is deterministic (fixed seed) and the verdict is unambiguous.
// One judge per cell; cellId = `${scenarioId}:${rep}` so reps multiply n.

function score(composite: number, dimensions: Record<string, number> = {}): JudgeScore {
  return { composite, dimensions, notes: '' }
}

interface CellSpec {
  scenarioId: string
  reps: number
  candidate: { composite: number; dimensions?: Record<string, number> }
  baseline: { composite: number; dimensions?: Record<string, number> }
}

function ctxFrom(cells: CellSpec[]): GateContext<unknown, Scenario> {
  const judgeScores = new Map<string, Record<string, JudgeScore>>()
  const baselineJudgeScores = new Map<string, Record<string, JudgeScore>>()
  const scenarios = new Map<string, Scenario>()
  for (const c of cells) {
    scenarios.set(c.scenarioId, { id: c.scenarioId, kind: 'test' })
    for (let r = 0; r < c.reps; r++) {
      const cellId = `${c.scenarioId}:${r}`
      judgeScores.set(cellId, { j: score(c.candidate.composite, c.candidate.dimensions) })
      baselineJudgeScores.set(cellId, { j: score(c.baseline.composite, c.baseline.dimensions) })
    }
  }
  return {
    candidateArtifacts: new Map(),
    judgeScores,
    baselineJudgeScores,
    scenarios: [...scenarios.values()],
    cost: { candidate: 0, baseline: 0 },
    signal: new AbortController().signal,
  }
}

// Six distinct scenarios, 1 rep each (n=6 paired observations) — comfortably
// above minProductiveRuns and enough for a tight bootstrap CI.
function cells(
  cand: (i: number) => { composite: number; dimensions?: Record<string, number> },
  base: (i: number) => { composite: number; dimensions?: Record<string, number> },
  count = 6,
): CellSpec[] {
  return Array.from({ length: count }, (_, i) => ({
    scenarioId: `s${i}`,
    reps: 1,
    candidate: cand(i),
    baseline: base(i),
  }))
}

const QUALITY: PromotionObjective = {
  name: 'quality',
  source: { kind: 'composite' },
  direction: 'maximize',
}

describe('paretoSignificanceGate — multi-objective promotion over the evidence vector', () => {
  it('ships a Pareto improvement: one axis credibly up, the other flat (a flat axis must not veto a real gain)', async () => {
    // quality: baseline 0.50 → candidate 0.80 on every cell (CI.low ≫ 0 → improved).
    // safety:  baseline 0.90 → candidate 0.90 (flat). A flat second axis is NOT a
    // regression, so it must not block the ship — the bug this guards is treating
    // "unchanged" as "failed".
    const ctx = ctxFrom(
      cells(
        () => ({ composite: 0.8, dimensions: { safety: 0.9 } }),
        () => ({ composite: 0.5, dimensions: { safety: 0.9 } }),
      ),
    )
    const gate = paretoSignificanceGate({
      objectives: [
        QUALITY,
        {
          name: 'safety',
          source: { kind: 'dimension', dimension: 'safety' },
          direction: 'maximize',
        },
      ],
    })
    const res = await gate.decide(ctx)
    expect(res.decision).toBe('ship')
    // One contributingGate per axis — the literal "many numbers, no scalar collapse".
    expect(res.contributingGates).toHaveLength(2)
    const quality = res.contributingGates.find((g) => g.name === 'objective:quality')!
    const safety = res.contributingGates.find((g) => g.name === 'objective:safety')!
    expect(quality.passed).toBe(true)
    expect((quality.detail as { verdict: string }).verdict).toBe('improved')
    expect((safety.detail as { verdict: string }).verdict).toBe('flat')
  })

  it('HOLDS when a safety dim credibly regresses even though quality improved (the +gain/−safety false positive)', async () => {
    // The exact shipped legal-agent bug: quality +0.30 but a safety dim −0.30.
    // A composite-only gate ships this; the symmetric Pareto floor must hold.
    const ctx = ctxFrom(
      cells(
        () => ({ composite: 0.8, dimensions: { hallucination_free: 0.5 } }),
        () => ({ composite: 0.5, dimensions: { hallucination_free: 0.9 } }),
      ),
    )
    const gate = paretoSignificanceGate({
      objectives: [
        QUALITY,
        {
          name: 'hallucination_free',
          source: { kind: 'dimension', dimension: 'hallucination_free' },
          direction: 'maximize',
        },
      ],
    })
    const res = await gate.decide(ctx)
    expect(res.decision).toBe('hold')
    expect(res.reasons.join(' ')).toContain('hallucination_free')
    expect(res.reasons.join(' ')).toContain('regressed')
    const safety = res.contributingGates.find((g) => g.name === 'objective:hallucination_free')!
    expect((safety.detail as { verdict: string }).verdict).toBe('regressed')
  })

  it('a minimize objective that credibly rises is a regression (direction orientation)', async () => {
    // cost_risk is a 'minimize' dim: baseline 0.20 → candidate 0.60 means it got
    // WORSE. Orientation must flip so the floor catches a rise, not a fall.
    const ctx = ctxFrom(
      cells(
        () => ({ composite: 0.8, dimensions: { cost_risk: 0.6 } }),
        () => ({ composite: 0.5, dimensions: { cost_risk: 0.2 } }),
      ),
    )
    const gate = paretoSignificanceGate({
      objectives: [
        QUALITY,
        {
          name: 'cost_risk',
          source: { kind: 'dimension', dimension: 'cost_risk' },
          direction: 'minimize',
        },
      ],
    })
    const res = await gate.decide(ctx)
    expect(res.decision).toBe('hold')
    const axis = res.contributingGates.find((g) => g.name === 'objective:cost_risk')!
    expect((axis.detail as { verdict: string }).verdict).toBe('regressed')
  })

  it('a credible regression is never masked as "improved" by a permissive negative gainThreshold (floor wins the tie)', async () => {
    // Anti-Goodhart: a consumer who sets gainThreshold below −floorTolerance
    // ("accept dips down to −0.4") must NOT have a genuine −0.3 regression
    // classified as a gain. The floor check precedes the gain check.
    const ctx = ctxFrom(
      cells(
        () => ({ composite: 0.5 }),
        () => ({ composite: 0.8 }), // candidate 0.5 vs baseline 0.8 ⇒ −0.3 delta
      ),
    )
    const gate = paretoSignificanceGate({
      objectives: [{ ...QUALITY, gainThreshold: -0.4, floorTolerance: 0.05 }],
    })
    const res = await gate.decide(ctx)
    expect(res.decision).toBe('hold')
    const axis = res.contributingGates.find((g) => g.name === 'objective:quality')!
    expect((axis.detail as { verdict: string }).verdict).toBe('regressed')
  })

  it('need_more_work (NOT hold) when an axis lacks the evidence to claim significance', async () => {
    // Only 2 paired runs — below minProductiveRuns. "Gather more" is a distinct
    // action from "reject"; folding it into hold abandons a real-but-underpowered
    // gain. quality is clearly up but the floor for safety has n=2.
    const ctx = ctxFrom(
      cells(
        () => ({ composite: 0.8, dimensions: { safety: 0.9 } }),
        () => ({ composite: 0.5, dimensions: { safety: 0.9 } }),
        2,
      ),
    )
    const gate = paretoSignificanceGate({
      objectives: [
        QUALITY,
        {
          name: 'safety',
          source: { kind: 'dimension', dimension: 'safety' },
          direction: 'maximize',
        },
      ],
      minProductiveRuns: 3,
    })
    const res = await gate.decide(ctx)
    expect(res.decision).toBe('need_more_work')
    expect(res.reasons.join(' ')).toContain('insufficient evidence')
  })

  it('HOLDS a statistical no-op: identical candidate and baseline must not ship as a win', async () => {
    // The noise-as-lift false positive: candidate == baseline on every cell.
    // Every axis is flat → no Pareto improvement → hold, never ship.
    const ctx = ctxFrom(
      cells(
        (i) => ({ composite: 0.5 + (i % 2) * 0.1 }),
        (i) => ({ composite: 0.5 + (i % 2) * 0.1 }),
      ),
    )
    const gate = paretoSignificanceGate({ objectives: [QUALITY] })
    const res = await gate.decide(ctx)
    expect(res.decision).toBe('hold')
    expect(res.reasons.join(' ')).toContain('statistically equivalent')
  })

  it('throws when no objectives are supplied (fail loud, no empty-vector default)', () => {
    expect(() => paretoSignificanceGate({ objectives: [] })).toThrow(/at least 1 objective/)
  })
})

describe('buildEvidenceVector + PromotionPolicy — one bus, plural competing strategies', () => {
  // The architecture claim: build the vector ONCE, run different policies over
  // the SAME evidence and get different decisions. Here a "strict" policy (ALL
  // axes must improve) and the default paretoPolicy (ANY axis improving + none
  // regressing) disagree on identical evidence.
  const ctx = ctxFrom(
    cells(
      () => ({ composite: 0.8, dimensions: { speed: 0.5 } }), // quality up, speed flat
      () => ({ composite: 0.5, dimensions: { speed: 0.5 } }),
    ),
  )
  const objectives: PromotionObjective[] = [
    QUALITY,
    { name: 'speed', source: { kind: 'dimension', dimension: 'speed' }, direction: 'maximize' },
  ]

  it('the same EvidenceVector feeds two policies that legitimately disagree', () => {
    const ev: EvidenceVector = buildEvidenceVector(ctx, objectives)
    // Default Pareto: quality improved, speed flat (not worse) → ship.
    expect(paretoPolicy(ev).decision).toBe('ship')

    // A stricter competing strategy: require EVERY axis to improve.
    const strictPolicy = (e: EvidenceVector) => {
      const allImproved = e.axes.every((a) => a.verdict === 'improved')
      return {
        decision: allImproved ? ('ship' as const) : ('hold' as const),
        reasons: [allImproved ? 'all axes improved' : 'not every axis improved'],
        contributingGates: e.axes.map((a) => ({
          name: a.name,
          passed: a.verdict === 'improved',
          detail: a.verdict,
        })),
      }
    }
    expect(strictPolicy(ev).decision).toBe('hold')

    // Evidence is the SAME object — the divergence is the policy, not the data.
    expect(ev.axes).toHaveLength(2)
    expect(ev.axes.map((a) => a.verdict).sort()).toEqual(['flat', 'improved'])
  })

  it('exposes per-axis CIs (the non-collapsed vector) with a binding minN', () => {
    const ev = buildEvidenceVector(ctx, objectives)
    expect(ev.minN).toBe(6)
    for (const axis of ev.axes) {
      expect(axis.n).toBe(6)
      expect(typeof axis.bootstrap.low).toBe('number')
      expect(typeof axis.bootstrap.high).toBe('number')
      expect(axis.bootstrap.low).toBeLessThanOrEqual(axis.bootstrap.high)
    }
  })
})
