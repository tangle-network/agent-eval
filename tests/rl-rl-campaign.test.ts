import { describe, expect, it } from 'vitest'
import { createChatClient } from '../src/analyst/chat-client'
import type { CampaignRunner } from '../src/eval-campaign'
import { runRLCampaign } from '../src/rl/rl-campaign'
import { InMemoryRawProviderSink } from '../src/trace/raw-provider-sink'
import { InMemoryTraceStore } from '../src/trace/store'

interface VariantPayload {
  prompt: string
}

const EXECUTION_REF = 'https://api.test/v1'

/** The caller owns execution; every runner here emits its own spans. */
const chatFactory = () =>
  createChatClient({
    transport: 'custom',
    defaultModel: 'test-model@2026-05-08',
    maximumAttempts: 1,
    chat: async () => {
      throw new Error('no RL campaign test in this file calls the model')
    },
  })

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
    baseUrl: EXECUTION_REF,
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
    costProvenance: { kind: 'observed', usd: 0.001 },
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
      chatFactory,
      executionRef: EXECUTION_REF,
      storeFactory: () => new InMemoryTraceStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner: defaultRunner,
      report: { comparator: 'baseline' },
    })

    expect(result.kind).toBe('agent-eval-rl-campaign')
    expect(result.campaign.runs.length).toBe(48) // 2 × 8 × 3
    expect(new Set(result.campaign.runs.map((run) => run.splitTag))).toEqual(new Set(['search']))
    expect(result.preferences.pairs.length).toBeGreaterThan(0)
    expect(result.interimConfidence).not.toBeNull()
    expect(result.interimConfidence?.candidates[0]?.candidateId).toBe('cand')
    expect(result.rewardHacking.verdict).toBeDefined()
    expect(result.rewardSignals.length).toBe(48)
    expect(result.summary).toMatch(/rl-test:/)
    expect(result.deltaCoverage).toEqual([
      {
        candidateId: 'cand',
        dealt: 24,
        answered: 24,
        unscoredCandidate: 0,
        unscoredComparator: 0,
        unmatched: 0,
        coverage: 1,
      },
    ])
  })

  // `collectPairedDeltaSeries` dropped an unscored candidate run, an unscored
  // comparator run, and an unmatched cell — all three silently — and the
  // survivors flowed into `evaluateInterimReleaseConfidence`, whose
  // `recommendation.decision` can be `promote_now`. Same defect as the promotion
  // gates, one call frame up.
  describe('paired-delta coverage', () => {
    /** Candidate RUNS every cell but produces no score past `answersUpTo` —
     *  measured absence (the run happened, the judge produced nothing), which is
     *  the case the old code turned into an absent cell. */
    const partialRunner =
      (answersUpTo: number): CampaignRunner<VariantPayload> =>
      async (ctx) => {
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
          baseUrl: EXECUTION_REF,
          attemptIndex: 0,
          direction: 'request',
          timestamp: 1_000,
          redactedFields: [],
        })
        await handle.end()
        const index = Number(ctx.scenarioId.split('-')[1] ?? '0')
        const dark = ctx.variantId === 'cand' && index >= answersUpTo
        const score = ctx.variantId === 'cand' ? 0.9 : 0.5
        if (dark) await ctx.emitter.endRun({ pass: false })
        else await ctx.emitter.endRun({ pass: true, score })
        return {
          pass: !dark,
          ...(dark ? {} : { score }),
          costUsd: 0.001,
          costProvenance: { kind: 'observed' as const, usd: 0.001 },
          tokenUsage: { input: 5, output: 5 },
          model: 'test-model@2026-05-08',
          promptHash: 'p'.repeat(64),
          configHash: 'c'.repeat(64),
        }
      }

    const campaign = (answersUpTo: number, minDeltaCoverage?: number) =>
      runRLCampaign<VariantPayload>({
        campaignId: 'rl-coverage',
        commitSha: 'cafebabe',
        variants: [
          { id: 'baseline', payload: { prompt: 'baseline' } },
          { id: 'cand', payload: { prompt: 'better' } },
        ],
        scenarios: Array.from({ length: 8 }, (_, i) => ({ scenarioId: `task-${i}` })),
        seeds: [0],
        chatFactory,
        executionRef: EXECUTION_REF,
        storeFactory: () => new InMemoryTraceStore(),
        rawSinkFactory: () => new InMemoryRawProviderSink(),
        runner: partialRunner(answersUpTo),
        report: { comparator: 'baseline' },
        ...(minDeltaCoverage === undefined ? {} : { sequential: { minDeltaCoverage } }),
      })

    it('withholds the interim verdict when the candidate scored 2 of 8 cells', async () => {
      const result = await campaign(2)
      expect(result.interimConfidence).toBeNull()
      expect(result.deltaCoverage).toEqual([
        {
          candidateId: 'cand',
          dealt: 8,
          answered: 2,
          unscoredCandidate: 6,
          unscoredComparator: 0,
          unmatched: 0,
          coverage: 0.25,
        },
      ])
      // Never a silent 0 — the summary says by how much, on the refused path.
      expect(result.summary).toMatch(/paired-delta coverage: cand 2\/8/)
      expect(result.summary).toMatch(/sequential verdict withheld/)
    })

    it('a declared minDeltaCoverage below 1 still ships the shrunken denominator', async () => {
      const result = await campaign(2, 0.25)
      expect(result.interimConfidence).not.toBeNull()
      expect(result.deltaCoverage[0]?.answered).toBe(2)
      expect(result.deltaCoverage[0]?.dealt).toBe(8)
      expect(result.summary).toMatch(/paired-delta coverage: cand 2\/8/)
    })

    it('rejects a minDeltaCoverage outside [0,1] rather than clamping it', async () => {
      await expect(campaign(8, 1.5)).rejects.toThrow(/minDeltaCoverage/)
    })
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
      chatFactory,
      executionRef: EXECUTION_REF,
      storeFactory: () => new InMemoryTraceStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner: defaultRunner,
      report: { comparator: 'baseline' },
      trainerExport: {
        dpo: {
          promptOf: () => 'shared scenario prompt',
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

  it('does not let an unrelated unscored run crash DPO export', async () => {
    const runner: CampaignRunner<VariantPayload> = async (ctx) => {
      const outcome = await defaultRunner(ctx)
      return ctx.variantId === 'unscored'
        ? { ...outcome, score: undefined as unknown as number }
        : outcome
    }

    const result = await runRLCampaign<VariantPayload>({
      campaignId: 'rl-export-unscored',
      commitSha: 'b'.repeat(40),
      variants: [
        { id: 'baseline', payload: { prompt: 'baseline' } },
        { id: 'cand', payload: { prompt: 'better' } },
        { id: 'unscored', payload: { prompt: 'unscored' } },
      ],
      scenarios: [{ scenarioId: 's-0' }],
      seeds: [0],
      chatFactory,
      executionRef: EXECUTION_REF,
      storeFactory: () => new InMemoryTraceStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner,
      trainerExport: {
        dpo: {
          promptOf: () => 'shared scenario prompt',
          completionOf: (id) => `completion-${id}`,
        },
      },
    })

    expect(result.campaign.runs).toHaveLength(3)
    expect(result.preferences.pairs).toHaveLength(1)
    expect(result.trainerRows.dpo).toHaveLength(1)
  })

  it('returns null interimConfidence when no comparator is configured', async () => {
    const result = await runRLCampaign<VariantPayload>({
      campaignId: 'no-comp',
      commitSha: 'abcd',
      variants: [{ id: 'only', payload: { prompt: 'x' } }],
      scenarios: [{ scenarioId: 's' }],
      seeds: [0],
      chatFactory,
      executionRef: EXECUTION_REF,
      storeFactory: () => new InMemoryTraceStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner: defaultRunner,
    })
    expect(result.interimConfidence).toBeNull()
    expect(result.preferences.pairs.length).toBe(0)
  })

  it('forwards the explicit held-out training override to preference extraction', async () => {
    const result = await runRLCampaign<VariantPayload>({
      campaignId: 'held-out-preferences',
      commitSha: 'abcd',
      variants: [
        { id: 'baseline', payload: { prompt: 'baseline' } },
        { id: 'cand', payload: { prompt: 'better' } },
      ],
      scenarios: [{ scenarioId: 's' }],
      seeds: [0],
      splitTag: 'holdout',
      preferences: { allowHeldOutTrainingData: true },
      chatFactory,
      executionRef: EXECUTION_REF,
      storeFactory: () => new InMemoryTraceStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner: defaultRunner,
    })

    expect(result.preferences.pairs).toHaveLength(1)
    expect(new Set(result.campaign.runs.map((run) => run.splitTag))).toEqual(new Set(['holdout']))
  })
})
