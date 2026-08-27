import { describe, expect, it } from 'vitest'
import { type HypothesisManifest, signManifest } from '../../pre-registration'
import { eProcess, mulberry32 } from '../../statistics'
import type { GateContext, GenerationRecord, JudgeScore, Scenario } from '../types'
import { sequentialDecide, sequentialPairedGate } from './sequential'

// ── Fixtures ──────────────────────────────────────────────────────────

function score(composite: number): JudgeScore {
  return { composite, dimensions: {}, notes: '' }
}

function ctxFrom(
  cells: Array<{ scenarioId: string; reps: number; candidate: number; baseline: number }>,
): GateContext<unknown, Scenario> {
  const judgeScores = new Map<string, Record<string, JudgeScore>>()
  const baselineJudgeScores = new Map<string, Record<string, JudgeScore>>()
  const scenarios = new Map<string, Scenario>()
  for (const c of cells) {
    scenarios.set(c.scenarioId, { id: c.scenarioId, kind: 'test' })
    for (let r = 0; r < c.reps; r++) {
      const cellId = `${c.scenarioId}:${r}`
      judgeScores.set(cellId, { j: score(c.candidate) })
      baselineJudgeScores.set(cellId, { j: score(c.baseline) })
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

function manifestBase(): HypothesisManifest {
  return {
    id: 'h-seq-1',
    hypothesis: 'candidate beats baseline on held-out composite',
    metric: 'composite',
    direction: 'increase',
    minEffect: 0,
    alpha: 0.05,
    power: 0.8,
    preRegisteredN: 30,
    registeredAt: '2026-06-10T00:00:00Z',
  }
}

function genRecord(
  generationIndex: number,
  topComposites: number[],
  decoyComposite?: number,
): GenerationRecord {
  const scenarios = topComposites.map((composite, i) => ({ scenarioId: `s${i}`, composite }))
  const mean = topComposites.reduce((s, v) => s + v, 0) / topComposites.length
  const top = {
    surfaceHash: `top-${generationIndex}`,
    composite: mean,
    ci95: [mean, mean] as [number, number],
    dimensions: {},
    scenarios,
  }
  const candidates =
    decoyComposite === undefined
      ? [top]
      : [
          // Decoy listed FIRST with a lower composite — the adapter must pick
          // the max-composite candidate, not candidates[0].
          {
            surfaceHash: `decoy-${generationIndex}`,
            composite: decoyComposite,
            ci95: [decoyComposite, decoyComposite] as [number, number],
            dimensions: {},
            scenarios: scenarios.map((s) => ({ ...s, composite: decoyComposite })),
          },
          top,
        ]
  return { generationIndex, candidates, promoted: [top.surfaceHash] }
}

// ── eProcess core ─────────────────────────────────────────────────────

describe('eProcess — betting test-martingale core', () => {
  it('rejects invalid alpha, maxBet, nullMean, and out-of-range observations', () => {
    expect(() => eProcess({ alpha: 0 })).toThrow(/alpha/)
    expect(() => eProcess({ alpha: 1 })).toThrow(/alpha/)
    expect(() => eProcess({ nullMean: 1 })).toThrow(/nullMean/)
    // maxBet must stay strictly below 1/nullMean or a wealth factor can hit 0.
    expect(() => eProcess({ nullMean: 0.5, maxBet: 2 })).toThrow(/maxBet/)
    const p = eProcess()
    expect(() => p.update(1.2)).toThrow(/\[0,1\]/)
    expect(() => p.update(-0.1)).toThrow(/\[0,1\]/)
    expect(() => p.update(Number.NaN)).toThrow(/\[0,1\]/)
  })

  it('predictability: the first bet is zero — even an extreme x_1 cannot move wealth', () => {
    // λ_1 is computed from zero prior observations (μ̂_0 = 1/2 ⇒ edge 0), so
    // wealth after one update is exactly 1 no matter what x_1 was. This is the
    // sharp end of the invariant: λ_i never sees x_i.
    expect(eProcess().update(1).wealth).toBe(1)
    expect(eProcess().update(0).wealth).toBe(1)
  })

  it('predictability: permuting FUTURE observations changes nothing before t', () => {
    const rng = mulberry32(42)
    const prefix = Array.from({ length: 8 }, () => rng())
    const futureA = [0.9, 0.1, 0.8, 0.2]
    const futureB = [0.2, 0.8, 0.1, 0.9] // a permutation of futureA
    const run = (future: number[]) => {
      const p = eProcess()
      const wealths: number[] = []
      for (const x of [...prefix, ...future]) wealths.push(p.update(x).wealth)
      return wealths
    }
    const a = run(futureA)
    const b = run(futureB)
    for (let t = 0; t < prefix.length; t++) expect(a[t]).toBe(b[t])
  })

  it('wealth stays strictly positive under adversarial alternating extremes', () => {
    const p = eProcess({ alpha: 0.05, maxBet: 0.5 })
    for (let i = 0; i < 200; i++) {
      const { wealth } = p.update(i % 2 === 0 ? 1 : 0)
      expect(wealth).toBeGreaterThan(0)
    }
  })

  it('decided latches at the first crossing and stays true while wealth keeps updating', () => {
    const p = eProcess({ alpha: 0.5 }) // threshold 2 — quick to cross
    let crossedAt = 0
    for (let i = 1; i <= 100 && crossedAt === 0; i++) {
      if (p.update(1).decided) crossedAt = i
    }
    expect(crossedAt).toBeGreaterThan(0)
    expect(p.state().decidedAtN).toBe(crossedAt)
    // Drive wealth back below the threshold — decided must stay latched.
    let dropped = false
    for (let i = 0; i < 50; i++) {
      const step = p.update(0)
      expect(step.decided).toBe(true)
      if (step.wealth < 2) dropped = true
    }
    expect(dropped).toBe(true)
    expect(p.state().decidedAtN).toBe(crossedAt)
  })
})

// ── sequentialPairedGate — streaming entry ────────────────────────────

describe('sequentialPairedGate.observe — anytime validity', () => {
  it('under H0 (symmetric deltas), false-promote rate over 200 seeded streams is 5/200 = 0.025 ≤ 1.5×alpha at maxN=400', () => {
    const maxN = 400
    let falsePromotes = 0
    for (let s = 1; s <= 200; s++) {
      const rng = mulberry32(s * 7919)
      const gate = sequentialPairedGate({ alpha: 0.05, minN: 5, maxN })
      for (let i = 0; i < maxN; i++) {
        const obs = gate.observe((rng() * 2 - 1) * 0.9)
        if (obs.decision === 'promote') {
          falsePromotes++
          break
        }
        if (obs.decision === 'undecided-at-maxN') break
      }
    }
    // Ville's inequality bounds the whole-stream crossing probability by alpha;
    // the 1.5× headroom covers seed-set luck, not a weaker guarantee.
    expect(falsePromotes).toBeLessThanOrEqual(Math.ceil(1.5 * 0.05 * 200))
  })

  it('under a +0.2 mean effect, stops at median n=68 of maxN=400 — 17% of the fixed-n budget (200 seeded streams, all decided)', () => {
    const maxN = 400
    const stops: number[] = []
    let undecided = 0
    for (let s = 1; s <= 200; s++) {
      const rng = mulberry32(s * 104729)
      const gate = sequentialPairedGate({ alpha: 0.05, minN: 5, maxN })
      for (let i = 0; i < maxN; i++) {
        const obs = gate.observe(0.2 + (rng() * 2 - 1) * 0.6)
        if (obs.decision === 'promote') {
          stops.push(obs.n)
          break
        }
        if (obs.decision === 'undecided-at-maxN') {
          undecided++
          stops.push(maxN)
          break
        }
      }
    }
    stops.sort((a, b) => a - b)
    const median = stops[Math.floor(stops.length / 2)]!
    expect(median).toBe(68)
    expect(median).toBeLessThan(0.4 * maxN)
    expect(undecided).toBe(0)
  })

  it('respects minN: a threshold crossing before minN does not promote; promotes at the first n ≥ minN still over threshold', () => {
    // alpha 0.55 ⇒ threshold ≈ 1.818. Verify with a parallel core that a
    // constant 0.9-delta stream (x = 0.95) crosses BEFORE minN=5, then assert
    // the gate holds 'continue' until n=5.
    const alpha = 0.55
    const core = eProcess({ alpha })
    let coreCrossing = 0
    for (let i = 1; i <= 10 && coreCrossing === 0; i++) {
      if (core.update(0.95).decided) coreCrossing = i
    }
    expect(coreCrossing).toBeGreaterThan(0)
    expect(coreCrossing).toBeLessThan(5)

    const gate = sequentialPairedGate({ alpha, minN: 5, maxN: 20 })
    const decisions: string[] = []
    for (let i = 0; i < 6; i++) decisions.push(gate.observe(0.9).decision)
    for (let i = 0; i < 4; i++) expect(decisions[i]).toBe('continue')
    expect(decisions[4]).toBe('promote')
  })

  it('promote is sticky: subsequent contrary deltas never un-promote', () => {
    const gate = sequentialPairedGate({ alpha: 0.05, minN: 5, maxN: 100 })
    let promoted = false
    for (let i = 0; i < 60 && !promoted; i++) promoted = gate.observe(0.7).decision === 'promote'
    expect(promoted).toBe(true)
    for (let i = 0; i < 10; i++) expect(gate.observe(-0.9).decision).toBe('promote')
    expect(gate.state().decision).toBe('promote')
  })

  it('observing past the pre-registered maxN throws (extending a finished stream reopens optional stopping)', () => {
    const gate = sequentialPairedGate({ alpha: 0.05, minN: 5, maxN: 6 })
    for (let i = 0; i < 5; i++) expect(gate.observe(0).decision).toBe('continue')
    const last = gate.observe(0)
    expect(last.decision).toBe('undecided-at-maxN')
    expect(last.reason).toContain('NOT evidence of no effect')
    expect(() => gate.observe(0)).toThrow(/optional stopping/)
  })

  it('fails loud on out-of-scale and non-finite deltas, and on a missing maxN', () => {
    const gate = sequentialPairedGate({ alpha: 0.05, maxN: 10 })
    expect(() => gate.observe(1.5)).toThrow(/scale/)
    expect(() => gate.observe(Number.NaN)).toThrow(/scale/)
    expect(() => sequentialPairedGate({ alpha: 0.05 })).toThrow(/maxN is required/)
    expect(() => sequentialPairedGate({ maxN: 10, minN: 11 })).toThrow(/minN/)
    expect(() => sequentialPairedGate({ maxN: 10, scale: 0 })).toThrow(/scale/)
  })
})

// ── sequentialPairedGate — Gate-contract conformance ──────────────────

describe('sequentialPairedGate.decide — gate contract', () => {
  const better = ctxFrom(
    Array.from({ length: 10 }, (_, i) => ({
      scenarioId: `s${i}`,
      reps: 3,
      candidate: 0.9,
      baseline: 0.2,
    })),
  )
  const flat = ctxFrom(
    Array.from({ length: 12 }, (_, i) => ({
      scenarioId: `s${i}`,
      reps: 1,
      candidate: 0.5,
      baseline: 0.5,
    })),
  )

  it('conforms to the Gate shape and ships a clear improvement', async () => {
    const gate = sequentialPairedGate({ alpha: 0.05, minN: 5, maxN: 30 })
    expect(gate.name).toBe('sequentialPairedGate')
    const result = await gate.decide(better)
    expect(result.decision).toBe('ship')
    expect(result.reasons[0]).toContain('e-value')
    expect(result.contributingGates).toHaveLength(1)
    expect(result.contributingGates[0]!.passed).toBe(true)
    expect(result.delta).toBeCloseTo(0.7, 10)
    const detail = result.contributingGates[0]!.detail as { decision: string; n: number }
    expect(detail.decision).toBe('promote')
    expect(detail.n).toBeLessThanOrEqual(30)
  })

  it('maps undecided-at-maxN to hold and names that it is NOT evidence of no effect', async () => {
    const gate = sequentialPairedGate({ alpha: 0.05, minN: 5, maxN: 12 })
    const result = await gate.decide(flat)
    expect(result.decision).toBe('hold')
    expect(result.reasons[0]).toContain('NOT evidence of no effect')
  })

  it('maps a stream that ends undecided before maxN to need_more_work (more reps could decide)', async () => {
    const gate = sequentialPairedGate({ alpha: 0.05, minN: 5, maxN: 100 })
    const result = await gate.decide(flat)
    expect(result.decision).toBe('need_more_work')
  })

  it('throws when ctx.baselineJudgeScores is missing — never compares the candidate against itself', async () => {
    const gate = sequentialPairedGate({ alpha: 0.05, minN: 5, maxN: 30 })
    const { baselineJudgeScores: _omit, ...rest } = better
    void _omit
    await expect(gate.decide(rest as GateContext<unknown, Scenario>)).rejects.toThrow(
      /baselineJudgeScores/,
    )
  })

  it('returns need_more_work when no cells pair (nothing to test, not a silent pass)', async () => {
    const gate = sequentialPairedGate({ alpha: 0.05, minN: 5, maxN: 30 })
    const empty = ctxFrom([])
    const result = await gate.decide(empty)
    expect(result.decision).toBe('need_more_work')
    expect(result.reasons[0]).toContain('no paired holdout observations')
  })

  it('decide(ctx) runs on its own stream — it never advances the observe-stream', async () => {
    const gate = sequentialPairedGate({ alpha: 0.05, minN: 5, maxN: 30 })
    await gate.decide(better)
    expect(gate.state().n).toBe(0)
    expect(gate.state().decision).toBe('continue')
  })
})

// ── Pre-registration binding ──────────────────────────────────────────

describe('sequentialPairedGate — pre-registration binding', () => {
  it('takes alpha and the observation budget FROM the manifest', async () => {
    const signed = await signManifest(manifestBase())
    const gate = sequentialPairedGate({ preRegistration: signed })
    expect(gate.state().alpha).toBe(0.05)
    let promoted = false
    for (let i = 0; i < 30 && !promoted; i++) promoted = gate.observe(0.7).decision === 'promote'
    expect(promoted).toBe(true)
  })

  it('rejects parameters that conflict with the registered statistic', async () => {
    const signed = await signManifest(manifestBase())
    expect(() => sequentialPairedGate({ preRegistration: signed, alpha: 0.1 })).toThrow(
      /conflicts with pre-registered alpha/,
    )
    expect(() => sequentialPairedGate({ preRegistration: signed, maxN: 99 })).toThrow(
      /conflicts with pre-registered N/,
    )
  })

  it('rejects a tampered manifest at construction', async () => {
    const signed = await signManifest(manifestBase())
    const tampered = { ...signed, minEffect: 0.5 }
    expect(() => sequentialPairedGate({ preRegistration: tampered })).toThrow(/tampered/)
    const badAlgo = { ...signed, algo: 'md5' as never }
    expect(() => sequentialPairedGate({ preRegistration: badAlgo })).toThrow(/algo/)
  })

  it("orients deltas by the manifest's direction: 'decrease' promotes on negative deltas", async () => {
    const signed = await signManifest({ ...manifestBase(), direction: 'decrease' })
    const gate = sequentialPairedGate({ preRegistration: signed })
    let promoted = false
    for (let i = 0; i < 30 && !promoted; i++) promoted = gate.observe(-0.7).decision === 'promote'
    expect(promoted).toBe(true)
  })

  it('minEffect shifts the null: effects below it never promote, effects above it do', async () => {
    const signed = await signManifest({ ...manifestBase(), minEffect: 0.5, preRegisteredN: 120 })
    const below = sequentialPairedGate({ preRegistration: signed })
    let last = ''
    for (let i = 0; i < 120 && last !== 'undecided-at-maxN'; i++) {
      const obs = below.observe(0.2) // a real effect, but under the registered minEffect
      expect(obs.decision).not.toBe('promote')
      last = obs.decision
    }
    expect(last).toBe('undecided-at-maxN')

    const above = sequentialPairedGate({ preRegistration: signed })
    let promoted = false
    for (let i = 0; i < 120 && !promoted; i++) promoted = above.observe(0.8).decision === 'promote'
    expect(promoted).toBe(true)
  })
})

// ── sequentialDecide — SurfaceProposer.decide adapter ───────────────

describe('sequentialDecide — early-stop adapter for the optimization loop', () => {
  const SCENARIOS = 10
  const flatGen = (g: number) =>
    genRecord(
      g,
      Array.from({ length: SCENARIOS }, () => 0.5),
    )
  const liftGen = (g: number) =>
    genRecord(
      g,
      Array.from({ length: SCENARIOS }, () => 0.8),
      0.1,
    )

  it('stops the loop once the per-scenario evidence vs the generation-0 incumbent decides', () => {
    const decide = sequentialDecide({ alpha: 0.05, minN: 5 })
    const history: GenerationRecord[] = [flatGen(0)]
    let stoppedAt = -1
    for (let g = 1; g <= 12 && stoppedAt < 0; g++) {
      history.push(liftGen(g))
      const verdict = decide({ history })
      if (verdict.stop) {
        stoppedAt = g
        expect(verdict.reason).toContain('e-value')
        expect(verdict.reason).toContain('generation')
      }
    }
    expect(stoppedAt).toBeGreaterThan(0)
    expect(stoppedAt).toBeLessThan(12)
    // Latched: the verdict stays stopped on every later call.
    expect(decide({ history }).stop).toBe(true)
  })

  it('never stops on an undecided process — absence of a crossing is not evidence of no effect', () => {
    const decide = sequentialDecide({ alpha: 0.05, minN: 5 })
    const history: GenerationRecord[] = [flatGen(0)]
    for (let g = 1; g <= 8; g++) {
      history.push(flatGen(g))
      expect(decide({ history }).stop).toBe(false)
    }
  })

  it('consumes each generation exactly once — repeated calls with the same history never double-count', () => {
    const decide = sequentialDecide({ alpha: 0.05, minN: 5 })
    const history = [flatGen(0), flatGen(1), flatGen(2)]
    decide({ history })
    const nAfterFirst = decide.state().n
    decide({ history })
    expect(decide.state().n).toBe(nAfterFirst)
    expect(nAfterFirst).toBe(2 * SCENARIOS) // generations 1 and 2; generation 0 is the reference
  })

  it('fails loud on scenario-set mismatches and empty generations', () => {
    const decide = sequentialDecide()
    const mismatched = genRecord(
      1,
      Array.from({ length: SCENARIOS }, () => 0.8),
    )
    mismatched.candidates[0]!.scenarios = mismatched.candidates[0]!.scenarios.slice(1)
    expect(() => decide({ history: [flatGen(0), mismatched] })).toThrow(/missing scenario/)

    const decide2 = sequentialDecide()
    expect(() =>
      decide2({ history: [flatGen(0), { generationIndex: 1, candidates: [], promoted: [] }] }),
    ).toThrow(/no candidates/)
  })

  it('picks the max-composite candidate per generation, not candidates[0]', () => {
    // liftGen lists a 0.1-composite decoy FIRST; if the adapter read
    // candidates[0] the deltas would be negative and it could never stop.
    const decide = sequentialDecide({ alpha: 0.05, minN: 5 })
    const history: GenerationRecord[] = [flatGen(0)]
    let stopped = false
    for (let g = 1; g <= 12 && !stopped; g++) {
      history.push(liftGen(g))
      stopped = decide({ history }).stop
    }
    expect(stopped).toBe(true)
  })
})
