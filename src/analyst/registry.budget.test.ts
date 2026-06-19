import { describe, expect, it } from 'vitest'
import { AnalystRegistry } from './registry'
import type { Analyst, AnalystContext, AnalystFinding } from './types'

function recorder(id: string, inputKind: Analyst['inputKind'], sink: { budget?: number }): Analyst {
  return {
    id,
    description: id,
    inputKind,
    cost: { kind: 'deterministic' },
    version: '1.0.0',
    async analyze(_input: unknown, ctx: AnalystContext): Promise<AnalystFinding[]> {
      sink.budget = ctx.budgetUsd
      return []
    },
  }
}

describe('AnalystRegistry budget allocation', () => {
  it('splits budget across analysts that actually run, not ones skipped for missing input', async () => {
    const sink: { budget?: number } = {}
    const reg = new AnalystRegistry()
    reg.register(recorder('runs', 'trace-store', sink))
    // artifact-dir input is NOT supplied → this analyst is skipped, so it must
    // not dilute the budget of the one that runs.
    reg.register(recorder('skipped', 'artifact-dir', {}))

    await reg.run('t', { traceStore: {} as never }, { budget: { totalUsd: 10 } })

    // runnableCount = 1 → full budget. The pre-fix code divided by 2 → 5.
    expect(sink.budget).toBe(10)
  })
})
