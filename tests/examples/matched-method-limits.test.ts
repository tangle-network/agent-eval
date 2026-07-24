import { describe, expect, it } from 'vitest'
import { assertMatchedMethodLimits } from '../../examples/_shared/matched-method-limits'

describe('assertMatchedMethodLimits', () => {
  it('accepts equal limits for compared methods', () => {
    expect(() =>
      assertMatchedMethodLimits(['gepa', 'skillopt'], { gepa: 33, skillopt: 33 }, 'evaluations'),
    ).not.toThrow()
  })

  it('accepts one selected method without comparing unused limits', () => {
    expect(() =>
      assertMatchedMethodLimits(['gepa'], { gepa: 33, skillopt: 12 }, 'evaluations'),
    ).not.toThrow()
  })

  it('rejects unequal compared limits with the exact allocation', () => {
    expect(() =>
      assertMatchedMethodLimits(['gepa', 'skillopt'], { gepa: 40, skillopt: 13 }, 'evaluations'),
    ).toThrow('evaluations must match when comparing methods; received gepa=40, skillopt=13')
  })

  it('rejects a missing selected-method limit', () => {
    expect(() => assertMatchedMethodLimits(['gepa'], {}, 'evaluations')).toThrow(
      'evaluations is missing a positive safe integer for gepa',
    )
  })
})
