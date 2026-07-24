import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { hostname, tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { type CampaignStorage, createRunCostLedger, fsCampaignStorage } from './campaign/storage'
import type { CostLedgerPersistence, CostReceipt, CostReceiptInput } from './cost-ledger'
import {
  CostAccountingIncompleteError,
  CostCallConflictError,
  CostCeilingReachedError,
  CostLedger,
  CostLedgerPersistenceError,
  CostReceiptCaptureError,
  CostReservationExceededError,
  costForTokenPricing,
  costForUsage,
  modelPriceKey,
} from './cost-ledger'
import { canonicalJson } from './verdict-cache'

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

  it('bills cache reads and writes at the input rate when provider cost is unavailable', () => {
    const base = costForUsage('gpt-4o', { inputTokens: 1000, outputTokens: 0 })
    const cached = costForUsage('gpt-4o', {
      inputTokens: 1000,
      outputTokens: 0,
      cachedTokens: 1000,
      cacheWriteTokens: 1000,
    })
    expect(cached.costUsd).toBeCloseTo(base.costUsd * 3, 6)
  })

  it('preserves reasoning and cache-write dimensions in durable receipts', async () => {
    const { persistence, state } = memoryPersistence()
    const ledger = new CostLedger({ persistence })
    const result = await ledger.runPaidCall({
      channel: 'analyst',
      phase: 'inspect',
      actor: 'fixture',
      model: 'gpt-4o',
      execute: async () => 'ok',
      receipt: () => ({
        model: 'gpt-4o',
        inputTokens: 10,
        outputTokens: 7,
        reasoningTokens: 3,
        cachedTokens: 4,
        cacheWriteTokens: 2,
      }),
    })

    expect(result.succeeded).toBe(true)
    const events = persistedEvents(state.events)
    const settledEvent = events.find(
      (event) =>
        event.record !== undefined && 'status' in event.record && event.record.status === 'settled',
    )
    expect(settledEvent).toMatchObject({
      version: 2,
      record: {
        inputTokens: 10,
        outputTokens: 7,
        reasoningTokens: 3,
        cachedTokens: 4,
        cacheWriteTokens: 2,
      },
    })
    expect(settledEvent?.record).not.toHaveProperty('error')

    const pendingEvent = events[0]
    expect(pendingEvent).toMatchObject({
      version: 1,
      record: {
        status: 'pending',
        callId: settledEvent?.record?.callId,
        channel: settledEvent?.record?.channel,
        phase: settledEvent?.record?.phase,
        actor: settledEvent?.record?.actor,
        timestamp: settledEvent?.record?.timestamp,
      },
    })
    expect(pendingEvent?.record?.tags).toEqual(settledEvent?.record?.tags)

    const reloaded = new CostLedger({ persistence })
    expect(reloaded.list()[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 7,
      reasoningTokens: 3,
      cachedTokens: 4,
      cacheWriteTokens: 2,
    })
    expect(reloaded.list()[0]?.tags).toBeUndefined()
    expect(reloaded.list()[0]?.error).toBeUndefined()
    expect(reloaded.summary()).toMatchObject({
      reasoningTokens: 3,
      cachedTokens: 4,
      cacheWriteTokens: 2,
      byChannel: [
        expect.objectContaining({
          channel: 'analyst',
          reasoningTokens: 3,
          cachedTokens: 4,
          cacheWriteTokens: 2,
        }),
      ],
    })
  })

  it('preserves a provider error alongside the compatible usage extension', async () => {
    const { persistence, state } = memoryPersistence()
    const ledger = new CostLedger({ persistence })

    const result = await ledger.runPaidCall({
      channel: 'analyst',
      phase: 'inspect',
      actor: 'fixture',
      model: 'gpt-4o',
      execute: async () => {
        throw new Error('provider rejected output')
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 0, outputTokens: 0 }),
      receiptFromError: () => ({
        model: 'gpt-4o',
        inputTokens: 10,
        outputTokens: 7,
        reasoningTokens: 3,
        cacheWriteTokens: 2,
      }),
    })

    expect(result).toMatchObject({
      succeeded: false,
      error: { message: 'provider rejected output' },
    })
    const settledEvent = persistedEvents(state.events).find(
      (event) =>
        event.record !== undefined && 'status' in event.record && event.record.status === 'settled',
    )
    expect(settledEvent).toMatchObject({
      version: 2,
      record: {
        inputTokens: 10,
        outputTokens: 7,
        reasoningTokens: 3,
        cacheWriteTokens: 2,
        error: 'provider rejected output',
      },
    })
    expect(new CostLedger({ persistence }).list()[0]).toMatchObject({
      inputTokens: 10,
      reasoningTokens: 3,
      cacheWriteTokens: 2,
      error: 'provider rejected output',
    })
  })

  it('fails loud on negative tokens', () => {
    expect(() => costForUsage('gpt-4o', { inputTokens: -1, outputTokens: 0 })).toThrow(
      /inputTokens/,
    )
  })
})

