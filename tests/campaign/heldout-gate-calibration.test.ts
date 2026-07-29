/**
 * REPEATED-SAMPLING CALIBRATION for the COMPOSABLE `heldOutGate` — the second
 * gate of that name.
 *
 * `tests/held-out-gate-calibration.test.ts` measures the `HeldOutGate` CLASS.
 * This file measures the `heldOutGate` FUNCTION, which is a different gate with
 * a different decision core (`heldoutSignificance` → `pairedDeltaTest`) exported
 * from two public barrels. When the class was fixed in #479 the function was
 * not, and nothing in the suite could see the difference, because a shape test
 * cannot measure a false-promotion rate — the two names differ only by
 * capitalisation and every existing test asked "does this input produce that
 * verdict", never "on what fraction of repeated samples is the verdict wrong".
 *
 * Measured on the gate as it stood before the fix, with the harness below:
 *
 *   paired-binary noninferiority boundary (true RD = margin = -0.05, nominal 5%)
 *     n=40   14.60%      n=76   10.10%      n=200   2.15%
 *   bounded asymmetric mean-null (true mean delta 0, threshold 0, nominal 5%)
 *     n=6    88.50%      n=20   65.65%      n=76    21.10%
 *
 * Every case fixes a data-generating process whose true effect sits exactly on
 * the threshold being tested, draws many samples from it, and asserts the
 * promotion rate against the nominal level the gate advertises.
 */
import { describe, expect, it } from 'vitest'
import { heldOutGate } from '../../src/campaign/gates/heldout-gate'
import type { JudgeScore } from '../../src/campaign/types'

const score = (composite: number): Record<string, JudgeScore> => ({
  judge: { dimensions: { q: composite }, composite, notes: '' },
})

/** One cell per paired observation, so n scenarios ⇒ n pairs. */
function cells(values: number[]): Map<string, Record<string, JudgeScore>> {
  const map = new Map<string, Record<string, JudgeScore>>()
  for (const [i, v] of values.entries()) map.set(`s${i}:0`, score(v))
  return map
}

const scenarios = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `s${i}`, kind: 'fixture' }))

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

/** The REAL exported gate, not a re-implementation of its rule. */
async function decide(before: number[], after: number[], deltaThreshold: number) {
  const result = await heldOutGate({ scenarios: scenarios(before.length), deltaThreshold }).decide({
    judgeScores: cells(after),
    baselineJudgeScores: cells(before),
  } as never)
  return {
    ship: result.decision === 'ship',
    reason: result.reasons?.join(' ') ?? '',
    detail: result.contributingGates[0]?.detail as Record<string, unknown>,
  }
}

