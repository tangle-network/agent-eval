/**
 * Wire-schema regression tests.
 *
 * These tests defend against silent schema drift. If you change a
 * Zod schema in src/wire/schemas.ts, expect to also update or add a
 * test here. The schemas are the cross-language contract — drift is
 * a breaking change, not a bug fix.
 */
import { describe, expect, it } from 'vitest'

import {
  hashRubric,
  JudgeRequestSchema,
  RubricDimensionSchema,
  RubricSchema,
  WIRE_VERSION,
} from '../../src/wire/schemas'

describe('RubricDimensionSchema', () => {
  it('defaults weight=1, min=0, max=1 when omitted', () => {
    const parsed = RubricDimensionSchema.parse({ id: 'x', description: 'y' })
    expect(parsed).toEqual({ id: 'x', description: 'y', weight: 1, min: 0, max: 1 })
  })

  it('rejects empty id (regression: empty id breaks dimension lookup)', () => {
    expect(() => RubricDimensionSchema.parse({ id: '', description: 'y' })).toThrow()
  })

  it('rejects negative weight (regression: negative weights flip score sign)', () => {
    expect(() =>
      RubricDimensionSchema.parse({ id: 'x', description: 'y', weight: -1 }),
    ).toThrow()
  })
})

describe('RubricSchema', () => {
  it('requires at least one dimension (regression: zero-dim rubric divides by zero in composite)', () => {
    expect(() =>
      RubricSchema.parse({
        name: 'r',
        description: 'd',
        systemPrompt: 'p',
        dimensions: [],
      }),
    ).toThrow()
  })

  it('defaults failureModes and wins to empty arrays', () => {
    const parsed = RubricSchema.parse({
      name: 'r',
      description: 'd',
      systemPrompt: 'p',
      dimensions: [{ id: 'a', description: 'b' }],
    })
    expect(parsed.failureModes).toEqual([])
    expect(parsed.wins).toEqual([])
  })
})

describe('JudgeRequestSchema', () => {
  const minimalRubric = {
    name: 'r',
    description: 'd',
    systemPrompt: 'p',
    dimensions: [{ id: 'a', description: 'b' }],
  }

  it('accepts rubricName alone', () => {
    expect(() =>
      JudgeRequestSchema.parse({ rubricName: 'anti-slop', content: 'hello' }),
    ).not.toThrow()
  })

  it('accepts inline rubric alone', () => {
    expect(() =>
      JudgeRequestSchema.parse({ rubric: minimalRubric, content: 'hello' }),
    ).not.toThrow()
  })

  it('rejects both rubricName and rubric (regression: ambiguous selection)', () => {
    expect(() =>
      JudgeRequestSchema.parse({
        rubricName: 'anti-slop',
        rubric: minimalRubric,
        content: 'hello',
      }),
    ).toThrow()
  })

  it('rejects neither rubricName nor rubric (regression: cannot dispatch)', () => {
    expect(() => JudgeRequestSchema.parse({ content: 'hello' })).toThrow()
  })

  it('rejects empty content (regression: empty content slips past judge as a high score)', () => {
    expect(() => JudgeRequestSchema.parse({ rubricName: 'anti-slop', content: '' })).toThrow()
  })
})

describe('hashRubric', () => {
  const r = {
    name: 'r',
    description: 'd',
    systemPrompt: 'p',
    dimensions: [{ id: 'a', description: 'b', weight: 1, min: 0, max: 1 }],
    failureModes: [],
    wins: [],
  }

  it('is stable across calls', () => {
    expect(hashRubric(r)).toEqual(hashRubric(r))
  })

  it('changes when the rubric changes (regression: drift undetected, scores not comparable)', () => {
    const r2 = { ...r, systemPrompt: 'p2' }
    expect(hashRubric(r)).not.toEqual(hashRubric(r2))
  })

  it('starts with the rubric name for human-readability', () => {
    expect(hashRubric(r).startsWith('r@')).toBe(true)
  })
})

describe('WIRE_VERSION', () => {
  it('is a semver-ish string (regression: empty version means clients silently mismatch)', () => {
    expect(WIRE_VERSION).toMatch(/^\d+\.\d+\.\d+/)
  })
})
