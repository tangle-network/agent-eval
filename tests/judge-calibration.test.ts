import { describe, expect, it } from 'vitest'
import {
  calibrateJudge,
  calibrateJudgeContinuous,
  continuousAgreement,
  positionalBias,
  selfPreference,
  verbosityBias,
} from '../src/judge-calibration'

describe('calibrateJudge', () => {
  it('returns high pearson + κ when judge perfectly matches human', () => {
    const golden = Array.from({ length: 10 }, (_, i) => ({ itemId: `i-${i}`, humanScore: i }))
    const cand = golden.map((g) => ({ itemId: g.itemId, score: g.humanScore }))
    const r = calibrateJudge(golden, cand)
    expect(r.pearson).toBeCloseTo(1)
    expect(r.mae).toBe(0)
  })

  it('flags miscalibration with worst-5 items', () => {
    const golden = [
      { itemId: 'a', humanScore: 5 },
      { itemId: 'b', humanScore: 5 },
      { itemId: 'c', humanScore: 5 },
    ]
    const cand = [
      { itemId: 'a', score: 5 },
      { itemId: 'b', score: 8 },
      { itemId: 'c', score: 1 },
    ]
    const r = calibrateJudge(golden, cand)
    expect(r.worstItems[0].itemId).toBe('c')
    expect(r.mae).toBeGreaterThan(0)
  })

  it('skips items without a judge score — regression: NaN would contaminate pearson', () => {
    const golden = [{ itemId: 'a', humanScore: 5 }, { itemId: 'b', humanScore: 6 }]
    const cand = [{ itemId: 'a', score: 5 }]
    const r = calibrateJudge(golden, cand)
    expect(r.n).toBe(1)
    expect(Number.isNaN(r.pearson)).toBe(true) // n<2
  })
})

describe('positionalBias', () => {
  it('returns zero when A/B positions don\'t move the score', () => {
    const r = positionalBias([
      { itemId: 'x', score: 7, positionOfAInput: 'first' },
      { itemId: 'x', score: 7, positionOfAInput: 'second' },
      { itemId: 'y', score: 4, positionOfAInput: 'first' },
      { itemId: 'y', score: 4, positionOfAInput: 'second' },
    ])
    expect(r.avgDelta).toBe(0)
    expect(r.n).toBe(2)
  })

  it('surfaces non-zero positional drift — regression: positional bias that stays hidden breaks rankings', () => {
    const r = positionalBias([
      { itemId: 'x', score: 8, positionOfAInput: 'first' },
      { itemId: 'x', score: 5, positionOfAInput: 'second' },
    ])
    expect(r.avgDelta).toBe(3)
  })
})

describe('verbosityBias', () => {
  it('detects positive correlation between length and score', () => {
    const samples = Array.from({ length: 10 }, (_, i) => ({ outputLen: i * 100, score: i }))
    const r = verbosityBias(samples)
    expect(r.pearson).toBeGreaterThan(0.9)
  })
})

describe('selfPreference', () => {
  it('computes delta between in-family and out-of-family means', () => {
    const r = selfPreference([
      { score: 9, inFamily: true },
      { score: 8.5, inFamily: true },
      { score: 7, inFamily: false },
      { score: 6.5, inFamily: false },
    ])
    expect(r.deltaMean).toBeCloseTo(2)
    expect(r.n).toBe(4)
  })
})

// ── continuousAgreement — ICC + κ_w on un-rounded scores ───────────────

