import { describe, expect, it, vi } from 'vitest'
import { CostLedger, type CostLedgerPersistence, type CostLedgerRecord } from './cost-ledger'

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}

function observed(actualCostUsd: number) {
  return { model: 'fixture', inputTokens: 0, outputTokens: 0, actualCostUsd }
}

function stored() {
  let events = ''
  const persistence: CostLedgerPersistence = {
    read: () => ({ revision: String(events.length), events }),
    append: (revision, event) => {
      if (revision !== String(events.length)) return undefined
      events += event
      return String(events.length)
    },
  }
  return persistence
}

describe('CostLedger admission', () => {
  it('scans records once without constructing reporting summaries', async () => {
    const ledger = new CostLedger({ costCeilingUsd: 100 })
    const summary = vi.spyOn(ledger, 'summary')
    const records = (ledger as unknown as { records: Map<string, CostLedgerRecord> }).records
    const values = records.values.bind(records)
    let visits = 0
    vi.spyOn(records, 'values').mockImplementation(function* (): Generator<CostLedgerRecord, undefined> {
      for (const record of values()) {
        visits += 1
        yield record
      }
      return undefined
    })
    for (let i = 0; i < 12; i += 1) {
      const result = await ledger.runPaidCall({
        callId: `call-${i}`,
        actor: 'fixture',
        channel: 'agent',
        phase: 'test',
        maximumCharge: { externallyEnforcedMaximumUsd: 1 },
        execute: async () => i,
        receipt: () => observed(1),
      })
      expect(result.succeeded).toBe(true)
    }
    expect(summary).not.toHaveBeenCalled()
    expect(visits).toBe((12 * 11) / 2)
  })

  it('preserves record-order sums after out-of-order settlements and replay', async () => {
    const large = 2 ** 53
    const persistence = stored()
    const ledger = new CostLedger({ costCeilingUsd: large + 8, persistence })
    const gates = [deferred<number>(), deferred<number>(), deferred<number>()] as const
    const calls = [
      { gate: gates[0], amount: large },
      { gate: gates[1], amount: 1 },
      { gate: gates[2], amount: 1 },
    ]
    const results = calls.map(({ gate, amount }, i) =>
      ledger.runPaidCall({
        callId: `call-${i}`,
        actor: 'fixture',
        channel: 'agent',
        phase: 'test',
        maximumCharge: { externallyEnforcedMaximumUsd: amount },
        execute: () => gate.promise,
        receipt: observed,
      }),
    )
    gates[1].resolve(1)
    gates[2].resolve(1)
    expect(await results[1]).toMatchObject({ succeeded: true })
    expect(await results[2]).toMatchObject({ succeeded: true })
    gates[0].resolve(large)
    expect(await results[0]).toMatchObject({ succeeded: true })
    expect(ledger.summary().totalCostUsd).toBe(large)

    for (const current of [ledger, new CostLedger({ persistence: storedCopy(persistence) })]) {
      const result = await current.runPaidCall({
        callId: 'boundary',
        actor: 'fixture',
        channel: 'agent',
        phase: 'test',
        maximumCharge: { externallyEnforcedMaximumUsd: 8 },
        execute: async () => 8,
        receipt: observed,
      })
      expect(result.succeeded).toBe(true)
      expect(current.summary().totalCostUsd).toBe(large + 8)
    }
  })

  it('reconciles by call ID without walking unrelated records', () => {
    const persistence = stored()
    const { revision } = persistence.read()
    persistence.append(
      revision,
      `${JSON.stringify({
        version: 1,
        record: {
          status: 'pending',
          callId: 'interrupted',
          actor: 'fixture',
          channel: 'agent',
          phase: 'test',
          model: 'fixture',
          timestamp: 1,
        },
      })}\n`,
    )
    const ledger = new CostLedger({ persistence })
    const records = (ledger as unknown as { records: Map<string, CostLedgerRecord> }).records
    const values = vi.spyOn(records, 'values')
    expect(ledger.reconcile('interrupted', observed(0)).costUsd).toBe(0)
    expect(() => ledger.reconcile('missing', observed(0))).toThrow("no pending call 'missing'")
    expect(() => ledger.reconcile('interrupted', observed(0))).toThrow(
      "no pending call 'interrupted'",
    )
    expect(values).not.toHaveBeenCalled()
  })
})

function storedCopy(source: CostLedgerPersistence): CostLedgerPersistence {
  const copy = stored()
  copy.append(copy.read().revision, source.read().events)
  return copy
}
