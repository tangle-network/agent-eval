import { describe, expect, it } from 'vitest'
import { createChatClient } from './analyst/chat-client'
import type { CampaignRunContext, CampaignRunOutcome, EvalCampaignOptions } from './eval-campaign'
import { runEvalCampaign } from './eval-campaign'

import { NoopRawProviderSink } from './trace/raw-provider-sink'
import { InMemoryTraceStore } from './trace/store'

/** The caller owns execution; no test here needs a real model answer. */
const chatFactory = () =>
  createChatClient({
    transport: 'custom',
    defaultModel: 'm@1',
    maximumAttempts: 1,
    chat: async () => {
      throw new Error('no campaign test in this file calls the model')
    },
  })

const TOKENS = { input: 1, output: 1 }

function passingOutcome(model = 'm@1', promptHash = 'p1'): CampaignRunOutcome {
  return {
    pass: true,
    score: 1,
    costUsd: 0,
    costProvenance: { kind: 'observed', usd: 0 },
    tokenUsage: TOKENS,
    model,
    promptHash,
    configHash: 'c1',
  }
}

/** A runner that starts and ends the run so the run is captured + completed. */
async function captureAndEnd(ctx: CampaignRunContext<unknown>): Promise<CampaignRunOutcome> {
  await ctx.emitter.startRun({ scenarioId: ctx.scenarioId, variantId: ctx.variantId })
  await ctx.emitter.endRun({ pass: true, score: 1 })
  return passingOutcome()
}

function baseOpts(
  overrides: Partial<EvalCampaignOptions<unknown>> = {},
): EvalCampaignOptions<unknown> {
  return {
    campaignId: 'c',
    variants: [{ id: 'v0', payload: {} }],
    scenarios: [{ scenarioId: 's0' }],
    seeds: [0],
    commitSha: 'sha',
    chatFactory,
    storeFactory: () => new InMemoryTraceStore(),
    rawSinkFactory: () => new NoopRawProviderSink(),
    integrity: {
      llmSpansMin: 0,
      requireRawCoverageOfLlmSpans: false,
      rawProviderEventsMin: 0,
    },
    runner: captureAndEnd,
    ...overrides,
  }
}



describe('runEvalCampaign — genuine-error orphan handling', () => {
  // A genuine (non-CellExecutionError) error from a worker — here a profile/model
  // contradiction surfaced AFTER the runner already completed and finalized its
  // run — must NOT reject the pool mid-flight and orphan peers. The campaign uses
  // allSettled, finalizes every still-open run in the post-settle sweep, then
  // re-throws the aggregated genuine error.
  it('re-throws the genuine error and finalizes the failing run without corrupting it', async () => {
    const stores = new Map<string, InMemoryTraceStore>()
    const opts = baseOpts({
      variants: [{ id: 'v0', payload: {} }],
      scenarios: [{ scenarioId: 's0' }],
      seeds: [0],
      storeFactory: (p) => {
        const s = new InMemoryTraceStore()
        stores.set(p.runId, s)
        return s
      },
      runner: async (ctx) => {
        await ctx.emitter.startRun({ scenarioId: ctx.scenarioId })
        await ctx.emitter.endRun({ pass: true, score: 1 })
        // Force a genuine error AFTER the run is completed: the declared profile
        // contradicts outcome.model. This is thrown from runOneCell, not the
        // runner, so it is a genuine error, not a CellExecutionError.
        return {
          ...passingOutcome('actual-model@1'),
          agentProfile: {
            profileId: 'prof-1',
            sourceProfile: { kind: 'test-profile', hash: 'a'.repeat(64) },
            model: 'different-model@1',
            promptHash: 'p1',
          },
        }
      },
    })

    await expect(runEvalCampaign(opts)).rejects.toThrow(/agentProfile\.model/)

    // The completed run must NOT have been flipped to aborted by post-settle
    // cleanup — its terminal status is preserved.
    expect(stores.size).toBe(1)
    const [, store] = [...stores][0]!
    const runs = await store.listRuns()
    expect(runs).toHaveLength(1)
    expect(runs[0]!.status).toBe('completed')
    expect(runs[0]!.outcome).toEqual({ pass: true, score: 1 })
  })

  it('aggregates multiple genuine errors into an AggregateError', async () => {
    const opts = baseOpts({
      variants: [{ id: 'v0', payload: {} }],
      scenarios: [{ scenarioId: 's0' }, { scenarioId: 's1' }],
      seeds: [0],
      concurrency: 2,
      runner: async (ctx) => {
        await ctx.emitter.startRun({ scenarioId: ctx.scenarioId })
        await ctx.emitter.endRun({ pass: true, score: 1 })
        return {
          ...passingOutcome('actual@1'),
          agentProfile: {
            profileId: 'prof-1',
            sourceProfile: { kind: 'test-profile', hash: 'a'.repeat(64) },
            model: 'mismatch@1',
            promptHash: 'p1',
          },
        }
      },
    })

    await expect(runEvalCampaign(opts)).rejects.toBeInstanceOf(AggregateError)
  })

  it('records a runner-throw as a failed run and still completes the campaign', async () => {
    const opts = baseOpts({
      runner: async (ctx) => {
        await ctx.emitter.startRun({ scenarioId: ctx.scenarioId })
        throw new Error('runner blew up')
      },
    })

    const result = await runEvalCampaign(opts)
    expect(result.failedRuns).toHaveLength(1)
    expect(result.failedRuns[0]!.reason).toBe('runner_threw')
    expect(result.failedRuns[0]!.error).toBe('runner blew up')
    expect(result.runs).toHaveLength(0)
  })

  it('happy path: a captured + completed run lands in result.runs', async () => {
    const result = await runEvalCampaign(baseOpts())
    expect(result.runs).toHaveLength(1)
    expect(result.failedRuns).toHaveLength(0)
    expect(result.runs[0]!.outcome.holdoutScore).toBe(1)
  })
})
