import { describe, expect, it } from 'vitest'
import type { BudgetLedgerEntry, BudgetSpec, Run } from '../trace/schema'
import { InMemoryTraceStore } from '../trace/store'
import { budgetBreachView } from './budget-breach'

function run(runId: string, scenarioId: string, variantId?: string): Run {
  return { runId, scenarioId, variantId, startedAt: 1, status: 'completed' }
}

function entry(
  runId: string,
  dimension: keyof BudgetSpec,
  limit: number,
  consumed: number,
  breached: boolean,
): BudgetLedgerEntry {
  return {
    runId,
    dimension,
    limit,
    consumed,
    remaining: limit - consumed,
    timestamp: 100,
    breached,
  }
}

async function storeWith(runs: Run[], entries: BudgetLedgerEntry[]): Promise<InMemoryTraceStore> {
  const store = new InMemoryTraceStore()
  for (const r of runs) await store.appendRun(r)
  for (const e of entries) await store.appendBudgetEntry(e)
  return store
}

describe('budgetBreachView', () => {
  it('counts only breached:true entries, ignoring non-breached ledger rows', async () => {
    const store = await storeWith(
      [run('r1', 's1')],
      [
        entry('r1', 'tokens', 100, 50, false), // not breached -> ignored
        entry('r1', 'tokens', 100, 150, true), // breached -> counted
      ],
    )
    const report = await budgetBreachView(store)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0]!.consumed).toBe(150)
    expect(report.byDimension).toEqual({ tokens: 1 })
    expect(report.byScenario).toEqual({ s1: 1 })
  })

  it('excessRatio is Infinity (not NaN/crash) when limit === 0', async () => {
    const store = await storeWith([run('r1', 's1')], [entry('r1', 'calls', 0, 5, true)])
    const report = await budgetBreachView(store)
    expect(report.findings).toHaveLength(1)
    const ratio = report.findings[0]!.excessRatio
    expect(ratio).toBe(Infinity)
    expect(Number.isNaN(ratio)).toBe(false)
  })

  it('computes excessRatio as consumed/limit when limit > 0', async () => {
    const store = await storeWith([run('r1', 's1')], [entry('r1', 'usd', 2, 5, true)])
    const report = await budgetBreachView(store)
    expect(report.findings[0]!.excessRatio).toBe(2.5)
  })

  it('tallies byDimension, byScenario, byVariant and breachedRunRatio across runs', async () => {
    const store = await storeWith(
      [run('r1', 's1', 'v1'), run('r2', 's1', 'v2'), run('r3', 's2', 'v1')],
      [
        entry('r1', 'tokens', 100, 200, true),
        entry('r1', 'wallMs', 1000, 2000, true), // two breaches, same run
        entry('r2', 'tokens', 100, 200, true),
        // r3 has only a non-breach entry -> contributes to totalRuns, not breaches
        entry('r3', 'tokens', 100, 10, false),
      ],
    )
    const report = await budgetBreachView(store)
    expect(report.totalRuns).toBe(3)
    expect(report.byDimension).toEqual({ tokens: 2, wallMs: 1 })
    expect(report.byScenario).toEqual({ s1: 3 })
    expect(report.byVariant).toEqual({ v1: 2, v2: 1 })
    // 2 of 3 runs breached at least once
    expect(report.breachedRunRatio).toBeCloseTo(2 / 3, 10)
  })

  it('breachedRunRatio is 0 (not NaN) when there are no runs', async () => {
    const store = new InMemoryTraceStore()
    const report = await budgetBreachView(store)
    expect(report.breachedRunRatio).toBe(0)
    expect(Number.isNaN(report.breachedRunRatio)).toBe(false)
    expect(report.findings).toHaveLength(0)
  })

  it('counts a run breaching multiple dimensions once toward breachedRunRatio', async () => {
    const store = await storeWith(
      [run('r1', 's1')],
      [
        entry('r1', 'tokens', 100, 200, true),
        entry('r1', 'usd', 1, 2, true),
        entry('r1', 'calls', 5, 9, true),
      ],
    )
    const report = await budgetBreachView(store)
    expect(report.findings).toHaveLength(3)
    expect(report.breachedRunRatio).toBe(1)
  })
})
