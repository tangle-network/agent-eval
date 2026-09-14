import { describe, expect, it } from 'vitest'
import { minimumPairsForPairedDeltaTest } from './paired-delta-test'
import { decidePairedPromotion, pairedDecisionShape } from './paired-promotion-decision'

/** 24 paired pass/fail outcomes: 4 shared passes, 10 the candidate newly wins. */
const binaryBaseline = Array.from({ length: 24 }, (_, i) => (i < 4 ? 1 : 0))
const binaryCandidate = Array.from({ length: 24 }, (_, i) => (i < 14 ? 1 : 0))

/** 30 continuous scores where the candidate gains between 0.020 and 0.064. */
const continuousBaseline = Array.from({ length: 30 }, (_, i) => 0.3 + (i % 7) * 0.013)
const continuousCandidate = continuousBaseline.map((v, i) => v + 0.02 + (i % 5) * 0.011)

describe('decidePairedPromotion input validation', () => {
  it('refuses unequal sample sizes', () => {
    expect(() => decidePairedPromotion([0, 1, 0], [1, 1])).toThrow(
      /unequal sample sizes \(3 vs 2\)/,
    )
  })

  it('refuses a non-finite threshold', () => {
    expect(() =>
      decidePairedPromotion(binaryBaseline, binaryCandidate, { threshold: Number.NaN }),
    ).toThrow(/threshold must be finite/)
    expect(() =>
      decidePairedPromotion(binaryBaseline, binaryCandidate, {
        threshold: Number.POSITIVE_INFINITY,
      }),
    ).toThrow(/threshold must be finite/)
  })

  it('refuses a minimum pair count that is not a positive integer', () => {
    for (const minPairs of [0, -1, 2.5, Number.NaN]) {
      expect(() => decidePairedPromotion(binaryBaseline, binaryCandidate, { minPairs })).toThrow(
        /minPairs must be a positive integer/,
      )
    }
  })
})

describe('decidePairedPromotion estimator selection', () => {
  it('routes a two-point outcome to the score interval, not the mean bootstrap', () => {
    const decision = decidePairedPromotion(binaryBaseline, binaryCandidate)

    expect(decision.statistic).toBe('paired_risk_difference')
    expect(decision.method).toBe('score-interval')
    expect(decision.binaryScale).toBe(1)
    expect(decision.label).toBe('success-rate')
    // The binary path costs no resamples, so it reports no bootstrap.
    expect(decision.bootstrap).toBeNull()
    expect(decision.mcnemar).toEqual({ b: 10, c: 0, nDiscordant: 10, pValue: 0.001953125 })
  })

  it('rescales a two-point outcome recorded on a 0-100 scale into the caller units', () => {
    const decision = decidePairedPromotion(
      binaryBaseline.map((v) => v * 100),
      binaryCandidate.map((v) => v * 100),
      { threshold: 5 },
    )
    const unitDecision = decidePairedPromotion(binaryBaseline, binaryCandidate)

    expect(decision.binaryScale).toBe(100)
    // The threshold is read in the units of the scores, so the interval is
    // reported in points rather than as a rate.
    expect(decision.delta).toBeCloseTo(unitDecision.delta * 100, 10)
    expect(decision.low).toBeCloseTo(unitDecision.low * 100, 10)
    expect(decision.high).toBeCloseTo(unitDecision.high * 100, 10)
    expect(decision.promote).toBe(true)
  })

  it('routes a continuous outcome to the mean bootstrap', () => {
    const decision = decidePairedPromotion(continuousBaseline, continuousCandidate, { seed: 11 })

    expect(decision.statistic).toBe('mean_bootstrap')
    expect(decision.method).toBe('bootstrap-ci')
    expect(decision.binaryScale).toBeNull()
    expect(decision.mcnemar).toBeNull()
    expect(decision.bootstrap).not.toBeNull()
  })

  it('forces the median bootstrap when the caller asks for it, even on a two-point outcome', () => {
    const decision = decidePairedPromotion(binaryBaseline, binaryCandidate, {
      statistic: 'median',
      seed: 11,
    })

    expect(decision.statistic).toBe('median_bootstrap')
    expect(decision.label).toBe('median')
    expect(decision.binaryScale).toBeNull()
    expect(decision.mcnemar).toBeNull()
  })

  it('reports the same shape facts as pairedDecisionShape without computing an interval', () => {
    const decision = decidePairedPromotion(binaryBaseline, binaryCandidate)
    const shape = pairedDecisionShape(binaryBaseline, binaryCandidate)

    expect(shape).toEqual({
      statistic: decision.statistic,
      binaryScale: decision.binaryScale,
      tieFraction: decision.tieFraction,
    })
    expect(pairedDecisionShape([], [])).toEqual({
      statistic: 'mean_bootstrap',
      binaryScale: null,
      tieFraction: null,
    })
  })

  it('is deterministic under a fixed seed', () => {
    const first = decidePairedPromotion(continuousBaseline, continuousCandidate, { seed: 11 })
    const second = decidePairedPromotion(continuousBaseline, continuousCandidate, { seed: 11 })

    expect(second.low).toBe(first.low)
    expect(second.high).toBe(first.high)
    expect(second.promote).toBe(first.promote)
  })
})

