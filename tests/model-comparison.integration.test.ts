import { once } from 'node:events'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { describe, expect, it } from 'vitest'
import { inMemoryCampaignStorage } from '../src/campaign/storage'
import { analyzeRuns, createChatClient, type ModelTreatment, selfImprove } from '../src/contract'
import type { RunRecord } from '../src/run-record'

const baselineModel = 'openai/gpt-4.1-2025-04-14'
const candidateModel = 'gpt-4.1-2025-05-14'
const scenarios = ['t1', 't2', 's1', 'h1', 'h2'].map((id) => ({ id, kind: 'fixture' }))
const freeCost = {
  totalCostUsd: 0,
  costProvenance: { kind: 'observed' as const, usd: 0 },
  accountingComplete: true,
  incompleteReasons: [],
}

async function measuredComparison(
  mode: 'method' | 'proposer',
  servedCandidate: string,
  modelTreatment?: ModelTreatment,
  neutralizedModel?: string,
) {
  let gateCalls = 0
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
    agent: async (surface, _scenario, context) => {
      const model =
        surface === 'BASE'
          ? baselineModel
          : surface === 'BLANK'
            ? neutralizedModel!
            : servedCandidate
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
        gateCalls++
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
  return { result, gateCalls }
}

describe('served snapshots through public comparison boundaries', () => {
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
    const runs: RunRecord[] = Array.from({ length: 24 }, (_, index) =>
      ['baseline', 'candidate'].map((arm) => ({
        runId: `${arm}-${index}`,
        experimentId: 'model-comparison',
        candidateId: arm,
        scenarioId: `task-${index}`,
        seed: 0,
        model: arm === 'candidate' && index === 0 ? candidateModel : baselineModel,
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
})
