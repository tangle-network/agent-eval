import { describe, expect, it } from 'vitest'
import { confidenceInterval, mulberry32, pairedBootstrap } from './index'

describe('seeding is deterministic, including seed 0', () => {
  it('mulberry32(0) is its own stream, not the golden-ratio constant', () => {
    const zero = mulberry32(0)
    const golden = mulberry32(0x9e3779b9 | 0)
    const zeroDraws = [zero(), zero(), zero()]
    const goldenDraws = [golden(), golden(), golden()]
    expect(zeroDraws).not.toEqual(goldenDraws)
  })

  it('mulberry32(0) is reproducible across constructions', () => {
    const a = mulberry32(0)
    const b = mulberry32(0)
    expect([a(), a(), a()]).toEqual([b(), b(), b()])
  })

  it('mulberry32 rejects a non-finite seed', () => {
    expect(() => mulberry32(Number.NaN)).toThrow(/finite/)
  })

  it('an unseeded bootstrap is reproducible on identical input', () => {
    const scores = [0.3, 0.4, 0.5, 0.55, 0.6, 0.65, 0.7]
    const first = confidenceInterval(scores)
    const second = confidenceInterval(scores)
    expect(first).toEqual(second)
  })

  it('an unseeded paired bootstrap is reproducible on identical input', () => {
    const before = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6]
    const after = [0.2, 0.25, 0.45, 0.5, 0.62, 0.68]
    expect(pairedBootstrap(before, after)).toEqual(pairedBootstrap(before, after))
  })

  it('different data still gets a different stream', () => {
    const a = pairedBootstrap([0, 0, 0, 0, 0, 0], [1, 2, 3, 4, 5, 6])
    const b = pairedBootstrap([0, 0, 0, 0, 0, 0], [1, 2, 3, 4, 5, 7])
    expect(a.high).not.toBe(b.high)
  })
})
