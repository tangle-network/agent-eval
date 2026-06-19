import { describe, expect, it } from 'vitest'
import { errorStreakDetector, noProgressDetector } from './index'

describe('errorStreakDetector edge cases', () => {
  it('is inert when status is undefined (does not advance or reset the streak)', () => {
    const d = errorStreakDetector({ maxErrors: 2 })
    expect(d.observe({ status: 'error' })).toBeNull() // streak 1
    // a step with no status field must NOT touch the streak
    expect(d.observe({})).toBeNull()
    expect(d.streak).toBe(1)
    // the next real error completes the streak across the inert step
    expect(d.observe({ status: 'error' })).toMatchObject({ detector: 'error-streak', streak: 2 })
  })

  it('maxErrors <= 0 disables signalling without crashing', () => {
    const d = errorStreakDetector({ maxErrors: 0 })
    for (let i = 0; i < 5; i++) {
      expect(d.observe({ status: 'error' })).toBeNull()
    }
    // streak still tracked for telemetry even though no signal fires
    expect(d.streak).toBe(5)
  })

  it('negative maxErrors also disables without crashing', () => {
    const d = errorStreakDetector({ maxErrors: -3 })
    expect(d.observe({ status: 'error' })).toBeNull()
    expect(d.observe({ status: 'error' })).toBeNull()
    expect(d.streak).toBe(2)
  })
})

describe('noProgressDetector edge cases', () => {
  it('does not trip on step 1 without a primed baseline', () => {
    // maxNoProgress 1 is the most aggressive setting; even so the FIRST observed
    // step has no prior state to compare against, so stateUnchanged is false and
    // the streak stays at 0 -> no signal.
    const d = noProgressDetector({ maxNoProgress: 1 })
    expect(d.observe({ stateFingerprint: 's0', score: 0 })).toBeNull()
    expect(d.streak).toBe(0)
    // the SECOND identical step now has a baseline -> trips at streak 1
    expect(d.observe({ stateFingerprint: 's0', score: 0 })).toMatchObject({
      detector: 'no-progress',
      streak: 1,
    })
  })

  it('maxNoProgress <= 0 disables signalling without crashing', () => {
    const d = noProgressDetector({ maxNoProgress: 0 })
    d.observe({ stateFingerprint: 's0', score: 0 }) // baseline
    for (let i = 0; i < 5; i++) {
      expect(d.observe({ stateFingerprint: 's0', score: 0 })).toBeNull()
    }
    expect(d.streak).toBe(5)
  })
})
