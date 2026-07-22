/**
 * ensembleJudge — the multi-model panel built from the substrate's judge
 * primitives. These tests pin the fail-loud invariants: a failed model is
 * recorded, never averaged as zero; an all-failed panel throws; a
 * single-family panel is rejected at construction; repeat samples of one
 * model get distinct vote keys.
 */

import { describe, expect, it } from 'vitest'
import { CostLedger, CrossFamilyError, ensembleJudge, type JudgeVerdict } from '../src/index'

type Dim = 'accuracy' | 'tone'
const DIMS: Dim[] = ['accuracy', 'tone']

// Two distinct provider families so the default crossFamily gate passes.
const PANEL = ['openai/gpt-4o', 'anthropic/claude-sonnet-4']

function fakeScoreWith(
  perModel: Record<string, { accuracy: number; tone: number } | Error>,
): (model: string, input: { artifact: unknown; scenario?: unknown }) => Promise<JudgeVerdict<Dim>> {
  return async (model) => {
    const v = perModel[model]
    if (!v) throw new Error(`unexpected model ${model}`)
    if (v instanceof Error) throw v
    return { model, perDimension: v, rationale: `${model} verdict` }
  }
}

const signal = new AbortController().signal
const scenario = { id: 's1', kind: 'unit' }

describe('ensembleJudge — construction', () => {
  it('rejects a single-family panel by default', () => {
    expect(() =>
      ensembleJudge({
        name: 'panel',
        dimensions: DIMS,
        models: ['openai/gpt-4o', 'openai/gpt-4o-mini'],
        scoreWith: fakeScoreWith({}),
      }),
    ).toThrow(CrossFamilyError)
  })

  it('crossFamily: false permits deliberate single-family panels', () => {
    expect(() =>
      ensembleJudge({
        name: 'panel',
        dimensions: DIMS,
        models: ['openai/gpt-4o', 'openai/gpt-4o'],
        scoreWith: fakeScoreWith({}),
        crossFamily: false,
      }),
    ).not.toThrow()
  })

  it('throws on empty models or dimensions', () => {
    expect(() =>
      ensembleJudge({ name: 'p', dimensions: DIMS, models: [], scoreWith: fakeScoreWith({}) }),
    ).toThrow(/models is empty/)
    expect(() =>
      ensembleJudge({ name: 'p', dimensions: [], models: PANEL, scoreWith: fakeScoreWith({}) }),
    ).toThrow(/dimensions is empty/)
  })

  it('returns the campaign JudgeConfig shape', () => {
    const judge = ensembleJudge({
      name: 'panel',
      dimensions: DIMS,
      models: PANEL,
      scoreWith: fakeScoreWith({}),
    })
    expect(judge.name).toBe('panel')
    expect(judge.dimensions.map((d) => d.key)).toEqual(DIMS)
  })
})

