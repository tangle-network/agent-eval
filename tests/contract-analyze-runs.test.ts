/**
 * analyzeRuns + intake adapters — integration tests exercising both
 * customer journeys end-to-end.
 *
 *   - Customer A: research outputs with multi-rater approve/reject →
 *     fromFeedbackTable → analyzeRuns. We expect interRater agreement,
 *     a recalibrate recommendation when raters disagree, and per-run
 *     mean ratings flowing into the composite distribution.
 *
 *   - Customer B: OTel production spans → fromOtelSpans → analyzeRuns.
 *     We expect runs grouped by tangle.runId, failures surfaced when
 *     spans carry ERROR status, and a Pareto pass-through.
 *
 * Also covers the lift / outcome correlation / contamination axes
 * directly against synthetic RunRecords.
 */

import { describe, expect, it } from 'vitest'
import {
  analyzeRuns,
  type FeedbackTableRow,
  fromFeedbackTable,
  fromOtelSpans,
  type InsightReport,
} from '../src/contract'
import type { TraceSpanEvent } from '../src/hosted/types'
import type { RunRecord } from '../src/run-record'

// ── Helpers ──────────────────────────────────────────────────────────

function makeRun(opts: {
  id: string
  candidate: string
  composite: number
  cost?: number
  judges?: Record<string, Record<string, number>>
  failureMode?: string
  metadata?: Record<string, unknown>
}): RunRecord {
  const perJudge = opts.judges ?? { default: { quality: opts.composite } }
  const perDimMean: Record<string, number> = {}
  for (const dims of Object.values(perJudge)) {
    for (const [d, v] of Object.entries(dims)) {
      perDimMean[d] = (perDimMean[d] ?? 0) + v / Object.keys(perJudge).length
    }
  }
  const run = {
    runId: opts.id,
    experimentId: 'exp',
    candidateId: opts.candidate,
    seed: 0,
    model: 'm@v',
    promptHash: 'sha256:p',
    configHash: 'sha256:c',
    commitSha: 'abc',
    wallMs: 100,
    costUsd: opts.cost ?? 0.01,
    tokenUsage: { input: 100, output: 50 },
    outcome: {
      holdoutScore: opts.composite,
      raw: {},
      judgeScores: {
        perJudge,
        perDimMean,
        composite: opts.composite,
      },
    },
    splitTag: 'holdout' as const,
    ...(opts.failureMode ? { failureMode: opts.failureMode } : {}),
  } satisfies RunRecord
  if (opts.metadata) Object.assign(run, { metadata: opts.metadata })
  return run
}

// ── analyzeRuns: lift detection ─────────────────────────────────────

describe('analyzeRuns — lift detection with paired bootstrap', () => {
  it('emits a positive lift CI when candidate beats baseline on holdout', async () => {
    const baseline = Array.from({ length: 20 }, (_, i) =>
      makeRun({ id: `b-${i}`, candidate: 'baseline', composite: 0.5 + i * 0.005 }),
    )
    const candidate = Array.from({ length: 20 }, (_, i) =>
      makeRun({ id: `c-${i}`, candidate: 'candidate', composite: 0.6 + i * 0.005 }),
    )
    // Pair on (experimentId, seed) — make seeds match across the two sides.
    for (let i = 0; i < 20; i++) {
      baseline[i]!.seed = i
      candidate[i]!.seed = i
    }
    const report = await analyzeRuns({ runs: [...baseline, ...candidate] })
    expect(report.lift).toBeDefined()
    expect(report.lift!.delta).toBeCloseTo(0.1, 1)
    expect(report.lift!.ci95[0]).toBeGreaterThan(0)
    expect(report.lift!.n).toBe(20)
    expect(report.recommendations.some((r) => r.kind === 'ship')).toBe(true)
  })

  it('emits a hold recommendation when CI lower bound is at or below threshold', async () => {
    const baseline = Array.from({ length: 20 }, (_, i) =>
      makeRun({ id: `b-${i}`, candidate: 'baseline', composite: 0.5 + (i % 5) * 0.01 }),
    )
    const candidate = Array.from({ length: 20 }, (_, i) =>
      makeRun({ id: `c-${i}`, candidate: 'candidate', composite: 0.5 + (i % 5) * 0.01 }),
    )
    for (let i = 0; i < 20; i++) {
      baseline[i]!.seed = i
      candidate[i]!.seed = i
    }
    const report = await analyzeRuns({ runs: [...baseline, ...candidate] })
    expect(report.lift).toBeDefined()
    expect(report.lift!.delta).toBeCloseTo(0, 2)
    expect(report.recommendations.some((r) => r.kind === 'hold')).toBe(true)
  })

  it('emits an expand-corpus recommendation when CI straddles threshold', async () => {
    const baseline = Array.from({ length: 6 }, (_, i) =>
      makeRun({ id: `b-${i}`, candidate: 'baseline', composite: 0.5 }),
    )
    const candidate = Array.from({ length: 6 }, (_, i) =>
      makeRun({ id: `c-${i}`, candidate: 'candidate', composite: 0.51 + (i - 3) * 0.05 }),
    )
    for (let i = 0; i < 6; i++) {
      baseline[i]!.seed = i
      candidate[i]!.seed = i
    }
    const report = await analyzeRuns({ runs: [...baseline, ...candidate] })
    expect(report.lift).toBeDefined()
    const kinds = report.recommendations.map((r) => r.kind)
    expect(kinds).toContain('expand-corpus')
  })
})

