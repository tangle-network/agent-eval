import { describe, expect, it } from 'vitest'
import { comparePairedArms, type PairedArmRow, pairArms } from './paired-arms'
import { mcnemar } from './statistics'

/**
 * The pairing layer every paired statistic downstream depends on: pairing
 * must key on row identity (pairKey, repKey) and NEVER on outcome content
 * (outcome-keyed matching deflates discordant counts and biases McNemar),
 * leftovers must be reported not dropped, and the composed estimators must
 * see exactly the discordant counts the pairs imply.
 */
describe('pairArms — matched-pair construction', () => {
  const row = (
    pairKey: string,
    arm: string,
    pass?: boolean,
    metrics?: Record<string, number>,
    repKey?: string,
  ): PairedArmRow => ({ pairKey, repKey, arm, pass, metrics })

  it('matches rows across arms by pairKey', () => {
    const rows = [row('t1', 'off', false), row('t1', 'on', true), row('t2', 'off', true)]
    const r = pairArms(rows, { baselineArm: 'off', treatmentArm: 'on' })
    expect(r.pairs).toHaveLength(1)
    expect(r.pairs[0]!.pairKey).toBe('t1')
    expect(r.pairs[0]!.baseline.arm).toBe('off')
    expect(r.pairs[0]!.treatment.arm).toBe('on')
    expect(r.unpairedBaseline).toHaveLength(1)
    expect(r.unpairedBaseline[0]!.pairKey).toBe('t2')
    expect(r.unpairedTreatment).toHaveLength(0)
  })

  it('is deterministic under input reordering (pairing keys on identity, not position)', () => {
    const rows = [
      row('t1', 'off', false, { score: 0.2 }, 'r1'),
      row('t1', 'off', true, { score: 0.9 }, 'r2'),
      row('t1', 'on', true, { score: 0.8 }, 'r1'),
      row('t1', 'on', false, { score: 0.1 }, 'r2'),
      row('t2', 'off', false),
      row('t2', 'on', true),
    ]
    const forward = pairArms(rows, { baselineArm: 'off', treatmentArm: 'on' })
    const reversed = pairArms([...rows].reverse(), { baselineArm: 'off', treatmentArm: 'on' })
    expect(reversed).toEqual(forward)
  })

  it('pairs multi-rep items on exact repKey match, never on outcome', () => {
    // Discordant on BOTH reps: outcome-keyed matching would pair fail↔fail
    // and pass↔pass and report zero discordant pairs.
    const rows = [
      row('t1', 'off', true, { score: 0.9 }, 'r1'),
      row('t1', 'off', false, { score: 0.2 }, 'r2'),
      row('t1', 'on', false, { score: 0.1 }, 'r1'),
      row('t1', 'on', true, { score: 0.8 }, 'r2'),
    ]
    const r = pairArms(rows, { baselineArm: 'off', treatmentArm: 'on' })
    expect(r.pairs).toHaveLength(2)
    expect(r.pairs.map((p) => p.repIndex)).toEqual([0, 1])
    expect(r.pairs[0]!.baseline.repKey).toBe('r1')
    expect(r.pairs[0]!.treatment.repKey).toBe('r1')
    expect(r.pairs[0]!.baseline.pass).toBe(true)
    expect(r.pairs[0]!.treatment.pass).toBe(false)
    expect(r.pairs[1]!.baseline.repKey).toBe('r2')
    expect(r.pairs[1]!.baseline.pass).toBe(false)
    expect(r.pairs[1]!.treatment.pass).toBe(true)
    expect(r.unpairedBaseline).toHaveLength(0)
    expect(r.unpairedTreatment).toHaveLength(0)
  })

  it('reports repKeys without a counterpart as unpaired, never dropping them', () => {
    const rows = [
      row('t1', 'off', false, undefined, 'r1'),
      row('t1', 'off', false, undefined, 'r2'),
      row('t1', 'off', true, undefined, 'r3'), // passing surplus rep must survive
      row('t1', 'on', true, undefined, 'r1'),
      row('t2', 'on', true), // pairKey only in treatment
    ]
    const r = pairArms(rows, { baselineArm: 'off', treatmentArm: 'on' })
    expect(r.pairs).toHaveLength(1)
    expect(r.pairs[0]!.baseline.repKey).toBe('r1')
    expect(r.unpairedBaseline.map((x) => x.repKey)).toEqual(['r2', 'r3'])
    expect(r.unpairedBaseline.map((x) => x.pass)).toEqual([false, true])
    expect(r.unpairedTreatment).toHaveLength(1)
    expect(r.unpairedTreatment[0]!.pairKey).toBe('t2')
  })

  it('throws when a multi-rep pairKey has a row without repKey', () => {
    const rows = [
      row('t1', 'off', false),
      row('t1', 'off', true),
      row('t1', 'on', true, undefined, 'r1'),
    ]
    expect(() => pairArms(rows, { baselineArm: 'off', treatmentArm: 'on' })).toThrow(
      /pairKey 't1' has multiple reps.*missing repKey/,
    )
  })

  it('throws on a duplicate repKey within a (pairKey, arm) group', () => {
    const rows = [
      row('t1', 'off', false, undefined, 'r1'),
      row('t1', 'off', true, undefined, 'r1'),
      row('t1', 'on', true, undefined, 'r1'),
    ]
    expect(() => pairArms(rows, { baselineArm: 'off', treatmentArm: 'on' })).toThrow(
      /duplicate repKey 'r1' for pairKey 't1' in arm 'off'/,
    )
  })

  it('throws on an unknown arm (fail-loud, never "everything unpaired")', () => {
    const rows = [row('t1', 'off', false), row('t1', 'on', true)]
    expect(() => pairArms(rows, { baselineArm: 'off', treatmentArm: 'onn' })).toThrow(
      /no rows for arm 'onn'.*arms present: off, on/,
    )
  })

  it('throws when baseline and treatment name the same arm', () => {
    const rows = [row('t1', 'off', false)]
    expect(() => pairArms(rows, { baselineArm: 'off', treatmentArm: 'off' })).toThrow(
      /cannot be compared to itself/,
    )
  })
})

