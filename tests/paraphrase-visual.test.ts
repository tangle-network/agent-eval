import { describe, expect, it } from 'vitest'
import {
  DEFAULT_MUTATORS,
  lowercaseMutator,
  paraphraseRobustness,
  sentenceReorderMutator,
  typoMutator,
  whitespaceCollapseMutator,
} from '../src/paraphrase'
import { pixelDeltaRatio, visualDiff } from '../src/visual-diff'

describe('paraphrase mutators', () => {
  it('lowercase + whitespace-collapse are deterministic', () => {
    expect(lowercaseMutator('Hello WORLD', 0)).toBe('hello world')
    expect(whitespaceCollapseMutator('a  \n  b', 0)).toBe('a b')
  })

  it('typo produces different output from original but same length', () => {
    const input = 'The quick brown fox jumps over the lazy dog and then goes home to sleep'
    const out = typoMutator(input, 7)
    expect(out).not.toBe(input)
    expect(out.length).toBe(input.length)
  })

  it('sentence reorder preserves sentence set', () => {
    const input = 'First. Second. Third.'
    const out = sentenceReorderMutator(input, 11)
    expect(out.split(/\s+/).sort()).toEqual(input.split(/\s+/).sort())
  })
})

describe('paraphraseRobustness', () => {
  it('returns robustness≈1 when scorer is invariant across mutators', async () => {
    const r = await paraphraseRobustness('Do The Thing Right Now', DEFAULT_MUTATORS, async () => 0.7)
    expect(r.robustness).toBeCloseTo(1, 6)
    expect(r.variantScores).toHaveLength(DEFAULT_MUTATORS.length)
  })

  it('robustness < 1 when mutators shift the score — regression: brittle prompts must surface', async () => {
    const r = await paraphraseRobustness(
      'Do The Thing',
      [{ id: 'lower', fn: lowercaseMutator }],
      async (p) => (p === p.toLowerCase() ? 0.3 : 0.9),
    )
    expect(r.robustness).toBeLessThan(1)
  })
})

describe('visualDiff', () => {
  const makeImg = (w: number, h: number, fill: [number, number, number, number]): Uint8Array => {
    const data = new Uint8Array(w * h * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = fill[0]; data[i + 1] = fill[1]; data[i + 2] = fill[2]; data[i + 3] = fill[3]
    }
    return data
  }

  it('returns unchanged for identical images', () => {
    const img = makeImg(4, 4, [10, 20, 30, 255])
    const r = visualDiff({ width: 4, height: 4, data: img }, { width: 4, height: 4, data: img })
    expect(r.diffRatio).toBe(0)
    expect(r.status).toBe('unchanged')
  })

  it('flags severely-changed when >5% differ', () => {
    const a = makeImg(10, 10, [0, 0, 0, 255])
    const b = makeImg(10, 10, [255, 255, 255, 255])
    const r = visualDiff({ width: 10, height: 10, data: a }, { width: 10, height: 10, data: b })
    expect(r.diffRatio).toBe(1)
    expect(r.status).toBe('severely-changed')
  })

  it('tolerates within-threshold noise', () => {
    const a = makeImg(4, 4, [100, 100, 100, 255])
    const b = makeImg(4, 4, [105, 102, 100, 255]) // max delta 5 < tolerance 8
    const r = visualDiff({ width: 4, height: 4, data: a }, { width: 4, height: 4, data: b })
    expect(r.diffRatio).toBe(0)
  })

  it('throws on dim mismatch — regression: silent resize would mask regressions', () => {
    const a = new Uint8Array(4)
    const b = new Uint8Array(4)
    expect(() => visualDiff({ width: 1, height: 1, data: a }, { width: 2, height: 2, data: b })).toThrow(/dims differ/)
  })

  it('pixelDeltaRatio shortcut', () => {
    const a = new Uint8Array([0, 0, 0, 255, 0, 0, 0, 255])
    const b = new Uint8Array([255, 0, 0, 255, 0, 0, 0, 255])
    expect(pixelDeltaRatio(a, b, 2, 1)).toBe(0.5)
  })
})
