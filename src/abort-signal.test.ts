import { describe, expect, it } from 'vitest'
import { combineAbortSignals } from './abort-signal'

describe('combineAbortSignals', () => {
  it('preserves zero and one-source identity', () => {
    const controller = new AbortController()
    expect(combineAbortSignals()).toBeUndefined()
    expect(combineAbortSignals(controller.signal, controller.signal)).toBe(controller.signal)
  })

  it('aborts when either distinct source aborts', () => {
    const first = new AbortController()
    const second = new AbortController()
    const combined = combineAbortSignals(first.signal, second.signal)

    second.abort(new Error('cancelled'))

    expect(combined?.aborted).toBe(true)
    expect(combined?.reason).toEqual(new Error('cancelled'))
  })
})