describe('costForTokenPricing', () => {
  it('prices caller-supplied per-million rates', () => {
    expect(
      costForTokenPricing(
        { inputUsdPerMillion: 0.27, outputUsdPerMillion: 1.1 },
        { inputTokens: 1_000_000, outputTokens: 500_000 },
      ),
    ).toBeCloseTo(0.82, 8)
  })

  it('prices normal input, cache reads, cache writes, and output independently', () => {
    expect(
      costForTokenPricing(
        {
          inputUsdPerMillion: 1,
          cachedInputUsdPerMillion: 0.25,
          cacheWriteUsdPerMillion: 1.5,
          outputUsdPerMillion: 2,
        },
        {
          inputTokens: 100,
          cachedTokens: 50,
          cacheWriteTokens: 25,
          outputTokens: 10,
        },
      ),
    ).toBeCloseTo(0.00017, 12)
  })

  it('falls back to the normal input rate for unspecified cache rates', () => {
    expect(
      costForTokenPricing(
        { inputUsdPerMillion: 1, outputUsdPerMillion: 2 },
        {
          inputTokens: 100,
          cachedTokens: 50,
          cacheWriteTokens: 25,
          outputTokens: 10,
        },
      ),
    ).toBeCloseTo(0.000195, 12)
  })

  it('records caller-supplied token pricing as an estimate, not provider-billed cost', async () => {
    const ledger = new CostLedger()
    const result = await ledger.runPaidCall({
      channel: 'optimizer',
      phase: 'propose',
      actor: 'official-package',
      model: 'router/custom-model',
      execute: async () => 'ok',
      receipt: () => ({
        model: 'router/custom-model',
        inputTokens: 100,
        cachedTokens: 50,
        cacheWriteTokens: 25,
        outputTokens: 10,
        customTokenPricing: {
          inputUsdPerMillion: 1,
          cachedInputUsdPerMillion: 0.25,
          cacheWriteUsdPerMillion: 1.5,
          outputUsdPerMillion: 2,
        },
      }),
    })

    expect(result).toMatchObject({
      succeeded: true,
      receipt: {
        costUsd: 0.00017,
        costUnknown: false,
        pricing: {
          inputUsdPerThousand: 0.001,
          cachedInputUsdPerThousand: 0.00025,
          cacheWriteUsdPerThousand: 0.0015,
          outputUsdPerThousand: 0.002,
        },
      },
    })
    if (!result.succeeded) throw result.error
    expect(result.receipt.actualCostUsd).toBeUndefined()
  })
})

let storedReceiptSequence = 0

function revision(events: string): string {
  return String(new TextEncoder().encode(events).byteLength)
}

function memoryPersistence(initialEvents = ''): {
  persistence: CostLedgerPersistence
  state: { events: string }
} {
  const state = { events: initialEvents }
  return {
    state,
    persistence: {
      read: () => ({ revision: revision(state.events), events: state.events }),
      append: (expected, event) => {
        if (expected !== revision(state.events)) return undefined
        state.events += event
        return revision(state.events)
      },
    },
  }
}

function eventFor(record: object, version: 1 | 2 = 1): string {
  return `${JSON.stringify({ version, record })}\n`
}

function persistedEvents(events: string): Array<{
  version: number
  record?: Record<string, unknown>
}> {
  return events
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { version: number; record?: Record<string, unknown> })
}

function persistedRecords(events: string): unknown[] {
  return persistedEvents(events).flatMap((event) =>
    event.record === undefined ? [] : [event.record],
  )
}