describe('decidePairedPromotion declared binary outcomes', () => {
  it.each([1, 100])('treats zero errors and all successes equally on scale %i', (binaryScale) => {
    for (const n of [20, 100]) {
      const threshold = -0.05 * binaryScale
      const errors = decidePairedPromotion(Array(n).fill(0), Array(n).fill(0), {
        binaryScale,
        threshold,
      })
      const successes = decidePairedPromotion(
        Array(n).fill(binaryScale),
        Array(n).fill(binaryScale),
        { threshold },
      )

      expect(errors).toEqual(successes)
      expect(errors.statistic).toBe('paired_risk_difference')
      expect(errors.indeterminate).toBe(false)
      expect(errors.sufficient).toBe(true)
      expect(errors.promote).toBe(n === 100)
    }
  })

  it('does not turn tied binary evidence into an improvement', () => {
    const decision = decidePairedPromotion(Array(100).fill(0), Array(100).fill(0), {
      binaryScale: 1,
    })
    expect(decision.delta).toBe(0)
    expect(decision.indeterminate).toBe(false)
    expect(decision.exactTestVetoes).toBe(true)
    expect(decision.promote).toBe(false)
  })

  it('does not infer a binary scale from undeclared zeros', () => {
    const decision = decidePairedPromotion(Array(100).fill(0), Array(100).fill(0), {
      threshold: -0.05,
    })
    expect(decision.binaryScale).toBeNull()
    expect(decision.statistic).toBe('mean_bootstrap')
    expect(decision.indeterminate).toBe(true)
    expect(decision.promote).toBe(false)
  })

  it('refuses invalid declared scales even without observations', () => {
    for (const binaryScale of [0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => decidePairedPromotion([], [], { binaryScale })).toThrow(
        /binaryScale must be finite and positive/,
      )
    }
  })

  it('refuses observations outside the declared support on either arm', () => {
    for (const [before, after] of [
      [[0.5], [0]],
      [[0], [0.5]],
      [[100], [0]],
      [[0], [Number.NaN]],
      [[Number.POSITIVE_INFINITY], [0]],
    ]) {
      expect(() => decidePairedPromotion(before!, after!, { binaryScale: 1 })).toThrow(
        /must be 0 or binaryScale \(1\)/,
      )
    }
  })

  it('refuses a declared binary mean when the requested statistic is the median', () => {
    expect(() => decidePairedPromotion([], [], { binaryScale: 1, statistic: 'median' })).toThrow(
      /binaryScale.*mean.*median/,
    )
  })

  it.each([1, 100])(
    'keeps empty declared binary samples insufficient on scale %i',
    (binaryScale) => {
      const decision = decidePairedPromotion([], [], { binaryScale, threshold: -binaryScale })
      expect(decision).toMatchObject({
        n: 0,
        binaryScale,
        statistic: 'paired_risk_difference',
        low: -binaryScale,
        high: binaryScale,
        sufficient: false,
        promote: false,
      })
      expect(decision.tieFraction).toBeNull()
    },
  )

  it('reports declared binary shape consistently before interval computation', () => {
    for (const n of [0, 100]) {
      const arm = Array(n).fill(0)
      const decision = decidePairedPromotion(arm, arm, { binaryScale: 100 })
      expect(pairedDecisionShape(arm, arm, 'mean', 100)).toEqual({
        statistic: decision.statistic,
        binaryScale: decision.binaryScale,
        tieFraction: decision.tieFraction,
      })
    }
  })
})

