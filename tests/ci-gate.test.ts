import { describe, expect, it } from 'vitest'
import { evaluateContract, renderMarkdownReport } from '../src/ci-gate'
import { DEFAULT_AGENT_SLOS } from '../src/slo'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'

async function seedRuns(
  store: InMemoryTraceStore,
  variantId: string,
  scores: number[],
): Promise<void> {
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

  // A run that reported no value for a declared metric is missing DATA. Dropping
  // it shrinks the denominator to the runs that reported, so the verdict is read
  // off the subset that answered — and with every run dropped, `pass` was
  // `breaches.length === 0`, i.e. a silent pass on no evidence at all.
  describe('coverage — unmeasured runs', () => {
    async function seedPartialCandidate(
      store: InMemoryTraceStore,
      reported: number,
      total: number,
    ) {
      for (let i = 0; i < total; i++) {
        const e = new TraceEmitter(store)
        await e.startRun({ scenarioId: 'scn', variantId: 'candidate' })
        if (i < reported) await e.endRun({ pass: true, score: 0.99 })
        else await e.endRun({ pass: false })
      }
    }

    it('refuses to pass when the candidate reported the metric on only 3 of 10 runs', async () => {
      const store = new InMemoryTraceStore()
      await seedRuns(store, 'baseline', [0.8, 0.81, 0.79, 0.82, 0.8, 0.81, 0.79, 0.8, 0.81, 0.8])
      await seedPartialCandidate(store, 3, 10)
      const report = await evaluateContract(store, {
        name: 'scn',
        baseline: { variantId: 'baseline' },
        candidate: { variantId: 'candidate' },
        metrics: [{ metric: 'score', higherIsBetter: true, maxRegression: 0.02 }],
      })
      expect(report.pass).toBe(false)
      expect(report.breaches.join(' ')).toMatch(/3\/10/)
      // The verdict the old gate returned — "improved" at candidateMean 0.99 read
      // off 3 runs — is not reachable: no metric verdict is produced at all.
      expect(report.baselineReport.metrics).toEqual([])
      expect(report.coverage).toEqual([
        {
          metric: 'score',
          baselineDealt: 10,
          baselineAnswered: 10,
          candidateDealt: 10,
          candidateAnswered: 3,
          coverage: 13 / 20,
        },
      ])
    })

    it('refuses to pass a declared metric that NO run reported', async () => {
      const store = new InMemoryTraceStore()
      await seedRuns(store, 'baseline', [0.9, 0.9, 0.9, 0.9, 0.9])
      await seedPartialCandidate(store, 0, 5)
      const report = await evaluateContract(store, {
        name: 'scn',
        baseline: { variantId: 'baseline' },
        candidate: { variantId: 'candidate' },
        metrics: [{ metric: 'score', higherIsBetter: true }],
      })
      expect(report.pass).toBe(false)
      expect(report.breaches.length).toBeGreaterThan(0)
      expect(report.coverage[0]?.candidateAnswered).toBe(0)
    })

    it('refuses a metric that every run reported but with too few samples to compare', async () => {
      const store = new InMemoryTraceStore()
      await seedRuns(store, 'baseline', [0.9])
      await seedRuns(store, 'candidate', [0.95])
      const report = await evaluateContract(store, {
        name: 'scn',
        baseline: { variantId: 'baseline' },
        candidate: { variantId: 'candidate' },
        metrics: [{ metric: 'score', higherIsBetter: true }],
      })
      // Full coverage, but nothing comparable — this used to drop the metric and
      // return `pass: true` on an empty breach list.
      expect(report.coverage[0]?.coverage).toBe(1)
      expect(report.pass).toBe(false)
      expect(report.breaches.join(' ')).toMatch(/too few comparable samples/)
    })

    it('refuses a contract that declares neither a metric nor an SLO', async () => {
      const store = new InMemoryTraceStore()
      await seedRuns(store, 'baseline', [0.9, 0.9])
      await seedRuns(store, 'candidate', [0.9, 0.9])
      const report = await evaluateContract(store, {
        name: 'scn',
        baseline: { variantId: 'baseline' },
        candidate: { variantId: 'candidate' },
        metrics: [],
      })
      expect(report.pass).toBe(false)
      expect(report.breaches.join(' ')).toMatch(/nothing was asserted/)
    })

    it('reports full coverage on a contract every run answered', async () => {
      const store = new InMemoryTraceStore()
      await seedRuns(store, 'baseline', [0.8, 0.81, 0.79, 0.82, 0.8, 0.81, 0.79, 0.8, 0.81, 0.8])
      await seedRuns(
        store,
        'candidate',
        [0.85, 0.84, 0.86, 0.85, 0.84, 0.86, 0.85, 0.85, 0.86, 0.85],
      )
      const report = await evaluateContract(store, {
        name: 'scn',
        baseline: { variantId: 'baseline' },
        candidate: { variantId: 'candidate' },
        metrics: [{ metric: 'score', higherIsBetter: true, maxRegression: 0.02 }],
      })
      expect(report.pass).toBe(true)
      expect(report.coverage).toEqual([
        {
          metric: 'score',
          baselineDealt: 10,
          baselineAnswered: 10,
          candidateDealt: 10,
          candidateAnswered: 10,
          coverage: 1,
        },
      ])
    })

    it('a declared minCoverage below 1 still ships the shrunken denominator', async () => {
      const store = new InMemoryTraceStore()
      await seedRuns(store, 'baseline', [0.8, 0.81, 0.79, 0.82, 0.8, 0.81, 0.79, 0.8, 0.81, 0.8])
      await seedPartialCandidate(store, 3, 10)
      const report = await evaluateContract(store, {
        name: 'scn',
        baseline: { variantId: 'baseline' },
        candidate: { variantId: 'candidate' },
        minCoverage: 0.5,
        metrics: [{ metric: 'score', higherIsBetter: true, maxRegression: 0.02 }],
      })
      expect(report.breaches.join(' ')).not.toMatch(/coverage/)
      expect(report.coverage[0]?.candidateAnswered).toBe(3)
      expect(report.coverage[0]?.candidateDealt).toBe(10)
    })

    it('rejects a minCoverage outside [0,1] rather than clamping it', async () => {
      const store = new InMemoryTraceStore()
      await expect(
        evaluateContract(store, {
          name: 'scn',
          baseline: { variantId: 'baseline' },
          candidate: { variantId: 'candidate' },
          minCoverage: 1.5,
          metrics: [{ metric: 'score', higherIsBetter: true }],
        }),
      ).rejects.toThrow(/minCoverage/)
    })

    it('renders the shrunken denominator next to the verdict', async () => {
      const store = new InMemoryTraceStore()
      await seedRuns(store, 'baseline', [0.8, 0.81, 0.79, 0.82, 0.8, 0.81, 0.79, 0.8, 0.81, 0.8])
      await seedPartialCandidate(store, 3, 10)
      const report = await evaluateContract(store, {
        name: 'scn',
        baseline: { variantId: 'baseline' },
        candidate: { variantId: 'candidate' },
        minCoverage: 0.5,
        metrics: [{ metric: 'score', higherIsBetter: true, maxRegression: 0.02 }],
      })
      const md = renderMarkdownReport([report])
      expect(md).toMatch(/Coverage \(measured \/ dealt runs\)/)
      expect(md).toMatch(/candidate 3\/10, baseline 10\/10/)
    })
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
        coverage: [],
        breaches: [],
        pass: true,
      },
    ])
    expect(md).toMatch(/## ✅ agent-eval gate: pass/)
    expect(md).toMatch(/### alpha/)
  })
})