describe('comparePairedArms — composed paired estimators', () => {
  const row = (
    pairKey: string,
    arm: string,
    pass?: boolean,
    metrics?: Record<string, number>,
    repKey?: string,
  ): PairedArmRow => ({ pairKey, repKey, arm, pass, metrics })

  it('feeds the discordant counts to mcnemar exactly (b10 = treatment wins, b01 = baseline wins)', () => {
    // 3 treatment-wins, 1 baseline-win, 2 concordant.
    const rows = [
      row('t1', 'off', false),
      row('t1', 'on', true),
      row('t2', 'off', false),
      row('t2', 'on', true),
      row('t3', 'off', false),
      row('t3', 'on', true),
      row('t4', 'off', true),
      row('t4', 'on', false),
      row('t5', 'off', true),
      row('t5', 'on', true),
      row('t6', 'off', false),
      row('t6', 'on', false),
    ]
    const r = comparePairedArms(rows, { baselineArm: 'off', treatmentArm: 'on' })
    expect(r.nPairs).toBe(6)
    expect(r.correctness).not.toBeNull()
    expect(r.correctness!.b10).toBe(3)
    expect(r.correctness!.b01).toBe(1)
    expect(r.correctness!.mcnemar).toEqual(mcnemar([0, 0, 0, 1, 1, 0], [1, 1, 1, 0, 1, 0]))
    expect(r.correctness!.riskDifference.riskDifference).toBeCloseTo((3 - 1) / 6, 6)
  })

  it('reports correctness as null when no pair carries pass on both sides', () => {
    const rows = [
      row('t1', 'off', undefined, { score: 0.2 }),
      row('t1', 'on', undefined, { score: 0.8 }),
    ]
    const r = comparePairedArms(rows, { baselineArm: 'off', treatmentArm: 'on' })
    expect(r.correctness).toBeNull()
    expect(r.nPairs).toBe(1)
  })

  it('computes per-metric deltas only over pairs carrying the metric on both sides', () => {
    const rows = [
      row('t1', 'off', false, { score: 0.2, cost: 1 }),
      row('t1', 'on', true, { score: 0.8, cost: 3 }),
      row('t2', 'off', false, { score: 0.4 }), // no cost on baseline side
      row('t2', 'on', true, { score: 0.5, cost: 2 }),
    ]
    const r = comparePairedArms(rows, {
      baselineArm: 'off',
      treatmentArm: 'on',
      bootstrap: { seed: 1337 },
    })
    expect(r.metricDeltas.map((m) => m.name)).toEqual(['cost', 'score'])

    const cost = r.metricDeltas.find((m) => m.name === 'cost')!
    expect(cost.n).toBe(1)
    expect(cost.nMissing).toBe(1)
    expect(cost.medianDelta).toBeCloseTo(2, 6) // treatment − baseline

    const score = r.metricDeltas.find((m) => m.name === 'score')!
    expect(score.n).toBe(2)
    expect(score.nMissing).toBe(0)
    expect(score.meanDelta).toBeCloseTo((0.6 + 0.1) / 2, 6)
    expect(score.bootstrapCi!.n).toBe(2)
  })

  it('reports a requested-but-absent metric with n = 0 and NaN deltas (visible, not vanished)', () => {
    const rows = [row('t1', 'off', false, { score: 0.2 }), row('t1', 'on', true, { score: 0.8 })]
    const r = comparePairedArms(rows, {
      baselineArm: 'off',
      treatmentArm: 'on',
      metricNames: ['latency'],
      bootstrap: { seed: 1337 },
    })
    expect(r.metricDeltas).toHaveLength(1)
    const m = r.metricDeltas[0]!
    expect(m.name).toBe('latency')
    expect(m.n).toBe(0)
    expect(m.nMissing).toBe(1)
    expect(Number.isNaN(m.medianDelta)).toBe(true)
    expect(Number.isNaN(m.meanDelta)).toBe(true)
    // No data must not read as a measured tight-null CI.
    expect(m.bootstrapCi).toBeNull()
    expect(m.wilcoxon).toBeNull()
  })

  it('accounts for unpaired rows in the summary counts', () => {
    const rows = [
      row('t1', 'off', false),
      row('t1', 'on', true),
      row('t2', 'off', false),
      row('t3', 'on', true, undefined, 'r1'),
      row('t3', 'on', true, undefined, 'r2'),
    ]
    const r = comparePairedArms(rows, { baselineArm: 'off', treatmentArm: 'on' })
    expect(r.nPairs).toBe(1)
    expect(r.nUnpairedBaseline).toBe(1)
    expect(r.nUnpairedTreatment).toBe(2)
  })

  it('regression: unequal rep counts on a null A/B report no effect (reps pair by repKey, surplus reported)', () => {
    // 20 tasks. Baseline: 2 reps each (r1 alternating pass/fail, r2 the
    // complement — every task 1 pass + 1 fail). Treatment: 1 rep (r1) with
    // the SAME outcome as baseline r1 — a true per-rep null. Outcome-sorted
    // index pairing would match every treatment rep against the baseline's
    // failing rep and truncate the 20 surplus baseline reps, fabricating
    // riskDifference +0.5 out of nothing.
    const rows: PairedArmRow[] = []
    for (let i = 0; i < 20; i++) {
      const r1Pass = i % 2 === 0
      rows.push(row(`t${i}`, 'off', r1Pass, undefined, 'r1'))
      rows.push(row(`t${i}`, 'off', !r1Pass, undefined, 'r2'))
      rows.push(row(`t${i}`, 'on', r1Pass, undefined, 'r1'))
    }
    const r = comparePairedArms(rows, { baselineArm: 'off', treatmentArm: 'on' })
    expect(r.nPairs).toBe(20)
    expect(r.nUnpairedBaseline).toBe(20) // every r2 rep accounted, none truncated
    expect(r.nUnpairedTreatment).toBe(0)
    expect(r.correctness).not.toBeNull()
    expect(r.correctness!.b10).toBe(0)
    expect(r.correctness!.b01).toBe(0)
    expect(r.correctness!.riskDifference.riskDifference).toBeCloseTo(0, 12)
    expect(r.correctness!.mcnemar.pValue).toBe(1)
  })

  it('regression: unequal rep counts without repKeys throw instead of silently truncating', () => {
    const rows: PairedArmRow[] = []
    for (let i = 0; i < 20; i++) {
      rows.push(row(`t${i}`, 'off', true))
      rows.push(row(`t${i}`, 'off', false))
      rows.push(row(`t${i}`, 'on', i % 2 === 0))
    }
    expect(() => comparePairedArms(rows, { baselineArm: 'off', treatmentArm: 'on' })).toThrow(
      /multiple reps.*missing repKey/,
    )
  })

  it('throws on a non-finite metric value (corrupt telemetry must not read as missing)', () => {
    const rows = [
      row('t1', 'off', false, { score: Number.NaN }),
      row('t1', 'on', true, { score: 0.8 }),
    ]
    expect(() => comparePairedArms(rows, { baselineArm: 'off', treatmentArm: 'on' })).toThrow(
      /non-finite value for metric 'score'/,
    )
  })

  it('is deterministic under a fixed bootstrap seed', () => {
    const rows = [
      row('t1', 'off', false, { score: 0.2 }),
      row('t1', 'on', true, { score: 0.7 }),
      row('t2', 'off', false, { score: 0.3 }),
      row('t2', 'on', false, { score: 0.4 }),
      row('t3', 'off', true, { score: 0.9 }),
      row('t3', 'on', true, { score: 0.8 }),
    ]
    const opts = { baselineArm: 'off', treatmentArm: 'on', bootstrap: { seed: 42 } }
    expect(comparePairedArms(rows, opts)).toEqual(comparePairedArms(rows, opts))
  })
})