describe('heldOutGate (composable) — repeated-sampling calibration', () => {
  it('holds the nominal level at a paired-binary NONINFERIORITY boundary', async () => {
    // True process: the candidate never wins and loses 5% of pairs, so the true
    // risk difference is exactly -0.05 — the margin it is judged against.
    //
    // Deciding this on the percentile bootstrap of the MEAN paired delta
    // promoted 14.60% of samples at n=40 and 10.10% at n=76: on a pass/fail
    // eval the delta vector has three atoms and is dominated by ties, and a
    // resample of that lattice is not a confidence interval at a nonzero
    // margin. Tango's score interval is.
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
        if ((await decide(before, after, -0.05)).ship) promoted++
      }
      expect(promoted / reps, `false promotion rate at n=${n}`).toBeLessThanOrEqual(0.05)
    }
  }, 300_000)

  it('holds the nominal level under a bounded asymmetric MEAN-null', async () => {
    // 2% of pairs drop by 1.0, the rest gain 0.02/0.98, so the TRUE mean paired
    // delta — the statistic this gate decides on — is exactly 0. Every sample
    // that happens to miss the drop is n identical positive deltas, whose
    // bootstrap interval has zero width; promoting on it is a claim of
    // certainty with no variance behind it, and it was worth 88.50% at n=6.
    const reps = 2000
    const gain = 0.02 / 0.98
    for (const n of [6, 20, 76]) {
      const r = rng(999 + n)
      let promoted = 0
      for (let rep = 0; rep < reps; rep++) {
        const before: number[] = []
        const after: number[] = []
        for (let i = 0; i < n; i++) {
          before.push(1)
          after.push(r() < 0.02 ? 0 : 1 + gain)
        }
        if ((await decide(before, after, 0)).ship) promoted++
      }
      expect(promoted / reps, `false promotion rate at n=${n}`).toBeLessThanOrEqual(0.05)
    }
  }, 300_000)

  it('refuses a sample with no spread at all, at every sample size', async () => {
    // The individual shape behind the rate above, pinned: a zero-width interval
    // carries no information about how far the estimate could be wrong. At
    // [0,0] it clears every negative threshold; at [g,g] it clears every
    // threshold below g on no evidence at all.
    for (const n of [6, 10, 20, 40, 76]) {
      const before = Array.from({ length: n }, () => 1)
      const after = Array.from({ length: n }, () => 1 + 0.02 / 0.98)
      const d = await decide(before, after, 0)
      expect(d.ship, `zero-spread sample at n=${n}`).toBe(false)
      expect(d.detail.indeterminate, `indeterminate flag at n=${n}`).toBe(true)
      expect(d.reason).toMatch(/carries no direction/)
    }
  })

  it('refuses the 76-pair witness: 0 wins, 3 losses, 73 ties at a -0.05 margin', async () => {
    // Three losses and no wins out of 76 does not establish noninferiority at
    // 5pp — the interval that decides must not claim it does.
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
    const d = await decide(before, after, -0.05)
    expect(d.ship).toBe(false)
    expect(d.detail.ciLow as number).toBeLessThan(-0.05)
    expect(d.detail.decisionStatistic).toBe('paired_risk_difference')
  })

  it('refuses n=6 b=5 c=0: no exact argument reaches α=0.05 on 5 discordant pairs', async () => {
    // The veto's own witness. The score interval clears 0 here and would
    // promote alone, but McNemar's exact two-sided p has a floor of 2/2^5 =
    // 0.0625 with five discordant pairs, so no exact argument reaches α=0.05
    // however the wins fall. The veto is redundant with the interval by
    // construction and kept anyway, so that swapping the estimator cannot
    // silently reintroduce "promotes what the exact test refuses".
    const before = [0, 0, 0, 0, 0, 1]
    const after = [1, 1, 1, 1, 1, 1]
    const d = await decide(before, after, 0)
    expect(d.ship).toBe(false)
    expect(d.detail.ciLow as number).toBeGreaterThan(0)
    expect((d.detail.mcnemar as { pValue: number }).pValue).toBeCloseTo(0.0625, 12)
    expect(d.reason).toMatch(/McNemar exact p=/)
  })

  it('still SEES the lift it exists to see: +13.2pp over 76 items', async () => {
    // A calibration file that only proved refusals would be satisfied by a gate
    // that never promotes. 15 wins / 5 losses / 56 ties is a real +13.2pp lift.
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
    const d = await decide(before, after, 0)
    expect(d.ship).toBe(true)
    expect(d.detail.decidingDelta as number).toBeCloseTo(0.1315789, 6)
    expect(d.detail.ciLow as number).toBeGreaterThan(0)
    // The median paired delta is 0 here — the tie-domination the mean fixed.
    expect(d.detail.deltaMedianDiagnostic).toBe(0)
  })

  it('retains power at a true +10pp lift', async () => {
    // The other half of the calibration claim.
    const reps = 400
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
      if ((await decide(before, after, 0)).ship) promoted++
    }
    expect(promoted / reps, 'power at a true +10pp lift, n=200').toBeGreaterThan(0.9)
  }, 300_000)
})
