import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { runProfileMatrix } from '../src/campaign'
import { inMemoryCampaignStorage } from '../src/campaign/storage'
import {
  analyzeRuns,
  createChatClient,
  fromCodexSession,
  type ModelTreatment,
  runImprovementLoop,
  selfImprove,
} from '../src/contract'
import { modelHasSnapshot, type RunRecord, UNKNOWN_MODEL } from '../src/run-record'
import { otlpToRunRecords } from '../src/trace-analyst/otlp-to-run-records'

const baselineModel = 'openai/gpt-4.1-2025-04-14'
const candidateModel = 'gpt-4.1-2025-05-14'
const scenarios = ['t1', 't2', 's1', 'h1', 'h2'].map((id) => ({ id, kind: 'fixture' }))
const freeCost = {
  totalCostUsd: 0,
  costProvenance: { kind: 'observed' as const, usd: 0 },
  accountingComplete: true,
  incompleteReasons: [],
}

type Observed = { gateCalls: number; decided: string[] }

async function measuredComparison(
  mode: 'method' | 'proposer',
  servedCandidate: string,
  modelTreatment?: ModelTreatment,
  neutralizedModel?: string,
  // An executor adds a second paid call to every cell of both arms.
  extra: { executor?: string; observed?: Observed } = {},
) {
  const observed: Observed = extra.observed ?? { gateCalls: 0, decided: [] }
  const result = await selfImprove({
    scenarios,
    baselineSurface: 'BASE',
    // A fallback must never overwrite a concrete receipt from the candidate.
    model: baselineModel,
    modelTreatment,
    storage: inMemoryCampaignStorage(),
    runDir: 'mem://served-model-comparison',
    budget: {
      holdoutScenarios: scenarios.slice(3),
      ...(mode === 'proposer' ? { generations: 1, populationSize: 1 } : {}),
    },
    onProgress: (event) => {
      if (event.kind === 'gate.decided') observed.decided.push(event.decision)
    },
    agent: async (surface, _scenario, context) => {
      const model =
        surface === 'BASE'
          ? baselineModel
          : surface === 'BLANK'
            ? neutralizedModel!
            : servedCandidate
      const executor = extra.executor
      if (executor) {
        const executed = await context.cost.runPaidCall({
          actor: 'worker',
          model: executor,
          execute: async () => executor,
          receipt: () => ({ model: executor, inputTokens: 2, outputTokens: 1, actualCostUsd: 0 }),
        })
        if (!executed.succeeded) throw executed.error
      }
      const response = await context.cost.runPaidCall({
        actor: 'worker',
        model,
        execute: async () => ({ quality: surface === 'BASE' ? 0.2 : 0.8 }),
        receipt: () => ({ model, inputTokens: 2, outputTokens: 1, actualCostUsd: 0 }),
      })
      if (!response.succeeded) throw response.error
      return response.value
    },
    judge: {
      name: 'quality',
      dimensions: [{ key: 'quality', description: 'Observed task quality' }],
      score: ({ artifact }) => ({
        composite: artifact.quality,
        dimensions: { quality: artifact.quality },
        notes: '',
      }),
    },
    gate: {
      name: 'custom-promotion',
      decide: async () => {
        observed.gateCalls++
        return { decision: 'ship', reasons: [], contributingGates: [] }
      },
    },
    ...(neutralizedModel ? { neutralize: () => 'BLANK' } : {}),
    ...(mode === 'method'
      ? {
          method: {
            name: 'selected',
            optimize: async () => ({ winnerSurface: 'WIN', cost: freeCost }),
          },
        }
      : { proposer: { kind: 'fixed', propose: async () => ['WIN'] } }),
  })
  return { result, gateCalls: observed.gateCalls }
}

// One paid call: `served` is the model the response names; without it the call times out.
type PaidCall = { requested?: string; served?: string }

