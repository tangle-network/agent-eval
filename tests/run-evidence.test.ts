import { describe, expect, it } from 'vitest'
import {
  controlRunToRunRecord,
  scoreFromEvals,
  type ControlRunResult,
} from '../src'

function controlRun(overrides: Partial<ControlRunResult<unknown, unknown, unknown>> = {}): ControlRunResult<unknown, unknown, unknown> {
  return {
    intent: 'build the workflow',
    pass: true,
    completed: true,
    reason: 'done',
    score: 0.82,
    steps: [],
    finalState: {},
    finalEvals: [],
    wallMs: 1200,
    spentCostUsd: 0.04,
    runId: 'run-1',
    runtimeErrors: [],
    stoppedBy: 'policy',
    ...overrides,
  }
}

describe('run evidence bridges', () => {
  it('converts a control run into a validated RunRecord', () => {
    const record = controlRunToRunRecord(controlRun(), {
      experimentId: 'exp-1',
      candidateId: 'candidate-a',
      seed: 7,
      model: 'gpt-4o-2024-11-20',
      promptHash: 'prompt-hash',
      configHash: 'config-hash',
      commitSha: 'abc123',
      splitTag: 'holdout',
      tokenUsage: { input: 100, output: 30 },
      raw: { deterministicChecks: 1 },
    })

    expect(record.runId).toBe('run-1')
    expect(record.outcome.holdoutScore).toBe(0.82)
    expect(record.outcome.raw).toMatchObject({
      pass: 1,
      completed: 1,
      steps: 0,
      runtimeErrors: 0,
      deterministicChecks: 1,
    })
  })

  it('uses eval scores when the control run has no explicit score', () => {
    const record = controlRunToRunRecord(controlRun({
      score: undefined,
      finalEvals: [
        { id: 'build', passed: true, score: 1 },
        { id: 'ux', passed: true, score: 0.5 },
      ],
    }), {
      experimentId: 'exp-1',
      candidateId: 'candidate-a',
      seed: 8,
      model: 'gpt-4o-2024-11-20',
      promptHash: 'prompt-hash',
      configHash: 'config-hash',
      commitSha: 'abc123',
      splitTag: 'search',
      tokenUsage: { input: 100, output: 30 },
    })

    expect(record.outcome.searchScore).toBe(0.75)
    expect(scoreFromEvals([])).toBeUndefined()
  })
})
