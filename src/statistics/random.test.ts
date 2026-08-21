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

  /**
   * Known-answer vectors for the mulberry32 stream. Every seeded draw this
   * package reports — bootstrap intervals, e-process shuffles, tournament
   * parent selection, the replay fix-case sample, the judge-calibration
   * bootstrap — resolves to this stream, so changing it silently changes an
   * already-published statistic. Pin it, do not regenerate it.
   */
  it('emits the pinned mulberry32 stream', () => {
    const one = mulberry32(1)
    expect([one(), one(), one(), one(), one()]).toEqual([
      0.6270739405881613, 0.002735721180215478, 0.5274470399599522, 0.9810509674716741,
      0.9683778982143849,
    ])
    const fortyTwo = mulberry32(42)
    expect([fortyTwo(), fortyTwo(), fortyTwo(), fortyTwo(), fortyTwo()]).toEqual([
      0.6011037519201636, 0.44829055899754167, 0.8524657934904099, 0.6697340414393693,
      0.17481389874592423,
    ])
  })

  it('reads a negative and an out-of-int32-range seed as the same 32 bits', () => {
    // The copies this owner replaced used `seed >>> 0` where it uses `seed | 0`.
    // Both keep the same 32 bits, so the streams are identical.
    const negative = mulberry32(-1)
    const unsigned = mulberry32(4294967295)
    expect([negative(), negative(), negative()]).toEqual([unsigned(), unsigned(), unsigned()])
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
