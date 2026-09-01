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