async function improvementLoop(
  callsFor: (surface: string) => PaidCall[],
  options: { model?: string; modelTreatment?: ModelTreatment; requireReportedModel?: boolean } = {},
) {
  let gateCalls = 0
  const result = await runImprovementLoop({
    scenarios: scenarios.slice(0, 3),
    holdoutScenarios: scenarios.slice(3),
    baselineSurface: 'BASE',
    storage: inMemoryCampaignStorage(),
    runDir: 'mem://improvement-loop-comparison',
    proposer: { kind: 'fixed', propose: async () => ['WIN'] },
    populationSize: 1,
    maxGenerations: 1,
    autoOnPromote: 'none',
    ...options,
    dispatchWithSurface: async (surface, _scenario, context) => {
      for (const call of callsFor(String(surface))) {
        const response = await context.cost.runPaidCall({
          actor: 'worker',
          ...(call.requested ? { model: call.requested } : {}),
          execute: async () => {
            if (call.served === undefined) throw new Error('request timed out')
            return call.served
          },
          receipt: (model) => ({ model, inputTokens: 2, outputTokens: 1, actualCostUsd: 0 }),
        })
        // The agent retries a timed-out call; the next entry is that retry.
        if (!response.succeeded && call.served !== undefined) throw response.error
      }
      return { quality: surface === 'BASE' ? 0.2 : 0.8 }
    },
    judges: [
      {
        name: 'quality',
        dimensions: [{ key: 'quality', description: 'Observed task quality' }],
        score: ({ artifact }) => ({
          composite: artifact.quality,
          dimensions: { quality: artifact.quality },
          notes: '',
        }),
      },
    ],
    gate: {
      name: 'custom-promotion',
      decide: async () => {
        gateCalls++
        return { decision: 'ship', reasons: [], contributingGates: [] }
      },
    },
  })
  return { result, gateCalls }
}

// Every cell records two paid calls: a planner, then an executor.
const plannerExecutorLoop = (candidateExecutor: string) =>
  improvementLoop((surface) =>
    ['gpt-4.1-2025-04-14', surface === 'BASE' ? 'gpt-4.1-mini-2025-04-14' : candidateExecutor].map(
      (model) => ({ requested: model, served: model }),
    ),
  )

function pairedRuns(candidateModelAt: (index: number) => string): RunRecord[] {
  return Array.from({ length: 24 }, (_, index) =>
    ['baseline', 'candidate'].map((arm) => ({
      runId: `${arm}-${index}`,
      experimentId: 'model-comparison',
      candidateId: arm,
      scenarioId: `task-${index}`,
      seed: 0,
      model: arm === 'candidate' ? candidateModelAt(index) : baselineModel,
      promptHash: `sha256:${arm}`,
      configHash: 'sha256:fixture',
      commitSha: 'fixture',
      wallMs: 1,
      costUsd: 0,
      costProvenance: { kind: 'observed' as const, usd: 0 },
      tokenUsage: { input: 1, output: 1 },
      terminalOutcome: 'succeeded' as const,
      outcome: { raw: {}, holdoutScore: arm === 'baseline' ? 0.2 : 0.65 + index / 200 },
      splitTag: 'holdout' as const,
    })),
  ).flat()
}

