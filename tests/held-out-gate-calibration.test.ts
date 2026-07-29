/**
 * REPEATED-SAMPLING CALIBRATION for `HeldOutGate`.
 *
 * Every other test in the suite asks "does this input produce that verdict".
 * None of them can see the failure that matters most for a promotion gate: a
 * rule that is individually reasonable on each input and still wrong on a
 * KNOWN FRACTION of repeated samples. Two such rules shipped — one on #457,
 * which was caught in review, and the same estimator again on #478, which was
 * not — because a shape test cannot measure a false-promotion rate. This file
 * measures it.
 *
 * Every case here fixes a data-generating process whose true effect sits
 * exactly on the threshold being tested, draws many samples from it, and
 * asserts the promotion rate against the nominal level the gate advertises.
 */
import { describe, expect, it } from 'vitest'
import { HeldOutGate } from '../src/held-out-gate'
import type { RunRecord } from '../src/run-record'

function rec(
  candidateId: string,
  scenarioId: string,
  split: 'search' | 'holdout',
  score: number,
): RunRecord {
  return {
    runId: `${candidateId}-${scenarioId}-${split}`,
    experimentId: 'exp1',
    candidateId,
    seed: 0,
    model: 'm',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'deadbeef',
    wallMs: 1000,
    costUsd: 0.01,
    costProvenance: { kind: 'observed', usd: 0.01 },
    tokenUsage: { input: 10, output: 10 },
    terminalOutcome: 'succeeded',
    outcome:
      split === 'search' ? { searchScore: score, raw: {} } : { holdoutScore: score, raw: {} },
    splitTag: split,
    scenarioId,
  }
}

/** Search scores mirror holdout, so the overfit-gap gate is neutral on both
 *  arms and coverage is exactly 1 — the paired-delta rule is the only thing
 *  under measurement. */
function arms(before: number[], after: number[]): { cand: RunRecord[]; base: RunRecord[] } {
  const cand: RunRecord[] = []
  const base: RunRecord[] = []
  for (let i = 0; i < before.length; i++) {
    const s = `s${i}`
    cand.push(rec('cand', s, 'search', after[i]!), rec('cand', s, 'holdout', after[i]!))
    base.push(rec('baseline', s, 'search', before[i]!), rec('baseline', s, 'holdout', before[i]!))
  }
  return { cand, base }
}

/** Seeded mulberry32, so a calibration figure is reproducible from the file
 *  alone and a red run points at the gate rather than at the draw. */