// ── analyzeRuns: outcome correlation + reward model ────────────────

describe('analyzeRuns — outcome correlation + reward model', () => {
  it('fits a linear reward model when judge scores correlate with engagement', async () => {
    const runs = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `r-${i}`, candidate: 'c', composite: 0.3 + i * 0.02 }),
    )
    // Engagement perfectly tracks composite with slope 2 + deterministic noise.
    const valueByRunId: Record<string, number> = {}
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i]!
      const noise = ((i * 7) % 11) / 1000 - 0.005 // deterministic ±0.005
      valueByRunId[r.runId] = 2 * r.outcome.holdoutScore! + noise
    }
    const report = await analyzeRuns({
      runs,
      outcomeSignal: { metric: 'engagement_rate', valueByRunId },
    })
    expect(report.outcomeCorrelation).toBeDefined()
    expect(report.outcomeCorrelation!.pearson).toBeGreaterThan(0.9)
    expect(report.outcomeCorrelation!.rewardModel!.slope).toBeCloseTo(2, 1)
  })

  it('emits a recalibrate recommendation when correlation is weak', async () => {
    const runs = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `r-${i}`, candidate: 'c', composite: 0.3 + i * 0.02 }),
    )
    // Engagement deterministically decoupled from composite — the values
    // alternate high/low independent of composite, producing |Spearman| < 0.3
    // every run. Random sampling would flake.
    const valueByRunId: Record<string, number> = {}
    for (let i = 0; i < runs.length; i++) {
      valueByRunId[runs[i]!.runId] = i % 2 === 0 ? 0.2 : 0.8
    }
    const report = await analyzeRuns({
      runs,
      outcomeSignal: { metric: 'engagement_rate', valueByRunId },
    })
    expect(report.outcomeCorrelation).toBeDefined()
    expect(Math.abs(report.outcomeCorrelation!.spearman)).toBeLessThan(0.3)
    expect(report.recommendations.some((r) => r.kind === 'recalibrate')).toBe(true)
  })
})

// ── analyzeRuns: contamination check ───────────────────────────────

describe('analyzeRuns — canary contamination', () => {
  it('flags canary leaks when a run output contains a holdout canary', async () => {
    const runs = [
      makeRun({
        id: 'r-1',
        candidate: 'c',
        composite: 0.8,
        metadata: { output: 'the lazy dog jumped over secret-canary-xyz123' },
      }),
    ]
    const report = await analyzeRuns({
      runs,
      canaryScenarios: [
        {
          id: 'canary-1',
          input: 'irrelevant',
          canary: 'secret-canary-xyz123',
        } as Parameters<typeof analyzeRuns>[0]['canaryScenarios'] extends infer T
          ? T extends Array<infer U>
            ? U
            : never
          : never,
      ],
    })
    expect(report.contamination).toBeDefined()
    expect(report.contamination!.leaks).toBe(1)
    expect(report.recommendations.some((r) => r.kind === 'fix')).toBe(true)
  })
})

// ── fromFeedbackTable: Customer A journey ──────────────────────────

describe('fromFeedbackTable → analyzeRuns: multi-rater approve/reject corpus', () => {
  it('produces runs with rater-averaged composites + emits inter-rater agreement', async () => {
    const ratings: FeedbackTableRow[] = [
      { runId: 'claim-1', rater: 'alice', rating: true },
      { runId: 'claim-1', rater: 'bob', rating: true },
      { runId: 'claim-1', rater: 'carol', rating: true },
      { runId: 'claim-2', rater: 'alice', rating: false },
      { runId: 'claim-2', rater: 'bob', rating: false },
      { runId: 'claim-2', rater: 'carol', rating: true },
      { runId: 'claim-3', rater: 'alice', rating: true },
      { runId: 'claim-3', rater: 'bob', rating: false },
      { runId: 'claim-3', rater: 'carol', rating: true },
    ]
    const { runs, raterScores } = fromFeedbackTable({ ratings })
    expect(runs).toHaveLength(3)
    expect(raterScores).toHaveLength(9)

    const report = await analyzeRuns({ runs, raterScores })
    expect(report.interRater).toBeDefined()
    expect(report.interRater!.raters).toBe(3)
    expect(report.interRater!.jointlyRated).toBe(3)
    expect(report.interRater!.disagreementCases.length).toBeGreaterThan(0)
  })

  it('normalises non-0..1 rating scales when scale is provided', () => {
    const { runs } = fromFeedbackTable({
      ratings: [
        { runId: 'r-1', rater: 'alice', rating: 4 },
        { runId: 'r-1', rater: 'bob', rating: 5 },
      ],
      scale: { min: 1, max: 5 },
    })
    expect(runs[0]!.outcome.holdoutScore).toBeCloseTo(0.875, 3)
  })
})

