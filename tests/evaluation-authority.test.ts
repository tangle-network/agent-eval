import { describe, expect, it, vi } from 'vitest'
import { AnalystRegistry } from '../src/analyst/registry'
import type { AnalystContext } from '../src/analyst/types'
import { CostLedger } from '../src/cost-ledger'
import { asAnalyst, asJudge, createEvaluator, type EvaluationContext } from '../src/evaluation'
import { jevAnalyst, jevEvaluator } from '../src/jev'

const maximumCharge = { externallyEnforcedMaximumUsd: 0.1 }
const receipt = () => ({ model: 'fixture', inputTokens: 10, outputTokens: 2, actualCostUsd: 0.1 })
const context = (overrides: Partial<AnalystContext> = {}): AnalystContext => ({
  runId: 'run-1',
  correlationId: 'review-1',
  ...overrides,
})
function fixture(costLedger?: CostLedger) {
  const execute = vi.fn(async (input: string) => input)
  const evaluate = createEvaluator({ execute, receipt, maximumCharge, costLedger })
  const map = vi.fn(() => [])
  const analyst = asAnalyst({
    id: 'review',
    version: 'v1',
    description: 'Caller-owned classifier',
    inputKind: 'custom',
    cost: { kind: 'llm', models: ['fixture'] },
    evaluate,
    map,
  })
  return { evaluate, execute, analyst, map }
}

describe('evaluation spending authority', () => {
  it('does not replace an evaluator spending cap with an unlimited analyst ledger', async () => {
    const ledger = new CostLedger({ costCeilingUsd: 0 })
    const { analyst, execute, map } = fixture(ledger)
    await expect(analyst.analyze('evidence', context())).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
    expect(map).not.toHaveBeenCalled()
    expect(ledger.summary().totalCalls).toBe(0)
  })

  it('conserves the configured account across repeated analyst calls', async () => {
    const ledger = new CostLedger({ costCeilingUsd: 0.15 })
    const { analyst, execute } = fixture(ledger)
    await expect(analyst.analyze('first', context())).resolves.toEqual([])
    await expect(analyst.analyze('second', context())).rejects.toThrow()
    expect(execute).toHaveBeenCalledOnce()
    expect(ledger.summary()).toMatchObject({ totalCalls: 1, totalCostUsd: 0.1 })
  })

  it('shares authority between direct evaluation, an analyst, and a judge', async () => {
    const ledger = new CostLedger({ costCeilingUsd: 0.25 })
    const { evaluate, analyst, execute } = fixture(ledger)
    const judge = asJudge<string, { id: string; kind: string }, string>({
      name: 'judge',
      version: 'v1',
      dimensions: [{ key: 'quality', description: 'Quality' }],
      evaluate: ({ artifact }, ctx) => evaluate(artifact, ctx),
      map: () => ({ dimensions: { quality: 1 }, composite: 1, notes: '' }),
    })
    await evaluate('direct')
    await analyst.analyze('analyst', context())
    await expect(
      judge.score({
        artifact: 'judge',
        scenario: { id: 'case-1', kind: 'test' },
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow()
    expect(execute).toHaveBeenCalledTimes(2)
    expect(ledger.summary()).toMatchObject({ totalCalls: 2, totalCostUsd: 0.2 })
  })

  it('uses the explicitly supplied run account instead of the evaluator default', async () => {
    const configured = new CostLedger({ costCeilingUsd: 0 })
    const runAccount = new CostLedger({ costCeilingUsd: 0.15 })
    const { analyst, execute } = fixture(configured)
    await analyst.analyze('first', context({ costLedger: runAccount }))
    await expect(analyst.analyze('second', context({ costLedger: runAccount }))).rejects.toThrow()
    expect(configured.summary().totalCalls).toBe(0)
    expect(runAccount.summary()).toMatchObject({ totalCalls: 1, totalCostUsd: 0.1 })
    expect(execute).toHaveBeenCalledOnce()
  })

  it('honors an explicit per-analysis cap when there is no supplied run account', async () => {
    const { analyst, execute } = fixture(new CostLedger())
    await expect(analyst.analyze('evidence', context({ budgetUsd: 0 }))).rejects.toThrow()
    expect(execute).not.toHaveBeenCalled()
  })

  it('keeps an explicit per-analysis budget local to that invocation', async () => {
    const configured = new CostLedger({ costCeilingUsd: 0 })
    const { analyst } = fixture(configured)
    const recordUsage = vi.fn()
    await analyst.analyze('first', context({ budgetUsd: 0.1, recordUsage }))
    await analyst.analyze('second', context({ budgetUsd: 0.1, recordUsage }))
    expect(configured.summary().totalCalls).toBe(0)
    expect(recordUsage).toHaveBeenCalledTimes(2)
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        calls: 1,
        cost: { kind: 'observed', usd: 0.1 },
        tokens: { input: 10, output: 2 },
      }),
    )
  })

  it('allows unconfigured evaluators without manufacturing new authority per invocation', async () => {
    const { analyst, execute } = fixture()
    await analyst.analyze('first', context())
    await analyst.analyze('second', context())
    expect(execute).toHaveBeenCalledTimes(2)
  })
})

