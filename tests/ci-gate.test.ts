import { describe, expect, it } from 'vitest'
import { evaluateContract, renderMarkdownReport } from '../src/ci-gate'
import { DEFAULT_AGENT_SLOS } from '../src/slo'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

async function seedRuns(store: InMemoryTraceStore, variantId: string, scores: number[]): Promise<void> {
  for (const s of scores) {
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 'scn', variantId })
    await e.endRun({ pass: true, score: s })
  }
}

describe('evaluateContract', () => {
  it('passes when candidate is equal-or-better than baseline', async () => {
    const store = new InMemoryTraceStore()
    await seedRuns(store, 'baseline', [0.8, 0.81, 0.79, 0.82, 0.8, 0.81, 0.79, 0.8, 0.81, 0.8])
    await seedRuns(store, 'candidate', [0.85, 0.84, 0.86, 0.85, 0.84, 0.86, 0.85, 0.85, 0.86, 0.85])
    const report = await evaluateContract(store, {
      name: 'scn',
      baseline: { variantId: 'baseline' },
      candidate: { variantId: 'candidate' },
      metrics: [{ metric: 'score', higherIsBetter: true, maxRegression: 0.02 }],
    })
    expect(report.pass).toBe(true)
  })

  it('fails on meaningful regression beyond maxRegression — regression: gate must actually block CI', async () => {
    const store = new InMemoryTraceStore()
    await seedRuns(store, 'baseline', [0.9, 0.91, 0.89, 0.9, 0.91, 0.89, 0.9, 0.91, 0.89, 0.9])
    await seedRuns(store, 'candidate', [0.6, 0.61, 0.59, 0.6, 0.61, 0.59, 0.6, 0.61, 0.59, 0.6])
    const report = await evaluateContract(store, {
      name: 'scn',
      baseline: { variantId: 'baseline' },
      candidate: { variantId: 'candidate' },
      metrics: [{ metric: 'score', higherIsBetter: true, maxRegression: 0.05 }],
    })
    expect(report.pass).toBe(false)
    expect(report.breaches.length).toBeGreaterThan(0)
  })

  it('fails when SLOs breach even without regression', async () => {
    const store = new InMemoryTraceStore()
    // Candidates all pass=false → passRate=0, breaching the default pass_rate SLO
    for (let i = 0; i < 5; i++) {
      const e = new TraceEmitter(store)
      await e.startRun({ scenarioId: 'scn', variantId: 'candidate' })
      await e.endRun({ pass: false })
    }
    await seedRuns(store, 'baseline', [1, 1, 1, 1, 1, 1, 1, 1, 1, 1])
    const report = await evaluateContract(store, {
      name: 'scn',
      baseline: { variantId: 'baseline' },
      candidate: { variantId: 'candidate' },
      metrics: [],
      slos: DEFAULT_AGENT_SLOS,
    })
    expect(report.pass).toBe(false)
    expect(report.breaches.some((b) => b.includes('pass_rate'))).toBe(true)
  })

  it('returns explicit failure when no candidates match', async () => {
    const store = new InMemoryTraceStore()
    const report = await evaluateContract(store, {
      name: 'scn',
      baseline: { variantId: 'baseline' },
      candidate: { variantId: 'missing' },
      metrics: [{ metric: 'score', higherIsBetter: true }],
    })
    expect(report.pass).toBe(false)
    expect(report.breaches[0]).toMatch(/no candidate/)
  })
})

describe('renderMarkdownReport', () => {
  it('produces a pass header + per-contract section', () => {
    const md = renderMarkdownReport([
      {
        name: 'alpha',
        baselineReport: { metrics: [], hasRegression: false, hasUnstable: false },
        breaches: [],
        pass: true,
      },
    ])
    expect(md).toMatch(/## ✅ agent-eval gate: pass/)
    expect(md).toMatch(/### alpha/)
  })
})
