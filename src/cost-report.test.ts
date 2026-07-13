import { describe, expect, it } from 'vitest'
import type { CostReceipt, CostReceiptInput } from './cost-ledger'
import { CostLedger, costForUsage } from './cost-ledger'
import { attachCostToReport, costReport } from './cost-report'
import { ValidationError } from './errors'

let receiptSequence = 0

function receipt(channel: 'agent' | 'judge', input: CostReceiptInput): CostReceipt {
  const estimated = costForUsage(input.model, input)
  return {
    status: 'settled',
    callId: `fixture-${receiptSequence++}`,
    ...input,
    channel,
    phase: 'test',
    actor: 'fixture',
    costUsd: input.actualCostUsd ?? estimated.costUsd,
    costUnknown: input.actualCostUsd === undefined && estimated.costUnknown,
    timestamp: 1,
  }
}

function buildLedger(): CostLedger {
  return new CostLedger({
    receipts: [
      receipt('agent', { model: 'gpt-4o', inputTokens: 1000, outputTokens: 1000 }),
      receipt('judge', { model: 'gpt-4o', inputTokens: 2000, outputTokens: 0 }),
      receipt('judge', { model: 'made-up-zzz', inputTokens: 1000, outputTokens: 1000 }),
    ],
  })
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
    const ledger = new CostLedger({
      receipts: [
        receipt('agent', {
          model: 'made-up-zzz',
          inputTokens: 100,
          outputTokens: 100,
          actualCostUsd: 0.42,
        }),
      ],
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
