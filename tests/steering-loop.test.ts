import { describe, expect, it } from 'vitest'
import { mergeSteeringBundle, renderSteeringText } from '../src/steering'

describe('steering helpers', () => {
  it('merges steering bundle overrides without dropping existing reviewer prompts', () => {
    const merged = mergeSteeringBundle(
      {
        id: 'base',
        coderPrompt: 'stay grounded',
        reviewerPrompts: { safety: 'strict', quality: 'detailed' },
      },
      {
        continuePrompt: 'continue only if progress is real',
        reviewerPrompts: { quality: 'ruthless' },
      },
    )
    expect(merged.reviewerPrompts).toEqual({ safety: 'strict', quality: 'ruthless' })
    expect(merged.continuePrompt).toContain('progress')
  })

  it('renders steering text deterministically', () => {
    const text = renderSteeringText({
      id: 'x',
      coderPrompt: 'repo first',
      reviewerPrompts: { b: 'beta', a: 'alpha' },
      skills: ['verify', 'critical-audit'],
    })
    expect(text).toContain('bundle:x')
    expect(text.indexOf('reviewer:a:alpha')).toBeLessThan(text.indexOf('reviewer:b:beta'))
    expect(text).toContain('skills:critical-audit,verify')
  })
})
