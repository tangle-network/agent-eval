import { describe, expect, it } from 'vitest'
import { proposeSynthesisTargets } from '../src/active-learning'
import { Dataset } from '../src/dataset'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

// ── active learning ──────────────────────────────────────────────────

describe('proposeSynthesisTargets', () => {
  it('flags difficulty gaps', async () => {
    const dataset = new Dataset({
      name: 'd',
      provenance: { version: '1.0', createdAt: new Date().toISOString() },
      scenarios: [
        { id: 'a', payload: {}, difficulty: 'easy' },
        { id: 'b', payload: {}, difficulty: 'easy' },
        // no hard/extreme
      ],
    })
    const store = new InMemoryTraceStore()
    const targets = await proposeSynthesisTargets(dataset, store, { minPerBand: 3 })
    expect(targets.some((t) => t.reason === 'difficulty-gap')).toBe(true)
  })

  it('flags failure-cluster when ≥3 runs fail with same class — regression: silent class-level weakness stays hidden', async () => {
    const store = new InMemoryTraceStore()
    for (let i = 0; i < 4; i++) {
      const e = new TraceEmitter(store)
      await e.startRun({ scenarioId: 's1' })
      const t = await e.tool({ name: 'search', toolName: 'search', args: {} })
      await t.fail('500')
      const t2 = await e.tool({ name: 'search', toolName: 'search', args: {} })
      await t2.fail('500')
      const t3 = await e.tool({ name: 'search', toolName: 'search', args: {} })
      await t3.fail('500')
      await e.endRun({ pass: false })
    }
    const dataset = new Dataset({
      name: 'd',
      provenance: { version: '1.0', createdAt: new Date().toISOString() },
      scenarios: [{ id: 's1', payload: {} }],
    })
    const targets = await proposeSynthesisTargets(dataset, store)
    expect(targets.some((t) => t.reason === 'failure-cluster')).toBe(true)
  })
})