// ── fromOtelSpans: Customer B journey ──────────────────────────────

describe('fromOtelSpans → analyzeRuns: OTel observability corpus', () => {
  function span(
    overrides: Partial<TraceSpanEvent> & Pick<TraceSpanEvent, 'traceId' | 'spanId' | 'name'>,
  ): TraceSpanEvent {
    return {
      startTimeUnixNano: 0,
      endTimeUnixNano: 1_000_000_000,
      attributes: {},
      ...overrides,
    }
  }

  it('groups spans by tangle.runId and extracts cost + tokens + score', async () => {
    const spans: TraceSpanEvent[] = [
      span({
        traceId: 't1',
        spanId: 's1',
        name: 'agent.turn',
        'tangle.runId': 'run-A',
        attributes: {
          'tangle.model': 'gpt-4o@2025-04-15',
          'tangle.cost.usd': 0.42,
          'gen_ai.usage.input_tokens': 1200,
          'gen_ai.usage.output_tokens': 350,
          'tangle.score': 0.78,
        },
        status: { code: 'OK' },
      }),
      span({
        traceId: 't2',
        spanId: 's2',
        name: 'agent.turn',
        'tangle.runId': 'run-B',
        attributes: {
          'tangle.model': 'gpt-4o@2025-04-15',
          'tangle.cost.usd': 0.31,
          'tangle.score': 0.42,
        },
        status: { code: 'ERROR' },
      }),
    ]
    const runs = fromOtelSpans({ spans })
    expect(runs).toHaveLength(2)
    const runA = runs.find((r) => r.runId === 'run-A')!
    expect(runA.outcome.holdoutScore).toBeCloseTo(0.78)
    expect(runA.costUsd).toBeCloseTo(0.42)
    expect(runA.tokenUsage.input).toBe(1200)
    expect(runA.tokenUsage.output).toBe(350)

    const runB = runs.find((r) => r.runId === 'run-B')!
    expect(runB.failureMode).toBe('agent.turn')

    const report = await analyzeRuns({ runs })
    expect(report.n).toBe(2)
    expect(report.composite.n).toBe(2)
    expect(report.costQuality.cost.mean).toBeGreaterThan(0)
  })
})

// ── Recommendations shape ──────────────────────────────────────────

