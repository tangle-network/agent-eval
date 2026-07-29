import { describe, expect, it } from 'vitest'
import type { JudgeScore } from '../types'
import { dimensionRegressions, heldoutSignificance, pairHoldout } from './statistical-heldout'

/**
 * The promotion gate's decision core: pair candidate-vs-baseline holdout cells,
 * then ship ONLY when the paired-bootstrap CI lower bound clears the threshold.
 * These pin the "trustworthy gate" behaviors the audit flagged as untested:
 * a clear gain is significant, noise/regression is not, thin n is refused
 * (not laundered into significance), and a candidate/baseline cell mismatch
 * fails loud rather than silently mispairing.
 */

const score = (composite: number, dimensions: Record<string, number> = {}): JudgeScore => ({
  composite,
  dimensions,
  notes: '',
})
/** One judge ('quality') per cell; cellId = `scN:0`. */
const cells = (vals: number[]): Map<string, Record<string, JudgeScore>> =>
  new Map(vals.map((v, i) => [`sc${i}:0`, { quality: score(v) }]))
const scenarioIds = (n: number): Set<string> =>
  new Set(Array.from({ length: n }, (_, i) => `sc${i}`))
const composite = (s: JudgeScore) => s.composite

describe('pairHoldout + heldoutSignificance — promotion gate decision core', () => {
  it('a clear held-out gain is SIGNIFICANT (gate ships)', () => {
    // Deltas must not be IDENTICAL: n identical deltas give a zero-width
    // interval, which carries no information about how far the estimate could
    // be wrong and is refused whatever the sign test says (pinned below).
    const paired = pairHoldout(
      cells([0.82, 0.78, 0.85, 0.79, 0.83, 0.8]),
      cells([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      scenarioIds(6),
      composite,
    )
    expect(paired.before).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5])
    const sig = heldoutSignificance(paired)
    expect(sig.n).toBe(6)
    expect(sig.fewRuns).toBe(false)
    expect(sig.decisionMethod).toBe('exact-sign')
    expect(sig.pValue).toBeCloseTo(1 / 64, 12)
    expect(sig.bootstrap.low).toBeGreaterThan(0)
    expect(sig.significant).toBe(true)
  })

  it('refuses a ZERO-WIDTH interval however large the uniform gain', () => {
    // Six cells that all move +0.30 give [0.30, 0.30]. The point estimate is
    // large and the interval says nothing about its error, and under a bounded
    // asymmetric null whose true mean paired delta is exactly 0 this is the
    // shape of every sample that misses the rare drop — worth 88.50% false
    // promotion at n=6 before the guard.
    const paired = pairHoldout(
      cells([0.8, 0.8, 0.8, 0.8, 0.8, 0.8]),
      cells([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      scenarioIds(6),
      composite,
    )
    const sig = heldoutSignificance(paired)
    expect(sig.bootstrap.low).toBe(sig.bootstrap.high)
    expect(sig.decision.indeterminate).toBe(true)
    expect(sig.significant).toBe(false)
  })

  it('decides a pass/fail holdout on the score interval, not the bootstrap', () => {
    // The defect this file exists to pin: on a two-point outcome the paired
    // delta vector is dominated by ties, so a percentile bootstrap of the mean
    // is not a valid interval at a nonzero margin. A candidate that loses 3 of
    // 76 pairs and wins none does not establish noninferiority at a -0.05
    // margin, and the interval that decides must not claim it does.
    const before = [
      ...Array.from({ length: 3 }, () => 1),
      ...Array.from({ length: 73 }, (_, i) => (i % 2 === 0 ? 1 : 0)),
    ]
    const after = [
      ...Array.from({ length: 3 }, () => 0),
      ...Array.from({ length: 73 }, (_, i) => (i % 2 === 0 ? 1 : 0)),
    ]
    const sig = heldoutSignificance(
      { before, after, cellIds: before.map((_, i) => `sc${i}:0`) },
      { deltaThreshold: -0.05 },
    )
    expect(sig.decisionStatistic).toBe('paired_risk_difference')
    expect(sig.decision.low).toBeLessThan(-0.05)
    expect(sig.significant).toBe(false)
  })

  it('pure noise is NOT significant (gate holds)', () => {
    const paired = pairHoldout(
      cells([0.6, 0.4, 0.6, 0.4, 0.6, 0.4]),
      cells([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]),
      scenarioIds(6),
      composite,
    )
    const sig = heldoutSignificance(paired)
    expect(sig.significant).toBe(false)
  })

  it('a regression is NOT significant (gate holds; CI high < 0)', () => {
    const paired = pairHoldout(
      cells([0.5, 0.5, 0.5, 0.5]),
      cells([0.8, 0.8, 0.8, 0.8]),
      scenarioIds(4),
      composite,
    )
    const sig = heldoutSignificance(paired)
    expect(sig.significant).toBe(false)
    expect(sig.bootstrap.high).toBeLessThan(0)
  })

  it('thin n (< minProductiveRuns) is REFUSED even with a huge delta (fewRuns, not significant)', () => {
    const paired = pairHoldout(cells([0.95, 0.95]), cells([0.1, 0.1]), scenarioIds(2), composite)
    const sig = heldoutSignificance(paired)
    expect(sig.n).toBe(2)
    expect(sig.fewRuns).toBe(true)
    expect(sig.significant).toBe(false) // 2 runs is not evidence, however large the gap
  })

  it('a positive-but-sub-threshold gain does NOT ship (deltaThreshold respected)', () => {
    const paired = pairHoldout(
      cells([0.55, 0.55, 0.55, 0.55, 0.55]),
      cells([0.5, 0.5, 0.5, 0.5, 0.5]),
      scenarioIds(5),
      composite,
    )
    const sig = heldoutSignificance(paired, { deltaThreshold: 0.2 }) // needs > +0.2; only +0.05 here
    expect(sig.significant).toBe(false)
  })

  it('fails loud when candidate/baseline holdout cells do not align (no silent mispairing)', () => {
    const candidate = cells([0.8, 0.8, 0.8]) // sc0, sc1, sc2
    const baseline = new Map([
      ['sc0:0', { quality: score(0.5) }],
      ['sc1:0', { quality: score(0.5) }],
      ['sc9:0', { quality: score(0.5) }], // sc9 instead of sc2
    ])
    expect(() =>
      pairHoldout(candidate, baseline, new Set(['sc0', 'sc1', 'sc2', 'sc9']), composite),
    ).toThrow(/do not align/)
  })

  it('is deterministic — the same holdout yields the same verdict (reproducible gate)', () => {
    const mk = () =>
      heldoutSignificance(
        pairHoldout(
          cells([0.7, 0.72, 0.8, 0.71, 0.79]),
          cells([0.5, 0.52, 0.6, 0.51, 0.59]),
          scenarioIds(5),
          composite,
        ),
      )
    expect(mk()).toEqual(mk())
  })
})

describe('dimensionRegressions — binary (0/1) safety dimensions', () => {
  /** Cells scoring one dimension 0/1: `wins` candidate-only, `losses` baseline-only. */
  const binaryDim = (dim: string, wins: number, losses: number, ties: number, level = 1) => {
    const cand = new Map<string, Record<string, JudgeScore>>()
    const base = new Map<string, Record<string, JudgeScore>>()
    let i = 0
    const put = (b: number, c: number) => {
      base.set(`sc${i}:0`, { quality: score(b, { [dim]: b }) })
      cand.set(`sc${i}:0`, { quality: score(c, { [dim]: c }) })
      i++
    }
    for (let k = 0; k < wins; k++) put(0, level)
    for (let k = 0; k < losses; k++) put(level, 0)
    for (let k = 0; k < ties; k++) put(level, level)
    return { cand, base, ids: new Set(Array.from({ length: i }, (_, n) => `sc${n}`)) }
  }

  it('CATCHES a real -13.2pp regression on a binary dimension (guard failed open on the median)', () => {
    const { cand, base, ids } = binaryDim('hallucination_free', 5, 15, 56)
    const [reg] = dimensionRegressions(cand, base, ids, ['hallucination_free'])
    expect(reg!.n).toBe(76)
    expect(reg!.bootstrapStatistic).toBe('mean')
    // The literal median of the paired delta vector is 0 — a median-CI guard
    // could never drop below −tolerance, so it reported `regressed: false`.
    expect(reg!.bootstrap.median).toBe(0)
    expect(reg!.bootstrap.mean).toBeCloseTo(-10 / 76, 6)
    expect(reg!.bootstrap.low).toBeLessThan(-reg!.tolerance)
    expect(reg!.regressed).toBe(true)
  })

  it('does not flag a binary dimension that IMPROVED', () => {
    const { cand, base, ids } = binaryDim('hallucination_free', 15, 5, 56)
    const [reg] = dimensionRegressions(cand, base, ids, ['hallucination_free'])
    expect(reg!.bootstrap.mean).toBeCloseTo(10 / 76, 6)
    expect(reg!.regressed).toBe(false)
  })

  it('CATCHES the same regression encoded on 0-100 (the scale detectScale exists for)', () => {
    // A {0,1}-only detector reads this as continuous, bootstraps the median,
    // gets CI [0,0] and reports regressed=false on a −13.16-POINT drop of a
    // safety dimension — with the tolerance auto-scaled to 5 points.
    const { cand, base, ids } = binaryDim('hallucination_free', 5, 15, 56, 100)
    const [reg] = dimensionRegressions(cand, base, ids, ['hallucination_free'])
    // The verdict first: this guard existing at all is the point.
    expect(reg!.regressed).toBe(true)
    expect(reg!.tolerance).toBe(5)
    expect(reg!.bootstrapStatistic).toBe('mean')
    expect(reg!.bootstrap.median).toBe(0)
    expect(reg!.bootstrap.mean).toBeCloseTo((-10 / 76) * 100, 6)
    expect(reg!.bootstrap.low).toBeLessThan(-reg!.tolerance)
  })

  it('CATCHES a regression that one partial-credit cell made non-binary', () => {
    const { cand, base, ids } = binaryDim('hallucination_free', 5, 15, 56)
    base.set('sc76:0', { quality: score(0.5, { hallucination_free: 0.5 }) })
    cand.set('sc76:0', { quality: score(0.5, { hallucination_free: 0.5 }) })
    ids.add('sc76')
    const [reg] = dimensionRegressions(cand, base, ids, ['hallucination_free'])
    expect(reg!.regressed).toBe(true)
    expect(reg!.n).toBe(77)
    expect(reg!.bootstrapStatistic).toBe('mean')
  })

  it('CATCHES a pass/fail safety regression the bootstrap arm cannot see', () => {
    // The mirror-image defect. `tolerance` is POSITIVE, so the credible-worst-
    // case arm (`bootstrap.low < -tolerance`) fails OPEN wherever the bootstrap
    // interval is pinned — which is the normal state of a pass/fail dimension,
    // not an edge case. Here the candidate loses the safety dimension on 12 of
    // 40 held-out cells and wins none; the proven-drop arm now decides on
    // Tango's score interval, which is valid at the nonzero tolerance.
    const cand = new Map<string, Record<string, JudgeScore>>()
    const base = new Map<string, Record<string, JudgeScore>>()
    for (let i = 0; i < 40; i++) {
      const safe = i < 12 ? { baseline: 1, candidate: 0 } : { baseline: 1, candidate: 1 }
      base.set(`sc${i}:0`, { quality: score(0.5, { safety: safe.baseline }) })
      cand.set(`sc${i}:0`, { quality: score(0.5, { safety: safe.candidate }) })
    }
    const [reg] = dimensionRegressions(cand, base, scenarioIds(40), ['safety'], {
      tolerance: 0.05,
    })
    expect(reg!.decisionStatistic).toBe('paired_risk_difference')
    expect(reg!.regressed).toBe(true)
  })

  it('decides continuous dimensions on the mean, and still offers the median', () => {
    const cand = new Map<string, Record<string, JudgeScore>>()
    const base = new Map<string, Record<string, JudgeScore>>()
    for (let i = 0; i < 6; i++) {
      base.set(`sc${i}:0`, { quality: score(0.5, { safety: 0.8 }) })
      cand.set(`sc${i}:0`, { quality: score(0.6, { safety: 0.3 }) })
    }
    const [reg] = dimensionRegressions(cand, base, scenarioIds(6), ['safety'])
    expect(reg!.bootstrapStatistic).toBe('mean')
    expect(reg!.regressed).toBe(true)
    // The pre-0.134 median path is still exactly reachable, same verdict here.
    const [med] = dimensionRegressions(cand, base, scenarioIds(6), ['safety'], {
      statistic: 'median',
    })
    expect(med!.bootstrapStatistic).toBe('median')
    expect(med!.regressed).toBe(true)
    expect(med!.bootstrap.low).toBe(reg!.bootstrap.low) // identical deltas ⇒ identical CI
  })
})
