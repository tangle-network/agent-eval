import { describe, it, expect } from 'vitest'
import {
  matchGoldens,
  weightedRecall,
  goldenPrecision,
  DEFAULT_SEVERITY_WEIGHTS,
} from '../src/index'
import type { GoldenSpec } from '../src/index'

const goldens: GoldenSpec[] = [
  { id: 'a', severity: 'critical', any: ['primary action', 'no clear primary'], hint: '' },
  { id: 'b', severity: 'major', any: ['equal weight'], hint: '' },
  { id: 'c', severity: 'minor', any: ['next step'], hint: '' },
]

describe('matchGoldens', () => {
  it('matches against a string-only candidate list', () => {
    const r = matchGoldens(goldens, ['No clear PRIMARY ACTION on welcome screen'])
    expect(r.matches).toEqual([true, false, false])
    expect(r.hits).toBe(1)
    expect(r.total).toBe(3)
  })

  it('default extract concatenates string fields', () => {
    const r = matchGoldens(goldens, [{ description: 'buttons compete', location: 'equal weight grid' }])
    expect(r.matches).toEqual([false, true, false])
  })

  it('honours custom text() extractor', () => {
    const r = matchGoldens(goldens, [{ x: 'PRIMARY ACTION missing' }], { text: (c) => c.x })
    expect(r.matches[0]).toBe(true)
  })

  it('handles regex via anyRegex', () => {
    const re: GoldenSpec[] = [{ id: 'r', severity: 'major', any: [], anyRegex: ['no\\s+primary'], hint: '' }]
    const r = matchGoldens(re, ['there is no    primary CTA'])
    expect(r.matches).toEqual([true])
  })

  it('returns all-false on empty candidates', () => {
    expect(matchGoldens(goldens, []).matches).toEqual([false, false, false])
  })

  it('skips invalid regex without crashing', () => {
    const bad: GoldenSpec[] = [{ id: 'b', severity: 'minor', any: [], anyRegex: ['['], hint: '' }]
    expect(() => matchGoldens(bad, ['anything'])).not.toThrow()
    expect(matchGoldens(bad, ['anything']).matches).toEqual([false])
  })
})

describe('weightedRecall', () => {
  it('weights critical 3x, major 2x, minor 1x', () => {
    // total weight = 3 + 2 + 1 = 6
    expect(weightedRecall(goldens, { matches: [true, false, false], hits: 1, total: 3 })).toBeCloseTo(3 / 6)
    expect(weightedRecall(goldens, { matches: [false, true, false], hits: 1, total: 3 })).toBeCloseTo(2 / 6)
    expect(weightedRecall(goldens, { matches: [true, true, true], hits: 3, total: 3 })).toBe(1)
    expect(weightedRecall(goldens, { matches: [false, false, false], hits: 0, total: 3 })).toBe(0)
  })

  it('returns 1 when no goldens (vacuous)', () => {
    expect(weightedRecall([], { matches: [], hits: 0, total: 0 })).toBe(1)
  })

  it('respects custom weights', () => {
    const custom = { ...DEFAULT_SEVERITY_WEIGHTS, critical: 10 }
    // weight = 10 + 2 + 1 = 13; hit critical only → 10/13
    expect(weightedRecall(goldens, { matches: [true, false, false], hits: 1, total: 3 }, custom)).toBeCloseTo(10 / 13)
  })
})

describe('goldenPrecision', () => {
  it('returns 1 when no candidates', () => {
    expect(goldenPrecision(goldens, [])).toBe(1)
  })

  it('counts the share that match a golden phrase', () => {
    const cands = [
      'Primary action unclear',
      'Some unrelated polish nit',
      'No clear primary visible',
    ]
    expect(goldenPrecision(goldens, cands)).toBeCloseTo(2 / 3)
  })

  it('honours regex goldens for precision too', () => {
    const re: GoldenSpec[] = [{ id: 'r', severity: 'major', any: [], anyRegex: ['p[a-z]+y action'], hint: '' }]
    expect(goldenPrecision(re, ['primary action found', 'noise'])).toBeCloseTo(1 / 2)
  })
})
