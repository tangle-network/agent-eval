import { describe, expect, it } from 'vitest'
import { buildAgentProfileCell } from '../src/agent-profile-cell'
import type { CampaignRunner, EvalCampaignOptions } from '../src/eval-campaign'
import { runEvalCampaign } from '../src/eval-campaign'
import { LlmRouteAssertionError } from '../src/llm-client'
import { InMemoryRawProviderSink, NoopRawProviderSink } from '../src/trace/raw-provider-sink'
import { InMemoryTraceStore } from '../src/trace/store'

interface VariantPayload {
  prompt: string
}

function baseOpts(
  overrides: Partial<EvalCampaignOptions<VariantPayload>> = {},
): EvalCampaignOptions<VariantPayload> {
  const sinks = new Map<string, InMemoryRawProviderSink>()
  const stores = new Map<string, InMemoryTraceStore>()
  return {
    campaignId: 'test-campaign',
    variants: [
      { id: 'baseline', payload: { prompt: 'be terse' } },
      { id: 'cand', payload: { prompt: 'be terse but kind' } },
    ],
    scenarios: [{ scenarioId: 's1' }, { scenarioId: 's2' }],
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
    const result = await runEvalCampaign(
      baseOpts({
        seeds: [0, 1, 2, 3, 4, 5, 6, 7],
        report: { comparator: 'baseline', seed: 1 },
      }),
    )
    expect(result.report).toBeDefined()
    expect(result.report?.kind).toBe('agent-eval-research-report')
    expect(result.report?.recommendation.decision).toMatch(
      /promote|hold|equivalent|reject|needs_more_data/,
    )
    // Fingerprint of the run set is in the report independent of the campaign fingerprint.
    expect(result.report?.runFingerprint).toMatch(/^[0-9a-f]{64}$/)
  })

  it('stamps every run with a canonical agent profile cell', async () => {
    const result = await runEvalCampaign(
      baseOpts({
        agentProfile: ({ variantId }) => ({
          profileId: `gtm-${variantId}`,
          sourceProfile: {
            kind: 'agent-interface-profile',
            profile: { name: 'gtm-agent', variantId, permissions: { bash: 'ask' } },
          },
          harness: { id: 'gtm-agent-eval', version: '0.3.0' },
          model: 'test-model@2026-05-08',
          promptHash: 'p'.repeat(64),
        }),
      }),
    )

    expect(new Set(result.runs.map((r) => r.agentProfile?.cellId)).size).toBe(2)
    expect(result.runs.every((r) => r.agentProfile?.model === r.model)).toBe(true)
    expect(result.runs.every((r) => r.agentProfile?.promptHash === r.promptHash)).toBe(true)
  })

  it('rejects a prebuilt agent profile cell when it contradicts the observed run', async () => {
    const agentProfile = await buildAgentProfileCell({
      profileId: 'gtm-bad-cell',
      sourceProfile: { kind: 'agent-interface-profile', profile: { name: 'gtm-agent' } },
      harness: { id: 'gtm-agent-eval', version: '0.3.0' },
      model: 'different-model@2026-05-08',
      promptHash: 'p'.repeat(64),
    })

    await expect(runEvalCampaign(baseOpts({ agentProfile }))).rejects.toThrow(
      /does not match outcome.model/,
    )
  })

  it('embeds preregistration hash in the report when supplied', async () => {
    const result = await runEvalCampaign(
      baseOpts({
        preregistrationHash: 'preregabc',
        report: { comparator: 'baseline' },
      }),
    )
    expect(result.preregistrationHash).toBe('preregabc')
    expect(result.report?.preregistrationHash).toBe('preregabc')
  })

  it('campaign fingerprint is stable across permutations of variants/scenarios/seeds', async () => {
    const a = await runEvalCampaign(baseOpts())
    const b = await runEvalCampaign(
      baseOpts({
        variants: [
          { id: 'cand', payload: { prompt: 'be terse but kind' } },
          { id: 'baseline', payload: { prompt: 'be terse' } },
        ],
        scenarios: [{ scenarioId: 's2' }, { scenarioId: 's1' }],
        seeds: [1, 0],
      }),
    )
    expect(a.campaignFingerprint).toBe(b.campaignFingerprint)
  })
})

