import { describe, expect, it } from 'vitest'
import {
  budgetBreachView,
  failureClusterView,
  firstDivergenceView,
  judgeAgreementView,
  regressionView,
  stuckLoopView,
  toolWasteView,
} from '../src/pipelines'
import type { ToolSpan } from '../src/trace'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

async function runWithTools(
  store: InMemoryTraceStore,
  scenarioId: string,
  toolNames: string[],
  args: unknown[] = [],
): Promise<string> {
  let now = 0
  const e = new TraceEmitter(store, { now: () => now++ })
  await e.startRun({ scenarioId })
  for (let i = 0; i < toolNames.length; i++) {
    const h = await e.tool({
      name: toolNames[i],
      toolName: toolNames[i],
      args: args[i] ?? { q: toolNames[i] },
    })
    await h.end({ latencyMs: 10, result: `result-${i}` } as Partial<ToolSpan>)
  }
  await e.endRun({ pass: true })
  return e.runId
}

describe('stuckLoopView', () => {
  it('flags ≥3 repeated identical calls — regression: silent loops burn budget and confuse users', async () => {
    const store = new InMemoryTraceStore()
    await runWithTools(
      store,
      'loopy',
      ['search', 'search', 'search', 'search'],
      [{ q: 'x' }, { q: 'x' }, { q: 'x' }, { q: 'x' }],
    )
    const report = await stuckLoopView(store)
    expect(report.findings).toHaveLength(1)
    expect(report.findings[0].occurrences).toBe(4)
    expect(report.affectedRunRatio).toBe(1)
  })

  it('does not flag diverse calls', async () => {
    const store = new InMemoryTraceStore()
    await runWithTools(store, 'ok', ['search', 'write', 'read'])
    const report = await stuckLoopView(store)
    expect(report.findings).toHaveLength(0)
  })
})

describe('toolWasteView', () => {
  it('counts errored tools as wasted', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 'x' })
    const a = await e.tool({ name: 'search', toolName: 'search', args: {} })
    await a.fail('boom')
    const b = await e.tool({ name: 'read', toolName: 'read', args: {} })
    await b.end({ result: 'ok' } as Partial<ToolSpan>)
    await e.endRun({ pass: true })
    const report = await toolWasteView(store)
    expect(report.byRun[0].wastedCalls).toBeGreaterThanOrEqual(1)
  })
})

describe('budgetBreachView', () => {
  it('aggregates breach events by dimension + run', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 'over' })
    await e.recordBudget({
      dimension: 'tokens',
      limit: 10,
      consumed: 20,
      remaining: -10,
      breached: true,
    })
    await e.endRun({ pass: false })
    const report = await budgetBreachView(store)
    expect(report.findings).toHaveLength(1)
    expect(report.byDimension.tokens).toBe(1)
    expect(report.breachedRunRatio).toBe(1)
  })

  it('empty when no runs match', async () => {
    const store = new InMemoryTraceStore()
    const report = await budgetBreachView(store)
    expect(report.findings).toHaveLength(0)
  })
})

describe('failureClusterView', () => {
  it('groups failures by class + trigger', async () => {
    const store = new InMemoryTraceStore()
    for (let i = 0; i < 3; i++) {
      const e = new TraceEmitter(store)
      await e.startRun({ scenarioId: `scn-${i}` })
      const t = await e.tool({ name: 'search', toolName: 'search', args: { q: 'same' } })
      await t.fail('HTTP 500')
      const t2 = await e.tool({ name: 'search', toolName: 'search', args: { q: 'same' } })
      await t2.fail('HTTP 500')
      const t3 = await e.tool({ name: 'search', toolName: 'search', args: { q: 'same' } })
      await t3.fail('HTTP 500')
      await e.endRun({ pass: false })
    }
    const report = await failureClusterView(store)
    expect(report.totalFailures).toBe(3)
    expect(report.clusters[0].failureClass).toBe('tool_recovery_failure')
    expect(report.clusters[0].toolName).toBe('search')
    expect(report.clusters[0].runCount).toBe(3)
  })

  it('populates dimension from judge trigger span — regression: aggregators were overloading argPrefix to encode dimension', async () => {
    const store = new InMemoryTraceStore()
    for (let i = 0; i < 2; i++) {
      const e = new TraceEmitter(store)
      await e.startRun({ scenarioId: `scn-${i}` })
      const target = await e.span({ kind: 'llm', name: 'call', model: 'claude', messages: [] })
      await target.end()
      await e.recordJudge({
        judgeId: 'fmt',
        targetSpanId: target.span.spanId,
        dimension: 'format',
        score: 0.1,
        name: 'fmt-judge',
      })
      await e.endRun({ pass: false })
    }
    const report = await failureClusterView(store)
    expect(report.totalFailures).toBe(2)
    expect(report.clusters).toHaveLength(1)
    expect(report.clusters[0].failureClass).toBe('format_drift')
    expect(report.clusters[0].dimension).toBe('format')
    expect(report.clusters[0].runCount).toBe(2)
  })
})

