import { describe, expect, it } from 'vitest'
import type { CampaignRunner } from '../src/eval-campaign'
import { runRLCampaign } from '../src/rl/rl-campaign'
import { InMemoryRawProviderSink } from '../src/trace/raw-provider-sink'
import { InMemoryTraceStore } from '../src/trace/store'

interface VariantPayload {
  prompt: string
}

const defaultRunner: CampaignRunner<VariantPayload> = async (ctx) => {
  await ctx.emitter.startRun({ scenarioId: ctx.scenarioId, layer: 'app-runtime' })
  const handle = await ctx.emitter.llm({
    name: 'judge',
    model: 'test-model@2026-05-08',
    messages: [{ role: 'user', content: ctx.variant.prompt }],
    output: 'ok',
  })
  await ctx.rawSink.record({
    eventId: `evt-${ctx.runId}`,
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
  const score = ctx.variantId === 'cand' ? 0.75 + ctx.seed * 0.001 : 0.55 + ctx.seed * 0.001
  await ctx.emitter.endRun({ pass: true, score })
  return {
    pass: true,
    score,
    costUsd: 0.001,
    tokenUsage: { input: 5, output: 5 },
    model: 'test-model@2026-05-08',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
  }
}

describe('runRLCampaign', () => {
  it('runs the matrix, extracts preferences, computes interim confidence, and reports rewardHacking verdict', async () => {
    const result = await runRLCampaign<VariantPayload>({
      campaignId: 'rl-test',
      commitSha: 'cafebabe',
      variants: [
        { id: 'baseline', payload: { prompt: 'baseline' } },
        { id: 'cand', payload: { prompt: 'better' } },
      ],
      scenarios: Array.from({ length: 8 }, (_, i) => ({ scenarioId: `task-${i}` })),
      seeds: [0, 1, 2],
      llmOpts: { baseUrl: 'https://api.test/v1', apiKey: 'sk-test' },
      storeFactory: () => new InMemoryTraceStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner: defaultRunner,
      report: { comparator: 'baseline' },
    })

    expect(result.kind).toBe('agent-eval-rl-campaign')
    expect(result.campaign.runs.length).toBe(48) // 2 × 8 × 3
    expect(result.preferences.pairs.length).toBeGreaterThan(0)
    expect(result.interimConfidence).not.toBeNull()
    expect(result.interimConfidence?.candidates[0]?.candidateId).toBe('cand')
    expect(result.rewardHacking.verdict).toBeDefined()
    expect(result.rewardSignals.length).toBe(48)
    expect(result.summary).toMatch(/rl-test:/)
  })

  it('produces trainer-export rows when lookups are supplied', async () => {
    const result = await runRLCampaign<VariantPayload>({
      campaignId: 'rl-export',
      commitSha: 'a'.repeat(40),
      variants: [
        { id: 'baseline', payload: { prompt: 'baseline' } },
        { id: 'cand', payload: { prompt: 'better' } },
      ],
      scenarios: Array.from({ length: 4 }, (_, i) => ({ scenarioId: `s-${i}` })),
      seeds: [0, 1],
      llmOpts: { baseUrl: 'https://api.test/v1', apiKey: 'sk-test' },
      storeFactory: () => new InMemoryTraceStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner: defaultRunner,
      report: { comparator: 'baseline' },
      trainerExport: {
        dpo: {
          promptOf: (id) => `prompt-${id}`,
          completionOf: (id) => `completion-${id}`,
        },
        sft: {
          promptOf: (id) => `prompt-${id}`,
          completionOf: (id) => `completion-${id}`,
        },
      },
    })
    expect(result.trainerRows.dpo).toBeDefined()
    expect(result.trainerRows.dpo!.length).toBeGreaterThan(0)
    expect(result.trainerRows.sft).toBeDefined()
    expect(result.trainerRows.sft!.length).toBe(16)
  })

  it('returns null interimConfidence when no comparator is configured', async () => {
    const result = await runRLCampaign<VariantPayload>({
      campaignId: 'no-comp',
      commitSha: 'abcd',
      variants: [{ id: 'only', payload: { prompt: 'x' } }],
      scenarios: [{ scenarioId: 's' }],
      seeds: [0],
      llmOpts: { baseUrl: 'https://api.test/v1', apiKey: 'sk-test' },
      storeFactory: () => new InMemoryTraceStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner: defaultRunner,
    })
    expect(result.interimConfidence).toBeNull()
    expect(result.preferences.pairs.length).toBe(0)
  })
})
