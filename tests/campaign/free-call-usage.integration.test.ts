import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  type DispatchContext,
  inMemoryCampaignStorage,
  type JudgeConfig,
  runCampaign,
  runProfileMatrix,
} from '../../src/campaign'
import { BackendIntegrityError } from '../../src/index'

// A retrieval that cannot spend money (an in-process search over a local
// corpus), recorded the way a knowledge retriever records one: a call through
// ctx.cost.runPaidCall with a $0 enforced maximum and a receipt that states
// zero tokens and an observed cost of $0.
const RETRIEVER_MODEL = 'local-search-2026-11-01'
const CORPUS: Record<string, string> = {
  alpha: 'alpha is the first letter of the Greek alphabet',
  beta: 'beta is the second letter of the Greek alphabet',
}
const scenarios = [
  { id: 'alpha', term: 'first' },
  { id: 'beta', term: 'second' },
]
type Question = (typeof scenarios)[number]

async function retrieveFree(scenario: Question, ctx: DispatchContext): Promise<string> {
  const call = await ctx.cost.runPaidCall({
    actor: 'retriever',
    model: RETRIEVER_MODEL,
    maximumCharge: { externallyEnforcedMaximumUsd: 0 },
    execute: async () => CORPUS[scenario.id]!,
    receipt: () => ({
      model: RETRIEVER_MODEL,
      inputTokens: 0,
      outputTokens: 0,
      actualCostUsd: 0,
    }),
  })
  if (!call.succeeded) throw call.error
  return call.value
}

const answers: JudgeConfig<string, Question> = {
  name: 'answers',
  dimensions: [{ key: 'found', description: 'the passage answers the question' }],
  score: ({ artifact, scenario }) => {
    const found = artifact.includes(scenario.term) ? 1 : 0
    return { dimensions: { found }, composite: found, notes: '' }
  },
}

function freeCampaign(runDir: string, storage = inMemoryCampaignStorage()) {
  return {
    scenarios,
    dispatch: retrieveFree,
    judges: [answers],
    expectUsage: 'assert' as const,
    runDir,
    storage,
  }
}

describe('expectUsage: a recorded free call is work at a known $0', () => {
  it('accepts a cell whose dispatch records one known-$0 call, with its cost known at $0', async () => {
    const result = await runCampaign(freeCampaign(mkdtempSync(join(tmpdir(), 'free-call-'))))

    expect(result.cells).toHaveLength(2)
    for (const cell of result.cells) {
      expect(cell.error).toBeUndefined()
      expect(cell.judgeScores.answers?.composite).toBe(1)
      expect(cell.costUsd).toBe(0)
      expect(cell.costProvenance).toEqual({ kind: 'observed', usd: 0 })
      expect(cell.tokenUsage).toEqual({ input: 0, output: 0 })
      expect(cell.costCallIds).toHaveLength(1)
      expect(cell.resolvedModel).toBe(RETRIEVER_MODEL)
    }
    expect(result.aggregates.cost).toMatchObject({
      totalCalls: 2,
      totalCostUsd: 0,
      costProvenance: { kind: 'observed', usd: 0 },
      accountingComplete: true,
    })
  })

  it('accepts the same cell when it is reused from the cache', async () => {
    const options = freeCampaign(mkdtempSync(join(tmpdir(), 'free-call-cached-')))
    await runCampaign(options)
    const resumed = await runCampaign(options)

    expect(resumed.cells.map((cell) => cell.cached)).toEqual([true, true])
    expect(resumed.cells.map((cell) => cell.costProvenance)).toEqual([
      { kind: 'observed', usd: 0 },
      { kind: 'observed', usd: 0 },
    ])
  })

  it('refuses a cell that records no call, and says that no call was recorded', async () => {
    const error = await runCampaign({
      ...freeCampaign(mkdtempSync(join(tmpdir(), 'no-call-'))),
      scenarios: scenarios.slice(0, 1),
      dispatch: async (scenario) => CORPUS[scenario.id]!,
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(BackendIntegrityError)
    expect((error as Error).message).toMatch(
      /cell '[^']+' produced an artifact but recorded no agent call through ctx\.cost\.runPaidCall/,
    )
    expect((error as BackendIntegrityError).report).toMatchObject({
      totalRecords: 0,
      realRecords: 0,
      verdict: 'stub',
    })
  })

  it('refuses a recorded call that reports no tokens, no charge and no observed cost', async () => {
    const error = await runCampaign({
      ...freeCampaign(mkdtempSync(join(tmpdir(), 'empty-receipt-'))),
      scenarios: scenarios.slice(0, 1),
      dispatch: async (scenario, ctx) => {
        const call = await ctx.cost.runPaidCall({
          actor: 'retriever',
          model: RETRIEVER_MODEL,
          execute: async () => CORPUS[scenario.id]!,
          // Usage the call dropped: no tokens, and no cost it states.
          receipt: () => ({ model: RETRIEVER_MODEL, inputTokens: 0, outputTokens: 0 }),
        })
        if (!call.succeeded) throw call.error
        return call.value
      },
    }).then(
      () => undefined,
      (thrown: unknown) => thrown,
    )

    expect(error).toBeInstanceOf(BackendIntegrityError)
    expect((error as Error).message).toMatch(
      /recorded 1 agent call through ctx\.cost\.runPaidCall, and none reports tokens, a charge or an observed cost/,
    )
    expect((error as BackendIntegrityError).report).toMatchObject({
      totalRecords: 1,
      stubRecords: 1,
      verdict: 'stub',
    })
  })

  it('lets runProfileMatrix, which asserts a real backend by default, accept a matrix of free calls', async () => {
    const result = await runProfileMatrix({
      profiles: [{ name: 'retriever', model: { default: RETRIEVER_MODEL } }],
      scenarios,
      dispatch: (_profile, scenario, ctx) => retrieveFree(scenario, ctx),
      judges: [answers],
      runDir: mkdtempSync(join(tmpdir(), 'free-matrix-')),
      commitSha: 'free-call-matrix',
      storage: inMemoryCampaignStorage(),
    })

    expect(result.integrity).toMatchObject({
      totalRecords: 2,
      realRecords: 2,
      stubRecords: 0,
      verdict: 'real',
    })
    expect(result.records.map((record) => record.costProvenance)).toEqual([
      { kind: 'observed', usd: 0 },
      { kind: 'observed', usd: 0 },
    ])
  })
})
