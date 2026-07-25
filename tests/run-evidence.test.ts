import { describe, expect, it } from 'vitest'
import type { ControlRunResult } from '../src/control-runtime'
import { controlRunToRunRecord, scoreFromEvals } from '../src/run-evidence'

function controlRun(
  overrides: Partial<ControlRunResult<unknown, unknown, unknown>> = {},
): ControlRunResult<unknown, unknown, unknown> {
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
      scenarioId: 'scenario-1',
      candidateId: 'candidate-a',
      seed: 7,
      model: 'gpt-4o-2024-11-20',
      promptHash: 'prompt-hash',
      configHash: 'config-hash',
      commitSha: 'abc123',
      splitTag: 'holdout',
      tokenUsage: { input: 100, output: 30 },
      costProvenance: { kind: 'observed', usd: 0.04 },
      raw: { deterministicChecks: 1 },
    })

    expect(record.runId).toBe('run-1')
    expect(record.terminalOutcome).toBe('succeeded')
    expect(record.outcome.holdoutScore).toBe(0.82)
    expect(record.outcome.raw).toMatchObject({
      pass: 1,
      completed: 1,
      steps: 0,
      runtimeErrors: 0,
      deterministicChecks: 1,
    })
  })

  it.each([
    [{ stoppedBy: 'abort', completed: false }, 'cancelled'],
    [{ stoppedBy: 'runtime-error', completed: false }, 'failed'],
    [{ stoppedBy: 'budget', completed: false }, 'incomplete'],
  ] as const)('maps control stop state %o to %s', (overrides, expected) => {
    const record = controlRunToRunRecord(controlRun(overrides), {
      experimentId: 'exp-1',
      scenarioId: 'scenario-1',
      candidateId: 'candidate-a',
      seed: 7,
      model: 'gpt-4o-2024-11-20',
      promptHash: 'prompt-hash',
      configHash: 'config-hash',
      commitSha: 'abc123',
      splitTag: 'holdout',
      tokenUsage: { input: 100, output: 30 },
      costProvenance: { kind: 'observed', usd: 0.04 },
    })

    expect(record.terminalOutcome).toBe(expected)
  })

  it('uses eval scores when the control run has no explicit score', () => {
    const record = controlRunToRunRecord(
      controlRun({
        score: undefined,
        finalEvals: [
          { id: 'build', passed: true, score: 1 },
          { id: 'ux', passed: true, score: 0.5 },
        ],
      }),
      {
        experimentId: 'exp-1',
        scenarioId: 'scenario-1',
        candidateId: 'candidate-a',
        seed: 8,
        model: 'gpt-4o-2024-11-20',
        promptHash: 'prompt-hash',
        configHash: 'config-hash',
        commitSha: 'abc123',
        splitTag: 'search',
        tokenUsage: { input: 100, output: 30 },
        costProvenance: { kind: 'observed', usd: 0.04 },
      },
    )

    expect(record.outcome.searchScore).toBe(0.75)
    expect(scoreFromEvals([])).toBeUndefined()
  })

  it.each([
    {
      label: 'successful run',
      run: () =>
        controlRun({
          score: undefined,
          finalEvals: [],
          pass: true,
          completed: true,
          reason: 'done',
          stoppedBy: 'policy',
        }),
      terminalOutcome: 'succeeded',
      terminalFailureReason: undefined,
      processPass: 1,
      executionErrors: 0,
    },
    {
      label: 'budget stop',
      run: () =>
        controlRun({
          score: undefined,
          finalEvals: [],
          pass: false,
          completed: false,
          reason: 'cost budget exhausted',
          failureClass: 'budget_exceeded',
          stoppedBy: 'budget',
        }),
      terminalOutcome: 'incomplete',
      terminalFailureReason: 'cost budget exhausted',
      processPass: 0,
      executionErrors: 0,
    },
    {
      label: 'abort',
      run: () =>
        controlRun({
          score: undefined,
          finalEvals: [],
          pass: false,
          completed: false,
          reason: 'operator aborted',
          failureClass: 'timeout',
          stoppedBy: 'abort',
        }),
      terminalOutcome: 'cancelled',
      terminalFailureReason: 'operator aborted',
      processPass: 0,
      executionErrors: 0,
    },
    {
      label: 'runtime failure',
      run: () =>
        controlRun({
          score: undefined,
          finalEvals: [],
          pass: false,
          completed: false,
          reason: 'transport disconnected',
          failureClass: 'unknown',
          runtimeErrors: [{ phase: 'act', stepIndex: 0, message: 'transport disconnected' }],
          stoppedBy: 'runtime-error',
        }),
      terminalOutcome: 'failed',
      terminalFailureReason: 'transport disconnected',
      processPass: 0,
      executionErrors: 1,
    },
  ])(
    'keeps an unscored $label out of task-quality and task-failure fields',
    ({ run, terminalOutcome, terminalFailureReason, processPass, executionErrors }) => {
      const record = controlRunToRunRecord(run(), {
        experimentId: 'exp-1',
        scenarioId: 'scenario-1',
        candidateId: 'candidate-a',
        seed: 8,
        model: 'gpt-4o-2024-11-20',
        promptHash: 'prompt-hash',
        configHash: 'config-hash',
        commitSha: 'abc123',
        splitTag: 'holdout',
        tokenUsage: { input: 100, output: 30 },
        costProvenance: { kind: 'observed', usd: 0.04 },
      })

      expect(record.outcome.holdoutScore).toBeUndefined()
      expect(record.outcome.searchScore).toBeUndefined()
      expect(record.outcome.raw).not.toHaveProperty('score')
      expect(record.failureClass).toBeUndefined()
      expect(record.failureMode).toBeUndefined()
      expect(record.terminalOutcome).toBe(terminalOutcome)
      expect(record.terminalFailureReason).toBe(terminalFailureReason)
      expect(record.outcome.raw.pass).toBe(processPass)
      expect(record.outcome.raw.execution_error_count).toBe(executionErrors)
    },
  )

  it.each([
    {
      label: 'NaN run score',
      run: () => controlRun({ score: Number.NaN, finalEvals: [] }),
      score: undefined,
    },
    {
      label: 'infinite caller score',
      run: () => controlRun({ score: undefined, finalEvals: [] }),
      score: Number.POSITIVE_INFINITY,
    },
    {
      label: 'non-finite eval scores',
      run: () =>
        controlRun({
          score: undefined,
          finalEvals: [
            { id: 'nan', passed: false, score: Number.NaN },
            { id: 'infinity', passed: false, score: Number.POSITIVE_INFINITY },
          ],
        }),
      score: undefined,
    },
  ])('omits $label instead of converting it to zero', ({ run, score }) => {
    const record = controlRunToRunRecord(run(), {
      experimentId: 'exp-1',
      scenarioId: 'scenario-1',
      candidateId: 'candidate-a',
      seed: 8,
      model: 'gpt-4o-2024-11-20',
      promptHash: 'prompt-hash',
      configHash: 'config-hash',
      commitSha: 'abc123',
      splitTag: 'search',
      tokenUsage: { input: 100, output: 30 },
      costProvenance: { kind: 'observed', usd: 0.04 },
      ...(score !== undefined ? { score } : {}),
    })

    expect(record.outcome.searchScore).toBeUndefined()
    expect(record.outcome.holdoutScore).toBeUndefined()
    expect(record.outcome.raw).not.toHaveProperty('score')
  })

  it('counts one thrown action as one canonical execution error', () => {
    const record = controlRunToRunRecord(
      controlRun({
        pass: false,
        completed: false,
        stoppedBy: 'runtime-error',
        steps: [
          {
            index: 0,
            decision: { type: 'continue', action: 'write' },
            beforeState: {},
            afterState: {},
            evalsBefore: [],
            evalsAfter: [],
            actionOutcome: {
              ok: false,
              error: 'worker failed',
              durationMs: 3,
            },
            startedAt: '2026-07-24T00:00:00.000Z',
            endedAt: '2026-07-24T00:00:00.003Z',
          },
        ],
        runtimeErrors: [{ phase: 'act', stepIndex: 0, message: 'worker failed' }],
      }),
      {
        experimentId: 'exp-1',
        scenarioId: 'scenario-1',
        candidateId: 'candidate-a',
        seed: 8,
        model: 'gpt-4o-2024-11-20',
        promptHash: 'prompt-hash',
        configHash: 'config-hash',
        commitSha: 'abc123',
        splitTag: 'holdout',
        tokenUsage: { input: 100, output: 30 },
        costProvenance: { kind: 'observed', usd: 0.04 },
      },
    )

    expect(record.outcome.raw.runtimeErrors).toBe(1)
    expect(record.outcome.raw.execution_error_count).toBe(1)
  })

  it('does not let raw metrics override canonical run evidence fields', () => {
    const record = controlRunToRunRecord(
      controlRun({
        pass: true,
        completed: true,
        score: 0.7,
        steps: [{ state: {}, action: 'x', result: 'y', evals: [] }],
        runtimeErrors: [],
      }),
      {
        experimentId: 'exp-1',
        scenarioId: 'scenario-1',
        candidateId: 'candidate-a',
        seed: 9,
        model: 'gpt-4o-2024-11-20',
        promptHash: 'prompt-hash',
        configHash: 'config-hash',
        commitSha: 'abc123',
        splitTag: 'holdout',
        tokenUsage: { input: 100, output: 30 },
        costProvenance: { kind: 'observed', usd: 0.04 },
        raw: {
          score: 0,
          pass: 0,
          completed: 0,
          steps: 99,
          runtimeErrors: 99,
          deterministicChecks: 1,
        },
      },
    )

    expect(record.outcome.raw).toMatchObject({
      score: 0.7,
      pass: 1,
      completed: 1,
      steps: 1,
      runtimeErrors: 0,
      deterministicChecks: 1,
    })
  })
})
