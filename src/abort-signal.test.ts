import { describe, expect, it } from 'vitest'
import { combineAbortSignals } from './abort-signal'

describe('combineAbortSignals', () => {
  it('preserves zero and one-source identity', () => {
    const controller = new AbortController()
    expect(combineAbortSignals()).toBeUndefined()
    expect(combineAbortSignals(undefined, controller.signal)).toBe(controller.signal)
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

  it('aborts when the first distinct source aborts', () => {
    const first = new AbortController()
    const second = new AbortController()
    const combined = combineAbortSignals(first.signal, second.signal)

    first.abort(new Error('first cancelled'))

    expect(combined?.aborted).toBe(true)
    expect(combined?.reason).toEqual(new Error('first cancelled'))
  })

  it('is already aborted when an input is already aborted', () => {
    const aborted = new AbortController()
    aborted.abort(new Error('already cancelled'))

    const combined = combineAbortSignals(new AbortController().signal, aborted.signal)

    expect(combined?.aborted).toBe(true)
    expect(combined?.reason).toEqual(new Error('already cancelled'))
  })
})
