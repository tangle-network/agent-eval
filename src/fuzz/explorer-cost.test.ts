import { describe, expect, it } from 'vitest'
import { CostLedger } from '../cost-ledger'
import { costReport } from '../cost-report'
import { ValidationError } from '../errors'
import { renderCapsuleHtml } from './capsule'
import { BehaviorExplorer } from './explorer'
import type { BehaviorSpace, ExploreOptions } from './types'

const space: BehaviorSpace = { axes: [{ name: 'difficulty', values: ['easy'] }] }

// Single-cell space + uniform allocation + concurrency 1 → the evaluation
// (and costOf) order is fully deterministic.
function makeOpts(overrides: Partial<ExploreOptions<string>>): ExploreOptions<string> {
  let n = 0
  return {
    target: 'cost-target',
    space,
    proposer: (ctx) => Array.from({ length: ctx.count }, () => `p-${n++}`),
    evaluate: async () => ({ valid: true, score: 0.9 }),
    seedsFor: () => ['seed-0'],
    scenarioId: (s) => s,
    allocation: 'uniform',
    budget: 50,
    seed: 3,
    ...overrides,
  }
}

describe('BehaviorExplorer cost budget', () => {
  it('stops the loop when accumulated known cost reaches costBudgetUsd', async () => {
    const explorer = new BehaviorExplorer(
      makeOpts({ costOf: () => ({ usd: 1 }), costBudgetUsd: 3 }),
    )
    const capsule = await explorer.run()
    expect(capsule.stats.totalRuns).toBe(3)
    expect(capsule.stats.costUsd).toBe(3)
    expect(capsule.stats.costUnknownRuns).toBe(0)
  })

  it('a zero budget stops before any evaluation — same >= semantics as control-runtime', async () => {
    const explorer = new BehaviorExplorer(
      makeOpts({ costOf: () => ({ usd: 1 }), costBudgetUsd: 0 }),
    )
    const capsule = await explorer.run()
    expect(capsule.stats.totalRuns).toBe(0)
    expect(capsule.stats.costUsd).toBe(0)
  })

  it('counts unknown-cost runs separately — never as $0, never against the budget', async () => {
    let call = 0
    const onCost: Array<{ usd: number; channel: string }> = []
    const explorer = new BehaviorExplorer(
      makeOpts({
        budget: 4,
        // Runs 1 and 3 cost $1; runs 2 and 4 have unknown cost.
        costOf: () => (call++ % 2 === 0 ? { usd: 1 } : null),
        costBudgetUsd: 10,
        onCost: (e) => onCost.push(e),
      }),
    )
    const capsule = await explorer.run()
    expect(capsule.stats.totalRuns).toBe(4)
    expect(capsule.stats.costUsd).toBe(2)
    expect(capsule.stats.costUnknownRuns).toBe(2)
    expect(onCost).toEqual([
      { usd: 1, channel: 'agent' },
      { usd: 1, channel: 'agent' },
    ])
  })

  it('records known costs into the supplied ledger with channel agent + actualCostUsd', async () => {
    const ledger = new CostLedger()
    const explorer = new BehaviorExplorer(
      makeOpts({ budget: 2, costOf: () => ({ usd: 0.5, model: 'gpt-4o' }), ledger }),
    )
    await explorer.run()
    const entries = ledger.list()
    expect(entries).toHaveLength(2)
    for (const entry of entries) {
      expect(entry.channel).toBe('agent')
      expect(entry.actualCostUsd).toBe(0.5)
      expect(entry.costUnknown).toBe(false)
      expect(entry.model).toBe('gpt-4o')
      expect(entry.tags?.target).toBe('cost-target')
    }
    const report = costReport(ledger)
    expect(report.perModel).toEqual([{ model: 'gpt-4o', usd: 1, entries: 2, unpriced: false }])
  })

  it('labels ledger entries unattributed when costOf names no model', async () => {
    const ledger = new CostLedger()
    const explorer = new BehaviorExplorer(
      makeOpts({ budget: 1, costOf: () => ({ usd: 0.25 }), ledger }),
    )
    await explorer.run()
    expect(ledger.list().map((e) => e.model)).toEqual(['unattributed'])
  })

  it('rejects negative, NaN, and infinite budgets loudly', () => {
    const costOf = () => ({ usd: 1 })
    for (const bad of [-1, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new BehaviorExplorer(makeOpts({ costOf, costBudgetUsd: bad }))).toThrow(
        /costBudgetUsd must be a nonnegative finite number/,
      )
    }
  })

  it('rejects cost options without costOf — the explorer cannot know run cost', () => {
    expect(() => new BehaviorExplorer(makeOpts({ costBudgetUsd: 3 }))).toThrow(ValidationError)
    expect(() => new BehaviorExplorer(makeOpts({ ledger: new CostLedger() }))).toThrow(
      ValidationError,
    )
    expect(() => new BehaviorExplorer(makeOpts({ onCost: () => {} }))).toThrow(ValidationError)
  })

  it('rejects a fabricated costOf number loudly — null is the only unknown', async () => {
    const explorer = new BehaviorExplorer(
      makeOpts({ budget: 1, costOf: () => ({ usd: Number.NaN }) }),
    )
    await expect(explorer.run()).rejects.toThrow(/costOf returned an invalid usd/)
  })

  it('omits cost stats entirely when cost tracking is not wired — absent, never $0', async () => {
    const capsule = await new BehaviorExplorer(makeOpts({ budget: 2 })).run()
    expect(capsule.stats.costUsd).toBeUndefined()
    expect(capsule.stats.costUnknownRuns).toBeUndefined()
  })
})

describe('renderCapsuleHtml cost KPI', () => {
  it('shows the known-dollar KPI when cost tracking was wired', async () => {
    const explorer = new BehaviorExplorer(
      makeOpts({ costOf: () => ({ usd: 1 }), costBudgetUsd: 3 }),
    )
    const html = renderCapsuleHtml(await explorer.run())
    expect(html).toContain('$3.00')
    expect(html).not.toContain('runs unpriced')
  })

  it('names the unpriced-run count next to the total — the dollar figure is a lower bound', async () => {
    let call = 0
    const explorer = new BehaviorExplorer(
      makeOpts({ budget: 4, costOf: () => (call++ % 2 === 0 ? { usd: 1 } : null) }),
    )
    const html = renderCapsuleHtml(await explorer.run())
    expect(html).toContain('$2.00')
    expect(html).toContain('2 runs unpriced')
  })

  it('shows no dollar KPI at all when cost was not tracked', async () => {
    const html = renderCapsuleHtml(await new BehaviorExplorer(makeOpts({ budget: 2 })).run())
    expect(/\$\d/.test(html)).toBe(false)
    expect(html).not.toContain('runs unpriced')
  })
})