describe('served snapshots through public comparison boundaries', () => {
  it('lets the gate decide when both arms serve the same set of models in every cell', async () => {
    const matched = await plannerExecutorLoop('gpt-4.1-mini-2025-04-14')
    expect(matched.result.winnerOnHoldout.cells[0]?.resolvedModels).toHaveLength(2)
    expect(matched.gateCalls).toBe(1)
    expect(matched.result.gateResult.decision).toBe('ship')
    expect(matched.result.modelComparison).toMatchObject({
      policy: 'matched',
      eligible: true,
      checkedPairs: 2,
      issues: [],
    })

    const changed = await plannerExecutorLoop('gpt-4.1-nano-2025-04-14')
    expect(changed.gateCalls).toBe(0)
    expect(changed.result.gateResult.decision).toBe('hold')
    expect(changed.result.modelComparison.issues.map((issue) => issue.reason)).toEqual([
      'baseline and candidate served different model snapshots',
      'baseline and candidate served different model snapshots',
    ])
  })

  it('counts a failed run without a served model as unreported in analyzeRuns', async () => {
    const runs = pairedRuns(() => baselineModel)
    const failed = runs.find((run) => run.runId === 'candidate-0')!
    Object.assign(failed, {
      model: UNKNOWN_MODEL,
      terminalOutcome: 'failed',
      outcome: { raw: {}, holdoutScore: 0 },
    })
    const report = await analyzeRuns({
      runs,
      baselineCandidateId: 'baseline',
      candidateCandidateId: 'candidate',
    })
    expect(report.lift?.n).toBe(24)
    expect(report.lift?.decisionEligible).toBe(true)
    expect(report.lift?.modelComparison).toMatchObject({
      eligible: true,
      checkedPairs: 23,
      unreportedPairs: 1,
      issues: [],
    })
  })

  it('reports served-model identity as not evaluated when analyzeRuns checks no pair', async () => {
    const runs = pairedRuns(() => baselineModel)
    for (const run of runs)
      if (run.candidateId === 'baseline')
        Object.assign(run, {
          model: UNKNOWN_MODEL,
          terminalOutcome: 'failed',
          outcome: { raw: {}, holdoutScore: 0.4 },
        })
    const report = await analyzeRuns({
      runs,
      baselineCandidateId: 'baseline',
      candidateCandidateId: 'candidate',
      canaryScenarios: [{ id: 'canary', payload: {}, canary: 'canary-token-never-emitted' }],
    })
    expect(report.lift).toMatchObject({ n: 24, decisionEligible: true })
    expect(report.lift?.modelComparison).toMatchObject({ checkedPairs: 0, unreportedPairs: 24 })
    expect(report.release.axes).toContainEqual(
      expect.objectContaining({ name: 'served-model-identity', status: 'not_evaluated' }),
    )
    expect(report.release.status).toBe('warn')
  })

  it.each(['method', 'proposer'] as const)(
    'holds %s promotion before a custom gate while preserving every measured cell',
    async (mode) => {
      const { result, gateCalls } = await measuredComparison(mode, candidateModel)
      expect(gateCalls).toBe(0)
      expect(result.gateDecision).toBe('hold')
      expect(result.raw.baselineOnHoldout.cells).toHaveLength(2)
      expect(result.raw.winnerOnHoldout.cells).toHaveLength(2)
      expect(result.raw.modelComparison).toMatchObject({
        policy: 'matched',
        eligible: false,
        checkedPairs: 2,
      })
      expect(result.insight?.n).toBe(4)
      expect(result.insight?.lift).toMatchObject({ n: 2, decisionEligible: false })
      expect(result.insight?.recommendations.some((row) => row.kind === 'ship')).toBe(false)
      expect(result.provenance.gate.contributingGates).toContainEqual(
        expect.objectContaining({ name: 'served-model-identity', status: 'fail' }),
      )
    },
  )

  it.each(['method', 'proposer'] as const)(
    'holds a %s cell that calls several models before a custom gate',
    async (mode) => {
      // Both arms call the same planner and executor; selfImprove records one model per cell,
      // so a second spelling of the planner's snapshot also counts as a second model.
      for (const executor of ['gpt-4.1-mini-2025-04-14', 'gpt-4.1-2025-04-14']) {
        const observed: Observed = { gateCalls: 0, decided: [] }
        await expect(
          measuredComparison(mode, baselineModel, undefined, undefined, { executor, observed }),
        ).rejects.toThrow(/multiple agent models/)
        expect(observed.gateCalls).toBe(0)
        expect(observed.decided).toEqual(mode === 'proposer' ? ['hold'] : [])
      }
    },
  )

  it.each(['method', 'proposer'] as const)(
    'admits %s routing aliases and predeclared exact model treatments',
    async (mode) => {
      const matched = await measuredComparison(mode, 'gpt-4.1-20250414')
      expect(matched.result.gateDecision).toBe('ship')
      expect(matched.gateCalls).toBe(1)
      const treatment = { baseline: baselineModel, candidate: candidateModel }
      const changed = await measuredComparison(mode, candidateModel, treatment)
      expect(changed.result.gateDecision).toBe('ship')
      expect(changed.result.raw.modelComparison).toMatchObject({
        policy: 'treatment',
        treatment,
        eligible: true,
      })
      expect(changed.result.insight?.lift?.modelComparison?.eligible).toBe(true)
      const wrong = await measuredComparison(mode, 'gpt-4.1-2025-06-14', treatment)
      expect(wrong.result.gateDecision).toBe('hold')
      expect(wrong.gateCalls).toBe(0)
    },
  )

  it('checks the optional neutralized arm against the same declared candidate model', async () => {
    const { result, gateCalls } = await measuredComparison(
      'method',
      candidateModel,
      { baseline: baselineModel, candidate: candidateModel },
      baselineModel,
    )
    expect(result.gateDecision).toBe('hold')
    expect(gateCalls).toBe(0)
    expect(
      result.raw.modelComparison.issues.every((issue) => issue.id.startsWith('neutralized:')),
    ).toBe(true)
    expect(result.raw.neutralizedOnHoldout?.cells).toHaveLength(2)
  })

  it('retains significant descriptive lift but withholds an analyzeRuns ship recommendation for a single confounded pair', async () => {
    const runs = pairedRuns((index) => (index === 0 ? candidateModel : baselineModel))
    const report = await analyzeRuns({
      runs,
      baselineCandidateId: 'baseline',
      candidateCandidateId: 'candidate',
    })
    expect(report.n).toBe(48)
    expect(report.lift?.n).toBe(24)
    expect(report.lift?.ci95[0]).toBeGreaterThan(0.4)
    expect(report.lift?.decisionEligible).toBe(false)
    expect(report.lift?.modelComparison?.issues).toHaveLength(1)
    expect(report.release.status).toBe('fail')
    expect(report.recommendations.some((row) => row.kind === 'ship')).toBe(false)

    for (const run of runs) if (run.candidateId === 'candidate') run.model = candidateModel
    const treatment = { baseline: baselineModel, candidate: candidateModel }
    const explicit = await analyzeRuns({
      runs,
      baselineCandidateId: 'baseline',
      candidateCandidateId: 'candidate',
      modelTreatment: treatment,
    })
    expect(explicit.lift?.decisionEligible).toBe(true)
    expect(explicit.recommendations.some((row) => row.kind === 'ship')).toBe(true)
    for (const run of runs)
      run.model = run.candidateId === 'baseline' ? 'fixture@releaseA' : 'fixture@releasea'
    const opaque = await analyzeRuns({
      runs,
      baselineCandidateId: 'baseline',
      candidateCandidateId: 'candidate',
    })
    expect(opaque.lift?.decisionEligible).toBe(false)
    await expect(analyzeRuns({ runs, modelTreatment: treatment })).rejects.toThrow(
      /explicit baseline and candidate ids/,
    )
    await expect(
      analyzeRuns({
        runs,
        baselineCandidateId: 'baseline',
        candidateCandidateId: 'candidate',
        modelTreatment: { ...treatment, candidate: 'gpt-4.1' },
      }),
    ).rejects.toThrow(/requires pinned/)
  })

  it('enforces exact pinned snapshots at the actual HTTP client boundary', async () => {
    let served = candidateModel
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {
        /* consume the request body */
      }
      response.setHeader('content-type', 'application/json')
      response.end(
        JSON.stringify({
          model: served,
          choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }],
          usage: { prompt_tokens: 1, completion_tokens: 1 },
        }),
      )
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const client = createChatClient({
      transport: 'openai-compatible',
      apiKey: 'fixture-only',
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`,
      maximumAttempts: 1,
      assertServedModel: true,
      minIntervalMs: 0,
    })
    const call = (model: string) =>
      client.chat({ model, messages: [{ role: 'user', content: 'Return ok' }] })
    try {
      await expect(call('openai/gpt-4.1')).resolves.toMatchObject({ servedModel: candidateModel })
      served = 'gpt-4.1-20250414'
      await expect(call(baselineModel)).resolves.toMatchObject({ servedModel: served })
      for (const [requested, actual] of [
        [baselineModel, candidateModel],
        [baselineModel, 'gpt-4.1'],
        ['fixture@build-a', 'fixture@build-b'],
        ['fixture@releaseA', 'fixture@releasea'],
        ['fixture-2025-04-14@v1', 'fixture-2025-05-14@v1'],
        ['fixture:date-build-a', 'fixture:date-build-b'],
        ['fixture:date-releaseA', 'fixture:date-releasea'],
        ['fixture-0301', 'fixture-0401'],
      ]) {
        served = actual!
        await expect(call(requested!)).rejects.toThrow(/served/)
      }
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      )
    }
  })

  it('admits a pinned id spelled with a routing tier, a Bedrock revision or a release', async () => {
    for (const served of [
      'deepseek/deepseek-chat-v3-0324:free',
      'anthropic.claude-3-5-sonnet-20240620-v1:0',
      'mistralai/devstral-2512:free',
      'anthropic/claude-sonnet-4.6',
    ]) {
      const { result, gateCalls } = await improvementLoop(() => [{ requested: served, served }])
      expect.soft(result.modelComparison, served).toMatchObject({ eligible: true, issues: [] })
      expect.soft(gateCalls, served).toBe(1)
    }
    // The comparison, checkServedModel and run-record validation read this one grammar.
    const grammar: Array<[string, boolean]> = [
      ['deepseek/deepseek-chat-v3-0324:free', true],
      ['gpt-4.1-2025-04-14:batch', true],
      ['anthropic.claude-3-5-sonnet-20240620-v1:0', true],
      ['amazon.nova-pro-v1:0', true],
      ['Claude-Sonnet-5', true],
      ['claude-code/anthropic/claude-sonnet-5', true],
      ['anthropic/claude-sonnet-4.6', true],
      ['fixture:date-build-a', true],
      ['mistralai/devstral-2512:free', true],
      ['qwen/qwen3-235b-a22b-2507', true],
      ['gpt-4.1:free', false],
      ['codestral-latest', false],
      ['claude-sonnet-4-5', false],
      ['anthropic/claude-sonnet-4.5', false],
      ['fixture-20241399', false],
      ['fixture-2024-13-01', false],
      ['fixture-0230', false],
      ['fixture@build-', false],
      ['fixture:date-build.', false],
      ['fixture@preset/name', false],
      [' gpt-4.1-2025-04-14 ', false],
    ]
    expect(grammar.filter(([model, pinned]) => modelHasSnapshot(model) !== pinned)).toEqual([])
  })

  it('counts only served calls, so a timed-out call before a served retry does not hold', async () => {
    const pinned = 'gpt-4.1-2025-04-14'
    // A timed-out call's receipt names the requested alias, or `unknown` when none was named.
    for (const requested of ['gpt-4.1', undefined]) {
      const { result, gateCalls } = await improvementLoop((surface) => [
        ...(surface === 'WIN' ? [{ requested }] : []),
        { requested, served: pinned },
      ])
      expect(result.modelComparison, String(requested)).toMatchObject({
        eligible: true,
        issues: [],
      })
      expect(gateCalls).toBe(1)
      expect(result.winnerOnHoldout.cells.map((cell) => cell.resolvedModels)).toEqual([
        [pinned],
        [pinned],
      ])
    }
  })

  it('takes no model from a cell whose only paid call failed', async () => {
    const pinned = 'gpt-4.1-2025-04-14'
    // Every winner cell's only call times out; the dispatch still returns a scored artifact.
    const winnerTimesOut = (requested: string) => (surface: string) =>
      surface === 'WIN' ? [{ requested }] : [{ requested: pinned, served: pinned }]
    const unserved = await improvementLoop(winnerTimesOut(pinned))
    expect.soft(unserved.gateCalls).toBe(0)
    expect
      .soft(unserved.result.modelComparison.issues.map((issue) => issue.reason))
      .toEqual(['each arm needs a reported served model', 'each arm needs a reported served model'])
    const required = await improvementLoop(winnerTimesOut(pinned), { requireReportedModel: true })
    expect.soft(required.gateCalls).toBe(0)
    expect
      .soft(required.result.modelComparison.issues.map((issue) => issue.reason))
      .toEqual([
        'each arm needs one unambiguous served model',
        'each arm needs one unambiguous served model',
      ])
    // A declared model fills a cell that served nothing, whatever the failed call requested.
    const declared = await improvementLoop(winnerTimesOut('gpt-4.1'), { model: pinned })
    expect.soft(declared.result.modelComparison).toMatchObject({ eligible: true, issues: [] })
    expect.soft(declared.gateCalls).toBe(1)

    // A failed profile-matrix row keeps its absence marker, not the alias it requested.
    const matrix = await runProfileMatrix({
      profiles: [{ name: 'moving', model: { default: 'gpt-4.1' } }],
      scenarios: scenarios.slice(0, 1),
      storage: inMemoryCampaignStorage(),
      runDir: 'mem://profile-matrix-failed-row',
      commitSha: 'fixture',
      integrity: 'off',
      dispatch: async (_profile, _scenario, context) => {
        const response = await context.cost.runPaidCall({
          actor: 'worker',
          model: 'gpt-4.1',
          execute: async (): Promise<string> => {
            throw new Error('request timed out')
          },
          receipt: () => ({ model: pinned, inputTokens: 2, outputTokens: 1, actualCostUsd: 0 }),
        })
        if (!response.succeeded) throw response.error
        return response.value
      },
    })
    expect(matrix.records.map((record) => [record.model, record.terminalOutcome])).toEqual([
      [UNKNOWN_MODEL, 'failed'],
    ])
  })

  it('does not read intake tags for an unrecorded snapshot as pinned served models', async () => {
    // Codex cohorts share 20 scenarios, the bootstrap floor; the candidate scores higher.
    const cohort = (candidateId: string, model: string, score: (index: number) => number) =>
      Array.from(
        { length: 20 },
        (_, index) =>
          fromCodexSession({
            entries: [
              { type: 'thread.started', thread_id: `codex-${candidateId}-${index}` },
              { type: 'turn_context', payload: { model } },
              { type: 'turn.started' },
              { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } },
            ],
            candidateId,
            scenarioId: `s${index}`,
            seed: 0,
            score: score(index),
          }).runs,
      ).flat()
    const baseline = cohort('baseline', 'gpt-5-codex', (index) => 0.2 + index / 100)
    const analyze = (candidate: RunRecord[], modelTreatment?: ModelTreatment) =>
      analyzeRuns({
        runs: [...baseline, ...candidate],
        baselineCandidateId: 'baseline',
        candidateCandidateId: 'candidate',
        modelTreatment,
      })
    const sameAlias = cohort('candidate', 'gpt-5-codex', () => 0.8)
    expect.soft(sameAlias[0]?.model).toBe('gpt-5-codex@observed-local')
    // One moving alias on both sides, or no recorded model: unreported, and lift is descriptive.
    for (const model of ['gpt-5-codex@observed-local', 'gpt-5-codex@otlp', 'unknown@unknown']) {
      const report = await analyze(sameAlias.map((run) => ({ ...run, model })))
      expect.soft(report.lift, model).toMatchObject({
        n: 20,
        decisionEligible: false,
        modelComparison: { checkedPairs: 0, unreportedPairs: 20 },
      })
      expect
        .soft(report.release.axes)
        .toContainEqual(
          expect.objectContaining({ name: 'served-model-identity', status: 'not_evaluated' }),
        )
      expect.soft(report.recommendations.some((row) => row.kind === 'ship')).toBe(false)
    }
    // Cohorts that recorded different models served different models, tagged or not.
    const changed = cohort('candidate', 'gpt-5.1-codex', () => 0.8)
    for (const candidate of [
      cohort('candidate', 'gpt-5', () => 0.8),
      changed,
      changed.map((run) => ({ ...run, model: 'claude-sonnet-4-5-20250929' })),
    ]) {
      const report = await analyze(candidate)
      expect.soft(report.lift, candidate[0]?.model).toMatchObject({
        decisionEligible: false,
        modelComparison: { eligible: false, checkedPairs: 20 },
      })
      expect
        .soft(report.release.axes)
        .toContainEqual(expect.objectContaining({ name: 'served-model-identity', status: 'fail' }))
    }
    // A declared treatment needs the build each arm served; an intake tag names none.
    const declared = await analyze(changed, {
      baseline: 'gpt-5-codex@2025-09-15',
      candidate: 'gpt-5.1-codex@2025-11-13',
    })
    expect.soft(declared.lift).toMatchObject({
      decisionEligible: false,
      modelComparison: { eligible: false, checkedPairs: 20 },
    })

    // OTLP intake tags a moving alias `@otlp`, never with the fallback's snapshot token.
    const traces = (candidateId: string, attributes: Record<string, string>) =>
      otlpToRunRecords(
        Array.from({ length: 20 }, (_, index) =>
          JSON.stringify({
            trace_id: `${candidateId}-${index}`,
            span_id: 'llm',
            name: 'llm',
            start_time: '1700000000000',
            end_time: '1700000001000',
            status: { code: 'OK' },
            attributes: { 'openinference.span.kind': 'LLM', ...attributes },
          }),
        ).join('\n'),
        {
          experimentId: 'otlp-cohorts',
          candidateId,
          fallbackModel: 'unknown@phoenix',
          logicalRunIdForTrace: (traceId) => traceId.split('-')[1]!,
          scoreForTrace: (runId) => (candidateId === 'baseline' ? 0.2 + Number(runId) / 100 : 0.8),
        },
      )
    expect
      .soft(traces('baseline', { 'gen_ai.request.model': 'gpt-4o-mini' })[0]?.model)
      .toBe('gpt-4o-mini@otlp')
    const attributeSets: Array<Record<string, string>> = [{ 'gen_ai.request.model': 'gpt-4o' }, {}]
    for (const attributes of attributeSets) {
      const report = await analyzeRuns({
        runs: [...traces('baseline', attributes), ...traces('candidate', attributes)],
        baselineCandidateId: 'baseline',
        candidateCandidateId: 'candidate',
      })
      expect.soft(report.lift, JSON.stringify(attributes)).toMatchObject({
        n: 20,
        decisionEligible: false,
        modelComparison: { checkedPairs: 0, unreportedPairs: 20 },
      })
    }
  })

  it('names an arm with no served model and counts treatment snapshots, not spellings', async () => {
    const pinned = 'gpt-4.1-2025-04-14'
    const served = (models: string[]) =>
      models.map((model) => ({ requested: model, served: model }))
    const empty = await improvementLoop((surface) => (surface === 'BASE' ? served([pinned]) : []))
    expect(empty.gateCalls).toBe(0)
    expect(empty.result.modelComparison.issues.map((issue) => issue.reason)).toEqual([
      'each arm needs a reported served model',
      'each arm needs a reported served model',
    ])
    // Without requireReportedModel, one candidate snapshot under two spellings is one model.
    const candidate = 'gpt-4.1-2025-05-14'
    const spelled = await improvementLoop(
      (surface) => served(surface === 'BASE' ? [pinned] : [candidate, `openai/${candidate}`]),
      { modelTreatment: { baseline: pinned, candidate } },
    )
    expect(spelled.result.winnerOnHoldout.cells[0]?.resolvedModels).toHaveLength(2)
    expect(spelled.result.modelComparison).toMatchObject({
      policy: 'treatment',
      eligible: true,
      issues: [],
    })
    expect(spelled.gateCalls).toBe(1)
  })
})