describe('decidePairedPromotion sufficiency', () => {
  it('raises a requested minimum that is below the exact one, and reports the effective value', () => {
    const exact = minimumPairsForPairedDeltaTest(0.95)
    expect(exact).toBe(6)

    const raised = decidePairedPromotion(binaryBaseline, binaryCandidate, { minPairs: 2 })
    expect(raised.minimumPairs).toBe(exact)
    expect(raised.sufficient).toBe(true)

    const stricter = decidePairedPromotion(binaryBaseline, binaryCandidate, { minPairs: 40 })
    expect(stricter.minimumPairs).toBe(40)
    expect(stricter.sufficient).toBe(false)
    // The interval still clears; the pair count is what refuses.
    expect(stricter.clearsThreshold).toBe(true)
    expect(stricter.promote).toBe(false)
  })

  it('raises the exact minimum with the confidence level', () => {
    const decision = decidePairedPromotion(binaryBaseline, binaryCandidate, { confidence: 0.99 })

    expect(decision.minimumPairs).toBe(minimumPairsForPairedDeltaTest(0.99))
    expect(decision.minimumPairs).toBe(8)
    expect(decision.confidence).toBe(0.99)
  })

  it('refuses a five-pair sweep even when every pair went the candidate way', () => {
    const decision = decidePairedPromotion([0, 0, 0, 0, 0], [1, 1, 1, 1, 1])

    expect(decision.n).toBe(5)
    expect(decision.sufficient).toBe(false)
    expect(decision.promote).toBe(false)
  })

  it('uses the actual binary minimum instead of a universal bootstrap floor', () => {
    const decision = decidePairedPromotion(Array(6).fill(0), Array(6).fill(1))
    expect(decision.minimumPairs).toBe(6)
    expect(decision.method).toBe('score-interval')
    expect(decision.sufficient).toBe(true)
    expect(decision.promote).toBe(true)
  })

  it('does not use a sign-probability result to certify a continuous mean', () => {
    const before = Array(6).fill(0.1)
    const after = [0.3, 0.35, 0.4, 0.45, 0.5, 0.55]
    const mean = decidePairedPromotion(before, after, { minPairs: 1 })
    expect(mean.pValue).toBeLessThan(0.05)
    expect(mean.minimumPairs).toBe(20)
    expect(mean.sufficient).toBe(false)
    expect(mean.promote).toBe(false)
    expect(mean.methodDetail).toContain('does not establish a mean effect')

    const median = decidePairedPromotion(before, after, { statistic: 'median' })
    expect(median.minimumPairs).toBe(6)
    expect(median.method).toBe('exact-sign')
    expect(median.sufficient).toBe(true)
    expect(median.promote).toBe(true)
  })
})

describe('decidePairedPromotion zero-width refusal', () => {
  it('refuses an all-tie comparison instead of clearing a noninferiority margin', () => {
    const arm = [0.4, 0.5, 0.6, 0.7, 0.8, 0.9]
    const decision = decidePairedPromotion(arm, [...arm], { threshold: -0.05 })

    expect(decision.low).toBe(0)
    expect(decision.high).toBe(0)
    // low > threshold holds at -0.05, which is exactly the laundering the
    // zero-width guard exists to stop.
    expect(decision.indeterminate).toBe(true)
    expect(decision.indeterminateCause).toBe('every paired delta is an exact tie')
    expect(decision.promote).toBe(false)
  })

  it('refuses identical positive deltas, which clear every threshold below them on no spread', () => {
    const baseline = Array.from({ length: 24 }, (_, i) => i + 1)
    const candidate = baseline.map((v) => v + 2)
    const decision = decidePairedPromotion(baseline, candidate, { seed: 3 })

    expect(decision.delta).toBe(2)
    expect(decision.low).toBe(2)
    expect(decision.high).toBe(2)
    expect(decision.indeterminate).toBe(true)
    expect(decision.indeterminateCause).toBe('the mean CI collapsed to a point at 2.0000')
    expect(decision.clearsThreshold).toBe(false)
    expect(decision.promote).toBe(false)
  })

  it('does not count rounding differences as observed variation at any score scale', () => {
    for (const scale of [1e-12, 1, 1e12]) {
      const before = Array.from({ length: 24 }, (_, i) => [0.5, 0.6, 0.4][i % 3]! * scale)
      const after = Array.from({ length: 24 }, (_, i) => [0.8, 0.9, 0.7][i % 3]! * scale)
      const decision = decidePairedPromotion(before, after, { seed: 1337 })
      expect(decision.sufficient).toBe(true)
      expect(decision.indeterminate).toBe(true)
      expect(decision.promote).toBe(false)
    }
  })

  it('retains real variation when scores use tiny units', () => {
    for (const scale of [1e-12, 1, 1e12]) {
      const decision = decidePairedPromotion(
        continuousBaseline.map((value) => value * scale),
        continuousCandidate.map((value) => value * scale),
        { seed: 11 },
      )
      expect(decision.indeterminate).toBe(false)
      expect(decision.promote).toBe(true)
    }
  })

  it('refuses a fully concordant binary comparison on the exact test, not on the interval', () => {
    const arm = [1, 0, 1, 0, 1, 0]
    const decision = decidePairedPromotion(arm, [...arm])

    expect(decision.mcnemar).toEqual({ b: 0, c: 0, nDiscordant: 0, pValue: 1 })
    // The score interval on zero discordant pairs is wide, not degenerate, so
    // the zero-width guard does not fire here and the veto is what refuses.
    expect(decision.indeterminate).toBe(false)
    expect(decision.low).toBeLessThan(0)
    expect(decision.high).toBeGreaterThan(0)
    expect(decision.exactTestVetoes).toBe(true)
    expect(decision.promote).toBe(false)
  })
})