function rng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('HeldOutGate — repeated-sampling calibration', () => {
  it('holds the nominal level at a paired-binary NONINFERIORITY boundary', () => {
    // True process: the candidate never wins and loses 5% of pairs, so the true
    // risk difference is exactly -0.05 — the margin it is judged against. This
    // is the shape `bench/rung2` ships (`pairedDeltaThreshold: -0.05`).
    //
    // Deciding this on the exact CONDITIONAL interval — Clopper-Pearson on the
    // win share among discordant pairs, scaled by the observed m/n — promoted
    // 24.75% of samples at n=40 and 43.95% at n=76, because conditioning on m
    // discards the sampling variability of m/n and the interval is therefore
    // not a confidence interval for the risk difference at a nonzero margin.
    const reps = 2000
    for (const n of [40, 76, 200]) {
      const r = rng(12345 + n)
      let promoted = 0
      for (let rep = 0; rep < reps; rep++) {
        const before: number[] = []
        const after: number[] = []
        for (let i = 0; i < n; i++) {
          if (r() < 0.05) {
            before.push(1)
            after.push(0)
          } else {
            const v = i % 2 === 0 ? 1 : 0
            before.push(v)
            after.push(v)
          }
        }
        const { cand, base } = arms(before, after)
        const d = new HeldOutGate({
          baselineKey: 'baseline',
          pairedDeltaThreshold: -0.05,
        }).evaluate(cand, base)
        if (d.promote) promoted++
      }
      expect(promoted / reps, `false promotion rate at n=${n}`).toBeLessThanOrEqual(0.05)
    }
  }, 120_000)

  it('refuses the 76-pair witness: 0 wins, 3 losses, 73 ties at a -0.05 margin', () => {
    // The individual sample behind the rate above. Three losses and no wins out
    // of 76 does not establish noninferiority at 5pp — the interval that
    // decides must not claim it does.
    const before: number[] = []
    const after: number[] = []
    for (let i = 0; i < 3; i++) {
      before.push(1)
      after.push(0)
    }
    for (let i = 0; i < 73; i++) {
      const v = i % 2 === 0 ? 1 : 0
      before.push(v)
      after.push(v)
    }
    const { cand, base } = arms(before, after)
    const d = new HeldOutGate({ baselineKey: 'baseline', pairedDeltaThreshold: -0.05 }).evaluate(
      cand,
      base,
    )
    expect(d.promote).toBe(false)
    expect(d.evidence.pairedCI!.low).toBeLessThan(-0.05)
  })

  it('refuses a sample with no spread at all, at every sample size', () => {
    // A bounded asymmetric null: 2% of pairs drop by 1.0, the rest gain
    // 0.02/0.98, so the TRUE mean paired delta — the statistic this gate
    // decides on — is exactly 0. Every sample that happens to miss the drop is
    // n identical positive deltas, whose bootstrap interval has zero width.
    // Promoting on it is a claim of certainty with no variance behind it, and
    // it was worth 88.20% false promotion at n=6 and 65.65% at n=20.
    const gain = 0.02 / 0.98
    for (const n of [6, 10, 20, 40, 76]) {
      const before = Array.from({ length: n }, () => 1)
      const after = Array.from({ length: n }, () => 1 + gain)
      const { cand, base } = arms(before, after)
      const d = new HeldOutGate({ baselineKey: 'baseline' }).evaluate(cand, base)
      expect(d.promote, `zero-spread sample at n=${n}`).toBe(false)
      expect(d.rejectionCode).toBe('indeterminate_delta')
    }
  })

  it('is deterministic: one identical input, 500 evaluations, one verdict', () => {
    // #457 was closed partly because 500 evaluations of one input produced 233
    // promotions and 267 refusals — unseeded bootstrap randomness decided
    // promotions. The seed is derived from the deltas when the caller supplies
    // none, so the interval is reproducible from the data alone.
    const n = 24
    const r = rng(7)
    const before: number[] = []
    const after: number[] = []
    for (let i = 0; i < n; i++) {
      before.push(1)
      after.push(1 + (r() < 0.5 ? 0.02 : -0.014))
    }
    const { cand, base } = arms(before, after)
    const verdicts = new Set<string>()
    const intervals = new Set<string>()
    for (let i = 0; i < 500; i++) {
      const d = new HeldOutGate({ baselineKey: 'baseline' }).evaluate(cand, base)
      verdicts.add(`${d.promote}|${d.rejectionCode}`)
      intervals.add(`${d.evidence.pairedCI?.low},${d.evidence.pairedCI?.high}`)
    }
    expect(verdicts.size).toBe(1)
    expect(intervals.size).toBe(1)
  }, 120_000)

  it('still SEES the lift it exists to see: +13.2pp over 76 items', () => {
    // The defect #478 was opened to fix. 15 wins / 5 losses / 56 ties is a real
    // +13.2pp lift whose MEDIAN paired delta is 0, so a median-decided gate
    // refused it at every non-negative threshold. A calibration file that only
    // proved refusals would be satisfied by a gate that never promotes.
    const before: number[] = []
    const after: number[] = []
    for (let i = 0; i < 15; i++) {
      before.push(0)
      after.push(1)
    }
    for (let i = 0; i < 5; i++) {
      before.push(1)
      after.push(0)
    }
    for (let i = 0; i < 56; i++) {
      const v = i % 2 === 0 ? 1 : 0
      before.push(v)
      after.push(v)
    }
    const { cand, base } = arms(before, after)
    const d = new HeldOutGate({ baselineKey: 'baseline' }).evaluate(cand, base)
    expect(d.promote).toBe(true)
    expect(d.evidence.decidingDelta).toBeCloseTo(0.1315789, 6)
    expect(d.evidence.pairedCI!.low).toBeGreaterThan(0)
    expect(d.evidence.medianPairedDelta).toBe(0)
  })

  it('retains power at a real lift and a real noninferiority pass', () => {
    // The other half of a calibration claim: a gate that refuses everything
    // also has a 0% false-promotion rate. A true +10pp lift must mostly
    // promote, and a candidate that is genuinely equivalent must mostly clear a
    // -5pp margin.
    const reps = 400
    const lift = (() => {
      const r = rng(555)
      let promoted = 0
      for (let rep = 0; rep < reps; rep++) {
        const before: number[] = []
        const after: number[] = []
        for (let i = 0; i < 200; i++) {
          if (r() < 0.1) {
            before.push(0)
            after.push(1)
          } else {
            const v = i % 2 === 0 ? 1 : 0
            before.push(v)
            after.push(v)
          }
        }
        const { cand, base } = arms(before, after)
        if (new HeldOutGate({ baselineKey: 'baseline' }).evaluate(cand, base).promote) promoted++
      }
      return promoted / reps
    })()
    expect(lift, 'power at a true +10pp lift, n=200').toBeGreaterThan(0.9)

    // Proving noninferiority at a 5pp margin against a candidate that differs
    // on 10% of pairs genuinely needs the sample: the measured power curve is
    // 22.3% at n=76, 52.5% at n=200, 87.2% at n=400. n=400 is the first size
    // where the answer is reliably available, and asserting it there is what
    // stops a future "fix" from buying calibration by refusing everything.
    const equivalent = (() => {
      const r = rng(777)
      let promoted = 0
      for (let rep = 0; rep < reps; rep++) {
        const before: number[] = []
        const after: number[] = []
        for (let i = 0; i < 400; i++) {
          const u = r()
          if (u < 0.05) {
            before.push(0)
            after.push(1)
          } else if (u < 0.1) {
            before.push(1)
            after.push(0)
          } else {
            const v = i % 2 === 0 ? 1 : 0
            before.push(v)
            after.push(v)
          }
        }
        const { cand, base } = arms(before, after)
        const d = new HeldOutGate({
          baselineKey: 'baseline',
          pairedDeltaThreshold: -0.05,
        }).evaluate(cand, base)
        if (d.promote) promoted++
      }
      return promoted / reps
    })()
    expect(equivalent, 'power at a true RD=0 against a -5pp margin, n=400').toBeGreaterThan(0.8)
  }, 120_000)
})