describe('judgeAgreementView', () => {
  it('returns pairwise Pearson and κ — regression: disagreement that stays hidden breaks calibration', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const target = await e.span({ kind: 'llm', name: 'call', model: 'claude', messages: [] })
    await target.end()
    const target2 = await e.span({ kind: 'llm', name: 'call', model: 'claude', messages: [] })
    await target2.end()
    for (const [judge, scores] of [
      ['claude-judge', [0.8, 0.9]],
      ['gpt-judge', [0.85, 0.88]],
    ] as const) {
      await e.recordJudge({
        judgeId: judge,
        targetSpanId: target.span.spanId,
        dimension: 'quality',
        score: scores[0],
        name: `${judge}-q`,
      })
      await e.recordJudge({
        judgeId: judge,
        targetSpanId: target2.span.spanId,
        dimension: 'quality',
        score: scores[1],
        name: `${judge}-q`,
      })
    }
    const report = await judgeAgreementView(store)
    expect(report.pairs).toHaveLength(1)
    expect(report.pairs[0].commonItems).toBe(2)
    expect(report.pairs[0].pearson).toBeGreaterThan(0)
    expect(report.judgeIds).toEqual(['claude-judge', 'gpt-judge'])
  })
})

describe('firstDivergenceView', () => {
  it('reports first differing step with a reason', async () => {
    const store = new InMemoryTraceStore()
    const runA = await runWithTools(store, 's', ['search', 'write', 'read'])
    const runB = await runWithTools(store, 's', ['search', 'delete', 'read'])
    const report = await firstDivergenceView(store, runA, runB)
    expect(report.firstDivergenceIndex).toBe(1)
    expect(report.reason).toContain('write')
    expect(report.reason).toContain('delete')
    expect(report.commonPrefixLen).toBe(1)
  })

  it('returns null index when identical', async () => {
    const store = new InMemoryTraceStore()
    const a = await runWithTools(store, 's', ['search', 'write'])
    const b = await runWithTools(store, 's', ['search', 'write'])
    const r = await firstDivergenceView(store, a, b)
    expect(r.firstDivergenceIndex).toBeNull()
  })
})

describe('regressionView', () => {
  it('detects score regression on candidate slice', async () => {
    const store = new InMemoryTraceStore()
    // baseline: 10 runs with score ~0.9
    for (let i = 0; i < 10; i++) {
      const e = new TraceEmitter(store)
      await e.startRun({ scenarioId: 's', variantId: 'baseline' })
      await e.endRun({ pass: true, score: 0.9 + (i % 2) * 0.01 })
    }
    // candidate: 10 runs with score ~0.6
    for (let i = 0; i < 10; i++) {
      const e = new TraceEmitter(store)
      await e.startRun({ scenarioId: 's', variantId: 'candidate' })
      await e.endRun({ pass: true, score: 0.6 + (i % 2) * 0.01 })
    }
    const report = await regressionView(store, [{ metric: 'score', higherIsBetter: true }], {
      baseline: { variantId: 'baseline' },
      candidate: { variantId: 'candidate' },
    })
    expect(report.hasRegression).toBe(true)
    expect(report.metrics[0].verdict).toBe('regressed')
  })
})
