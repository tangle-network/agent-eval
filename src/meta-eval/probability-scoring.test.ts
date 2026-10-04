import { describe, expect, it } from 'vitest'
import { brierScore, multiclassBrierScore, rankedProbabilityScore } from './index'

describe('multiclassBrierScore', () => {
  it('scores known controls: certain right, certain wrong, uniform', () => {
    expect(multiclassBrierScore([{ probabilities: { a: 1, b: 0, c: 0 }, outcome: 'a' }])).toBe(0)
    expect(multiclassBrierScore([{ probabilities: { a: 0, b: 1, c: 0 }, outcome: 'a' }])).toBe(2)
    expect(
      multiclassBrierScore([
        { probabilities: { a: 1 / 4, b: 1 / 4, c: 1 / 4, d: 1 / 4 }, outcome: 'c' },
      ]),
    ).toBeCloseTo(0.75, 12)
  })

  it('is twice the binary Brier score with two outcomes', () => {
    const p = 0.7
    expect(
      multiclassBrierScore([{ probabilities: { yes: p, no: 1 - p }, outcome: 'no' }]),
    ).toBeCloseTo(2 * brierScore([{ evalScore: p, outcome: 0 }]), 12)
  })

  it('refuses a distribution that does not sum to 1, a missing outcome, and an empty set', () => {
    expect(() =>
      multiclassBrierScore([{ probabilities: { a: 0.6, b: 0.39 }, outcome: 'a' }]),
    ).toThrow(/sum to/)
    expect(() =>
      multiclassBrierScore([{ probabilities: { a: 0.5, b: 0.5 }, outcome: 'c' }]),
    ).toThrow(/no probability for outcome/)
    expect(() => multiclassBrierScore([])).toThrow(/at least one/)
    expect(() =>
      multiclassBrierScore([
        { probabilities: [0.5, 0.5] as unknown as Record<string, number>, outcome: '0' },
      ]),
    ).toThrow(/object keyed by outcome/)
    const hidden: Record<string, number> = { a: 0.5, b: 0.5 }
    Object.defineProperty(hidden, 'c', { value: 0, enumerable: false })
    expect(() => multiclassBrierScore([{ probabilities: hidden, outcome: 'c' }])).toThrow(
      /no probability for outcome/,
    )
  })
})

describe('rankedProbabilityScore', () => {
  it('charges less for mass beside the outcome than for mass far from it', () => {
    const near = rankedProbabilityScore([{ probabilities: [0, 0, 1, 0, 0], outcome: 3 }])
    const far = rankedProbabilityScore([{ probabilities: [1, 0, 0, 0, 0], outcome: 3 }])
    expect(near).toBeCloseTo(1 / 4, 12)
    expect(far).toBeCloseTo(3 / 4, 12)
    expect(rankedProbabilityScore([{ probabilities: [0, 0, 0, 1, 0], outcome: 3 }])).toBe(0)
    expect(rankedProbabilityScore([{ probabilities: [0, 0, 0, 0, 1], outcome: 0 }])).toBe(1)
  })

  it('equals the binary Brier score with two levels', () => {
    expect(rankedProbabilityScore([{ probabilities: [0.3, 0.7], outcome: 0 }])).toBeCloseTo(
      brierScore([{ evalScore: 0.3, outcome: 1 }]),
      12,
    )
  })

  it('refuses an outcome outside the levels and an invalid distribution', () => {
    expect(() => rankedProbabilityScore([{ probabilities: [0.5, 0.5], outcome: 2 }])).toThrow(
      /outcome/,
    )
    expect(() => rankedProbabilityScore([{ probabilities: [1.2, -0.2], outcome: 0 }])).toThrow(
      /outside/,
    )
    expect(() => rankedProbabilityScore([{ probabilities: [1], outcome: 0 }])).toThrow(/two level/)
  })
})