function storedReceipt(channel: 'agent' | 'judge', input: CostReceiptInput): CostReceipt {
  const estimated = costForUsage(input.model, input)
  return {
    status: 'settled',
    callId: `fixture-${storedReceiptSequence++}`,
    ...input,
    channel,
    phase: 'test',
    actor: 'fixture',
    costUsd: input.actualCostUsd ?? estimated.costUsd,
    costUnknown: input.actualCostUsd === undefined && estimated.costUnknown,
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

  it('persists completed tasks so resumed cost-per-task remains correct', () => {
    const { persistence } = memoryPersistence()
    const ledger = new CostLedger({
      persistence,
      receipts: [storedReceipt('agent', { model: 'gpt-4o', inputTokens: 1000, outputTokens: 0 })],
    })
    expect(ledger.costPerCompletedTask()).toBeNull()
    ledger.markCompleted(2)
    expect(ledger.costPerCompletedTask()).toBeCloseTo(0.0025 / 2, 6)
    const resumed = new CostLedger({ persistence })
    expect(resumed.costPerCompletedTask()).toBeCloseTo(0.0025 / 2, 6)
  })

  it('persists the spend limit before a free completed-task update', async () => {
    const { persistence } = memoryPersistence()
    const first = new CostLedger({ costCeilingUsd: 0.1, persistence })
    first.markCompleted()

    const resumed = new CostLedger({ persistence })
    let calls = 0
    const denied = await resumed.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      maximumCharge: { externallyEnforcedMaximumUsd: 0.2 },
      execute: async () => {
        calls += 1
        return 'unexpected'
      },
      receipt: () => ({
        model: 'gpt-4o',
        inputTokens: 0,
        outputTokens: 0,
        actualCostUsd: 0.2,
      }),
    })

    expect(resumed.costCeilingUsd).toBe(0.1)
    expect(denied).toMatchObject({ succeeded: false, error: expect.any(CostCeilingReachedError) })
    expect(calls).toBe(0)
  })

  it('rejects the reproduced $7.50 call before a $1 capped run spends anything', async () => {
    const ledger = new CostLedger(1)
    let callsStarted = 0

    const result = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'expensive-call',
      model: 'provider-priced',
      maximumCharge: {
        model: 'claude-opus-4-20250514',
        inputTokens: 0,
        outputTokens: 100_000,
      },
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

  it('reserves an unrecognized model with caller-supplied token prices', async () => {
    const ledger = new CostLedger(1)
    const result = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'custom-priced-call',
      model: 'router/custom-model',
      maximumCharge: {
        customTokenPricing: { inputUsdPerMillion: 0.27, outputUsdPerMillion: 1.1 },
        inputTokens: 1_000,
        outputTokens: 1_000,
      },
      execute: async () => 'ok',
      receipt: () => ({
        model: 'router/custom-model',
        inputTokens: 100,
        outputTokens: 50,
        actualCostUsd: 0.000082,
      }),
    })

    expect(result).toMatchObject({ succeeded: true })
    expect(ledger.summary()).toMatchObject({ totalCostUsd: 0.000082, accountingComplete: true })
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
          maximumCharge: { model: 'gpt-4o', inputTokens: 0, outputTokens: 75_000 },
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

  it('reloads the original spend limit and durable receipts before resumed work', async () => {
    const { persistence } = memoryPersistence()
    const first = new CostLedger({ costCeilingUsd: 1, persistence })
    for (const [index, amount] of [0.6, 0.6].entries()) {
      const result = await first.runPaidCall({
        channel: 'agent',
        phase: 'search',
        actor: 'worker',
        model: 'provider-priced',
        maximumCharge: {
          model: 'gpt-4o',
          inputTokens: 0,
          outputTokens: amount * 100_000,
        },
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

    const resumed = new CostLedger({ persistence })
    let resumedCalls = 0
    const denied = await resumed.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'provider-priced',
      maximumCharge: { model: 'gpt-4o', inputTokens: 0, outputTokens: 50_000 },
      async execute() {
        resumedCalls += 1
        return 'unexpected'
      },
      receipt: () => ({ model: 'provider-priced', inputTokens: 1, outputTokens: 1 }),
    })

    expect(resumed.summary().totalCostUsd).toBe(0.6)
    expect(resumed.costCeilingUsd).toBe(1)
    expect(resumed.list()).toHaveLength(1)
    expect(resumedCalls).toBe(0)
    expect(denied).toMatchObject({ succeeded: false })
    expect(denied).not.toHaveProperty('receipt')
  })

  it('rejects a resumed ledger that declares a different spend limit', async () => {
    const { persistence } = memoryPersistence()
    const first = new CostLedger({ costCeilingUsd: 1, persistence })
    const result = await first.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      maximumCharge: { externallyEnforcedMaximumUsd: 0.1 },
      execute: async () => 'ok',
      receipt: () => ({
        model: 'gpt-4o',
        inputTokens: 1,
        outputTokens: 1,
        actualCostUsd: 0.1,
      }),
    })
    expect(result.succeeded).toBe(true)

    expect(() => new CostLedger({ costCeilingUsd: 2, persistence })).toThrow(
      /does not match persisted ceiling/,
    )
  })

  it('persists a pending call before dispatch and blocks crash-resumed spend', async () => {
    const { persistence, state } = memoryPersistence()
    const controller = new AbortController()
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const first = new CostLedger({ costCeilingUsd: 1, persistence })
    const inFlight = first.runPaidCall({
      callId: 'provider-request-1',
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'gpt-4o',
      tags: { run: 'crash-resume' },
      signal: controller.signal,
      maximumCharge: { model: 'gpt-4o', inputTokens: 0, outputTokens: 50_000 },
      async execute(_signal, callId) {
        expect(callId).toBe('provider-request-1')
        markStarted()
        return await new Promise<string>(() => {})
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
    })
    await started
    expect(persistedRecords(state.events)).toEqual([
      expect.objectContaining({ status: 'pending', callId: 'provider-request-1' }),
    ])
    const active = first.listPending()
    expect(active).toEqual([
      expect.objectContaining({
        callId: 'provider-request-1',
        state: 'active',
        tags: { run: 'crash-resume' },
      }),
    ])
    active[0]!.tags!.run = 'mutated'
    expect(first.listPending()[0]?.tags).toEqual({ run: 'crash-resume' })

    let resumedCalls = 0
    const resumed = new CostLedger({ costCeilingUsd: 1, persistence })
    expect(resumed.listPending()).toEqual([
      expect.objectContaining({ callId: 'provider-request-1', state: 'interrupted' }),
    ])
    expect(resumed.listPending({ tags: { run: 'crash-resume' } })).toHaveLength(1)
    expect(resumed.listPending({ tags: { run: 'other' } })).toHaveLength(0)
    const denied = await resumed.runPaidCall({
      callId: 'provider-request-2',
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'gpt-4o',
      maximumCharge: { model: 'gpt-4o', inputTokens: 0, outputTokens: 1 },
      execute: async () => {
        resumedCalls += 1
        return 'unexpected'
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
    })
    expect(denied).toMatchObject({
      succeeded: false,
      error: expect.any(CostAccountingIncompleteError),
    })
    expect(resumedCalls).toBe(0)
    expect(resumed.summary()).toMatchObject({ pendingCalls: 1, unresolvedCalls: 1 })

    controller.abort(new Error('simulated process exit'))
    await inFlight
    expect(first.listPending()).toEqual([
      expect.objectContaining({ callId: 'provider-request-1', state: 'late' }),
    ])
  })

  it('allows only one file-backed ledger instance to reserve a shared revision', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'agent-eval-cost-ledger-'))
    const first = createRunCostLedger({
      storage: fsCampaignStorage(),
      runDir,
      costCeilingUsd: 1,
    })
    const second = createRunCostLedger({
      storage: fsCampaignStorage(),
      runDir,
      costCeilingUsd: 1,
    })
    const controller = new AbortController()
    let started!: () => void
    const dispatched = new Promise<void>((resolve) => {
      started = resolve
    })
    const inFlight = first.runPaidCall({
      callId: 'first-process',
      channel: 'agent',
      phase: 'search',
      actor: 'first',
      signal: controller.signal,
      maximumCharge: { model: 'gpt-4o', inputTokens: 0, outputTokens: 10_000 },
      execute: async () => {
        started()
        return await new Promise<string>(() => {})
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
    })

    try {
      await dispatched
      let secondCalls = 0
      const conflict = await second.runPaidCall({
        callId: 'second-process',
        channel: 'agent',
        phase: 'search',
        actor: 'second',
        maximumCharge: { model: 'gpt-4o', inputTokens: 0, outputTokens: 10_000 },
        execute: async () => {
          secondCalls += 1
          return 'unexpected'
        },
        receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
      })
      expect(conflict).toMatchObject({
        succeeded: false,
        error: expect.any(CostCallConflictError),
      })
      expect(secondCalls).toBe(0)
    } finally {
      controller.abort(new Error('test cleanup'))
      await inFlight
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('fails closed when an existing event log cannot be read', () => {
    const storage: CampaignStorage = {
      ensureDir: () => undefined,
      exists: () => true,
      read: () => undefined,
      write: () => undefined,
      append: () => {
        throw new Error('unexpected append')
      },
    }

    expect(() => createRunCostLedger({ storage, runDir: 'mem://unreadable' })).toThrow(
      CostLedgerPersistenceError,
    )
  })

  it('keeps legacy storage adapters usable until they attempt paid work', async () => {
    const storage: CampaignStorage = {
      ensureDir: () => undefined,
      exists: () => false,
      read: () => undefined,
      write: () => undefined,
    }
    const ledger = createRunCostLedger({ storage, runDir: 'mem://legacy' })
    expect(ledger.summary().totalCalls).toBe(0)

    const result = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      execute: async () => 'unexpected',
      receipt: () => ({ model: 'gpt-4o', inputTokens: 0, outputTokens: 0 }),
    })

    expect(result).toMatchObject({
      succeeded: false,
      error: expect.any(CostLedgerPersistenceError),
    })
  })

  it('blocks dispatch while another process holds the filesystem lock', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'agent-eval-cost-claim-'))
    writeFileSync(
      join(runDir, 'cost-ledger.jsonl.lock'),
      `${JSON.stringify({ host: hostname(), nonce: 'active-process', pid: process.pid })}\n`,
      'utf8',
    )
    const ledger = createRunCostLedger({ storage: fsCampaignStorage(), runDir })
    let calls = 0

    try {
      const result = await ledger.runPaidCall({
        callId: 'blocked-by-claim',
        channel: 'agent',
        phase: 'search',
        actor: 'worker',
        execute: async () => {
          calls += 1
          return 'unexpected'
        },
        receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
      })
      expect(result).toMatchObject({
        succeeded: false,
        error: expect.any(CostCallConflictError),
      })
      expect(calls).toBe(0)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('recovers a stale filesystem lock left by a crashed writer', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'agent-eval-cost-stale-lock-'))
    const lockPath = join(runDir, 'cost-ledger.jsonl.lock')
    writeFileSync(
      lockPath,
      `${JSON.stringify({ host: hostname(), nonce: 'crashed-process', pid: 999_999_999 })}\n`,
      'utf8',
    )
    const ledger = createRunCostLedger({ storage: fsCampaignStorage(), runDir })

    try {
      const result = await ledger.runPaidCall({
        callId: 'after-crash',
        channel: 'agent',
        phase: 'search',
        actor: 'worker',
        execute: async () => 'completed',
        receipt: () => ({
          model: 'gpt-4o',
          inputTokens: 1,
          outputTokens: 1,
          actualCostUsd: 0.01,
        }),
      })
      expect(result).toMatchObject({ succeeded: true, receipt: { costUsd: 0.01 } })
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('appends one constant-size event per reservation and settlement', async () => {
    const state = { events: '' }
    const writes: string[] = []
    const ledger = new CostLedger({
      persistence: {
        read: () => ({ revision: revision(state.events), events: state.events }),
        append: (expected, event) => {
          if (expected !== revision(state.events)) return undefined
          writes.push(event)
          state.events += event
          return revision(state.events)
        },
      },
    })

    for (let index = 0; index < 100; index += 1) {
      const result = await ledger.runPaidCall({
        callId: `call-${index}`,
        channel: 'agent',
        phase: 'search',
        actor: 'worker',
        execute: async () => 'ok',
        receipt: () => ({
          model: 'gpt-4o',
          inputTokens: 1,
          outputTokens: 1,
          actualCostUsd: 0.001,
        }),
      })
      expect(result.succeeded).toBe(true)
    }

    expect(writes).toHaveLength(200)
    expect(writes.every((event) => event.trim().split('\n').length === 1)).toBe(true)
    const sizes = writes.map((event) => new TextEncoder().encode(event).byteLength)
    for (const transitionSizes of [
      sizes.filter((_, index) => index % 2 === 0),
      sizes.filter((_, index) => index % 2 === 1),
    ]) {
      expect(Math.max(...transitionSizes) - Math.min(...transitionSizes)).toBeLessThan(8)
    }
  })

  it('reconciles a crash-pending call before allowing resumed work', async () => {
    const pending = {
      status: 'pending',
      callId: 'recover-me',
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'gpt-4o',
      maximumCostUsd: 0.5,
      timestamp: 1,
    }
    const { persistence, state } = memoryPersistence(eventFor(pending))
    const ledger = new CostLedger({ costCeilingUsd: 1, persistence })
    const receipt = ledger.reconcile('recover-me', {
      model: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 5,
      actualCostUsd: 0.2,
    })

    expect(receipt).toMatchObject({ status: 'settled', callId: 'recover-me', costUsd: 0.2 })
    expect(ledger.summary()).toMatchObject({ pendingCalls: 0, totalCostUsd: 0.2 })
    expect(persistedRecords(state.events).at(-1)).toMatchObject({
      status: 'settled',
      costUsd: 0.2,
    })
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

  it('records known and explicitly incomplete receipts for settled provider failures', async () => {
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
      receipt: { costUsd: 0, costUnknown: true, usageUnknown: true },
    })
    if (unknownFailure.succeeded || !unknownFailure.receipt) {
      throw new Error('expected the failed provider call to return its settled receipt')
    }
    const listedUnknownReceipt = ledger
      .list()
      .find((receipt) => receipt.callId === unknownFailure.callId)
    if (!listedUnknownReceipt) throw new Error('expected the settled receipt in the ledger')
    const unknownReceipts = [unknownFailure.receipt, listedUnknownReceipt]
    for (const receipt of unknownReceipts) {
      expect(receipt).not.toHaveProperty('tags')
      expect(receipt).not.toHaveProperty('pricing')
      expect(() => canonicalJson(receipt)).not.toThrow()
    }
    expect(ledger.summary()).toMatchObject({
      totalCostUsd: 0.4,
      pendingCalls: 0,
      unresolvedCalls: 0,
      accountingComplete: false,
      incompleteReasons: expect.arrayContaining([expect.stringContaining('network failure')]),
    })
  })

  it('keeps an aborted external call pending and blocks uncapped work until reconciliation', async () => {
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
    expect(result).toMatchObject({
      succeeded: false,
      error: { message: 'deadline' },
    })
    expect(result).not.toHaveProperty('receipt')
    expect(returnedSummary).toMatchObject({
      totalCostUsd: 0,
      pendingCalls: 1,
      unresolvedCalls: 1,
      usageComplete: false,
      accountingComplete: false,
    })
    let nextCalls = 0
    const denied = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'next-call',
      execute: async () => {
        nextCalls += 1
        return 'unexpected'
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
    })
    expect(denied).toMatchObject({
      succeeded: false,
      error: expect.any(CostAccountingIncompleteError),
    })
    expect(nextCalls).toBe(0)

    finish()
    await ledger.waitForIdle()
    expect(ledger.summary()).toMatchObject({
      totalCostUsd: 0.5,
      pendingCalls: 0,
      unresolvedCalls: 0,
      accountingComplete: true,
    })
  })

  it('bounds idle waiting when a provider ignores cancellation', async () => {
    const ledger = new CostLedger()
    const controller = new AbortController()
    let started!: () => void
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const call = ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'stuck-provider',
      model: 'gpt-4o',
      signal: controller.signal,
      async execute() {
        started()
        return new Promise<never>(() => {})
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
    })

    await providerStarted
    controller.abort(new Error('deadline'))
    await expect(call).resolves.toMatchObject({ succeeded: false })
    await expect(ledger.waitForIdle({ timeoutMs: 1 })).resolves.toBe(false)
    expect(ledger.summary()).toMatchObject({
      pendingCalls: 1,
      usageComplete: false,
      accountingComplete: false,
    })
  })

  it('waits only for active calls matching the requested attribution', async () => {
    const ledger = new CostLedger()
    let finishA!: () => void
    let finishB!: () => void
    const call = (cellId: string, finish: (value: () => void) => void) =>
      ledger.runPaidCall({
        channel: 'agent',
        phase: 'campaign',
        actor: cellId,
        tags: { cellId },
        async execute() {
          await new Promise<void>((resolve) => finish(resolve))
          return cellId
        },
        receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
      })
    const callA = call('a', (resolve) => {
      finishA = resolve
    })
    const callB = call('b', (resolve) => {
      finishB = resolve
    })
    while (!finishA || !finishB) await new Promise((resolve) => setTimeout(resolve, 1))

    const waitingForA = ledger.waitForIdle({ timeoutMs: 100, filter: { tags: { cellId: 'a' } } })
    finishA()
    await expect(waitingForA).resolves.toBe(true)
    expect(ledger.summary()).toMatchObject({ pendingCalls: 1 })

    finishB()
    await Promise.all([callA, callB])
  })

  it('rejects premature reconciliation while an aborted provider call is still running', async () => {
    const ledger = new CostLedger()
    const controller = new AbortController()
    let started!: () => void
    let finish!: (cost: number) => void
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const provider = new Promise<number>((resolve) => {
      finish = resolve
    })
    const call = ledger.runPaidCall({
      callId: 'abort-race',
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'gpt-4o',
      signal: controller.signal,
      async execute() {
        started()
        return provider
      },
      receipt: (cost) => ({
        model: 'gpt-4o',
        inputTokens: 1,
        outputTokens: 1,
        actualCostUsd: cost,
      }),
    })

    await providerStarted
    controller.abort(new Error('deadline'))
    await expect(call).resolves.toMatchObject({ succeeded: false })
    expect(() =>
      ledger.reconcile('abort-race', {
        model: 'gpt-4o',
        inputTokens: 0,
        outputTokens: 0,
        actualCostUsd: 0,
      }),
    ).toThrow(/still active/)

    let followupCalls = 0
    const denied = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'followup',
      execute: async () => {
        followupCalls += 1
        return 'unexpected'
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
    })
    expect(denied).toMatchObject({
      succeeded: false,
      error: expect.any(CostAccountingIncompleteError),
    })
    expect(followupCalls).toBe(0)

    finish(0.5)
    await ledger.waitForIdle()
    expect(ledger.summary()).toMatchObject({
      totalCostUsd: 0.5,
      pendingCalls: 0,
      unresolvedCalls: 0,
      accountingComplete: true,
    })
  })

  it('settles an aborted provider rejection as incomplete after the provider stops', async () => {
    const ledger = new CostLedger()
    const controller = new AbortController()
    let started!: () => void
    let fail!: (error: Error) => void
    const providerStarted = new Promise<void>((resolve) => {
      started = resolve
    })
    const provider = new Promise<string>((_resolve, reject) => {
      fail = reject
    })
    const call = ledger.runPaidCall({
      callId: 'aborted-rejection',
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'gpt-4o',
      signal: controller.signal,
      async execute() {
        started()
        return provider
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
    })

    await providerStarted
    controller.abort(new Error('deadline'))
    await expect(call).resolves.toMatchObject({ succeeded: false })
    expect(ledger.summary()).toMatchObject({ pendingCalls: 1, unresolvedCalls: 1 })

    fail(new DOMException('provider request aborted', 'AbortError'))
    await ledger.waitForIdle()
    expect(ledger.summary()).toMatchObject({
      pendingCalls: 0,
      unresolvedCalls: 0,
      totalCostUsd: 0,
      usageComplete: false,
      accountingComplete: false,
    })
    expect(ledger.list()[0]).toMatchObject({
      callId: 'aborted-rejection',
      costUnknown: true,
      usageUnknown: true,
      error: 'provider request aborted',
    })
  })

  it('exposes unknown pricing and refuses to continue a capped run', async () => {
    const ledger = new CostLedger(1)
    const result = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'unknown-model',
      model: 'not-in-price-table',
      maximumCharge: { externallyEnforcedMaximumUsd: 0.5 },
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

  it('persists an explicitly unknown priced receipt as unknown, not an estimate', async () => {
    const { persistence } = memoryPersistence()
    const ledger = new CostLedger({ persistence })
    const result = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'unknown-provider-bill',
      model: 'gpt-4o',
      execute: async () => 'done',
      receipt: () => ({
        model: 'gpt-4o',
        inputTokens: 1_000,
        outputTokens: 100,
        costUnknown: true,
      }),
    })

    expect(result).toMatchObject({
      succeeded: true,
      receipt: { costUsd: 0, costUnknown: true },
    })
    expect(new CostLedger({ persistence }).summary()).toMatchObject({
      totalCalls: 1,
      totalCostUsd: 0,
      accountingComplete: false,
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
      maximumCharge: { externallyEnforcedMaximumUsd: 0.25 },
      execute: async () => 'charged',
      receipt: () => ({
        model: 'provider-priced',
        inputTokens: 1,
        outputTokens: 1,
        actualCostUsd: 1.25,
      }),
    })

    expect(result).toMatchObject({
      succeeded: false,
      error: expect.any(CostReservationExceededError),
      receipt: { costUsd: 1.25, maximumCostUsd: 0.25 },
    })
    expect(ledger.summary()).toMatchObject({
      totalCostUsd: 1.25,
      accountingComplete: false,
    })
    let followupCalls = 0
    const denied = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'followup',
      maximumCharge: { externallyEnforcedMaximumUsd: 0.1 },
      execute: async () => {
        followupCalls += 1
        return 'unexpected'
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
    })
    expect(denied).toMatchObject({
      succeeded: false,
      error: expect.any(CostAccountingIncompleteError),
    })
    expect(followupCalls).toBe(0)
  })

  it('returns typed persistence failures without dispatching or mutating memory', async () => {
    let calls = 0
    const ledger = new CostLedger({
      costCeilingUsd: 1,
      persistence: {
        read: () => ({ revision: '0', events: '' }),
        append: () => {
          throw new Error('disk unavailable')
        },
      },
    })
    const result = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'gpt-4o',
      maximumCharge: { model: 'gpt-4o', inputTokens: 0, outputTokens: 1 },
      execute: async () => {
        calls += 1
        return 'unexpected'
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
    })

    expect(result).toMatchObject({
      succeeded: false,
      error: expect.any(CostLedgerPersistenceError),
    })
    expect(calls).toBe(0)
    expect(ledger.summary()).toMatchObject({ totalCalls: 0, pendingCalls: 0 })
  })

  it('keeps the durable pending record when settlement persistence fails', async () => {
    const state = { events: '' }
    let writes = 0
    const ledger = new CostLedger({
      costCeilingUsd: 1,
      persistence: {
        read: () => ({ revision: revision(state.events), events: state.events }),
        append: (expected, event) => {
          writes += 1
          if (writes === 3) throw new Error('settlement write failed')
          if (expected !== revision(state.events)) return undefined
          state.events += event
          return revision(state.events)
        },
      },
    })
    const result = await ledger.runPaidCall({
      callId: 'settlement-fails',
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'gpt-4o',
      maximumCharge: { model: 'gpt-4o', inputTokens: 0, outputTokens: 10_000 },
      execute: async () => 'charged',
      receipt: () => ({
        model: 'gpt-4o',
        inputTokens: 10,
        outputTokens: 5,
        actualCostUsd: 0.1,
      }),
    })

    expect(result).toMatchObject({
      succeeded: false,
      error: expect.objectContaining({
        receipt: expect.objectContaining({ callId: 'settlement-fails', costUsd: 0.1 }),
      }),
    })
    expect(result).not.toHaveProperty('receipt')
    if (result.succeeded) throw new Error('expected settlement failure')
    expect(result.error).toBeInstanceOf(CostLedgerPersistenceError)
    expect(ledger.list()).toHaveLength(0)
    expect(ledger.summary()).toMatchObject({ pendingCalls: 1, unresolvedCalls: 1 })
    expect(persistedRecords(state.events)).toEqual([expect.objectContaining({ status: 'pending' })])
  })

  it('retains the provider receipt when settlement loses a persistence race', async () => {
    const state = { events: '' }
    let writes = 0
    const ledger = new CostLedger({
      persistence: {
        read: () => ({ revision: revision(state.events), events: state.events }),
        append: (expected, event) => {
          writes += 1
          if (writes === 2) return undefined
          if (expected !== revision(state.events)) return undefined
          state.events += event
          return revision(state.events)
        },
      },
    })
    const result = await ledger.runPaidCall({
      callId: 'settlement-conflict',
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'gpt-4o',
      execute: async () => 'charged',
      receipt: () => ({
        model: 'gpt-4o',
        inputTokens: 10,
        outputTokens: 5,
        actualCostUsd: 0.1,
      }),
    })

    expect(result).toMatchObject({
      succeeded: false,
      error: expect.objectContaining({
        callId: 'settlement-conflict',
        receipt: expect.objectContaining({ costUsd: 0.1 }),
      }),
    })
    expect(result).not.toHaveProperty('receipt')
    if (result.succeeded) throw new Error('expected settlement conflict')
    expect(result.error).toBeInstanceOf(CostCallConflictError)
    expect(ledger.summary()).toMatchObject({ pendingCalls: 1, unresolvedCalls: 1 })
  })

  it('turns malformed provider receipts into one typed unknown receipt', async () => {
    const ledger = new CostLedger()
    const result = await ledger.runPaidCall({
      channel: 'judge',
      phase: 'holdout',
      actor: 'malformed-receipt',
      model: 'gpt-4o',
      execute: async () => 'done',
      receipt: () => ({ model: 'gpt-4o', inputTokens: -1, outputTokens: 0 }),
    })

    expect(result).toMatchObject({
      succeeded: false,
      error: expect.any(CostReceiptCaptureError),
      receipt: { costUnknown: true },
    })
    expect(ledger.list()).toHaveLength(1)
    expect(ledger.summary()).toMatchObject({ totalCalls: 1, accountingComplete: false })
  })

  it('strictly validates restored records and clones imported tags', () => {
    const invalid = eventFor({
      status: 'settled',
      callId: 'bad',
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'gpt-4o',
      inputTokens: -1,
      outputTokens: 0,
      costUsd: 0,
      costUnknown: false,
      timestamp: 1,
      unexpected: true,
    })
    expect(
      () =>
        new CostLedger({
          persistence: {
            read: () => ({ revision: revision(invalid), events: invalid }),
            append: () => undefined,
          },
        }),
    ).toThrow(/invalid persisted event/)

    const tags = { tenant: 'a' }
    const imported = storedReceipt('agent', {
      model: 'gpt-4o',
      inputTokens: 1,
      outputTokens: 1,
    })
    imported.tags = tags
    const ledger = new CostLedger({ receipts: [imported] })
    tags.tenant = 'mutated'
    expect(ledger.list()[0]?.tags).toEqual({ tenant: 'a' })
  })

  it('rejects a persisted estimated cost that disagrees with its token usage', () => {
    const invalid = eventFor({
      status: 'settled',
      callId: 'forged-zero',
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'gpt-4o',
      inputTokens: 1_000_000,
      outputTokens: 1_000_000,
      costUsd: 0,
      costUnknown: false,
      pricing: { inputUsdPerThousand: 0.0025, outputUsdPerThousand: 0.01 },
      timestamp: 1,
    })

    expect(
      () =>
        new CostLedger({
          persistence: {
            read: () => ({ revision: revision(invalid), events: invalid }),
            append: () => undefined,
          },
        }),
    ).toThrow(/does not match pricing snapshot/)
  })

  it('rejects persisted reasoning usage that exceeds total output', () => {
    const invalid = eventFor(
      {
        status: 'settled',
        callId: 'impossible-reasoning',
        channel: 'analyst',
        phase: 'inspect',
        actor: 'worker',
        model: 'gpt-4o',
        inputTokens: 10,
        outputTokens: 2,
        reasoningTokens: 3,
        costUsd: 0.000045,
        costUnknown: false,
        pricing: { inputUsdPerThousand: 0.0025, outputUsdPerThousand: 0.01 },
        timestamp: 1,
      },
      2,
    )

    expect(
      () =>
        new CostLedger({
          persistence: {
            read: () => ({ revision: revision(invalid), events: invalid }),
            append: () => undefined,
          },
        }),
    ).toThrow(/reasoningTokens must not exceed outputTokens/)
  })

  it('fails loud on a partial final event instead of dropping possible spend', () => {
    const complete = eventFor({
      status: 'pending',
      callId: 'durable-reservation',
      channel: 'agent',
      phase: 'search',
      actor: 'worker',
      model: 'gpt-4o',
      maximumCostUsd: 0.5,
      timestamp: 1,
    })
    const events = `${complete}{"version":1,"record":`

    expect(
      () =>
        new CostLedger({
          persistence: {
            read: () => ({ revision: revision(events), events }),
            append: () => undefined,
          },
        }),
    ).toThrow(/invalid persisted event 2/)
  })

  it('captures a late receipt when abort races a completed provider call', async () => {
    const ledger = new CostLedger()
    const controller = new AbortController()
    const result = await ledger.runPaidCall({
      channel: 'agent',
      phase: 'search',
      actor: 'racy-abort',
      model: 'gpt-4o',
      signal: controller.signal,
      execute: async () => {
        controller.abort(new DOMException('cancelled', 'AbortError'))
        return 'late'
      },
      receipt: () => ({ model: 'gpt-4o', inputTokens: 1, outputTokens: 1 }),
    })

    expect(result).toMatchObject({
      succeeded: false,
      error: { name: 'AbortError' },
    })
    expect(result).not.toHaveProperty('receipt')
    await ledger.waitForIdle()
    expect(ledger.list()).toHaveLength(1)
    expect(ledger.summary()).toMatchObject({ pendingCalls: 0, unresolvedCalls: 0 })
  })
})
