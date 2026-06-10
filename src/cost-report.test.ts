import { describe, expect, it } from 'vitest'
import { CostLedger } from './cost-ledger'
import { attachCostToReport, costReport } from './cost-report'
import { ValidationError } from './errors'

function buildLedger(): CostLedger {
  const ledger = new CostLedger()
  // gpt-4o: 0.0025 in + 0.01 out per 1k
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
  // Unpriced model — costUnknown, the $0 is a lower bound, not a measured zero.
  ledger.record({
    model: 'made-up-zzz',
    channel: 'judge',
    usage: { inputTokens: 1000, outputTokens: 1000 },
  })
  return ledger
}

describe('costReport', () => {
  it('projects per-channel, total, and per-model rollups from the ledger', () => {
    const report = costReport(buildLedger())

    expect(report.perChannel.map((c) => c.channel)).toEqual(['agent', 'judge'])
    const judge = report.perChannel.find((c) => c.channel === 'judge')
    expect(judge?.calls).toBe(2)
    expect(judge?.unpricedCalls).toBe(1)

    expect(report.total.usd).toBeCloseTo(0.0125 + 0.005, 6)
    expect(report.total.unknownEntries).toBe(1)

    expect(report.perModel.map((m) => m.model)).toEqual(['gpt-4o', 'made-up-zzz'])
    expect(report.perModel[0]).toEqual({
      model: 'gpt-4o',
      usd: 0.0175,
      entries: 2,
      unpriced: false,
    })
  })

  it('flags an unpriced model unpriced:true — its $0 is never a measured zero', () => {
    const report = costReport(buildLedger())
    const unpriced = report.perModel.find((m) => m.model === 'made-up-zzz')
    expect(unpriced).toEqual({ model: 'made-up-zzz', usd: 0, entries: 1, unpriced: true })
  })

  it('an actualCostUsd override clears unpriced — observed dollars are real', () => {
    const ledger = new CostLedger()
    ledger.record({
      model: 'made-up-zzz',
      channel: 'agent',
      usage: { inputTokens: 100, outputTokens: 100 },
      actualCostUsd: 0.42,
    })
    const report = costReport(ledger)
    expect(report.perModel[0]).toEqual({
      model: 'made-up-zzz',
      usd: 0.42,
      entries: 1,
      unpriced: false,
    })
    expect(report.total.unknownEntries).toBe(0)
  })

  it('an empty ledger projects to zeros, never throws', () => {
    const report = costReport(new CostLedger())
    expect(report).toEqual({
      perChannel: [],
      total: { usd: 0, unknownEntries: 0 },
      perModel: [],
    })
  })
})

describe('attachCostToReport', () => {
  it('stamps the projection under cost and preserves the report fields', () => {
    const stamped = attachCostToReport({ verdict: 'ship', lift: 0.04 }, buildLedger())
    expect(stamped.verdict).toBe('ship')
    expect(stamped.lift).toBe(0.04)
    expect(stamped.cost.total.unknownEntries).toBe(1)
    expect(stamped.cost.perModel).toHaveLength(2)
  })

  it('refuses to overwrite an existing cost stamp', () => {
    expect(() => attachCostToReport({ cost: 'already-stamped' }, new CostLedger())).toThrow(
      ValidationError,
    )
  })
})