describe('caller-owned physical evaluation identity', () => {
  it('forwards the existing callId into both the ledger and transport', async () => {
    let received = ''
    const ledger = new CostLedger()
    const evaluate = createEvaluator({
      execute: async (_input: string, ctx) => {
        received = ctx.idempotencyKey
        return 'result'
      },
      receipt,
      costLedger: ledger,
    })
    const options: EvaluationContext = { callId: 'run-1/action-2/review-3' }
    const result = await evaluate('request', options)
    expect(received).toBe('run-1/action-2/review-3')
    expect(result.receipt.callId).toBe(received)
    expect(ledger.summary().totalCalls).toBe(1)
  })

  it('uses the ledger conflict policy instead of silently purchasing the same call again', async () => {
    const { evaluate, execute } = fixture(new CostLedger())
    const options: EvaluationContext = { callId: 'physical-attempt-1' }
    await evaluate('evidence', options)
    await expect(evaluate('evidence', options)).rejects.toThrow(/already exists/)
    expect(execute).toHaveBeenCalledOnce()
  })

  it('rejects duplicates during execution before another physical attempt starts', async () => {
    let started!: () => void
    let finish!: () => void
    const entered = new Promise<void>((resolve) => {
      started = resolve
    })
    const pending = new Promise<void>((resolve) => {
      finish = resolve
    })
    const execute = vi.fn(async () => {
      started()
      await pending
      return 'result'
    })
    const evaluate = createEvaluator({ execute, receipt, costLedger: new CostLedger() })
    const options: EvaluationContext = { callId: 'physical-attempt-1' }
    const first = evaluate(null, options)
    await entered
    const second = evaluate(null, options)
    // Attach the observer before releasing the first call to avoid an unhandled rejection.
    const rejected = expect(second).rejects.toThrow(/unresolved/)
    finish()
    await first
    await rejected
    expect(execute).toHaveBeenCalledOnce()
  })

  it('still assigns different identities when the caller does not supply one', async () => {
    const { evaluate } = fixture()
    const first = await evaluate('first')
    const second = await evaluate('second')
    expect(first.receipt.callId).not.toBe(second.receipt.callId)
  })
})

describe('native and generic analyst authority use the same path', () => {
  const request = {
    model: 'jev-fixture',
    state: 'fixture',
    questions: { ready: { type: 'noul' as const } },
  }
  const value = {
    model: 'jev-fixture',
    usage: { input_tokens: 10, output_tokens: 2 },
    answers: { ready: { type: 'noul' as const, noul: 0.8 } },
  }

  it('keeps the same configured cap for native analysts after removing the provider-specific override', async () => {
    const ledger = new CostLedger({ costCeilingUsd: 0.15 })
    const execute = vi.fn(async () => value)
    const analyst = jevAnalyst<string>({
      id: 'native',
      version: 'v1',
      description: 'Native review',
      inputKind: 'custom',
      model: request.model,
      questions: request.questions,
      renderState: (input) => input,
      evaluate: execute,
      receipt,
      maximumCharge,
      costLedger: ledger,
      findings: () => [],
    })
    const recordUsage = vi.fn()
    await analyst.analyze('first', context({ recordUsage }))
    await expect(analyst.analyze('second', context({ recordUsage }))).rejects.toThrow()
    expect(execute).toHaveBeenCalledOnce()
    expect(recordUsage).toHaveBeenCalledOnce()
    expect(ledger.summary()).toMatchObject({ totalCalls: 1, totalCostUsd: 0.1 })
  })

  it('forwards explicit native call identity without changing question JSON or answer types', async () => {
    const transport = vi.fn(
      async (_input: unknown, ctx: { signal: AbortSignal; idempotencyKey: string }) => {
        expect(ctx.idempotencyKey).toBe('native-attempt-1')
        return value
      },
    )
    const evaluate = jevEvaluator({ evaluate: transport, receipt })
    const result = await evaluate(request, { callId: 'native-attempt-1' })
    expect(transport.mock.calls[0]?.[0]).toEqual(request)
    expect(result.value.answers.ready.noul).toBe(0.8)
    expect(result.receipt.callId).toBe('native-attempt-1')
  })

  it('reports a denied configured account as a failed analyst through the real registry', async () => {
    const ledger = new CostLedger({ costCeilingUsd: 0 })
    const { analyst, execute } = fixture(ledger)
    const registry = new AnalystRegistry()
    registry.register(analyst)
    const result = await registry.run('run-1', { custom: { review: 'evidence' } })
    expect(result.per_analyst[0]?.status).toBe('failed')
    expect(result.findings).toEqual([])
    expect(execute).not.toHaveBeenCalled()
    expect(ledger.summary().totalCalls).toBe(0)
  })
})
