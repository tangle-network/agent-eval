import { describe, expect, it } from 'vitest'
import { type HypothesisManifest, signManifest } from '../../pre-registration'
import { eProcess, mulberry32 } from '../../statistics'
import type { GateContext, GenerationRecord, JudgeScore, Scenario } from '../types'
import {
  type SequentialObservation,
  type SequentialPairedGateOptions,
  type SequentialStreamState,
  sequentialDecide,
  sequentialPairedGate,
} from './sequential'

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
    eligibleForPromotion: true,
    coverage: {
      expectedCells: scenarios.length,
      scorableCells: scenarios.length,
      unscorableCells: [],
    },
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
            eligibleForPromotion: true,
            coverage: {
              expectedCells: scenarios.length,
              scorableCells: scenarios.length,
              unscorableCells: [],
            },
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
    expect(result.contributingGates[0]!.status).toBe('pass')
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

// ── sequentialPairedGate — restart reconstruction ─────────────────────

describe('sequentialPairedGate.resume — reconstruction after a process restart', () => {
  const opts = { alpha: 0.05, minN: 5, maxN: 80, maxBet: 0.5, scale: 1 }

  /** Paired deltas with a real edge (≈ +0.3 on scale 1) so the reference
   *  promotes inside the budget. */
  function deltas(seed: number, length: number): number[] {
    const rng = mulberry32(seed)
    return Array.from({ length }, () => Math.min(1, Math.max(-1, 0.3 + (rng() - 0.5) * 1.2)))
  }

  function observeAll(
    ds: number[],
    o: SequentialPairedGateOptions = opts,
  ): SequentialObservation[] {
    const gate = sequentialPairedGate(o)
    const out: SequentialObservation[] = []
    for (const d of ds) out.push(gate.observe(d))
    return out
  }

  /** Observe the first k deltas, persist `state()` through JSON, rebuild
   *  the gate with `resume`, and observe the rest. */
  function observeWithRestart(
    ds: number[],
    k: number,
    o: SequentialPairedGateOptions = opts,
  ): { observations: SequentialObservation[]; final: SequentialStreamState } {
    const first = sequentialPairedGate(o)
    const observations: SequentialObservation[] = []
    for (const d of ds.slice(0, k)) observations.push(first.observe(d))
    const persisted = JSON.parse(JSON.stringify(first.state())) as SequentialStreamState
    const second = sequentialPairedGate({ ...o, resume: persisted })
    for (const d of ds.slice(k)) observations.push(second.observe(d))
    return { observations, final: second.state() }
  }

  const ds = deltas(99, 60)
  const reference = observeAll(ds)
  const promoteAt = reference.findIndex((o) => o.decision === 'promote') + 1

  it('the reference stream promotes inside the budget (fixture has an edge)', () => {
    expect(promoteAt).toBeGreaterThan(opts.minN)
    expect(promoteAt).toBeLessThan(ds.length)
  })

  it.each([0, 1, 4, 5, 20, 59])(
    'interrupting at n=%i and resuming from state() yields the identical observation sequence and final state',
    (k) => {
      const resumed = observeWithRestart(ds, k)
      expect(resumed.observations).toEqual(reference)
      const uninterrupted = sequentialPairedGate(opts)
      for (const d of ds) uninterrupted.observe(d)
      expect(resumed.final).toEqual(uninterrupted.state())
    },
  )

  it('interrupting around the promote crossing keeps the sticky decision and its n', () => {
    for (const k of [promoteAt - 1, promoteAt, promoteAt + 1]) {
      const resumed = observeWithRestart(ds, k)
      expect(resumed.observations).toEqual(reference)
      expect(resumed.final.decision).toBe('promote')
    }
  })

  it('a stream resumed after promote keeps the sticky decision against contrary evidence', () => {
    const first = sequentialPairedGate(opts)
    for (const d of ds.slice(0, promoteAt + 3)) first.observe(d)
    const second = sequentialPairedGate({ ...opts, resume: first.state() })
    const next = second.observe(-0.9)
    expect(next.decision).toBe('promote')
    expect(next.n).toBe(promoteAt + 4)
  })

  it('a stream resumed at undecided-at-maxN refuses further observations exactly like the original', () => {
    const flat = Array.from({ length: 6 }, () => 0)
    const small = { alpha: 0.05, minN: 5, maxN: 6 }
    const first = sequentialPairedGate(small)
    for (const d of flat) first.observe(d)
    expect(first.state().decision).toBe('undecided-at-maxN')
    const second = sequentialPairedGate({ ...small, resume: first.state() })
    expect(second.state()).toEqual(first.state())
    expect(() => second.observe(0)).toThrow(/optional stopping/)
  })

  it('a resumed gate reaches undecided-at-maxN at the same n as the uninterrupted gate', () => {
    const noise = Array.from({ length: 30 }, (_, i) => (i % 2 === 0 ? 0.05 : -0.05))
    const small = { alpha: 0.05, minN: 5, maxN: 30 }
    const ref = observeAll(noise, small)
    expect(ref[ref.length - 1]!.decision).toBe('undecided-at-maxN')
    const resumed = observeWithRestart(noise, 17, small)
    expect(resumed.observations).toEqual(ref)
  })

  it('resume under a bound manifest continues the registered statistic', async () => {
    const signed = await signManifest(manifestBase())
    const bound = { preRegistration: signed, minN: 5 }
    const ref = observeAll(ds.slice(0, 30), bound)
    const first = sequentialPairedGate(bound)
    for (const d of ds.slice(0, 9)) first.observe(d)
    const second = sequentialPairedGate({ ...bound, resume: first.state() })
    const tail = ds.slice(9, 30).map((d) => second.observe(d))
    expect([...ds.slice(0, 9).map((_, i) => ref[i]!), ...tail]).toEqual(ref)
  })

  it('decide(ctx) is unaffected by resume — it always runs its own fresh stream', async () => {
    const first = sequentialPairedGate(opts)
    for (const d of ds.slice(0, 10)) first.observe(d)
    const resumed = sequentialPairedGate({ ...opts, resume: first.state() })
    const fresh = sequentialPairedGate(opts)
    const ctx = ctxFrom(
      Array.from({ length: 12 }, (_, i) => ({
        scenarioId: `s${i}`,
        reps: 2,
        candidate: 0.8,
        baseline: 0.5,
      })),
    )
    const [a, b] = await Promise.all([resumed.decide(ctx), fresh.decide(ctx)])
    expect(a).toEqual(b)
    expect(resumed.state().n).toBe(10)
  })

  it('refuses a snapshot recorded under different e-process parameters (alpha / minEffect / maxBet)', async () => {
    const first = sequentialPairedGate(opts)
    for (const d of ds.slice(0, 10)) first.observe(d)
    const snap = first.state()
    expect(() => sequentialPairedGate({ ...opts, alpha: 0.01, resume: snap })).toThrow(
      /cannot resume — snapshot alpha=0\.05 differs from the process alpha=0\.01/,
    )
    expect(() => sequentialPairedGate({ ...opts, maxBet: 0.3, resume: snap })).toThrow(
      /snapshot maxBet=0\.5 differs/,
    )
    // A manifest with minEffect shifts the null boundary: a snapshot taken at
    // minEffect 0 does not continue a minEffect 0.2 statistic.
    const shifted = await signManifest({ ...manifestBase(), minEffect: 0.2 })
    expect(() => sequentialPairedGate({ preRegistration: shifted, minN: 5, resume: snap })).toThrow(
      /snapshot nullMean=0\.5 differs from the process nullMean=0\.6/,
    )
    expect(() => sequentialPairedGate({ ...opts, resume: { ...snap, threshold: 7 } })).toThrow(
      /snapshot threshold=7 differs/,
    )
  })

  it('refuses a snapshot whose gate decision this configuration could not have reached', () => {
    const first = sequentialPairedGate(opts)
    for (const d of ds.slice(0, 10)) first.observe(d)
    const snap = first.state()
    expect(snap.decision).toBe('continue')
    expect(() => sequentialPairedGate({ ...opts, maxN: 9, resume: snap })).toThrow(
      /snapshot n=10 exceeds the pre-registered maxN=9/,
    )
    expect(() => sequentialPairedGate({ ...opts, maxN: 10, resume: snap })).toThrow(
      /decision 'continue' at n=10 with maxN=10; the stream is finished/,
    )
    expect(() =>
      sequentialPairedGate({
        ...opts,
        resume: { ...snap, decision: 'promote', n: 3, sumX: 1, varSum: 0.1 },
      }),
    ).toThrow(/decision 'promote' at n=3 is below minN=5/)
    expect(() =>
      sequentialPairedGate({ ...opts, resume: { ...snap, decision: 'undecided-at-maxN' } }),
    ).toThrow(/decision 'undecided-at-maxN' at n=10 does not match maxN=80/)
    expect(() =>
      sequentialPairedGate({
        ...opts,
        resume: { ...snap, decision: 'continue', wealth: 25, decided: true, decidedAtN: 9 },
      }),
    ).toThrow(
      /decision 'continue' at n=10 ≥ minN=5 with e-value 25 ≥ 1\/α=20; this stream would have promoted/,
    )
    expect(() =>
      sequentialPairedGate({
        ...opts,
        resume: { ...snap, decision: 'later' as unknown as SequentialStreamState['decision'] },
      }),
    ).toThrow(/unknown decision 'later'/)
  })

  it('refuses a tampered e-process snapshot through the core validator', () => {
    const first = sequentialPairedGate(opts)
    for (const d of ds.slice(0, 10)) first.observe(d)
    const snap = first.state()
    expect(() => sequentialPairedGate({ ...opts, resume: { ...snap, sumX: 11 } })).toThrow(
      /eProcess: cannot resume — sumX must lie in \[0, n=10\]/,
    )
    expect(() => sequentialPairedGate({ ...opts, resume: { ...snap, wealth: -2 } })).toThrow(
      /wealth must be a finite positive number/,
    )
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
