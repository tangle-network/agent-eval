import { describe, expect, it } from 'vitest'
import { CostLedger, costForUsage, modelPriceKey } from './cost-ledger'

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

describe('CostLedger', () => {
  it('rolls up tokens + cost per channel and in total', () => {
    const ledger = new CostLedger()
    ledger.record({
      model: 'gpt-4o',
      channel: 'agent',
      usage: { inputTokens: 1000, outputTokens: 1000 },
    })
    ledger.record({
      model: 'gpt-4o',
      channel: 'judge',
      usage: { inputTokens: 2000, outputTokens: 0 },
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
    const ledger = new CostLedger()
    ledger.record({
      model: 'made-up-zzz',
      channel: 'agent',
      usage: { inputTokens: 1000, outputTokens: 1000 },
    })
    const s = ledger.summary()
    expect(s.totalCostUsd).toBe(0)
    expect(s.fullyPriced).toBe(false)
    expect(s.unpricedModels).toEqual(['made-up-zzz'])
    expect(s.byChannel[0]!.unpricedCalls).toBe(1)
  })

  it('actualCostUsd overrides the estimate and clears costUnknown', () => {
    const ledger = new CostLedger()
    const e = ledger.record({
      model: 'made-up-zzz',
      channel: 'agent',
      usage: { inputTokens: 1, outputTokens: 1 },
      actualCostUsd: 0.42,
    })
    expect(e.costUsd).toBe(0.42)
    expect(e.costUnknown).toBe(false)
    expect(ledger.summary().fullyPriced).toBe(true)
  })

  it('cost-per-completed-task is null until a task completes', () => {
    const ledger = new CostLedger()
    ledger.record({
      model: 'gpt-4o',
      channel: 'agent',
      usage: { inputTokens: 1000, outputTokens: 0 },
    })
    expect(ledger.costPerCompletedTask()).toBeNull()
    ledger.markCompleted(2)
    expect(ledger.costPerCompletedTask()).toBeCloseTo(0.0025 / 2, 6)
  })
})