describe('decidePairedPromotion McNemar veto', () => {
  it('vetoes the n=6, b=5, c=0 witness the exact test cannot reach alpha on', () => {
    const decision = decidePairedPromotion([0, 0, 0, 0, 0, 1], [1, 1, 1, 1, 1, 1])

    expect(decision.mcnemar).toEqual({ b: 5, c: 0, nDiscordant: 5, pValue: 0.0625 })
    expect(decision.sufficient).toBe(true)
    expect(decision.indeterminate).toBe(false)
    // The score interval clears; the exact test refuses, and the refusal wins.
    expect(decision.clearsThreshold).toBe(true)
    expect(decision.exactTestVetoes).toBe(true)
    expect(decision.promote).toBe(false)
  })

  it('does not veto at a negative threshold, which asks a different question', () => {
    const decision = decidePairedPromotion([0, 0, 0, 0, 0, 1], [1, 1, 1, 1, 1, 1], {
      threshold: -0.2,
    })

    expect(decision.mcnemar?.pValue).toBe(0.0625)
    expect(decision.exactTestVetoes).toBe(false)
    expect(decision.promote).toBe(true)
  })

  it('does not veto when the exact test reaches alpha', () => {
    const decision = decidePairedPromotion(binaryBaseline, binaryCandidate)

    expect(decision.mcnemar?.pValue).toBeLessThan(0.05)
    expect(decision.exactTestVetoes).toBe(false)
    expect(decision.promote).toBe(true)
  })
})

describe('decidePairedPromotion threshold boundary', () => {
  it('refuses a lower bound that sits exactly on the threshold', () => {
    const open = decidePairedPromotion(binaryBaseline, binaryCandidate)
    expect(open.clearsThreshold).toBe(true)

    const onTheLine = decidePairedPromotion(binaryBaseline, binaryCandidate, {
      threshold: open.low,
    })
    expect(onTheLine.low).toBe(open.low)
    // Strictly greater than, so a bound that only touches the threshold is not
    // evidence the threshold was cleared.
    expect(onTheLine.clearsThreshold).toBe(false)
    expect(onTheLine.promote).toBe(false)
  })

  it('refuses the same boundary on the continuous path', () => {
    const open = decidePairedPromotion(continuousBaseline, continuousCandidate, { seed: 11 })
    const onTheLine = decidePairedPromotion(continuousBaseline, continuousCandidate, {
      seed: 11,
      threshold: open.low,
    })

    expect(open.promote).toBe(true)
    expect(onTheLine.clearsThreshold).toBe(false)
    expect(onTheLine.promote).toBe(false)
  })
})

describe('decidePairedPromotion refuses a candidate that is not better', () => {
  it('refuses a binary candidate that lost ten pairs', () => {
    const decision = decidePairedPromotion(binaryCandidate, binaryBaseline)

    expect(decision.delta).toBeLessThan(0)
    expect(decision.high).toBeLessThan(0)
    expect(decision.clearsThreshold).toBe(false)
    expect(decision.promote).toBe(false)
  })

  it('refuses a continuous candidate that clears zero but not the asked-for margin', () => {
    const decision = decidePairedPromotion(continuousBaseline, continuousCandidate, {
      seed: 11,
      threshold: 0.5,
    })

    expect(decision.delta).toBeGreaterThan(0)
    expect(decision.clearsThreshold).toBe(false)
    expect(decision.promote).toBe(false)
  })
})
