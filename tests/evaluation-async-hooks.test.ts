import { describe, expect, it, vi } from 'vitest'
import { createEvaluator } from '../src/evaluation'

const receipt = () => ({
  model: 'fixture-classifier',
  inputTokens: 7,
  outputTokens: 1,
  actualCostUsd: 0.01,
})

describe('asynchronous evaluation hooks', () => {
  it('finishes receipt persistence and validation before delivering a decision', async () => {
    const order: string[] = []
    const run = createEvaluator({
      execute: async (_input: string) => ({ route: 'inspect' as const }),
      receipt,
      validate: async () => {
        order.push('validate-start')
        await Promise.resolve()
        order.push('validate-finish')
      },
    })
    const result = await run('evidence', {
      onReceipt: async () => {
        order.push('receipt-start')
        await Promise.resolve()
        order.push('receipt-finish')
      },
    })
    order.push('delivered')
    expect(result.value.route).toBe('inspect')
    expect(order).toEqual([
      'receipt-start',
      'receipt-finish',
      'validate-start',
      'validate-finish',
      'delivered',
    ])
  })

  it('rejects an asynchronously invalid answer without losing its paid receipt or retrying', async () => {
    const error = new Error('Caller schema rejected the answer')
    const execute = vi.fn(async (_input: string) => ({ route: 'inspect' as const }))
    const onReceipt = vi.fn()
    const run = createEvaluator({
      execute,
      receipt,
      validate: async () => {
        await Promise.resolve()
        throw error
      },
    })
    await expect(run('evidence', { onReceipt })).rejects.toBe(error)
    expect(execute).toHaveBeenCalledOnce()
    expect(onReceipt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: 'settled', actualCostUsd: 0.01,
    }))
  })

  it('propagates an asynchronous receipt observer failure instead of emitting an unchecked decision', async () => {
    const error = new Error('Receipt archive unavailable')
    const validate = vi.fn()
    const run = createEvaluator({
      execute: async (_input: string) => ({ route: 'inspect' as const }),
      receipt,
      validate,
    })
    await expect(run('evidence', {
      onReceipt: async () => {
        await Promise.resolve()
        throw error
      },
    })).rejects.toBe(error)
    expect(validate).not.toHaveBeenCalled()
  })

  it('rechecks cancellation after asynchronous validation', async () => {
    const controller = new AbortController()
    const onReceipt = vi.fn()
    const run = createEvaluator({
      execute: async (_input: string) => ({ route: 'inspect' as const }),
      receipt,
      validate: async () => {
        await Promise.resolve()
        controller.abort()
      },
    })
    await expect(run('evidence', {
      signal: controller.signal,
      onReceipt,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(onReceipt).toHaveBeenCalledOnce()
  })
})