function mulberry(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

describe('continuousAgreement', () => {
  it('returns ICC=1 and κ_w=1 for identical raters', () => {
    const rng = mulberry(1)
    const rows = Array.from({ length: 30 }, () => {
      const v = rng()
      return [v, v]
    })
    const r = continuousAgreement(rows, { bootstrap: 200, seed: 7 })
    expect(r.icc).toBeCloseTo(1, 6)
    expect(r.weightedKappa).toBeCloseTo(1, 6)
    expect(r.pearson).toBeCloseTo(1, 6)
    expect(r.spearman).toBeCloseTo(1, 6)
    expect(r.n).toBe(30)
    expect(r.raters).toBe(2)
  })

  it('returns ICC ≈ 0 and κ_w ≈ 0 for independent uniform raters', () => {
    const rng = mulberry(42)
    const rows = Array.from({ length: 400 }, () => [rng(), rng()])
    const r = continuousAgreement(rows, { bootstrap: 200, seed: 11 })
    expect(Math.abs(r.icc)).toBeLessThan(0.15)
    expect(Math.abs(r.weightedKappa)).toBeLessThan(0.15)
    expect(Math.abs(r.pearson)).toBeLessThan(0.15)
  })

  it('catches systematic bias (rater B = 2× rater A + noise): high Pearson, lower ICC', () => {
    // Pearson is scale-invariant so it stays high. ICC(2,1) is absolute
    // agreement so the 2× scaling drives it down — this is the bug the
    // integer-rounded κ used to hide.
    const rng = mulberry(99)
    const rows = Array.from({ length: 100 }, () => {
      const a = rng() * 0.5 // in [0, 0.5] so 2× still fits [0,1]
      const noise = (rng() - 0.5) * 0.02
      const b = Math.min(1, 2 * a + noise)
      return [a, b]
    })
    const r = continuousAgreement(rows, { bootstrap: 200, seed: 13 })
    expect(r.pearson).toBeGreaterThan(0.95)
    // ICC penalises absolute disagreement: should be meaningfully lower
    // than Pearson and clearly below 0.9.
    expect(r.icc).toBeLessThan(0.9)
    expect(r.icc).toBeLessThan(r.pearson - 0.05)
  })

  it('bootstrap CI brackets the truth on synthetic identical-rater data', () => {
    const rng = mulberry(123)
    const rows = Array.from({ length: 50 }, () => {
      const v = rng()
      // Tiny perturbation so denominators are non-degenerate.
      return [v, v + (rng() - 0.5) * 1e-3]
    })
    const r = continuousAgreement(rows, { bootstrap: 1000, seed: 5 })
    // True value is essentially 1 — bootstrap CI must contain it.
    expect(r.ci.icc[0]).toBeLessThanOrEqual(1)
    expect(r.ci.icc[1]).toBeGreaterThanOrEqual(0.99)
    expect(r.ci.weightedKappa[0]).toBeLessThanOrEqual(1)
    expect(r.ci.weightedKappa[1]).toBeGreaterThanOrEqual(0.99)
  })

  it('bootstrap CI brackets true ICC on noisy linear ground truth', () => {
    // Construct rows whose population ICC is known to sit in (0.5, 0.9).
    // a ~ U[0,1], b = a + N(0, σ) with σ chosen for moderate agreement.
    const rng = mulberry(2025)
    const sigma = 0.15
    const rows = Array.from({ length: 200 }, () => {
      const a = rng()
      // Box–Muller for normal noise.
      const u1 = Math.max(rng(), 1e-12)
      const u2 = rng()
      const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
      const b = Math.max(0, Math.min(1, a + sigma * z))
      return [a, b]
    })
    const r = continuousAgreement(rows, { bootstrap: 1000, seed: 17 })
    expect(r.icc).toBeGreaterThan(0.5)
    expect(r.icc).toBeLessThan(0.95)
    expect(r.ci.icc[0]).toBeLessThanOrEqual(r.icc)
    expect(r.ci.icc[1]).toBeGreaterThanOrEqual(r.icc)
    // CI width should be informative (< 0.5) at n=200, B=1000.
    expect(r.ci.icc[1] - r.ci.icc[0]).toBeLessThan(0.5)
  })

  it('supports >2 raters via mean-pairwise aggregation', () => {
    const rng = mulberry(77)
    const rows = Array.from({ length: 60 }, () => {
      const truth = rng()
      const noise = () => (rng() - 0.5) * 0.05
      return [truth + noise(), truth + noise(), truth + noise()]
    })
    const r = continuousAgreement(rows, { bootstrap: 100, seed: 3 })
    expect(r.raters).toBe(3)
    expect(r.icc).toBeGreaterThan(0.8)
    expect(r.weightedKappa).toBeGreaterThan(0.8)
  })

  it('returns NaN metrics when fewer than 2 complete items', () => {
    const r = continuousAgreement([[0.5, 0.6]], { bootstrap: 0 })
    expect(Number.isNaN(r.icc)).toBe(true)
    expect(Number.isNaN(r.weightedKappa)).toBe(true)
    expect(r.n).toBe(1)
  })

  it('drops rows containing NaN/Infinity rather than poisoning the stats', () => {
    const rows = [
      [0.1, 0.2],
      [0.4, Number.NaN],
      [0.7, 0.75],
      [Number.POSITIVE_INFINITY, 0.5],
      [0.9, 0.88],
    ]
    const r = continuousAgreement(rows, { bootstrap: 0 })
    expect(r.n).toBe(3)
  })

  it('linear weights are accepted and produce a sane κ_w', () => {
    const rng = mulberry(8)
    const rows = Array.from({ length: 40 }, () => {
      const v = rng()
      return [v, v + (rng() - 0.5) * 0.02]
    })
    const r = continuousAgreement(rows, { weights: 'linear', bootstrap: 0 })
    expect(r.weightedKappa).toBeGreaterThan(0.7)
  })

  it('catches the rounding-blindspot bug: 0.78 vs 0.81 are no longer "perfect"', () => {
    // Both raters score in (0.5, 1.0] but never agree exactly. Integer-
    // rounded κ would call this a tie at category "1" for every item;
    // continuous κ_w and ICC reveal the residual disagreement.
    const rows: number[][] = []
    for (let i = 0; i < 30; i++) {
      const a = 0.55 + 0.4 * (i / 29)
      const b = a + ((i % 2 === 0 ? 1 : -1) * 0.03)
      rows.push([a, b])
    }
    const r = continuousAgreement(rows, { bootstrap: 0 })
    // Strong rank/linear association — but ICC penalises the residual.
    expect(r.pearson).toBeGreaterThan(0.95)
    expect(r.icc).toBeLessThan(1)
    expect(r.weightedKappa).toBeLessThan(1)
  })
})

describe('calibrateJudgeContinuous', () => {
  it('returns all legacy fields plus continuous metrics', () => {
    const rng = mulberry(31)
    const golden = Array.from({ length: 25 }, (_, i) => ({
      itemId: `i-${i}`,
      humanScore: rng(),
    }))
    const cand = golden.map((g) => ({
      itemId: g.itemId,
      score: g.humanScore + (rng() - 0.5) * 0.05,
    }))
    const r = calibrateJudgeContinuous(golden, cand, { bootstrap: 200, seed: 19 })
    // Legacy fields preserved.
    expect(r.n).toBe(25)
    expect(typeof r.pearson).toBe('number')
    expect(typeof r.kappa).toBe('number')
    expect(typeof r.mae).toBe('number')
    expect(Array.isArray(r.worstItems)).toBe(true)
    // New continuous fields.
    expect(r.weightedKappaContinuous).toBeGreaterThan(0.8)
    expect(r.icc).toBeGreaterThan(0.8)
    expect(typeof r.spearman).toBe('number')
    expect(r.ci.icc.length).toBe(2)
    expect(r.ci.weightedKappa.length).toBe(2)
  })

  it('flags 2× scaling bias that the integer-rounded κ misses', () => {
    // Judge always scores 2× the human, but rounds to same integer for
    // many items in [0,1]. New ICC drops; old kappa stays artificially high.
    const items = Array.from({ length: 20 }, (_, i) => i / 38) // human in [0, 0.5]
    const golden = items.map((h, i) => ({ itemId: `i-${i}`, humanScore: h }))
    const cand = items.map((h, i) => ({ itemId: `i-${i}`, score: Math.min(1, 2 * h) }))
    const r = calibrateJudgeContinuous(golden, cand, { bootstrap: 0 })
    expect(r.pearson).toBeGreaterThan(0.99)
    expect(r.icc).toBeLessThan(0.9)
    expect(r.icc).toBeLessThan(r.pearson - 0.05)
  })
})
