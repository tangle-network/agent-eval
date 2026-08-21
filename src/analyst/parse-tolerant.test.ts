import { describe, expect, it } from 'vitest'
import { coerceJson, stripCodeFences } from './parse-tolerant'

describe('parse-tolerant — recover schema-correct content from unusable wrappers', () => {
  it('strips ```json fences (the arXiv:2605.02363 GPT-4o failure mode)', () => {
    expect(stripCodeFences('```json\n[{"a":1}]\n```')).toBe('[{"a":1}]')
    expect(stripCodeFences('```\nplain\n```')).toBe('plain')
    expect(stripCodeFences('no fence here')).toBe('no fence here')
  })

  it('coerceJson de-fences + drops trailing commas before parsing', () => {
    expect(coerceJson('```json\n{"x":1,}\n```')).toEqual({ x: 1 })
    expect(coerceJson('[1, 2, 3,]')).toEqual([1, 2, 3])
    expect(coerceJson('not json at all')).toBeUndefined()
  })
})
