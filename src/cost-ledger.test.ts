import { describe, expect, it } from 'vitest'
import type { CostReceipt, CostReceiptInput } from './cost-ledger'
import {
  CostAccountingIncompleteError,
  CostCeilingReachedError,
  CostLedger,
  CostReservationExceededError,
  costForUsage,
  modelPriceKey,
} from './cost-ledger'

describe('modelPriceKey', () => {
  it('returns the id for a priced model (exact or family)', () => {
    expect(modelPriceKey('gpt-4o')).toBe('gpt-4o')
    // family resolver matches harness-qualified ids
    expect(modelPriceKey('claude-code/sonnet')).toBe('claude-code/sonnet')
  })

  it('returns null for an unpriced model', () => {
    expect(modelPriceKey('totally-made-up-model-xyz')).toBeNull()
  })
})

describe('costForUsage', () => {
  it('prices a known model and flags costUnknown=false', () => {
    const r = costForUsage('gpt-4o', { inputTokens: 1000, outputTokens: 1000 })
    expect(r.costUnknown).toBe(false)
    // gpt-4o: 0.0025 in + 0.01 out per 1k
    expect(r.costUsd).toBeCloseTo(0.0125, 6)
  })

  it('flags costUnknown=true and returns 0 for an unpriced model', () => {
    const r = costForUsage('made-up-zzz', { inputTokens: 5000, outputTokens: 5000 })
    expect(r.costUnknown).toBe(true)
    expect(r.costUsd).toBe(0)
  })

  it('bills cached tokens at the input rate', () => {
    const base = costForUsage('gpt-4o', { inputTokens: 1000, outputTokens: 0 })
    const cached = costForUsage('gpt-4o', {
      inputTokens: 1000,
      outputTokens: 0,
      cachedTokens: 1000,
    })
    expect(cached.costUsd).toBeCloseTo(base.costUsd * 2, 6)
  })

  it('fails loud on negative tokens', () => {
    expect(() => costForUsage('gpt-4o', { inputTokens: -1, outputTokens: 0 })).toThrow(
      /inputTokens/,
    )
  })
})

function storedReceipt(channel: 'agent' | 'judge', input: CostReceiptInput): CostReceipt {
  const estimated = costForUsage(input.model, input)
  return {
    ...input,
    channel,
    phase: 'test',
    actor: 'fixture',
    costUsd: input.actualCostUsd ?? estimated.costUsd,
    costUnknown: input.actualCostUsd === undefined && estimated.costUnknown,
    terminationConfirmed: true,
    timestamp: 1,
  }
}

