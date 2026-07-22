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
import { AnalystRegistry } from '../src/analyst/registry'
import { makeFinding } from '../src/analyst/types'
import {
  analyzeRuns,
  type FeedbackTableRow,
  fromFeedbackTable,
  fromOtelSpans,
  type InsightReport,
  summarizeExecution,
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

describe('analyzeRuns — execution facts', () => {
  it('summarizes duration, queueing, token categories, models, and recorded failures', async () => {
    const runs = [
      makeRun({ id: 'exec-1', candidate: 'c', composite: 0.8 }),
      makeRun({ id: 'exec-2', candidate: 'c', composite: 0.7, failureMode: 'tool failed' }),
      makeRun({ id: 'exec-3', candidate: 'c', composite: 0.9 }),
    ]
    Object.assign(runs[0]!, {
      wallMs: 100,
      queueMs: 10,
      tokenUsage: { input: 10, output: 4, reasoning: 1, cached: 100, cacheWrite: 20 },
      outcome: {
        ...runs[0]!.outcome,
        raw: { error_span_count: 0, llm_span_count: 2 },
      },
    })
    Object.assign(runs[1]!, {
      wallMs: 200,
      queueMs: 30,
      tokenUsage: { input: 20, output: 5, cached: 200 },
      outcome: {
        ...runs[1]!.outcome,
        raw: { error_span_count: 2, llm_span_count: 1 },
      },
    })
    Object.assign(runs[2]!, {
      wallMs: 300,
      model: 'other@v',
      failureClass: 'success',
      tokenUsage: { input: 30, output: 6 },
      outcome: {
        ...runs[2]!.outcome,
        raw: {
          aggregate_prompt_tokens: 40,
          aggregate_completion_tokens: 50,
          aggregate_reasoning_tokens: 10,
          aggregate_cached_tokens: 60,
          aggregate_cache_write_tokens: 70,
          aggregate_cost_usd: 0.2,
        },
      },
    })

    const { execution } = await analyzeRuns({ runs })
    const executionOnly = summarizeExecution({ runs })

    expect(executionOnly.execution).toEqual(execution)
    expect(executionOnly.costProvenance.observed.n).toBe(3)
    expect(execution.durationMs).toMatchObject({ n: 3, min: 100, p50: 200, max: 300 })
    expect(execution.queueMs).toMatchObject({ n: 2, min: 10, p50: 20, max: 30 })
    expect(execution.tokenUsage.totals).toEqual({
      input: 60,
      output: 15,
      reasoning: 1,
      cached: 300,
      cacheWrite: 20,
    })
    expect(execution.tokenUsage.cached.n).toBe(2)
    expect(execution.tokenUsage.cacheWrite.n).toBe(1)
    expect(execution.aggregateUsage.runs).toBe(1)
    expect(execution.aggregateUsage.tokenUsage.totals).toEqual({
      input: 40,
      output: 50,
      reasoning: 10,
      cached: 60,
      cacheWrite: 70,
    })
    expect(execution.aggregateUsage.totalCostUsd).toBe(0.2)
    expect(execution.models).toEqual([
      { model: 'm@v', runs: 2 },
      { model: 'other@v', runs: 1 },
    ])
    expect(execution.modelCalls).toEqual({ runs: 3, events: 3, reportingRuns: 2 })
    expect(execution.failures).toEqual({
      runs: 1,
      fraction: 1 / 3,
      reportedErrorEvents: 2,
      reportingRuns: 2,
    })
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

  it('preserves a cost-only model call and an untyped run-total cost', () => {
    const runs = fromOtelSpans({
      spans: [
        span({
          traceId: 'cost-only-call',
          spanId: 'call',
          name: 'provider.request',
          attributes: {
            'gen_ai.request.model': 'gpt-4o-2024-11-20',
            'tangle.cost.usd': 0.1,
          },
        }),
        span({
          traceId: 'run-total-cost',
          spanId: 'run',
          name: 'workflow.run',
          attributes: { 'cost.usd': 0.2 },
        }),
      ],
    })

    const modelCall = runs.find((run) => run.runId === 'cost-only-call')!
    expect(modelCall.costProvenance).toEqual({ kind: 'observed', usd: 0.1 })
    expect(modelCall.outcome.raw.llm_span_count).toBe(1)

    const runTotal = runs.find((run) => run.runId === 'run-total-cost')!
    expect(runTotal.costProvenance).toEqual({ kind: 'observed', usd: 0.2 })
    expect(runTotal.outcome.raw.llm_span_count).toBe(0)
    expect(runTotal.outcome.raw.aggregate_cost_usd).toBe(0.2)
  })

  it('sums model-call usage without double-counting aggregate parent spans', () => {
    const spans: TraceSpanEvent[] = [
      span({
        traceId: 'hierarchical',
        spanId: 'root',
        name: 'agent.run',
        startTimeUnixNano: 0,
        endTimeUnixNano: 2_000_000_000,
        attributes: {
          'gen_ai.usage.input_tokens': 9999,
          'gen_ai.usage.output_tokens': 9999,
          'tangle.cost.usd': 9,
        },
      }),
      span({
        traceId: 'hierarchical',
        spanId: 'llm-1',
        parentSpanId: 'root',
        name: 'claude.llm_request',
        attributes: {
          'openinference.span.kind': 'LLM',
          'gen_ai.request.model': 'claude-opus@2026-07-01',
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 3,
          cache_read_tokens: 100,
          cache_creation_tokens: 7,
          'tangle.cost.usd': 0.01,
        },
      }),
      span({
        traceId: 'hierarchical',
        spanId: 'llm-2',
        parentSpanId: 'root',
        name: 'provider.request',
        attributes: {
          'gen_ai.request.model': 'claude-opus@2026-07-01',
          'gen_ai.usage.input_tokens': 20,
          'gen_ai.usage.output_tokens': 4,
          cache_read_tokens: 200,
          cache_creation_tokens: 8,
          'tangle.cost.usd': 0.02,
        },
      }),
    ]

    const [run] = fromOtelSpans({ spans })

    expect(run!.tokenUsage).toEqual({
      input: 30,
      output: 7,
      cached: 300,
      cacheWrite: 15,
    })
    expect(run!.costUsd).toBeCloseTo(0.03)
    expect(run!.costProvenance).toEqual({ kind: 'observed', usd: 0.03 })
  })

  it('uses aggregate cost when model-call cost coverage is incomplete', () => {
    const spans: TraceSpanEvent[] = [
      span({
        traceId: 'partial-cost',
        spanId: 'root',
        name: 'agent.run',
        attributes: {
          'gen_ai.usage.input_tokens': 999,
          'gen_ai.usage.output_tokens': 999,
          'tangle.cost.usd': 0.5,
        },
      }),
      span({
        traceId: 'partial-cost',
        spanId: 'call-1',
        parentSpanId: 'root',
        name: 'provider.request',
        attributes: {
          'gen_ai.usage.input_tokens': 10,
          'gen_ai.usage.output_tokens': 2,
          'tangle.cost.usd': 0.1,
        },
      }),
      span({
        traceId: 'partial-cost',
        spanId: 'call-2',
        parentSpanId: 'root',
        name: 'provider.request',
        attributes: {
          'gen_ai.usage.input_tokens': 20,
          'gen_ai.usage.output_tokens': 3,
        },
      }),
    ]

    const [run] = fromOtelSpans({ spans })

    expect(run!.tokenUsage).toEqual({ input: 30, output: 5 })
    expect(run!.costProvenance).toEqual({ kind: 'observed', usd: 0.5 })
  })

  it('reconciles complementary parent and child measurements per field', () => {
    const spans: TraceSpanEvent[] = [
      span({
        traceId: 'complementary',
        spanId: 'root',
        name: 'agent.run',
        attributes: {
          'gen_ai.usage.input_tokens': 50,
          'gen_ai.usage.output_tokens': 8,
        },
      }),
      span({
        traceId: 'complementary',
        spanId: 'provider',
        parentSpanId: 'root',
        name: 'provider.request',
        attributes: {
          'gen_ai.request.model': 'claude-opus@2026-07-01',
          cache_read_tokens: 400,
          cache_creation_tokens: 20,
          'tangle.cost.usd': 0.04,
        },
      }),
    ]

    const [run] = fromOtelSpans({ spans })

    expect(run!.tokenUsage).toEqual({ input: 50, output: 8, cached: 400, cacheWrite: 20 })
    expect(run!.costProvenance).toEqual({ kind: 'observed', usd: 0.04 })
    expect(run!.outcome.raw.llm_span_count).toBe(1)
  })

  it('marks incomplete model-call cost as uncaptured while retaining the observed partial', () => {
    const spans: TraceSpanEvent[] = [
      span({ traceId: 'partial-only', spanId: 'root', name: 'agent.run' }),
      span({
        traceId: 'partial-only',
        spanId: 'call-1',
        parentSpanId: 'root',
        name: 'provider.request',
        attributes: {
          'gen_ai.usage.input_tokens': 10,
          'tangle.cost.usd': 0.1,
        },
      }),
      span({
        traceId: 'partial-only',
        spanId: 'call-2',
        parentSpanId: 'root',
        name: 'provider.request',
        attributes: { 'gen_ai.usage.input_tokens': 20 },
      }),
    ]

    const [run] = fromOtelSpans({ spans })

    expect(run!.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
    expect(run!.outcome.raw.partial_observed_cost_usd).toBe(0.1)
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
    expect(report.costQuality.degraded!.pareto).toMatch(/no candidates/)
  })

  it('separates observed, estimated, and uncaptured USD in cost analysis', async () => {
    const observed = makeRun({ id: 'cost-observed', candidate: 'c', composite: 0.7, cost: 0 })
    observed.costProvenance = { kind: 'observed', usd: 0 }
    const estimated = makeRun({ id: 'cost-estimated', candidate: 'c', composite: 0.8, cost: 0.2 })
    estimated.costProvenance = { kind: 'estimated', usd: 0.2 }
    const uncaptured = makeRun({ id: 'cost-uncaptured', candidate: 'c', composite: 0.9, cost: 0 })
    uncaptured.costProvenance = { kind: 'uncaptured', usd: null }

    const report = await analyzeRuns({ runs: [observed, estimated, uncaptured] })

    expect(report.costQuality.provenance).toEqual({
      observed: { n: 1, totalUsd: 0 },
      estimated: { n: 1, totalUsd: 0.2 },
      uncaptured: { n: 1 },
      knownFraction: 2 / 3,
    })
    expect(report.costQuality.cost.n).toBe(2)
    expect(report.costQuality.cost.mean).toBeCloseTo(0.1)
    expect(report.costQuality.pareto.points[0]).toMatchObject({ candidateId: 'c', n: 2 })
    expect(report.costQuality.degraded?.cost).toMatch(/1\/3 runs/)
    expect(report.costQuality.degraded?.cost).toMatch(/1 observed, 1 estimated/)
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

// ── analyzeRuns: failure clustering ─────────────────────────────────

describe('analyzeRuns — failure clustering via the analyst registry', () => {
  function failureRegistry(): AnalystRegistry {
    const registry = new AnalystRegistry()
    registry.register({
      id: 'failure-classifier',
      description: 'tags every failed run with a timeout finding',
      inputKind: 'run-record',
      cost: { kind: 'deterministic' },
      version: '1',
      analyze: async (input) => {
        const run = input as RunRecord
        return [
          makeFinding({
            analyst_id: 'failure-classifier',
            severity: 'major',
            area: 'timeout',
            claim: `run ${run.runId} timed out`,
            evidence_refs: [],
            confidence: 1,
            subject: run.runId,
          }),
        ]
      },
    })
    return registry
  }

  it('failureClusters is NON-EMPTY for failing runs (run-record input routing regression)', async () => {
    const runs = [
      makeRun({ id: 'f-1', candidate: 'c', composite: 0.1 }),
      makeRun({ id: 'f-2', candidate: 'c', composite: 0.2 }),
      makeRun({ id: 'ok-1', candidate: 'c', composite: 0.9 }),
    ]
    const report = await analyzeRuns({ runs, analyst: failureRegistry() })
    expect(report.failureClusters).toBeDefined()
    expect(report.failureClusters!.totalFailures).toBe(2)
    expect(report.failureClusters!.clusters.length).toBeGreaterThan(0)
    const cluster = report.failureClusters!.clusters[0]!
    expect(cluster.id).toBe('timeout')
    expect(cluster.exemplars.sort()).toEqual(['f-1', 'f-2'])
    expect(cluster.share).toBeCloseTo(1, 5)
  })

  it('failureClusters stays undefined without an analyst', async () => {
    const report = await analyzeRuns({
      runs: [makeRun({ id: 'f-1', candidate: 'c', composite: 0.1 })],
    })
    expect(report.failureClusters).toBeUndefined()
  })
})
