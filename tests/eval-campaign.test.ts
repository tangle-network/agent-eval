import { describe, expect, it } from 'vitest'
import { runEvalCampaign } from '../src/eval-campaign'
import { InMemoryTraceStore } from '../src/trace/store'
import {
  InMemoryRawProviderSink,
  NoopRawProviderSink,
} from '../src/trace/raw-provider-sink'
import type { CampaignRunner, EvalCampaignOptions } from '../src/eval-campaign'
import { LlmRouteAssertionError } from '../src/llm-client'

interface VariantPayload {
  prompt: string
}

function baseOpts(overrides: Partial<EvalCampaignOptions<VariantPayload>> = {}): EvalCampaignOptions<VariantPayload> {
  const sinks = new Map<string, InMemoryRawProviderSink>()
  const stores = new Map<string, InMemoryTraceStore>()
  return {
    campaignId: 'test-campaign',
    variants: [
      { id: 'baseline', payload: { prompt: 'be terse' } },
      { id: 'cand', payload: { prompt: 'be terse but kind' } },
    ],
    scenarios: [
      { scenarioId: 's1' },
      { scenarioId: 's2' },
    ],
    seeds: [0, 1],
    commitSha: 'cafebabe',
    llmOpts: { baseUrl: 'https://api.test.local/v1', apiKey: 'sk-test' },
    storeFactory: ({ runId }) => {
      const s = new InMemoryTraceStore()
      stores.set(runId, s)
      return s
    },
    rawSinkFactory: ({ runId }) => {
      const s = new InMemoryRawProviderSink()
      sinks.set(runId, s)
      return s
    },
    runner: defaultRunner,
    ...overrides,
  }
}

const defaultRunner: CampaignRunner<VariantPayload> = async (ctx) => {
  await ctx.emitter.startRun({ scenarioId: ctx.scenarioId, layer: 'app-runtime' })
  // Simulate one LLM call captured via the pre-wired sink + traceContext.
  const handle = await ctx.emitter.llm({
    name: 'judge',
    model: 'test-model@2026-05-08',
    messages: [{ role: 'user', content: ctx.variant.prompt }],
    output: 'ok',
  })
  // Mirror what callLlm would have done — write a fake raw-request event so
  // the integrity check passes without actually hitting the network.
  await ctx.rawSink.record({
    eventId: `evt-${ctx.runId}-0`,
    runId: ctx.runId,
    spanId: handle.span.spanId,
    provider: 'test',
    model: 'test-model@2026-05-08',
    endpoint: '/chat/completions',
    baseUrl: ctx.llmOpts.baseUrl ?? '',
    attemptIndex: 0,
    direction: 'request',
    timestamp: 1_000,
    redactedFields: [],
  })
  await handle.end()
  // Variant + seed combination determines the deterministic score.
  const score = ctx.variantId === 'cand' ? 0.7 + ctx.seed * 0.001 : 0.55 + ctx.seed * 0.001
  await ctx.emitter.endRun({ pass: true, score })
  return {
    pass: true,
    score,
    costUsd: 0.001,
    tokenUsage: { input: 10, output: 5 },
    model: 'test-model@2026-05-08',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
  }
}

