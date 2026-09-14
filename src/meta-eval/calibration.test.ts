import { describe, expect, it } from 'vitest'
import { type CalibrationPair, calibrationFromPairs } from './index'

describe('calibrationFromPairs', () => {
  it('separates calibrated controls from a confident wrong predictor without storage adapters', () => {
    const calibrated: readonly CalibrationPair[] = Object.freeze([
      Object.freeze({ evalScore: 0, outcome: 0 }),
      Object.freeze({ evalScore: 1, outcome: 1 }),
    ])
    expect(calibrationFromPairs(calibrated, 'confidence', 'success')).toMatchObject({
      n: 2,
      ece: 0,
      maxGap: 0,
    })
    const wrong = calibrationFromPairs(
      [
        { evalScore: 1, outcome: 0 },
        { evalScore: 1, outcome: 0 },
      ],
      'confidence',
      'success',
    )
    expect(wrong).toMatchObject({ n: 2, ece: 1, maxGap: 1 })
    expect(wrong?.bins).toEqual([{ lower: 1, upper: 1, n: 2, evalMean: 1, outcomeMean: 0, gap: 1 }])
  })

  it('clips explicitly without changing caller observations or their denominator', () => {
    const pairs = Object.freeze([
      Object.freeze({ evalScore: -1, outcome: 1 }),
      Object.freeze({ evalScore: 2, outcome: 0 }),
    ])
    const report = calibrationFromPairs(pairs, 'confidence', 'success', {
      bins: 2,
      range: { lo: 0, hi: 1 },
    })
    expect(report).toMatchObject({ n: 2, ece: 1 })
    expect(report?.bins.reduce((sum, bin) => sum + bin.n, 0)).toBe(2)
    expect(pairs.map((pair) => pair.evalScore)).toEqual([-1, 2])
  })

  it.each([
    { evalScore: Number.NaN, outcome: 1 },
    { evalScore: 1, outcome: Number.NaN },
    { evalScore: Number.POSITIVE_INFINITY, outcome: 1 },
    { evalScore: 1, outcome: Number.NEGATIVE_INFINITY },
  ])('refuses nonfinite observations rather than reducing n: %j', (invalid) => {
    expect(() =>
      calibrationFromPairs(
        [{ evalScore: 0, outcome: 0 }, invalid, { evalScore: 1, outcome: 1 }],
        'confidence',
        'success',
      ),
    ).toThrow(/calibration pair 1 must contain finite/)
  })

  it('validates pairs before treating a short input as insufficient evidence', () => {
    expect(() =>
      calibrationFromPairs([{ evalScore: Number.NaN, outcome: 1 }], 'confidence', 'success'),
    ).toThrow(/calibration pair 0/)
    expect(calibrationFromPairs([], 'confidence', 'success')).toBeNull()
    expect(calibrationFromPairs([{ evalScore: 0, outcome: 0 }], 'confidence', 'success')).toBeNull()
  })

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
    'validates bin count %s on direct input before returning null',
    (bins) => {
      expect(() => calibrationFromPairs([], 'confidence', 'success', { bins })).toThrow(
        /bins must be a positive safe integer/,
      )
    },
  )

  it.each([
    { lo: 1, hi: 0 },
    { lo: Number.NaN, hi: 1 },
    { lo: 0, hi: Number.POSITIVE_INFINITY },
    { lo: -Number.MAX_VALUE, hi: Number.MAX_VALUE },
  ])('validates range %j on direct input', (range) => {
    expect(() => calibrationFromPairs([], 'confidence', 'success', { range })).toThrow(
      /range must have finite ordered bounds/,
    )
  })

  it.each([
    ['', 'success'],
    ['confidence', ''],
    [' confidence', 'success'],
    ['confidence', 'success '],
  ])('requires exact nonempty metric identities: %j, %j', (evalMetric, outcomeMetric) => {
    expect(() => calibrationFromPairs([], evalMetric, outcomeMetric)).toThrow(/metric/)
  })
})