describe('CostLedger', () => {
  it('rolls up tokens + cost per channel and in total', () => {
    const ledger = new CostLedger({
      receipts: [
        storedReceipt('agent', { model: 'gpt-4o', inputTokens: 1000, outputTokens: 1000 }),
        storedReceipt('judge', { model: 'gpt-4o', inputTokens: 2000, outputTokens: 0 }),
      ],
    })
    const s = ledger.summary()
    expect(s.totalCalls).toBe(2)
    expect(s.inputTokens).toBe(3000)
    expect(s.byChannel.map((c) => c.channel)).toEqual(['agent', 'judge'])
    const agent = s.byChannel.find((c) => c.channel === 'agent')!
    expect(agent.costUsd).toBeCloseTo(0.0125, 6)
    expect(s.fullyPriced).toBe(true)
    expect(s.unpricedModels).toEqual([])
  })

  it('surfaces unpriced models so a $0 is never mistaken for free', () => {
    const ledger = new CostLedger({
      receipts: [
        storedReceipt('agent', {
          model: 'made-up-zzz',
          inputTokens: 1000,
          outputTokens: 1000,
        }),
      ],
    })
    const s = ledger.summary()
    expect(s.totalCostUsd).toBe(0)
    expect(s.fullyPriced).toBe(false)
    expect(s.unpricedModels).toEqual(['made-up-zzz'])
    expect(s.byChannel[0]!.unpricedCalls).toBe(1)
  })

  it('actualCostUsd overrides the estimate and clears costUnknown', () => {
    const ledger = new CostLedger({
      receipts: [
        storedReceipt('agent', {
          model: 'made-up-zzz',
          inputTokens: 1,
          outputTokens: 1,
          actualCostUsd: 0.42,
        }),
      ],
    })
    const e = ledger.list()[0]!
    expect(e.costUsd).toBe(0.42)
    expect(e.costUnknown).toBe(false)
    expect(ledger.summary().fullyPriced).toBe(true)
  })

  it('cost-per-completed-task is null until a task completes', () => {
    const ledger = new CostLedger({
      receipts: [storedReceipt('agent', { model: 'gpt-4o', inputTokens: 1000, outputTokens: 0 })],
    })
    expect(ledger.costPerCompletedTask()).toBeNull()
    ledger.markCompleted(2)
    expect(ledger.costPerCompletedTask()).toBeCloseTo(0.0025 / 2, 6)
  })

  it('rejects the reproduced $7.50 call before a $1 capped run spends anything', async () => {
    const ledger = new CostLedger(1)
    let callsStarted = 0

    const result = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'expensive-call',
      model: 'provider-priced',
      maximumCharge: { providerLimitUsd: 7.5 },
      async execute() {
        callsStarted += 1
        return 'unexpected'
      },
      receipt: () => ({
        model: 'provider-priced',
        inputTokens: 1,
        outputTokens: 1,
        actualCostUsd: 7.5,
      }),
    })

    expect(result).toMatchObject({
      succeeded: false,
      error: expect.any(CostCeilingReachedError),
    })
    expect(callsStarted).toBe(0)
    expect(ledger.summary().totalCostUsd).toBe(0)
  })

  it('atomically reserves concurrent calls so actual spend stays within the cap', async () => {
    const ledger = new CostLedger(1)
    let callsStarted = 0
    let active = 0
    let maxActive = 0

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        ledger.runPaidCall({
          channel: 'agent',
          phase: 'search',
          actor: `call-${index}`,
          model: 'provider-priced',
          maximumCharge: { providerLimitUsd: 0.75 },
          async execute() {
            callsStarted += 1
            active += 1
            maxActive = Math.max(maxActive, active)
            await Promise.resolve()
            active -= 1
            return index
          },
          receipt: () => ({
            model: 'provider-priced',
            inputTokens: 1,
            outputTokens: 1,
            actualCostUsd: 0.75,
          }),
        }),
      ),
    )

    expect(callsStarted).toBe(1)
    expect(maxActive).toBe(1)
    expect(results.filter((result) => result.succeeded)).toHaveLength(1)
    expect(results.filter((result) => !result.succeeded && !result.receipt)).toHaveLength(9)
    expect(ledger.summary().totalCostUsd).toBe(0.75)
    expect(ledger.summary().totalCostUsd).toBeLessThanOrEqual(1)
    expect(results.at(-1)).toMatchObject({
      succeeded: false,
      error: expect.any(CostCeilingReachedError),
    })
  })

  it('keeps uncapped paid calls concurrent', async () => {
    const ledger = new CostLedger()
    let active = 0
    let maxActive = 0

    const results = await Promise.all(
      Array.from({ length: 10 }, (_, index) =>
        ledger.runPaidCall({
          channel: 'agent',
          phase: 'search',
          actor: `call-${index}`,
          async execute() {
            active += 1
            maxActive = Math.max(maxActive, active)
            await Promise.resolve()
            active -= 1
            return index
          },
          receipt: () => ({
            model: 'provider-priced',
            inputTokens: 1,
            outputTokens: 1,
            actualCostUsd: 0.75,
          }),
        }),
      ),
    )

    expect(results.every((result) => result.succeeded)).toBe(true)
    expect(maxActive).toBe(10)
    expect(ledger.summary().totalCostUsd).toBe(7.5)
  })

  it('reloads durable receipts before admitting resumed work', async () => {
    let contents = ''
    const persistence = {
      read: () => contents,
      write: (next: string) => {
        contents = next
      },
    }
    const first = new CostLedger({ costCeilingUsd: 1, persistence })
    for (const [index, amount] of [0.6, 0.6].entries()) {
      const result = await first.runPaidCall({
        channel: 'agent',
        phase: 'search',
        actor: 'worker',
        model: 'provider-priced',
        maximumCharge: { providerLimitUsd: amount },
        async execute() {
          return 'ok'
        },
        receipt: () => ({
          model: 'provider-priced',
          inputTokens: 10,
          outputTokens: 2,
          actualCostUsd: amount,
        }),
      })
      expect(result.succeeded).toBe(index === 0)
    }

    const resumed = new CostLedger({ costCeilingUsd: 1, persistence })
    let resumedCalls = 0
    const denied = await resumed.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'provider-priced',
      maximumCharge: { providerLimitUsd: 0.5 },
      async execute() {
        resumedCalls += 1
        return 'unexpected'
      },
      receipt: () => ({ model: 'provider-priced', inputTokens: 1, outputTokens: 1 }),
    })

    expect(resumed.summary().totalCostUsd).toBe(0.6)
    expect(resumed.list()).toHaveLength(1)
    expect(resumedCalls).toBe(0)
    expect(denied).toMatchObject({ succeeded: false })
    expect(denied).not.toHaveProperty('receipt')
  })

  it('preserves an explicit zero-cost receipt instead of repricing its tokens', async () => {
    const ledger = new CostLedger()
    const result = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'free-provider-call',
      model: 'gpt-4o',
      async execute() {
        return 'ok'
      },
      receipt: () => ({
        model: 'gpt-4o',
        inputTokens: 1_000,
        outputTokens: 100,
        actualCostUsd: 0,
      }),
    })

    expect(result.succeeded).toBe(true)
    expect(ledger.summary()).toMatchObject({ totalCostUsd: 0, accountingComplete: true })
  })

  it('records failure receipts and reports receipt-less failures as incomplete', async () => {
    const ledger = new CostLedger()
    const paidFailure = await ledger.runPaidCall({
      channel: 'judge',
      phase: 'holdout',
      actor: 'judge-a',
      model: 'provider-priced',
      async execute() {
        throw new Error('provider rejected parsed output')
      },
      receipt: () => ({ model: 'provider-priced', inputTokens: 0, outputTokens: 0 }),
      receiptFromError: () => ({
        model: 'provider-priced',
        inputTokens: 40,
        outputTokens: 10,
        actualCostUsd: 0.4,
      }),
    })
    const unknownFailure = await ledger.runPaidCall({
      channel: 'judge',
      phase: 'holdout',
      actor: 'judge-b',
      model: 'provider-priced',
      async execute() {
        throw new Error('network failure')
      },
      receipt: () => ({ model: 'provider-priced', inputTokens: 0, outputTokens: 0 }),
    })

    expect(paidFailure).toMatchObject({ succeeded: false, receipt: { costUsd: 0.4 } })
    expect(unknownFailure).toMatchObject({
      succeeded: false,
      receipt: { costUnknown: true },
    })
    expect(ledger.summary()).toMatchObject({
      totalCostUsd: 0.4,
      accountingComplete: false,
      incompleteReasons: ['network failure'],
    })
  })

  it('does not mutate receipts after an aborted call returns', async () => {
    const ledger = new CostLedger()
    const controller = new AbortController()
    let finish!: () => void
    const external = new Promise<void>((resolve) => {
      finish = resolve
    })
    const pending = ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'ignores-abort',
      model: 'provider-priced',
      signal: controller.signal,
      async execute() {
        await external
        return 'late'
      },
      receipt: () => ({
        model: 'provider-priced',
        inputTokens: 5,
        outputTokens: 2,
        actualCostUsd: 0.5,
      }),
    })
    controller.abort(new Error('deadline'))
    const result = await pending
    const returnedSummary = ledger.summary()
    finish()
    await Promise.resolve()

    expect(result).toMatchObject({
      succeeded: false,
      receipt: { terminationConfirmed: false },
    })
    expect(returnedSummary).toMatchObject({ totalCostUsd: 0, accountingComplete: false })
    expect(ledger.summary()).toEqual(returnedSummary)
  })

  it('exposes unknown pricing and refuses to continue a capped run', async () => {
    const ledger = new CostLedger(1)
    const result = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'unknown-model',
      model: 'not-in-price-table',
      maximumCharge: { providerLimitUsd: 0.5 },
      async execute() {
        return 'unusable'
      },
      receipt: () => ({ model: 'not-in-price-table', inputTokens: 10, outputTokens: 2 }),
    })

    expect(result).toMatchObject({ succeeded: true })
    expect(ledger.summary()).toMatchObject({
      totalCostUsd: 0,
      fullyPriced: false,
      accountingComplete: false,
      unpricedModels: ['not-in-price-table'],
    })

    const denied = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'next-call',
      model: 'gpt-4o',
      maximumCharge: { model: 'gpt-4o', inputTokens: 1, outputTokens: 1 },
      async execute() {
        return 'must not start'
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
    })
    expect(denied).toMatchObject({
      succeeded: false,
      error: expect.any(CostAccountingIncompleteError),
    })
  })

  it('rejects missing and unpriced token bounds before capped calls execute', async () => {
    const ledger = new CostLedger(1)
    let callsStarted = 0
    const execute = async () => {
      callsStarted += 1
      return 'unexpected'
    }
    const receipt = () => ({ model: 'unknown', inputTokens: 1, outputTokens: 1 })

    const missing = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'missing-bound',
      execute,
      receipt,
    })
    const unpriced = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'unpriced-bound',
      maximumCharge: { model: 'unknown', inputTokens: 10, outputTokens: 10 },
      execute,
      receipt,
    })

    expect(missing).toMatchObject({
      succeeded: false,
      error: expect.any(CostAccountingIncompleteError),
    })
    expect(unpriced).toMatchObject({
      succeeded: false,
      error: expect.any(CostAccountingIncompleteError),
    })
    expect(callsStarted).toBe(0)
    expect(ledger.list()).toHaveLength(0)
  })

  it('retains a receipt and stops capped work when a provider breaks its hard maximum', async () => {
    const ledger = new CostLedger(1)
    const result = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'broken-provider-limit',
      maximumCharge: { providerLimitUsd: 0.25 },
      execute: async () => 'charged',
      receipt: () => ({
        model: 'provider-priced',
        inputTokens: 1,
        outputTokens: 1,
        actualCostUsd: 0.5,
      }),
    })

    expect(result).toMatchObject({
      succeeded: false,
      error: expect.any(CostReservationExceededError),
      receipt: { costUsd: 0.5, maximumCostUsd: 0.25 },
    })
    expect(ledger.summary()).toMatchObject({
      totalCostUsd: 0.5,
      accountingComplete: false,
    })
  })
})