describe('ensembleJudge — scoring', () => {
  it('attributes reported usage and cost to judge receipts', async () => {
    const costLedger = new CostLedger()
    const judge = ensembleJudge({
      name: 'panel',
      dimensions: DIMS,
      models: PANEL,
      costLedger,
      scoreWith: async (model) => ({
        model,
        perDimension: { accuracy: 1, tone: 1 },
        costUsd: 0.25,
        usage: {
          promptTokens: 120,
          completionTokens: 30,
          totalTokens: 150,
          cachedPromptTokens: 20,
        },
      }),
    })

    await judge.score({ artifact: 'text', scenario, signal })

    expect(costLedger.summary()).toMatchObject({
      totalCalls: 2,
      inputTokens: 200,
      outputTokens: 60,
      cachedTokens: 40,
      totalCostUsd: 0.5,
      accountingComplete: true,
      byChannel: [
        {
          channel: 'judge',
          calls: 2,
          inputTokens: 200,
          outputTokens: 60,
          cachedTokens: 40,
          costUsd: 0.5,
        },
      ],
    })
  })

  it('prices panel usage when the provider omits an explicit dollar amount', async () => {
    const costLedger = new CostLedger()
    const judge = ensembleJudge({
      name: 'panel',
      dimensions: DIMS,
      models: PANEL,
      costLedger,
      scoreWith: async (model) => ({
        model,
        perDimension: { accuracy: 1, tone: 1 },
        usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
      }),
    })

    await judge.score({ artifact: 'text', scenario, signal })

    expect(costLedger.summary()).toMatchObject({
      totalCalls: 2,
      inputTokens: 240,
      outputTokens: 60,
      fullyPriced: true,
      usageComplete: true,
      accountingComplete: true,
    })
    expect(costLedger.summary().totalCostUsd).toBeGreaterThan(0)
  })

  it('rejects opaque panel calls before spend when a capped run has no hard maximum', async () => {
    let calls = 0
    const costLedger = new CostLedger({ costCeilingUsd: 1 })
    const judge = ensembleJudge({
      name: 'panel',
      dimensions: DIMS,
      models: PANEL,
      scoreWith: async (model) => {
        calls++
        return { model, perDimension: { accuracy: 1, tone: 1 } }
      },
    })

    await expect(judge.score({ artifact: 'text', scenario, signal, costLedger })).rejects.toThrow(
      /all 2 judges failed/,
    )
    expect(calls).toBe(0)
    expect(costLedger.summary()).toMatchObject({ totalCalls: 0, totalCostUsd: 0 })
  })

  it('aggregates per-dimension means + composite across the panel', async () => {
    const judge = ensembleJudge({
      name: 'panel',
      dimensions: DIMS,
      models: PANEL,
      scoreWith: fakeScoreWith({
        'openai/gpt-4o': { accuracy: 0.8, tone: 0.6 },
        'anthropic/claude-sonnet-4': { accuracy: 0.6, tone: 0.4 },
      }),
    })
    const score = await judge.score({ artifact: 'text', scenario, signal })
    expect(score.dimensions.accuracy).toBeCloseTo(0.7, 5)
    expect(score.dimensions.tone).toBeCloseTo(0.5, 5)
    expect(score.composite).toBeCloseTo(0.6, 5)
    expect(score.failed).toBeUndefined()
    expect(score.failedJudges).toBeUndefined()
    expect(score.maxDisagreement).toBeCloseTo(0.2, 5)
    expect(Object.keys(score.perJudge ?? {})).toEqual(PANEL)
    expect(score.notes).toBe('openai/gpt-4o verdict')
  })

  it('applies weights as select-and-weight over named dimensions', async () => {
    const judge = ensembleJudge({
      name: 'panel',
      dimensions: DIMS,
      models: PANEL,
      scoreWith: fakeScoreWith({
        'openai/gpt-4o': { accuracy: 1, tone: 0 },
        'anthropic/claude-sonnet-4': { accuracy: 1, tone: 0 },
      }),
      weights: { accuracy: 1 },
    })
    const score = await judge.score({ artifact: 'text', scenario, signal })
    expect(score.composite).toBeCloseTo(1, 5)
  })

  it('records a failed model in failedJudges without folding a zero into the mean', async () => {
    const judge = ensembleJudge({
      name: 'panel',
      dimensions: DIMS,
      models: PANEL,
      scoreWith: fakeScoreWith({
        'openai/gpt-4o': { accuracy: 0.9, tone: 0.9 },
        'anthropic/claude-sonnet-4': new Error('judge call blew up'),
      }),
    })
    const score = await judge.score({ artifact: 'text', scenario, signal })
    expect(score.failedJudges).toEqual(['anthropic/claude-sonnet-4'])
    // Mean over the ONE survivor, not (0.9 + 0)/2.
    expect(score.dimensions.accuracy).toBeCloseTo(0.9, 5)
    expect(score.composite).toBeCloseTo(0.9, 5)
    expect(Object.keys(score.perJudge ?? {})).toEqual(['openai/gpt-4o'])
  })

  it('throws when every model fails — never a silent zero', async () => {
    const judge = ensembleJudge({
      name: 'panel',
      dimensions: DIMS,
      models: PANEL,
      scoreWith: fakeScoreWith({
        'openai/gpt-4o': new Error('boom'),
        'anthropic/claude-sonnet-4': new Error('boom'),
      }),
    })
    await expect(judge.score({ artifact: 'text', scenario, signal })).rejects.toThrow(
      /all 2 judges failed/,
    )
  })

  it('suffixes repeat samples of the same model so votes are not overwritten', async () => {
    let call = 0
    const judge = ensembleJudge({
      name: 'self-consistency',
      dimensions: DIMS,
      models: ['openai/gpt-4o', 'openai/gpt-4o', 'openai/gpt-4o'],
      crossFamily: false,
      scoreWith: async (model) => {
        call++
        return {
          model,
          perDimension: { accuracy: call * 0.1, tone: call * 0.1 } as Record<Dim, number>,
        }
      },
    })
    const score = await judge.score({ artifact: 'text', scenario, signal })
    expect(Object.keys(score.perJudge ?? {}).sort()).toEqual([
      'openai/gpt-4o',
      'openai/gpt-4o#2',
      'openai/gpt-4o#3',
    ])
    expect(score.dimensions.accuracy).toBeCloseTo(0.2, 5)
  })

  it('retries through withJudgeRetry and uses the recovered verdict', async () => {
    const attemptsByModel = new Map<string, number>()
    const judge = ensembleJudge({
      name: 'panel',
      dimensions: DIMS,
      models: PANEL,
      retry: { maxAttempts: 2, backoffMs: () => 0, isRetryable: () => true },
      receiptFromError: (_error, model) => ({
        model,
        inputTokens: 0,
        outputTokens: 0,
        actualCostUsd: 0,
      }),
      scoreWith: async (model) => {
        const n = (attemptsByModel.get(model) ?? 0) + 1
        attemptsByModel.set(model, n)
        if (model === 'anthropic/claude-sonnet-4' && n === 1) throw new Error('transient')
        return { model, perDimension: { accuracy: 0.5, tone: 0.5 } as Record<Dim, number> }
      },
    })
    const score = await judge.score({ artifact: 'text', scenario, signal })
    expect(attemptsByModel.get('anthropic/claude-sonnet-4')).toBe(2)
    expect(score.failedJudges).toBeUndefined()
    expect(score.composite).toBeCloseTo(0.5, 5)
  })

  it('records a model that exhausts its retries as failed', async () => {
    const judge = ensembleJudge({
      name: 'panel',
      dimensions: DIMS,
      models: PANEL,
      retry: { maxAttempts: 2, backoffMs: () => 0, isRetryable: () => true },
      scoreWith: fakeScoreWith({
        'openai/gpt-4o': { accuracy: 0.4, tone: 0.4 },
        'anthropic/claude-sonnet-4': new Error('permanently down'),
      }),
    })
    const score = await judge.score({ artifact: 'text', scenario, signal })
    expect(score.failedJudges).toEqual(['anthropic/claude-sonnet-4'])
    expect(score.composite).toBeCloseTo(0.4, 5)
  })
})
