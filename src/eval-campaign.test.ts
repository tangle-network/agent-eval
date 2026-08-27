import { describe, expect, it } from 'vitest'
import type { CampaignRunContext, CampaignRunOutcome, EvalCampaignOptions } from './eval-campaign'
import { finalizeAbort, runEvalCampaign } from './eval-campaign'
import { assertLlmRoute, type LlmClientOptions } from './llm-client'
import { TraceEmitter } from './trace/emitter'
import { NoopRawProviderSink } from './trace/raw-provider-sink'
import { InMemoryTraceStore } from './trace/store'

// A minimally-valid LLM config. routeRequirements is set to `{}` in every
// campaign below so assertLlmRoute does not gate on baseUrl/auth.
const LLM_OPTS: LlmClientOptions = {
  baseUrl: 'https://api.example.test/v1',
  apiKey: 'test-key',
  provider: 'test',
}

const TOKENS = { input: 1, output: 1 }

function passingOutcome(model = 'm@1', promptHash = 'p1'): CampaignRunOutcome {
  return {
    pass: true,
    score: 1,
    costUsd: 0,
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
    llmOpts: LLM_OPTS,
    routeRequirements: {},
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

describe('finalizeAbort', () => {
  it('aborts a run still in `running` status', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store, { runId: 'r1', now: () => 1 })
    await emitter.startRun({ scenarioId: 's' })

    await finalizeAbort(emitter, 'r1', 'pool aborted')

    const run = await store.getRun('r1')
    expect(run?.status).toBe('aborted')
    expect(run?.outcome).toEqual({ pass: false, notes: 'pool aborted' })
  })

  // Regression: the guard. Before the `status !== 'running'` check was added,
  // finalizeAbort unconditionally called abortRun and would overwrite a
  // successfully-completed run — flipping status `completed`→`aborted` and the
  // real outcome `{ pass: true }`→`{ pass: false, notes: reason }`. This is the
  // exact corruption the post-settle cleanup could cause if the open-run
  // bookkeeping invariant is ever broken in a refactor.
  it('does NOT overwrite a run that is already completed', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store, { runId: 'r2', now: () => 1 })
    await emitter.startRun({ scenarioId: 's' })
    await emitter.endRun({ pass: true, score: 0.9, notes: 'real outcome' })

    const before = await store.getRun('r2')
    expect(before?.status).toBe('completed')

    await finalizeAbort(emitter, 'r2', 'late cleanup must not corrupt this')

    const after = await store.getRun('r2')
    expect(after?.status).toBe('completed')
    expect(after?.outcome).toEqual({ pass: true, score: 0.9, notes: 'real outcome' })
  })

  it('does NOT overwrite a run that already failed', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store, { runId: 'r3', now: () => 1 })
    await emitter.startRun({ scenarioId: 's' })
    await emitter.endRun({ pass: false, score: 0, notes: 'genuine failure' })

    await finalizeAbort(emitter, 'r3', 'should not touch a failed run')

    const after = await store.getRun('r3')
    expect(after?.status).toBe('failed')
    expect(after?.outcome).toEqual({ pass: false, score: 0, notes: 'genuine failure' })
  })

  it('is a no-op (no throw) when the run was never started', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store, { runId: 'never', now: () => 1 })

    await expect(finalizeAbort(emitter, 'never', 'nothing to abort')).resolves.toBeUndefined()
    expect(await store.getRun('never')).toBeUndefined()
  })

  it('propagates a genuine store-read error rather than swallowing it', async () => {
    class ReadFailingStore extends InMemoryTraceStore {
      async getRun(): Promise<never> {
        throw new Error('disk fault on getRun')
      }
    }
    const store = new ReadFailingStore()
    const emitter = new TraceEmitter(store, { runId: 'r4', now: () => 1 })

    await expect(finalizeAbort(emitter, 'r4', 'x')).rejects.toThrow('disk fault on getRun')
  })

  it('propagates a genuine abort-write error on a running run', async () => {
    class WriteFailingStore extends InMemoryTraceStore {
      async updateRun(): Promise<never> {
        throw new Error('disk full on updateRun')
      }
    }
    const store = new WriteFailingStore()
    const emitter = new TraceEmitter(store, { runId: 'r5', now: () => 1 })
    await emitter.startRun({ scenarioId: 's' })

    await expect(finalizeAbort(emitter, 'r5', 'x')).rejects.toThrow('disk full on updateRun')
  })
})

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

describe('preflight sanity', () => {
  it('assertLlmRoute is exercised by the campaign (smoke)', () => {
    expect(() => assertLlmRoute(LLM_OPTS, {})).not.toThrow()
  })
})
