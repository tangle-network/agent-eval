import { createEvaluator } from '@arizeai/phoenix-evals'
import { ExactMatch } from 'autoevals'
import { describe, expect, it } from 'vitest'
import { CostLedger } from '../cost-ledger'
import type { Scenario } from './types'
import { autoevalsScorerJudge, phoenixEvaluatorJudge } from './upstream-evaluators'

interface ExpectedScenario extends Scenario {
  expected: string
}

const scenario: ExpectedScenario = { id: 'case-1', kind: 'text', expected: 'answer' }
const signal = new AbortController().signal

function exactPaidCall<TResult>(model = 'gpt-4o-mini') {
  return {
    model,
    receipt: (_result: TResult) => ({
      model,
      inputTokens: 12,
      outputTokens: 3,
      actualCostUsd: 0.001,
    }),
  }
}

describe('phoenixEvaluatorJudge', () => {
  it('runs the installed Phoenix evaluator contract', async () => {
    const evaluator = createEvaluator<{ output: string; expected: string }>(
      ({ output, expected }) => ({
        score: output === expected ? 1 : 0,
        label: output === expected ? 'match' : 'mismatch',
      }),
      { name: 'exact-match', kind: 'CODE', telemetry: { isEnabled: false } },
    )
    const judge = phoenixEvaluatorJudge(evaluator, {
      mapInput: ({
        artifact,
        scenario: inputScenario,
      }: {
        artifact: string
        scenario: ExpectedScenario
      }) => ({ output: artifact, expected: inputScenario.expected }),
    })

    await expect(judge.score({ artifact: 'answer', scenario, signal })).resolves.toMatchObject({
      dimensions: { 'exact-match': 1 },
      composite: 1,
      notes: 'match',
    })
  })

  it('runs an upstream Phoenix evaluator and preserves its native dimension', async () => {
    const costLedger = new CostLedger()
    const judge = phoenixEvaluatorJudge(
      {
        name: 'correctness',
        kind: 'LLM',
        optimizationDirection: 'MAXIMIZE',
        async evaluate(record) {
          return {
            score: record.output === record.expected ? 1 : 0,
            label: 'correct',
            explanation: 'The values match.',
          }
        },
      },
      {
        mapInput: ({
          artifact,
          scenario: inputScenario,
        }: {
          artifact: string
          scenario: ExpectedScenario
        }) => ({
          output: artifact,
          expected: inputScenario.expected,
        }),
        paidCall: exactPaidCall(),
      },
    )
    const result = await judge.score({
      artifact: 'answer',
      scenario,
      signal,
      costLedger,
    })
    expect(result).toEqual({
      dimensions: { correctness: 1 },
      composite: 1,
      notes: 'correct: The values match.',
    })
    expect(costLedger.list()).toHaveLength(1)
    expect(costLedger.summary()).toMatchObject({
      totalCalls: 1,
      inputTokens: 12,
      outputTokens: 3,
      totalCostUsd: 0.001,
      accountingComplete: true,
    })
  })

  it('does not invoke or charge an LLM evaluator when the request is already aborted', async () => {
    const controller = new AbortController()
    const cancellation = new Error('cancel before Phoenix evaluation')
    controller.abort(cancellation)
    const costLedger = new CostLedger()
    let evaluatorCalls = 0
    const judge = phoenixEvaluatorJudge(
      {
        name: 'cancelled-correctness',
        kind: 'LLM',
        async evaluate() {
          evaluatorCalls += 1
          return { score: 1 }
        },
      },
      {
        mapInput: () => ({}),
        paidCall: exactPaidCall(),
      },
    )

    await expect(
      judge.score({
        artifact: 'answer',
        scenario,
        signal: controller.signal,
        costLedger,
      }),
    ).rejects.toBe(cancellation)
    expect({
      signalAborted: controller.signal.aborted,
      evaluatorCalls,
      ledgerCalls: costLedger.list().length,
    }).toEqual({
      signalAborted: true,
      evaluatorCalls: 0,
      ledgerCalls: 0,
    })
  })

  it('does not invoke an LLM evaluator without the campaign cost ledger', async () => {
    let evaluatorCalls = 0
    const judge = phoenixEvaluatorJudge(
      {
        name: 'unmetered-correctness',
        kind: 'LLM',
        async evaluate() {
          evaluatorCalls += 1
          return { score: 1 }
        },
      },
      {
        mapInput: () => ({}),
        paidCall: exactPaidCall(),
      },
    )

    await expect(judge.score({ artifact: 'answer', scenario, signal })).rejects.toThrow(
      /requires the campaign cost ledger/,
    )
    expect(evaluatorCalls).toBe(0)
  })

  it('rejects a score backed by incomplete cost or token usage', async () => {
    const costLedger = new CostLedger()
    const judge = phoenixEvaluatorJudge(
      {
        name: 'unknown-cost-correctness',
        kind: 'LLM',
        async evaluate() {
          return { score: 1 }
        },
      },
      {
        mapInput: () => ({}),
        paidCall: {
          model: 'unpriced-model',
          receipt: () => ({
            model: 'unpriced-model',
            inputTokens: 0,
            outputTokens: 0,
            costUnknown: true,
            usageUnknown: true,
          }),
        },
      },
    )

    await expect(judge.score({ artifact: 'answer', scenario, signal, costLedger })).rejects.toThrow(
      /without complete cost and token usage/,
    )
    expect(costLedger.list()).toHaveLength(1)
    expect(costLedger.summary()).toMatchObject({
      totalCalls: 1,
      accountingComplete: false,
      usageComplete: false,
    })
  })

  it('rejects a mid-call cancellation and settles the late Phoenix receipt', async () => {
    const controller = new AbortController()
    const cancellation = new Error('cancel Phoenix evaluation in flight')
    const costLedger = new CostLedger()
    let resolveEvaluation!: (result: { score: number }) => void
    let observedSignal: AbortSignal | undefined
    let observedCallId: string | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const judge = phoenixEvaluatorJudge(
      {
        name: 'slow-correctness',
        kind: 'LLM',
        evaluate(_record, context) {
          observedSignal = context?.signal
          observedCallId = context?.callId
          markStarted()
          return new Promise((resolveResult) => {
            resolveEvaluation = resolveResult
          })
        },
      },
      {
        mapInput: () => ({}),
        paidCall: exactPaidCall(),
      },
    )
    const scoring = judge.score({
      artifact: 'answer',
      scenario,
      signal: controller.signal,
      costLedger,
    })

    await started
    controller.abort(cancellation)
    resolveEvaluation({ score: 1 })
    await expect(scoring).rejects.toBe(cancellation)
    expect(observedSignal).toBe(controller.signal)
    expect(observedSignal?.aborted).toBe(true)
    expect(observedCallId).toEqual(expect.any(String))
    await expect(costLedger.waitForIdle({ timeoutMs: 1_000 })).resolves.toBe(true)
    expect(costLedger.list()).toHaveLength(1)
    expect(costLedger.summary()).toMatchObject({
      totalCalls: 1,
      inputTokens: 12,
      outputTokens: 3,
      totalCostUsd: 0.001,
      accountingComplete: true,
    })
  })

  it.each(['MINIMIZE', 'NEUTRAL'] as const)(
    'requires an explicit conversion for %s metrics',
    (optimizationDirection) => {
      expect(() =>
        phoenixEvaluatorJudge(
          {
            name: 'distance',
            kind: 'CODE',
            optimizationDirection,
            async evaluate() {
              return { score: 2 }
            },
          },
          { mapInput: () => ({}) },
        ),
      ).toThrow(new RegExp(`requires toComposite for a ${optimizationDirection} evaluator`))
    },
  )

  it('rejects a non-finite Phoenix conversion result', async () => {
    const judge = phoenixEvaluatorJudge(
      {
        name: 'distance',
        kind: 'CODE',
        optimizationDirection: 'MINIMIZE',
        async evaluate() {
          return { score: 2 }
        },
      },
      {
        mapInput: () => ({}),
        toComposite: () => Number.NaN,
      },
    )

    await expect(judge.score({ artifact: null, scenario, signal })).rejects.toThrow(
      /toComposite returned a non-finite score/,
    )
  })

  it('uses a finite conversion only for the composite score', async () => {
    const judge = phoenixEvaluatorJudge(
      {
        name: 'distance',
        kind: 'CODE',
        optimizationDirection: 'NEUTRAL',
        async evaluate() {
          return { score: 2 }
        },
      },
      {
        mapInput: () => ({}),
        toComposite: (score) => 1 / (1 + score),
      },
    )

    await expect(judge.score({ artifact: null, scenario, signal })).resolves.toMatchObject({
      dimensions: { distance: 2 },
      composite: 1 / 3,
    })
  })
})

