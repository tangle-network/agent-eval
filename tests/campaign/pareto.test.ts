import { describe, expect, it } from 'vitest'
import { dominates, objectiveKeys, paretoFrontier } from '../../src/campaign/pareto'

describe('dominates', () => {
  const keys = ['s1', 's2']
  it('a dominates b when >= on all and > on one', () => {
    expect(dominates({ s1: 0.8, s2: 0.6 }, { s1: 0.7, s2: 0.6 }, keys)).toBe(true)
  })
  it('no domination when worse on any objective (the trade-off case)', () => {
    expect(dominates({ s1: 0.9, s2: 0.4 }, { s1: 0.6, s2: 0.8 }, keys)).toBe(false)
    expect(dominates({ s1: 0.6, s2: 0.8 }, { s1: 0.9, s2: 0.4 }, keys)).toBe(false)
  })
  it('identical vectors do not dominate each other', () => {
    expect(dominates({ s1: 0.5, s2: 0.5 }, { s1: 0.5, s2: 0.5 }, keys)).toBe(false)
  })
  it('a missing objective is treated as worst (−∞), cannot dominate on it', () => {
    // a is better on s1 but missing s2 → a is −∞ on s2 < b's 0.5 → not >= on all → no dominate.
    expect(dominates({ s1: 0.9 }, { s1: 0.7, s2: 0.5 }, keys)).toBe(false)
  })
})

describe('paretoFrontier', () => {
  interface Cand {
    id: string
    composite: number
    scenarios: Record<string, number>
  }
  const vec = (c: Cand) => c.scenarios

  it('THE regression: a composite-worse candidate that is uniquely best on one scenario SURVIVES', () => {
    // `specialist` has a LOWER composite than `generalist`, but it is the only
    // candidate that cracks s3. A composite-only sort().slice(1) would discard
    // it; the Pareto frontier keeps it so its lesson can be combined.
    const generalist: Cand = {
      id: 'generalist',
      composite: 0.7,
      scenarios: { s1: 0.8, s2: 0.8, s3: 0.5 },
    }
    const specialist: Cand = {
      id: 'specialist',
      composite: 0.6,
      scenarios: { s1: 0.5, s2: 0.4, s3: 0.9 },
    }
    const frontier = paretoFrontier([generalist, specialist], vec)
    expect(frontier.map((c) => c.id).sort()).toEqual(['generalist', 'specialist'])
  })

  it('drops a candidate dominated on every scenario', () => {
    const strong: Cand = { id: 'strong', composite: 0.8, scenarios: { s1: 0.8, s2: 0.8 } }
    const weak: Cand = { id: 'weak', composite: 0.5, scenarios: { s1: 0.5, s2: 0.5 } }
    const frontier = paretoFrontier([strong, weak], vec)
    expect(frontier.map((c) => c.id)).toEqual(['strong'])
  })

  it('preserves input order among non-dominated members', () => {
    const a: Cand = { id: 'a', composite: 0.7, scenarios: { s1: 0.9, s2: 0.3 } }
    const b: Cand = { id: 'b', composite: 0.7, scenarios: { s1: 0.3, s2: 0.9 } }
    const c: Cand = { id: 'c', composite: 0.6, scenarios: { s1: 0.6, s2: 0.6 } }
    // a and b are mutually non-dominated; c is dominated by neither (0.6/0.6 vs
    // a's 0.9/0.3 — a is not >= on s2; vs b similarly) → all three survive, in order.
    expect(paretoFrontier([a, b, c], vec).map((x) => x.id)).toEqual(['a', 'b', 'c'])
  })

  it('handles 0/1 items', () => {
    expect(paretoFrontier([], vec)).toEqual([])
    const solo: Cand = { id: 'solo', composite: 0.5, scenarios: { s1: 0.5 } }
    expect(paretoFrontier([solo], vec)).toEqual([solo])
  })
})

describe('objectiveKeys', () => {
  it('unions keys across vectors in first-seen order', () => {
    expect(
      objectiveKeys([
        { s2: 1, s1: 1 },
        { s3: 1, s1: 1 },
      ]),
    ).toEqual(['s2', 's1', 's3'])
  })
})
