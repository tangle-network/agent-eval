import { describe, expect, it } from 'vitest'
import {
  errorStreakDetector,
  noProgressDetector,
  observeAll,
  repeatedActionDetector,
} from './index'

describe('repeatedActionDetector', () => {
  it('signals once the same action fingerprint repeats maxRepeated consecutive steps', () => {
    const d = repeatedActionDetector({ maxRepeated: 3 })
    expect(d.observe({ actionFingerprint: 'a' })).toBeNull() // streak 1
    expect(d.observe({ actionFingerprint: 'a' })).toBeNull() // streak 2
    const sig = d.observe({ actionFingerprint: 'a' }) // streak 3 → trip
    expect(sig).toMatchObject({
      detector: 'repeated-action',
      streak: 3,
      failureClass: 'tool_recovery_failure',
      reason: 'stuck: repeated same action for 3 step(s)',
    })
  })

  it('resets the streak when the action changes', () => {
    const d = repeatedActionDetector({ maxRepeated: 2 })
    d.observe({ actionFingerprint: 'a' })
    expect(d.observe({ actionFingerprint: 'b' })).toBeNull() // streak back to 1
    expect(d.streak).toBe(1)
    expect(d.observe({ actionFingerprint: 'b' })).not.toBeNull() // streak 2 → trip
  })

  it('maxRepeated <= 0 disables the signal but still tracks streak', () => {
    const d = repeatedActionDetector({ maxRepeated: 0 })
    d.observe({ actionFingerprint: 'a' })
    expect(d.observe({ actionFingerprint: 'a' })).toBeNull()
    expect(d.streak).toBe(2)
  })

  it('reset clears state', () => {
    const d = repeatedActionDetector({ maxRepeated: 2 })
    d.observe({ actionFingerprint: 'a' })
    d.reset()
    expect(d.streak).toBe(0)
    expect(d.observe({ actionFingerprint: 'a' })).toBeNull() // streak 1 again
  })
})

describe('noProgressDetector', () => {
  it('signals when state + score are unchanged for maxNoProgress steps', () => {
    const d = noProgressDetector({ maxNoProgress: 2 })
    expect(d.observe({ stateFingerprint: 's0', score: 0 })).toBeNull() // baseline
    expect(d.observe({ stateFingerprint: 's0', score: 0 })).toBeNull() // streak 1
    const sig = d.observe({ stateFingerprint: 's0', score: 0 }) // streak 2 → trip
    expect(sig).toMatchObject({
      detector: 'no-progress',
      streak: 2,
      reason: 'stuck: no state/score progress for 2 step(s)',
    })
  })

  it('a state change OR score movement resets the streak', () => {
    const d = noProgressDetector({ maxNoProgress: 2, minScoreDelta: 0.001 })
    d.observe({ stateFingerprint: 's0', score: 0 })
    d.observe({ stateFingerprint: 's0', score: 0 }) // streak 1
    expect(d.observe({ stateFingerprint: 's1', score: 0 })).toBeNull() // state moved → 0
    expect(d.streak).toBe(0)
    d.observe({ stateFingerprint: 's1', score: 0 }) // streak 1
    expect(d.observe({ stateFingerprint: 's1', score: 1 })).toBeNull() // score moved → 0
    expect(d.streak).toBe(0)
  })
})

describe('errorStreakDetector', () => {
  it('signals on consecutive errors and resets on an ok step', () => {
    const d = errorStreakDetector({ maxErrors: 2 })
    expect(d.observe({ status: 'error' })).toBeNull() // streak 1
    expect(d.observe({ status: 'error' })).toMatchObject({
      detector: 'error-streak',
      streak: 2,
      reason: 'stuck: 2 consecutive errored step(s)',
    })
    expect(d.observe({ status: 'ok' })).toBeNull()
    expect(d.streak).toBe(0)
  })
})

describe('observeAll', () => {
  it('folds one event through a panel and collects every signal that fires', () => {
    const panel = [
      repeatedActionDetector({ maxRepeated: 1 }),
      errorStreakDetector({ maxErrors: 1 }),
    ]
    const signals = observeAll(panel, { actionFingerprint: 'a', status: 'error' })
    expect(signals.map((s) => s.detector).sort()).toEqual(['error-streak', 'repeated-action'])
  })
})