describe('analyzeRuns — recommendations are always actionable', () => {
  it('every recommendation has a kind + priority + title + detail', async () => {
    const runs = [
      ...Array.from({ length: 10 }, (_, i) =>
        makeRun({ id: `b-${i}`, candidate: 'baseline', composite: 0.5 }),
      ),
      ...Array.from({ length: 10 }, (_, i) =>
        makeRun({ id: `c-${i}`, candidate: 'candidate', composite: 0.7 }),
      ),
    ]
    const report = await analyzeRuns({ runs })
    expect(report.recommendations.length).toBeGreaterThan(0)
    for (const rec of report.recommendations) {
      expect(rec.kind).toBeDefined()
      expect(rec.priority).toBeDefined()
      expect(rec.title.length).toBeGreaterThan(0)
      expect(rec.detail.length).toBeGreaterThan(0)
    }
  })

  it('emits a critical "investigate" with worstN runIds when composite mean is below 0.3', async () => {
    // Real-world shape from dogfooding legal-agent canonical (mean=0.002, n=36).
    const runs = Array.from({ length: 30 }, (_, i) =>
      makeRun({ id: `broken-${i}`, candidate: 'c', composite: i < 25 ? 0 : 0.02 }),
    )
    const report = await analyzeRuns({ runs })
    expect(report.composite.mean).toBeLessThan(0.3)
    expect(report.composite.tailRuns).toBeDefined()
    expect(report.composite.tailRuns!.length).toBe(5)
    expect(report.composite.tailRuns![0]!.score).toBe(0)
    const critical = report.recommendations.find(
      (r) => r.priority === 'critical' && r.kind === 'investigate',
    )
    expect(critical).toBeDefined()
    expect(critical!.detail).toContain('broken-')
  })

  it('emits a high-priority "investigate" when composite mean is between 0.3 and 0.5', async () => {
    const runs = Array.from({ length: 20 }, (_, i) =>
      makeRun({ id: `mid-${i}`, candidate: 'c', composite: 0.35 + (i % 3) * 0.02 }),
    )
    const report = await analyzeRuns({ runs })
    expect(report.composite.mean).toBeGreaterThanOrEqual(0.3)
    expect(report.composite.mean).toBeLessThan(0.5)
    const high = report.recommendations.find(
      (r) => r.priority === 'high' && r.kind === 'investigate',
    )
    expect(high).toBeDefined()
  })

  it('flags missing-judges when records carry no outcome.judgeScores', async () => {
    const runs: RunRecord[] = Array.from({ length: 8 }, (_, i) => ({
      runId: `nj-${i}`,
      experimentId: 'exp',
      candidateId: 'c',
      seed: i,
      model: 'm@v',
      promptHash: 'sha256:p',
      configHash: 'sha256:c',
      commitSha: 'abc',
      wallMs: 100,
      costUsd: 0.01,
      tokenUsage: { input: 100, output: 50 },
      outcome: { holdoutScore: 0.7, raw: {} },
      splitTag: 'holdout',
    }))
    const report = await analyzeRuns({ runs })
    expect(Object.keys(report.judges).length).toBe(0)
    const flag = report.recommendations.find(
      (r) => r.kind === 'expand-corpus' && r.title.includes('No judge'),
    )
    expect(flag).toBeDefined()
  })

  it('marks costQuality.degraded when all costUsd are zero', async () => {
    const runs: RunRecord[] = Array.from({ length: 5 }, (_, i) => ({
      runId: `z-${i}`,
      experimentId: 'exp',
      candidateId: 'c',
      seed: i,
      model: 'm@v',
      promptHash: 'sha256:p',
      configHash: 'sha256:c',
      commitSha: 'abc',
      wallMs: 100,
      costUsd: 0,
      tokenUsage: { input: 100, output: 50 },
      outcome: { holdoutScore: 0.6, raw: {} },
      splitTag: 'holdout',
    }))
    const report = await analyzeRuns({ runs })
    expect(report.costQuality.degraded).toBeDefined()
    // tokens present (100/50) but cost 0 → uncosted (unpriced model), not stub.
    expect(report.costQuality.degraded!.cost).toMatch(/no costUsd/)
    expect(report.costQuality.degraded!.cost).toMatch(/unpriced model/)
    expect(report.costQuality.degraded!.cost).toMatch(/5\/5 records have token usage/)
    expect(report.costQuality.degraded!.pareto).toMatch(/single candidate/)
  })

  it('zero-cost diagnosis distinguishes stub-mode (no tokens) from uncosted (unpriced model)', async () => {
    // Regression: a blank cost axis has two opposite root causes. Stub-mode
    // (tokenUsage 0/0) means the backend never ran — fix is upstream. Uncosted
    // (tokens but $0) means the model id was unpriced — fix is FAMILY_PRICING.
    // A generic "no signal" note sends the reader to the wrong layer.
    const stubRuns: RunRecord[] = Array.from({ length: 4 }, (_, i) => ({
      runId: `s-${i}`,
      experimentId: 'exp',
      candidateId: 'c',
      seed: i,
      model: 'claude-code/sonnet@deploy-dev',
      promptHash: 'sha256:p',
      configHash: 'sha256:c',
      commitSha: 'abc',
      wallMs: 100,
      costUsd: 0,
      tokenUsage: { input: 0, output: 0 },
      outcome: { holdoutScore: 0.6, raw: {} },
      splitTag: 'holdout',
    }))
    const stubReport = await analyzeRuns({ runs: stubRuns })
    expect(stubReport.costQuality.degraded!.cost).toMatch(/all 4 records are stub-mode/)
    expect(stubReport.costQuality.degraded!.cost).toMatch(/backend never reported/)
    expect(stubReport.costQuality.degraded!.cost).not.toMatch(/unpriced model/)
  })

  it('report is JSON-serialisable end-to-end (hosted wire format compatible)', async () => {
    const runs = [
      makeRun({ id: 'r-1', candidate: 'c', composite: 0.8 }),
      makeRun({ id: 'r-2', candidate: 'c', composite: 0.6 }),
    ]
    const report = await analyzeRuns({ runs })
    const json = JSON.stringify(report)
    expect(json.length).toBeGreaterThan(0)
    const parsed = JSON.parse(json) as InsightReport
    expect(parsed.n).toBe(2)
  })
})
