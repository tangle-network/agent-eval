import { describe, expect, it } from 'vitest'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'
import { BudgetBreachError, BudgetGuard } from '../src/budget-guard'

describe('BudgetGuard', () => {
  it('records ledger entries on charge', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const guard = new BudgetGuard(e, { tokens: 100 })
    await guard.charge({ tokens: 25 })
    await guard.charge({ tokens: 40 })
    const entries = await store.budget(e.runId)
    expect(entries).toHaveLength(2)
    expect(entries[1].consumed).toBe(65)
    expect(entries[1].remaining).toBe(35)
    expect(entries[1].breached).toBe(false)
  })

  it('throws BudgetBreachError when limit is exceeded — regression: silent breaches continue charging money', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const guard = new BudgetGuard(e, { tokens: 50 })
    await guard.charge({ tokens: 40 })
    await expect(guard.charge({ tokens: 20 })).rejects.toBeInstanceOf(BudgetBreachError)
    const events = await store.events({ kind: 'budget_breach' })
    expect(events).toHaveLength(1)
  })

  it('rejects negative/non-finite charges — regression: NaN contaminates the ledger silently', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const guard = new BudgetGuard(e, { tokens: 100 })
    await expect(guard.charge({ tokens: -1 })).rejects.toThrow(/non-finite or negative/)
    await expect(guard.charge({ tokens: NaN })).rejects.toThrow(/non-finite or negative/)
  })

  it('dimensions without a declared limit charge without breach', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const guard = new BudgetGuard(e, { tokens: 100 }) // no usd limit
    await guard.charge({ usd: 10 })
    // No ledger entry when no limit declared
    expect((await store.budget(e.runId))).toHaveLength(0)
    expect(guard.state.usd).toBe(10)
  })

  it('tickWall advances wallMs budget from clock', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    let now = 1000
    const guard = new BudgetGuard(e, { wallMs: 5000 }, () => now)
    now = 2000
    await guard.tickWall(now)
    const entries = await store.budget(e.runId)
    expect(entries).toHaveLength(1)
    expect(entries[0].consumed).toBe(1000)
  })
})