describe('autoevalsScorerJudge', () => {
  it('runs the installed Autoevals scorer contract', async () => {
    const judge = autoevalsScorerJudge(ExactMatch, {
      name: 'exact-match',
      kind: 'CODE',
      mapInput: ({
        artifact,
        scenario: inputScenario,
      }: {
        artifact: string
        scenario: ExpectedScenario
      }) => ({ output: artifact, expected: inputScenario.expected }),
    })

    await expect(judge.score({ artifact: 'answer', scenario, signal })).resolves.toMatchObject({
      dimensions: { 'exact-match': 1 },
      composite: 1,
      notes: 'ExactMatch',
    })
  })

  it('runs an upstream Autoevals scorer without copying its implementation', async () => {
    const judge = autoevalsScorerJudge(
      async ({ output, expected }) => ({
        name: 'ExactMatch',
        score: output === expected ? 1 : 0,
        metadata: { implementation: 'autoevals' },
      }),
      {
        name: 'exact-match',
        kind: 'CODE',
        mapInput: ({
          artifact,
          scenario: inputScenario,
        }: {
          artifact: string
          scenario: ExpectedScenario
        }) => ({
          output: artifact,
          expected: inputScenario.expected,
        }),
      },
    )
    const result = await judge.score({
      artifact: 'answer',
      scenario,
      signal,
    })
    expect(result.dimensions).toEqual({ 'exact-match': 1 })
    expect(result.composite).toBe(1)
    expect(result.notes).toBe('{"implementation":"autoevals"}')
  })

  it('fails on missing scores instead of treating missing capture as success', async () => {
    const judge = autoevalsScorerJudge(async () => ({ name: 'missing', score: null }), {
      name: 'missing',
      kind: 'CODE',
      mapInput: () => ({}),
    })
    await expect(judge.score({ artifact: null, scenario, signal })).rejects.toThrow(
      /returned no finite score/,
    )
  })

  it('does not invoke or charge an LLM scorer when the request is already aborted', async () => {
    const controller = new AbortController()
    const cancellation = new Error('cancel before Autoevals scoring')
    controller.abort(cancellation)
    const costLedger = new CostLedger()
    let scorerCalls = 0
    const judge = autoevalsScorerJudge(
      async () => {
        scorerCalls += 1
        return { name: 'PaidScorer', score: 1 }
      },
      {
        name: 'paid-scorer',
        kind: 'LLM',
        mapInput: () => ({}),
        paidCall: exactPaidCall(),
      },
    )

    await expect(
      judge.score({
        artifact: 'answer',
        scenario,
        signal: controller.signal,
        costLedger,
      }),
    ).rejects.toBe(cancellation)
    expect({
      signalAborted: controller.signal.aborted,
      evaluatorCalls: scorerCalls,
      ledgerCalls: costLedger.list().length,
    }).toEqual({
      signalAborted: true,
      evaluatorCalls: 0,
      ledgerCalls: 0,
    })
  })

  it('rejects a mid-call cancellation and settles the late Autoevals receipt', async () => {
    const controller = new AbortController()
    const cancellation = new Error('cancel Autoevals scoring in flight')
    const costLedger = new CostLedger()
    let resolveScore!: (result: { name: string; score: number }) => void
    let observedSignal: AbortSignal | undefined
    let observedCallId: string | undefined
    let markStarted!: () => void
    const started = new Promise<void>((resolve) => {
      markStarted = resolve
    })
    const judge = autoevalsScorerJudge(
      (_input, context) => {
        observedSignal = context.signal
        observedCallId = context.callId
        markStarted()
        return new Promise((resolve) => {
          resolveScore = resolve
        })
      },
      {
        name: 'slow-paid-scorer',
        kind: 'LLM',
        mapInput: () => ({}),
        paidCall: exactPaidCall(),
      },
    )
    const scoring = judge.score({
      artifact: 'answer',
      scenario,
      signal: controller.signal,
      costLedger,
    })

    await started
    controller.abort(cancellation)
    resolveScore({ name: 'PaidScorer', score: 1 })
    await expect(scoring).rejects.toBe(cancellation)
    expect(observedSignal).toBe(controller.signal)
    expect(observedSignal?.aborted).toBe(true)
    expect(observedCallId).toEqual(expect.any(String))
    await expect(costLedger.waitForIdle({ timeoutMs: 1_000 })).resolves.toBe(true)
    expect(costLedger.list()).toHaveLength(1)
    expect(costLedger.summary()).toMatchObject({
      totalCalls: 1,
      inputTokens: 12,
      outputTokens: 3,
      totalCostUsd: 0.001,
      accountingComplete: true,
    })
  })
})