describe('runEvalCampaign — preflight', () => {
  it('throws LlmRouteAssertionError when baseUrl is missing under the default policy', async () => {
    await expect(
      runEvalCampaign(
        baseOpts({
          llmOpts: { apiKey: 'sk-test' }, // no baseUrl
        }),
      ),
    ).rejects.toBeInstanceOf(LlmRouteAssertionError)
  })

  it('throws on duplicate variant ids', async () => {
    await expect(
      runEvalCampaign(
        baseOpts({
          variants: [
            { id: 'a', payload: { prompt: 'x' } },
            { id: 'a', payload: { prompt: 'y' } },
          ],
        }),
      ),
    ).rejects.toThrow(/duplicate variant id "a"/)
  })

  it('throws on duplicate scenarioIds', async () => {
    await expect(
      runEvalCampaign(
        baseOpts({
          scenarios: [{ scenarioId: 's1' }, { scenarioId: 's1' }],
        }),
      ),
    ).rejects.toThrow(/duplicate scenarioId "s1"/)
  })

  it('throws when the report comparator is not a configured variant', async () => {
    await expect(
      runEvalCampaign(
        baseOpts({
          report: { comparator: 'no-such-variant' },
        }),
      ),
    ).rejects.toThrow(/comparator "no-such-variant" is not a configured variantId/)
  })

  it('throws when commitSha is missing', async () => {
    await expect(runEvalCampaign(baseOpts({ commitSha: '' }))).rejects.toThrow(
      /commitSha is required/,
    )
  })

  it('errors without rawSinkFactory or workDir (forensic capture is non-negotiable)', async () => {
    const opts = baseOpts({})
    delete (opts as { rawSinkFactory?: unknown }).rawSinkFactory
    await expect(runEvalCampaign(opts)).rejects.toThrow(
      /rawSinkFactory not supplied and workDir not set/,
    )
  })

  it('opt-out of capture via NoopRawProviderSink + integrity override is allowed', async () => {
    const result = await runEvalCampaign(
      baseOpts({
        rawSinkFactory: () => new NoopRawProviderSink(),
        integrity: {
          llmSpansMin: 0,
          rawProviderEventsMin: 0,
          requireRawCoverageOfLlmSpans: false,
          requireOutcome: false,
        },
      }),
    )
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

  it('propagates the outcome failureClass + failureMode onto the RunRecord', async () => {
    // A runner that classifies its failure with the canonical cross-agent
    // key (failureClass) plus a domain detail (failureMode). The projection
    // must carry BOTH onto the RunRecord so the substrate aggregates campaign
    // failures in the same vocabulary as runtime-produced records.
    const classifiedRunner: CampaignRunner<VariantPayload> = async (ctx) => {
      const base = await defaultRunner(ctx)
      return {
        ...base,
        failureClass: 'instruction_following' as const,
        failureMode: 'forge_build_unsatisfied',
      }
    }
    const result = await runEvalCampaign(baseOpts({ runner: classifiedRunner }))
    expect(result.runs.length).toBeGreaterThan(0)
    const r = result.runs[0]!
    expect(r.failureClass).toBe('instruction_following')
    expect(r.failureMode).toBe('forge_build_unsatisfied')
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
    const result = await runEvalCampaign(
      baseOpts({
        seeds: [0],
        scenarios: [{ scenarioId: 's1' }],
        variants: [{ id: 'baseline', payload: { prompt: 'x' } }],
        runner: noCaptureRunner,
      }),
    )
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
    await expect(
      runEvalCampaign(
        baseOpts({
          seeds: [0],
          scenarios: [{ scenarioId: 's1' }],
          variants: [{ id: 'baseline', payload: { prompt: 'x' } }],
          runner: noCaptureRunner,
          onIntegrityFailure: 'throw',
        }),
      ),
    ).rejects.toThrow(/integrity check/)
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
    const result = await runEvalCampaign(
      baseOpts({
        seeds: [0],
        scenarios: [{ scenarioId: 's1' }],
        variants: [{ id: 'baseline', payload: { prompt: 'x' } }],
        runner: noCaptureRunner,
        onIntegrityFailure: 'log',
      }),
    )
    expect(result.runs).toHaveLength(1)
    expect(result.failedRuns).toEqual([])
    expect(result.integrityReports).toHaveLength(1)
    expect(result.integrityReports[0]?.ok).toBe(false)
  })
})

describe('runEvalCampaign — judgeScores propagation', () => {
  // Forge-chat / multi-judge consumers produce per-judge per-dim scores
  // alongside the composite. The campaign must thread them onto
  // `RunRecord.outcome.judgeScores` without coercion, and the record
  // must survive a JSON round-trip (records.jsonl is what consumers
  // ultimately persist).

  function judgeScoresRunner(
    judgeScores: import('../src/run-record').JudgeScoresRecord | undefined,
  ): CampaignRunner<VariantPayload> {
    return async (ctx) => {
      const base = await defaultRunner(ctx)
      if (judgeScores === undefined) return base
      return { ...base, judgeScores }
    }
  }

  it('full shape: lands all per-judge/per-dim/composite fields on the record + JSON round-trip', async () => {
    const judgeScores = {
      perJudge: {
        'kimi-k2.6@2026-04-01': { helpfulness: 0.8, clarity: 0.75, on_topic: 0.9 },
        'glm-5.1@2026-04-02': { helpfulness: 0.85, clarity: 0.7, on_topic: 0.95 },
      },
      perDimMean: { helpfulness: 0.825, clarity: 0.725, on_topic: 0.925 },
      composite: 0.825,
    }
    const result = await runEvalCampaign(
      baseOpts({
        variants: [{ id: 'v1', payload: { prompt: 'p' } }],
        scenarios: [{ scenarioId: 's1' }],
        seeds: [0],
        runner: judgeScoresRunner(judgeScores),
      }),
    )
    expect(result.runs).toHaveLength(1)
    const rec = result.runs[0]
    expect(rec?.outcome.judgeScores).toEqual(judgeScores)
    // JSON round-trip — this is the shape that lands in records.jsonl.
    const roundTripped = JSON.parse(JSON.stringify(rec))
    expect(roundTripped.outcome.judgeScores).toEqual(judgeScores)
  })

  it('partial shape (failedJudges populated): one judge errored, recorded explicitly', async () => {
    // Fail-loud: a panel with one dead judge is recorded as such — not
    // inferred from a missing key in perJudge. The composite + perDimMean
    // are computed over the surviving judges only.
    const judgeScores = {
      perJudge: {
        'kimi-k2.6@2026-04-01': { helpfulness: 0.8, clarity: 0.75 },
      },
      perDimMean: { helpfulness: 0.8, clarity: 0.75 },
      composite: 0.775,
      failedJudges: ['glm-5.1@2026-04-02'],
    }
    const result = await runEvalCampaign(
      baseOpts({
        variants: [{ id: 'v1', payload: { prompt: 'p' } }],
        scenarios: [{ scenarioId: 's1' }],
        seeds: [0],
        runner: judgeScoresRunner(judgeScores),
      }),
    )
    const rec = result.runs[0]
    expect(rec?.outcome.judgeScores?.failedJudges).toEqual(['glm-5.1@2026-04-02'])
    expect(Object.keys(rec?.outcome.judgeScores?.perJudge ?? {})).toEqual(['kimi-k2.6@2026-04-01'])
  })

  it('missing shape (no ensemble): legacy / single-judge runs leave outcome.judgeScores undefined', async () => {
    const result = await runEvalCampaign(
      baseOpts({
        variants: [{ id: 'v1', payload: { prompt: 'p' } }],
        scenarios: [{ scenarioId: 's1' }],
        seeds: [0],
        runner: judgeScoresRunner(undefined),
      }),
    )
    const rec = result.runs[0]
    expect(rec?.outcome.judgeScores).toBeUndefined()
  })

  it('with notes: judge prose survives the campaign-to-record conversion', async () => {
    const judgeScores = {
      perJudge: {
        'kimi-k2.6@2026-04-01': { helpfulness: 0.6, clarity: 0.55 },
        'glm-5.1@2026-04-02': { helpfulness: 0.65, clarity: 0.5 },
      },
      perDimMean: { helpfulness: 0.625, clarity: 0.525 },
      composite: 0.575,
      notes: 'panel flagged tone drift mid-response',
    }
    const result = await runEvalCampaign(
      baseOpts({
        variants: [{ id: 'v1', payload: { prompt: 'p' } }],
        scenarios: [{ scenarioId: 's1' }],
        seeds: [0],
        runner: judgeScoresRunner(judgeScores),
      }),
    )
    const rec = result.runs[0]
    expect(rec?.outcome.judgeScores?.notes).toBe('panel flagged tone drift mid-response')
  })

  it('fail-loud: a judge throwing during scoring lands in failedJudges, not swallowed', async () => {
    // Consumer pattern: the runner runs the panel, catches per-judge
    // throws, and records the dead judge in `failedJudges`. The
    // composite is computed over survivors. The substrate's job is to
    // preserve that signal — never to silently zero it.
    const ensembleRunner: CampaignRunner<VariantPayload> = async (ctx) => {
      const base = await defaultRunner(ctx)
      const judges = ['kimi-k2.6@2026-04-01', 'glm-5.1@2026-04-02'] as const
      const perJudge: Record<string, Record<string, number>> = {}
      const failed: string[] = []
      for (const judgeId of judges) {
        try {
          if (judgeId === 'glm-5.1@2026-04-02') throw new Error('upstream 503')
          perJudge[judgeId] = { helpfulness: 0.7, clarity: 0.65 }
        } catch {
          failed.push(judgeId)
        }
      }
      // perDimMean over surviving judges only. No silent zero.
      const dims = ['helpfulness', 'clarity'] as const
      const perDimMean: Record<string, number> = {}
      for (const d of dims) {
        const vals = Object.values(perJudge)
          .map((d2) => d2[d])
          .filter((v): v is number => typeof v === 'number')
        perDimMean[d] = vals.reduce((a, b) => a + b, 0) / vals.length
      }
      const composite =
        Object.values(perDimMean).reduce((a, b) => a + b, 0) / Object.values(perDimMean).length
      return {
        ...base,
        judgeScores: {
          perJudge,
          perDimMean,
          composite,
          failedJudges: failed,
        },
      }
    }
    const result = await runEvalCampaign(
      baseOpts({
        variants: [{ id: 'v1', payload: { prompt: 'p' } }],
        scenarios: [{ scenarioId: 's1' }],
        seeds: [0],
        runner: ensembleRunner,
      }),
    )
    const rec = result.runs[0]
    expect(rec?.outcome.judgeScores?.failedJudges).toEqual(['glm-5.1@2026-04-02'])
    expect(rec?.outcome.judgeScores?.perJudge['glm-5.1@2026-04-02']).toBeUndefined()
    expect(rec?.outcome.judgeScores?.perJudge['kimi-k2.6@2026-04-01']).toBeDefined()
    // Composite is the mean over survivor dim-means — not silently zero.
    expect(rec?.outcome.judgeScores?.composite).toBeGreaterThan(0)
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

describe('runEvalCampaign — genuine-error containment (no orphaned workers)', () => {
  // A genuine (non-CellExecutionError) bug in one cell must not reject the pool
  // mid-flight and orphan the other in-flight workers. The campaign must wait
  // for every sibling worker to finish (its run finalized) before re-throwing.
  it('does not throw until every in-flight sibling run has finalized', async () => {
    // Two cells, concurrency 2. Cell A is the genuine-error cell. Cell B parks
    // mid-run on a barrier we control. With Promise.all (old behaviour) the
    // campaign rejects the instant A throws, while B is still parked — orphaned.
    // With Promise.allSettled the campaign cannot settle until B finalizes.
    let releaseB: () => void = () => {}
    const bParked = new Promise<void>((resolve) => {
      releaseB = resolve
    })
    let bFinalized = false

    const runner: CampaignRunner<VariantPayload> = async (ctx) => {
      if (ctx.variantId === 'fail') {
        // Genuine error in post-runner assembly: the runner finalizes its OWN
        // run, then hands back an agent profile that contradicts the model.
        // assertAgentProfileMatchesRun throws a plain Error (not a Cell error).
        const base = await defaultRunner(ctx)
        return {
          ...base,
          agentProfile: {
            profileId: 'mismatch',
            sourceProfile: { kind: 'agent-interface-profile', profile: { name: 'a' } },
            harness: { id: 'h', version: '1' },
            model: 'WRONG-MODEL@2026-05-08',
            promptHash: 'p'.repeat(64),
          },
        }
      }
      // Cell B: start the run, park until released, then finalize itself.
      await ctx.emitter.startRun({ scenarioId: ctx.scenarioId, layer: 'app-runtime' })
      await bParked
      const handle = await ctx.emitter.llm({
        name: 'judge',
        model: 'test-model@2026-05-08',
        messages: [{ role: 'user', content: ctx.variant.prompt }],
        output: 'ok',
      })
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
      await ctx.emitter.endRun({ pass: true, score: 0.6 })
      bFinalized = true
      return {
        pass: true,
        score: 0.6,
        costUsd: 0.001,
        tokenUsage: { input: 10, output: 5 },
        model: 'test-model@2026-05-08',
        promptHash: 'p'.repeat(64),
        configHash: 'c'.repeat(64),
      }
    }

    const stores = new Map<string, InMemoryTraceStore>()
    const opts: EvalCampaignOptions<VariantPayload> = {
      campaignId: 'orphan-campaign',
      variants: [
        { id: 'fail', payload: { prompt: 'x' } },
        { id: 'park', payload: { prompt: 'y' } },
      ],
      scenarios: [{ scenarioId: 's1' }],
      seeds: [0],
      commitSha: 'cafebabe',
      llmOpts: { baseUrl: 'https://api.test.local/v1', apiKey: 'sk-test' },
      storeFactory: ({ runId }) => {
        const s = new InMemoryTraceStore()
        stores.set(runId, s)
        return s
      },
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      concurrency: 2,
      runner,
    }

    const campaign = runEvalCampaign(opts)
    let settled = false
    void campaign.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )

    // Flush microtasks + a macrotask. Cell A has thrown its genuine error by
    // now, but cell B is still parked. Old Promise.all would have rejected the
    // campaign already; allSettled must keep it pending.
    await new Promise((r) => setTimeout(r, 20))
    expect(settled).toBe(false)
    expect(bFinalized).toBe(false)

    // Release B; only now may the campaign settle (re-throwing the genuine error).
    releaseB()
    await expect(campaign).rejects.toThrow(/does not match outcome.model/)
    expect(bFinalized).toBe(true)

    // B's run was finalized as a real completed run — not left dangling.
    const bRunId = [...stores.keys()].find((id) => id.length > 0)
    expect(bRunId).toBeDefined()
    // Every store that recorded a run must have a terminal status (no 'running').
    for (const store of stores.values()) {
      const runs = await store.listRuns()
      for (const r of runs) {
        expect(r.status).not.toBe('running')
      }
    }
  })
})

describe('runEvalCampaign — abort failure is surfaced, not swallowed', () => {
  // When the runner throws, the campaign aborts the run to finalize the
  // emitter. A store-write failure during that abort is a genuine diagnostic
  // (disk full, FS fault, backend down) and MUST surface — the old
  // `try { abortRun } catch {}` swallowed it, hiding real corruption.
  it('re-throws a store-write failure that occurs while aborting a thrown run', async () => {
    class AbortFailingStore extends InMemoryTraceStore {
      override async updateRun(runId: string, patch: Partial<import('../src/trace/schema').Run>) {
        if (patch.status === 'aborted') {
          throw new Error('disk full: cannot persist aborted run')
        }
        return super.updateRun(runId, patch)
      }
    }

    const runner: CampaignRunner<VariantPayload> = async (ctx) => {
      await ctx.emitter.startRun({ scenarioId: ctx.scenarioId, layer: 'app-runtime' })
      throw new Error('runner boom')
    }

    const opts: EvalCampaignOptions<VariantPayload> = {
      campaignId: 'abort-fail-campaign',
      variants: [{ id: 'v1', payload: { prompt: 'x' } }],
      scenarios: [{ scenarioId: 's1' }],
      seeds: [0],
      commitSha: 'cafebabe',
      llmOpts: { baseUrl: 'https://api.test.local/v1', apiKey: 'sk-test' },
      storeFactory: () => new AbortFailingStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner,
    }

    // Old behaviour: the abort error is swallowed; the cell is recorded as a
    // plain runner_threw failure and the campaign resolves. New behaviour: the
    // store-write failure surfaces as a genuine error.
    await expect(runEvalCampaign(opts)).rejects.toThrow(/disk full: cannot persist aborted run/)
  })

  it('still treats a never-started run as a benign abort (nothing to finalize)', async () => {
    // If the runner throws BEFORE startRun, there is no run to abort — that is
    // the only benign case the narrowed catch may pass over. It must NOT throw
    // a store error; the cell is a normal runner_threw failure.
    const runner: CampaignRunner<VariantPayload> = async () => {
      throw new Error('threw before startRun')
    }

    const opts: EvalCampaignOptions<VariantPayload> = {
      campaignId: 'never-started-campaign',
      variants: [{ id: 'v1', payload: { prompt: 'x' } }],
      scenarios: [{ scenarioId: 's1' }],
      seeds: [0],
      commitSha: 'cafebabe',
      llmOpts: { baseUrl: 'https://api.test.local/v1', apiKey: 'sk-test' },
      storeFactory: () => new InMemoryTraceStore(),
      rawSinkFactory: () => new InMemoryRawProviderSink(),
      runner,
    }

    const result = await runEvalCampaign(opts)
    expect(result.failedRuns).toHaveLength(1)
    expect(result.failedRuns[0]?.reason).toBe('runner_threw')
    expect(result.failedRuns[0]?.error).toBe('threw before startRun')
  })
})
