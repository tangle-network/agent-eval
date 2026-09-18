import { describe, expect, it, vi } from 'vitest'
import { CostLedger } from '../src/cost-ledger'
import { asAnalyst, asJudge, createEvaluator } from '../src/evaluation'

const receipt = () => ({
  model: 'fixture-classifier',
  inputTokens: 7,
  outputTokens: 1,
  actualCostUsd: 0.01,
})

function fixture() {
  return createEvaluator({
    execute: async (_input: string) => ({ route: 'inspect' as const }),
    receipt,
  })
}

describe('evaluation cancellation after paid work', () => {
  it('settles and reports the receipt but returns no decision when the receipt observer cancels', async () => {
    const controller = new AbortController()
    const ledger = new CostLedger()
    const onReceipt = vi.fn(() => controller.abort())
    const run = fixture()
    await expect(run('evidence', {
      costLedger: ledger,
      signal: controller.signal,
      onReceipt,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(onReceipt).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      status: 'settled', inputTokens: 7, outputTokens: 1, actualCostUsd: 0.01,
    }))
  })

  it('does not return a decision when caller validation revokes execution authority', async () => {
    const controller = new AbortController()
    const onReceipt = vi.fn()
    const run = createEvaluator({
      execute: async (_input: string) => ({ route: 'inspect' as const }),
      receipt,
      validate: () => controller.abort(),
    })
    await expect(run('evidence', {
      signal: controller.signal,
      onReceipt,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(onReceipt).toHaveBeenCalledOnce()
  })

  it('retains an observation but never maps a cancelled judge into a successful score', async () => {
    const controller = new AbortController()
    const evaluate = fixture()
    const map = vi.fn(() => ({ dimensions: { quality: 1 }, composite: 1, notes: '' }))
    const record = vi.fn(async () => {
      await Promise.resolve()
      controller.abort()
    })
    const judge = asJudge({
      name: 'fixture',
      version: 'v1',
      dimensions: [{ key: 'quality', description: 'Fixture quality' }],
      evaluate: (_input, context) => evaluate('evidence', context),
      record,
      map,
    })
    await expect(judge.score({
      artifact: 'artifact',
      scenario: { id: 's', kind: 'test' },
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(record).toHaveBeenCalledOnce()
    expect(map).not.toHaveBeenCalled()
  })

  it('reports an analyst receipt but does not map a cancelled result to findings', async () => {
    const controller = new AbortController()
    const recordUsage = vi.fn(() => controller.abort())
    const evaluate = fixture()
    const map = vi.fn(async () => [])
    const analyst = asAnalyst({
      id: 'fixture', version: 'v1', description: 'Fixture analyst',
      inputKind: 'custom', cost: { kind: 'llm', models: ['fixture-classifier'] },
      evaluate: (_input, context) => evaluate('evidence', context),
      map,
    })
    await expect(analyst.analyze('evidence', {
      runId: 'r', correlationId: 'c', signal: controller.signal, recordUsage,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(recordUsage).toHaveBeenCalledOnce()
    expect(map).not.toHaveBeenCalled()
  })
})
