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

  it('normalizes weights across runnable analysts without exceeding the total', async () => {
    const heavy: { budget?: number } = {}
    const light: { budget?: number } = {}
    const reg = new AnalystRegistry()
    reg.register(recorder('heavy', 'trace-store', heavy))
    reg.register(recorder('light', 'trace-store', light))
    reg.register(recorder('skipped', 'artifact-dir', {}))

    await reg.run(
      't',
      { traceStore: {} as never },
      { budget: { totalUsd: 11, weights: { heavy: 10, light: 1, skipped: 100 } } },
    )

    expect(heavy.budget).toBe(10)
    expect(light.budget).toBe(1)
  })

  it('rejects invalid weights before any analyst runs', async () => {
    const sink: { budget?: number } = {}
    const reg = new AnalystRegistry()
    reg.register(recorder('runs', 'trace-store', sink))

    await expect(
      reg.run('t', { traceStore: {} as never }, { budget: { totalUsd: 1, weights: { runs: -1 } } }),
    ).rejects.toThrow(/non-negative finite/)
    expect(sink.budget).toBeUndefined()
  })

  it('rejects an invalid total before any analyst runs', async () => {
    const sink: { budget?: number } = {}
    const reg = new AnalystRegistry()
    reg.register(recorder('runs', 'trace-store', sink))

    await expect(
      reg.run('t', { traceStore: {} as never }, { budget: { totalUsd: Number.NaN } }),
    ).rejects.toThrow(/totalUsd.*non-negative finite/)
    expect(sink.budget).toBeUndefined()
  })

  it('clamps later allocations to the known remaining total', async () => {
    const second: { budget?: number } = {}
    const reg = new AnalystRegistry()
    reg.register({
      ...recorder('first', 'trace-store', {}),
      async analyze(_input, ctx) {
        ctx.recordUsage?.({
          calls: 1,
          tokens: { input: 1, output: 1 },
          cost: { kind: 'observed', usd: 8 },
        })
        return []
      },
    })
    reg.register(recorder('second', 'trace-store', second))

    await reg.run('t', { traceStore: {} as never }, { budget: { totalUsd: 10 } })

    expect(second.budget).toBe(2)
  })

  it('does not reallocate an unknown-cost reservation to a later analyst', async () => {
    const second: { budget?: number } = {}
    const reg = new AnalystRegistry()
    reg.register({
      ...recorder('first', 'trace-store', {}),
      cost: { kind: 'llm' },
      async analyze(_input, ctx) {
        ctx.recordUsage?.({
          calls: 1,
          tokens: null,
          cost: { kind: 'uncaptured', usd: null },
        })
        return []
      },
    })
    reg.register(recorder('second', 'trace-store', second))

    await reg.run(
      't',
      { traceStore: {} as never },
      {
        budget: {
          totalUsd: 10,
          allocate: ({ remainingUsd }) => remainingUsd,
        },
      },
    )

    expect(second.budget).toBe(0)
  })

  it('does not reallocate an unknown-cost reservation after an analyst throws', async () => {
    const second: { budget?: number } = {}
    const reg = new AnalystRegistry()
    reg.register({
      ...recorder('first', 'trace-store', {}),
      cost: { kind: 'llm' },
      async analyze(_input, ctx) {
        ctx.recordUsage?.({
          calls: 1,
          tokens: null,
          cost: { kind: 'uncaptured', usd: null },
        })
        throw new Error('provider disconnected')
      },
    })
    reg.register(recorder('second', 'trace-store', second))

    await reg.run(
      't',
      { traceStore: {} as never },
      {
        budget: {
          totalUsd: 10,
          allocate: ({ remainingUsd }) => remainingUsd,
        },
      },
    )

    expect(second.budget).toBe(0)
  })

  it('debits a hook-expanded reservation from the overall budget', async () => {
    const second: { budget?: number } = {}
    const reg = new AnalystRegistry({
      hooks: {
        onBeforeAnalyze: ({ analyst, ctx }) => {
          if (analyst.id === 'first') ctx.budgetUsd = 10
        },
      },
    })
    reg.register({
      ...recorder('first', 'trace-store', {}),
      cost: { kind: 'llm' },
      async analyze(_input, ctx) {
        ctx.recordUsage?.({
          calls: 1,
          tokens: null,
          cost: { kind: 'uncaptured', usd: null },
        })
        return []
      },
    })
    reg.register(recorder('second', 'trace-store', second))

    await reg.run('t', { traceStore: {} as never }, { budget: { totalUsd: 10 } })

    expect(second.budget).toBe(0)
  })

  it('rejects a hook budget that removes or exceeds the overall cap', async () => {
    for (const override of [undefined, 11] as const) {
      const reg = new AnalystRegistry({
        hooks: {
          onBeforeAnalyze: ({ ctx }) => {
            ctx.budgetUsd = override
          },
        },
      })
      reg.register(recorder('runs', 'trace-store', {}))

      await expect(
        reg.run('t', { traceStore: {} as never }, { budget: { totalUsd: 10 } }),
      ).rejects.toThrow(/cannot be removed|exceeds the remaining overall budget/)
    }
  })

  it('rejects an uncapped custom allocation inside a capped run', async () => {
    const sink: { budget?: number } = {}
    const reg = new AnalystRegistry()
    reg.register(recorder('runs', 'trace-store', sink))

    await expect(
      reg.run(
        't',
        { traceStore: {} as never },
        { budget: { totalUsd: 10, allocate: () => undefined } },
      ),
    ).rejects.toThrow(/cannot return undefined when totalUsd is set/)
    expect(sink.budget).toBeUndefined()
  })
})