describe('runEvalCampaign — happy path', () => {
  it('runs the matrix, emits a RunRecord per cell, and reports clean integrity', async () => {
    const result = await runEvalCampaign(baseOpts())
    expect(result.runs).toHaveLength(8) // 2 variants × 2 scenarios × 2 seeds
    expect(result.failedRuns).toEqual([])
    expect(result.integrityReports.every((r) => r.ok)).toBe(true)
    expect(result.campaignFingerprint).toMatch(/^[0-9a-f]{64}$/)
    // Every run record must validate at the Campaign boundary.
    for (const r of result.runs) {
      expect(r.commitSha).toBe('cafebabe')
      expect(r.experimentId).toBe('test-campaign')
      expect(r.splitTag).toBe('holdout')
      expect(r.outcome.holdoutScore).toBeGreaterThan(0)
      expect(r.outcome.searchScore).toBeUndefined()
    }
  })

  it('produces a researchReport when comparator is supplied', async () => {
    const result = await runEvalCampaign(baseOpts({
      seeds: [0, 1, 2, 3, 4, 5, 6, 7],
      report: { comparator: 'baseline', seed: 1 },
    }))
    expect(result.report).toBeDefined()
    expect(result.report?.kind).toBe('agent-eval-research-report')
    expect(result.report?.recommendation.decision).toMatch(/promote|hold|equivalent|reject|needs_more_data/)
    // Fingerprint of the run set is in the report independent of the campaign fingerprint.
    expect(result.report?.runFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('embeds preregistration hash in the report when supplied', async () => {
    const result = await runEvalCampaign(baseOpts({
      preregistrationHash: 'preregabc',
      report: { comparator: 'baseline' },
    }))
    expect(result.preregistrationHash).toBe('preregabc')
    expect(result.report?.preregistrationHash).toBe('preregabc')
  })

  it('campaign fingerprint is stable across permutations of variants/scenarios/seeds', async () => {
    const a = await runEvalCampaign(baseOpts())
    const b = await runEvalCampaign(baseOpts({
      variants: [
        { id: 'cand', payload: { prompt: 'be terse but kind' } },
        { id: 'baseline', payload: { prompt: 'be terse' } },
      ],
      scenarios: [
        { scenarioId: 's2' },
        { scenarioId: 's1' },
      ],
      seeds: [1, 0],
    }))
    expect(a.campaignFingerprint).toBe(b.campaignFingerprint)
  })
})

describe('runEvalCampaign — preflight', () => {
  it('throws LlmRouteAssertionError when baseUrl is missing under the default policy', async () => {
    await expect(runEvalCampaign(baseOpts({
      llmOpts: { apiKey: 'sk-test' }, // no baseUrl
    }))).rejects.toBeInstanceOf(LlmRouteAssertionError)
  })

  it('throws on duplicate variant ids', async () => {
    await expect(runEvalCampaign(baseOpts({
      variants: [
        { id: 'a', payload: { prompt: 'x' } },
        { id: 'a', payload: { prompt: 'y' } },
      ],
    }))).rejects.toThrow(/duplicate variant id "a"/)
  })

  it('throws on duplicate scenarioIds', async () => {
    await expect(runEvalCampaign(baseOpts({
      scenarios: [{ scenarioId: 's1' }, { scenarioId: 's1' }],
    }))).rejects.toThrow(/duplicate scenarioId "s1"/)
  })

  it('throws when the report comparator is not a configured variant', async () => {
    await expect(runEvalCampaign(baseOpts({
      report: { comparator: 'no-such-variant' },
    }))).rejects.toThrow(/comparator "no-such-variant" is not a configured variantId/)
  })

  it('throws when commitSha is missing', async () => {
    await expect(runEvalCampaign(baseOpts({ commitSha: '' }))).rejects.toThrow(/commitSha is required/)
  })

  it('errors without rawSinkFactory or workDir (forensic capture is non-negotiable)', async () => {
    const opts = baseOpts({})
    delete (opts as { rawSinkFactory?: unknown }).rawSinkFactory
    await expect(runEvalCampaign(opts)).rejects.toThrow(/rawSinkFactory not supplied and workDir not set/)
  })

  it('opt-out of capture via NoopRawProviderSink + integrity override is allowed', async () => {
    const result = await runEvalCampaign(baseOpts({
      rawSinkFactory: () => new NoopRawProviderSink(),
      integrity: {
        llmSpansMin: 0,
        rawProviderEventsMin: 0,
        requireRawCoverageOfLlmSpans: false,
        requireOutcome: false,
      },
    }))
    expect(result.failedRuns).toEqual([])
    expect(result.runs).toHaveLength(8)
  })
})

describe('runEvalCampaign — failure handling', () => {
  it('marks runs failed when the runner throws and continues other cells', async () => {
    const calls = { count: 0 }
    const flakyRunner: CampaignRunner<VariantPayload> = async (ctx) => {
      calls.count++
      if (ctx.scenarioId === 's1' && ctx.variantId === 'cand') {
        throw new Error('synthetic failure')
      }
      return defaultRunner(ctx)
    }
    const result = await runEvalCampaign(baseOpts({ runner: flakyRunner }))
    expect(result.runs).toHaveLength(6)
    expect(result.failedRuns).toHaveLength(2)
    expect(result.failedRuns.every((f) => f.reason === 'runner_threw')).toBe(true)
    expect(result.failedRuns.every((f) => f.error === 'synthetic failure')).toBe(true)
    expect(calls.count).toBe(8)
  })

  it('mark_failed (default) collects integrity-failed runs into failedRuns', async () => {
    const noCaptureRunner: CampaignRunner<VariantPayload> = async (ctx) => {
      // Runs without recording any LLM span — fails default integrity (llmSpansMin=1).
      await ctx.emitter.startRun({ scenarioId: ctx.scenarioId, layer: 'app-runtime' })
      await ctx.emitter.endRun({ pass: true, score: 0.5 })
      return {
        pass: true,
        score: 0.5,
        costUsd: 0,
        tokenUsage: { input: 0, output: 0 },
        model: 'm@x',
        promptHash: 'p'.repeat(64),
        configHash: 'c'.repeat(64),
      }
    }
    const result = await runEvalCampaign(baseOpts({
      seeds: [0],
      scenarios: [{ scenarioId: 's1' }],
      variants: [{ id: 'baseline', payload: { prompt: 'x' } }],
      runner: noCaptureRunner,
    }))
    expect(result.runs).toEqual([])
    expect(result.failedRuns).toHaveLength(1)
    expect(result.failedRuns[0]?.reason).toBe('integrity_failed')
    expect(result.failedRuns[0]?.error).toContain('missing_llm_spans')
  })

  it('throw policy propagates RunIntegrityError', async () => {
    const noCaptureRunner: CampaignRunner<VariantPayload> = async (ctx) => {
      await ctx.emitter.startRun({ scenarioId: ctx.scenarioId, layer: 'app-runtime' })
      await ctx.emitter.endRun({ pass: true, score: 0.5 })
      return {
        pass: true,
        score: 0.5,
        costUsd: 0,
        tokenUsage: { input: 0, output: 0 },
        model: 'm@x',
        promptHash: 'p'.repeat(64),
        configHash: 'c'.repeat(64),
      }
    }
    await expect(runEvalCampaign(baseOpts({
      seeds: [0],
      scenarios: [{ scenarioId: 's1' }],
      variants: [{ id: 'baseline', payload: { prompt: 'x' } }],
      runner: noCaptureRunner,
      onIntegrityFailure: 'throw',
    }))).rejects.toThrow(/integrity check/)
  })

  it('log policy admits the run with the integrity report flagged', async () => {
    const noCaptureRunner: CampaignRunner<VariantPayload> = async (ctx) => {
      await ctx.emitter.startRun({ scenarioId: ctx.scenarioId, layer: 'app-runtime' })
      await ctx.emitter.endRun({ pass: true, score: 0.5 })
      return {
        pass: true,
        score: 0.5,
        costUsd: 0,
        tokenUsage: { input: 0, output: 0 },
        model: 'm@x',
        promptHash: 'p'.repeat(64),
        configHash: 'c'.repeat(64),
      }
    }
    const result = await runEvalCampaign(baseOpts({
      seeds: [0],
      scenarios: [{ scenarioId: 's1' }],
      variants: [{ id: 'baseline', payload: { prompt: 'x' } }],
      runner: noCaptureRunner,
      onIntegrityFailure: 'log',
    }))
    expect(result.runs).toHaveLength(1)
    expect(result.failedRuns).toEqual([])
    expect(result.integrityReports).toHaveLength(1)
    expect(result.integrityReports[0]?.ok).toBe(false)
  })
})

describe('runEvalCampaign — concurrency', () => {
  it('runs cells in parallel up to the configured worker count', async () => {
    const inFlight = { count: 0, max: 0 }
    const slowRunner: CampaignRunner<VariantPayload> = async (ctx) => {
      inFlight.count++
      inFlight.max = Math.max(inFlight.max, inFlight.count)
      await new Promise((r) => setTimeout(r, 25))
      const result = await defaultRunner(ctx)
      inFlight.count--
      return result
    }
    await runEvalCampaign(baseOpts({ runner: slowRunner, concurrency: 4 }))
    expect(inFlight.max).toBeGreaterThanOrEqual(2)
    expect(inFlight.max).toBeLessThanOrEqual(4)
  })
})
