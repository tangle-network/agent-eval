import { describe, expect, it } from 'vitest'
import { twoSampleEvidence, welch } from './two-sample'

const arm = (n: number, mean: number, stddev: number, spread = 2) => ({
  n,
  mean,
  stddev,
  ci95Low: mean - spread,
  ci95High: mean + spread,
})

describe('welch', () => {
  it('returns nulls for spread-less or single-sample arms', () => {
    expect(welch(arm(1, 100, 0), arm(3, 120, 5)).t).toBeNull()
    expect(welch(arm(3, 100, 0), arm(3, 120, 0)).t).toBeNull()
  })
})

describe('twoSampleEvidence', () => {
  it('keeps the null on overlapping windows and rejects on separated ones', () => {
    const overlap = twoSampleEvidence(arm(3, 100, 20, 25), arm(3, 130, 20, 25))
    expect(overlap.ciDisjoint).toBe(false)
    expect(overlap.significant).toBe(false)
    const separated = twoSampleEvidence(arm(3, 100, 5, 4), arm(3, 200, 5, 4))
    expect(separated.significant).toBe(true)
    expect(separated.pValue!).toBeLessThan(0.05)
  })

  it('disjoint CIs alone carry significance when welch is unestimable', () => {
    const evidence = twoSampleEvidence(
      { n: 2, mean: 100, stddev: 0.0, ci95Low: 99, ci95High: 101 },
      { n: 2, mean: 300, stddev: 0.0, ci95Low: 299, ci95High: 301 },
    )
    expect(evidence.t).toBeNull()
    expect(evidence.ciDisjoint).toBe(true)
    expect(evidence.significant).toBe(true)
  })
})
