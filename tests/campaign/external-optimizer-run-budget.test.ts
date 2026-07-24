import { describe, expect, it } from 'vitest'
import {
  externalOptimizerRunKey,
  openExternalOptimizerRunBudget,
} from '../../src/campaign/external-optimizer-run-budget'
import { inMemoryCampaignStorage } from '../../src/campaign/storage'

describe('external optimizer run budget', () => {
  it('uses one content key for compatible attempts and unique keys for fresh attempts', () => {
    const material = { optimizer: 'gepa', objective: 'improve', cases: ['a', 'b'] }
    const compatibleA = externalOptimizerRunKey({
      material,
      attemptId: 'attempt-a',
      resumeEnabled: true,
    })
    const compatibleB = externalOptimizerRunKey({
      material,
      attemptId: 'attempt-b',
      resumeEnabled: true,
    })
    const freshA = externalOptimizerRunKey({
      material,
      attemptId: 'attempt-a',
      resumeEnabled: false,
    })
    const freshB = externalOptimizerRunKey({
      material,
      attemptId: 'attempt-b',
      resumeEnabled: false,
    })

    expect(compatibleA).toBe(compatibleB)
    expect(freshA).not.toBe(freshB)
    expect(freshA).toContain(compatibleA)
  })

  it('shares one append-only allowance across independently opened handles', () => {
    const storage = inMemoryCampaignStorage()
    const first = openExternalOptimizerRunBudget({
      storage,
      runDir: 'run',
      runKey: 'compatible',
      attemptId: 'attempt-a',
      maxEvaluations: 3,
    })
    const second = openExternalOptimizerRunBudget({
      storage,
      runDir: 'run',
      runKey: 'compatible',
      attemptId: 'attempt-b',
      maxEvaluations: 3,
    })

    expect(first.acceptEvaluation()).toBe(1)
    expect(second.acceptEvaluation()).toBe(2)
    expect(first.acceptEvaluation()).toBe(3)
    expect(second.acceptEvaluation()).toBeUndefined()
    expect(first.acceptedEvaluations()).toBe(3)
    expect(second.acceptedEvaluations()).toBe(3)
    expect(storage.read('run/budgets/compatible.jsonl')).toBe(
      '{"maxEvaluations":3,"accepted":1}\n' +
        '{"maxEvaluations":3,"accepted":2}\n' +
        '{"maxEvaluations":3,"accepted":3}\n',
    )
  })

  it('fails closed on altered or incompatible saved counters', () => {
    const storage = inMemoryCampaignStorage()
    storage.ensureDir('run/budgets')
    storage.write(
      'run/budgets/compatible.jsonl',
      '{"maxEvaluations":3,"accepted":1}\n{"maxEvaluations":3,"accepted":3}\n',
    )
    const budget = openExternalOptimizerRunBudget({
      storage,
      runDir: 'run',
      runKey: 'compatible',
      attemptId: 'attempt',
      maxEvaluations: 3,
    })

    expect(() => budget.acceptedEvaluations()).toThrow(
      'external optimizer evaluation state does not match',
    )
  })
})
