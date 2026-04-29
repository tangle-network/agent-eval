import { describe, expect, it } from 'vitest'
import {
  InMemoryTraceStore,
  objectiveEval,
  runAgentControlLoop,
  type ControlDecision,
  type ControlEvalResult,
} from './index'

interface TestState {
  count: number
  artifact?: string
}

type TestAction =
  | { type: 'increment' }
  | { type: 'write_artifact'; value: string }

describe('runAgentControlLoop', () => {
  it('runs worker actions until objective validators pass', async () => {
    const state: TestState = { count: 0 }

    const result = await runAgentControlLoop<TestState, TestAction, TestState>({
      intent: 'raise count to 2',
      budget: { maxSteps: 4 },
      observe: () => ({ ...state }),
      validate: ({ state }) => [
        objectiveEval({
          id: 'count>=2',
          passed: state.count >= 2,
          score: Math.min(1, state.count / 2),
          severity: 'critical',
          detail: `count=${state.count}`,
        }),
      ],
      decide: ({ state }): ControlDecision<TestAction> => ({
        type: 'continue',
        action: { type: 'increment' },
        reason: `count ${state.count} is too low`,
      }),
      act: (action) => {
        if (action.type === 'increment') state.count += 1
        return { ...state }
      },
    })

    expect(result.pass).toBe(true)
    expect(result.completed).toBe(true)
    expect(result.stoppedBy).toBe('stop-policy')
    expect(result.finalState).toEqual({ count: 2 })
    expect(result.steps).toHaveLength(2)
    expect(result.finalEvals[0].score).toBe(1)
  })

  it('lets the policy stop when progress is impossible', async () => {
    const result = await runAgentControlLoop<TestState, TestAction, TestState>({
      intent: 'produce artifact',
      budget: { maxSteps: 3 },
      observe: () => ({ count: 0 }),
      validate: ({ state }) => [
        objectiveEval({
          id: 'artifact-present',
          passed: Boolean(state.artifact),
          severity: 'critical',
        }),
      ],
      decide: ({ history }) => history.length > 0
        ? { type: 'stop', pass: false, reason: 'worker did not change state' }
        : { type: 'continue', action: { type: 'write_artifact', value: 'x' } },
      act: () => ({ count: 0 }),
    })

    expect(result.pass).toBe(false)
    expect(result.completed).toBe(true)
    expect(result.stoppedBy).toBe('policy')
    expect(result.reason).toBe('worker did not change state')
    expect(result.steps).toHaveLength(1)
  })

  it('checks stop policy after the final allowed step before reporting budget exhaustion', async () => {
    const state: TestState = { count: 0 }

    const result = await runAgentControlLoop<TestState, TestAction, TestState>({
      intent: 'pass exactly on final step',
      budget: { maxSteps: 2 },
      observe: () => ({ ...state }),
      validate: ({ state }) => [
        objectiveEval({
          id: 'count>=2',
          passed: state.count >= 2,
          severity: 'critical',
        }),
      ],
      decide: () => ({ type: 'continue', action: { type: 'increment' } }),
      act: () => {
        state.count += 1
        return { ...state }
      },
    })

    expect(result.pass).toBe(true)
    expect(result.completed).toBe(true)
    expect(result.stoppedBy).toBe('stop-policy')
    expect(result.steps).toHaveLength(2)
    expect(result.reason).toBe('all critical evals passed')
  })

  it('records action failures so a policy can recover on the next step', async () => {
    const state: TestState = { count: 0 }

    const result = await runAgentControlLoop<TestState, TestAction, TestState, ControlEvalResult>({
      intent: 'recover after failed action',
      budget: { maxSteps: 3 },
      observe: () => ({ ...state }),
      validate: ({ state }) => [
        objectiveEval({
          id: 'artifact-present',
          passed: state.artifact === 'done',
          severity: 'critical',
        }),
      ],
      decide: ({ history }) => ({
        type: 'continue',
        action: history.length === 0
          ? { type: 'write_artifact', value: 'throw' }
          : { type: 'write_artifact', value: 'done' },
      }),
      act: (action) => {
        if (action.type === 'write_artifact' && action.value === 'throw') throw new Error('synthetic failure')
        if (action.type === 'write_artifact') state.artifact = action.value
        return { ...state }
      },
    })

    expect(result.pass).toBe(true)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].actionOutcome?.ok).toBe(false)
    expect(result.steps[0].actionOutcome?.error).toContain('synthetic failure')
    expect(result.steps[1].actionOutcome?.ok).toBe(true)
  })

  it('can fail fast on action errors when configured', async () => {
    const result = await runAgentControlLoop<TestState, TestAction, TestState>({
      intent: 'stop on action failure',
      actionFailure: 'stop',
      observe: () => ({ count: 0 }),
      validate: () => [
        objectiveEval({
          id: 'artifact-present',
          passed: false,
          severity: 'critical',
        }),
      ],
      decide: () => ({ type: 'continue', action: { type: 'write_artifact', value: 'throw' } }),
      act: () => {
        throw new Error('worker failed')
      },
    })

    expect(result.pass).toBe(false)
    expect(result.completed).toBe(false)
    expect(result.stoppedBy).toBe('runtime-error')
    expect(result.reason).toBe('worker failed')
    expect(result.steps).toHaveLength(1)
    expect(result.steps[0].actionOutcome?.ok).toBe(false)
    expect(result.runtimeErrors).toEqual([
      { phase: 'act', stepIndex: 0, message: 'worker failed' },
    ])
  })

  it('enforces cost budgets with a caller-provided cost extractor', async () => {
    const state: TestState = { count: 0 }

    const result = await runAgentControlLoop<TestState, TestAction, TestState>({
      intent: 'spend under control',
      budget: { maxSteps: 4, maxCostUsd: 0.03 },
      observe: () => ({ ...state }),
      validate: () => [
        objectiveEval({
          id: 'never-pass',
          passed: false,
          score: 0,
          severity: 'critical',
        }),
      ],
      decide: () => ({ type: 'continue', action: { type: 'increment' } }),
      act: () => {
        state.count += 1
        return { ...state }
      },
      getActionCostUsd: () => 0.02,
    })

    expect(result.stoppedBy).toBe('budget')
    expect(result.failureClass).toBe('budget_exceeded')
    expect(result.spentCostUsd).toBe(0.04)
    expect(result.steps).toHaveLength(2)
    expect(result.steps[0].actionOutcome?.costUsd).toBe(0.02)
  })

  it('stops repeated same-action loops before burning the whole step budget', async () => {
    const result = await runAgentControlLoop<TestState, TestAction, TestState>({
      intent: 'avoid repeated action loop',
      budget: { maxSteps: 8 },
      stopPolicies: { maxRepeatedActions: 3 },
      observe: () => ({ count: 0 }),
      validate: () => [
        objectiveEval({
          id: 'artifact-present',
          passed: false,
          severity: 'critical',
        }),
      ],
      decide: () => ({ type: 'continue', action: { type: 'increment' } }),
      act: () => ({ count: 0 }),
    })

    expect(result.stoppedBy).toBe('stop-policy')
    expect(result.failureClass).toBe('tool_recovery_failure')
    expect(result.reason).toContain('repeated same action')
    expect(result.steps).toHaveLength(2)
  })

  it('returns structured results instead of throwing on observation failures', async () => {
    const result = await runAgentControlLoop<TestState, TestAction, TestState>({
      intent: 'observe safely',
      observe: () => {
        throw new Error('state backend unavailable')
      },
      validate: () => [],
      decide: () => ({ type: 'continue', action: { type: 'increment' } }),
      act: () => ({ count: 1 }),
    })

    expect(result.pass).toBe(false)
    expect(result.stoppedBy).toBe('runtime-error')
    expect(result.runtimeErrors).toEqual([
      { phase: 'observe', stepIndex: 0, message: 'state backend unavailable' },
    ])
    expect(result.finalState).toBeUndefined()
  })

  it('returns structured results instead of throwing on validation failures', async () => {
    const result = await runAgentControlLoop<TestState, TestAction, TestState>({
      intent: 'validate safely',
      observe: () => ({ count: 0 }),
      validate: () => {
        throw new Error('validator unavailable')
      },
      decide: () => ({ type: 'continue', action: { type: 'increment' } }),
      act: () => ({ count: 1 }),
    })

    expect(result.pass).toBe(false)
    expect(result.stoppedBy).toBe('runtime-error')
    expect(result.runtimeErrors).toEqual([
      { phase: 'validate', stepIndex: 0, message: 'validator unavailable' },
    ])
    expect(result.finalState).toEqual({ count: 0 })
  })

  it('stops when state and score do not improve across steps', async () => {
    const result = await runAgentControlLoop<TestState, TestAction, TestState>({
      intent: 'detect no progress',
      budget: { maxSteps: 8 },
      stopPolicies: { maxNoProgressSteps: 2 },
      observe: () => ({ count: 0 }),
      validate: () => [
        objectiveEval({
          id: 'count>=1',
          passed: false,
          score: 0.25,
          severity: 'critical',
        }),
      ],
      decide: ({ history }) => ({
        type: 'continue',
        action: { type: 'write_artifact', value: `attempt-${history.length}` },
      }),
      act: () => ({ count: 0 }),
    })

    expect(result.stoppedBy).toBe('stop-policy')
    expect(result.failureClass).toBe('tool_recovery_failure')
    expect(result.reason).toContain('no state/score progress')
    expect(result.steps).toHaveLength(2)
  })

  it('emits trace runs, spans, and budget entries', async () => {
    const state: TestState = { count: 0 }
    const store = new InMemoryTraceStore()

    const result = await runAgentControlLoop<TestState, TestAction, TestState>({
      intent: 'trace me',
      store,
      scenarioId: 'control-runtime-test',
      budget: { maxSteps: 2, maxCostUsd: 1 },
      observe: () => ({ ...state }),
      validate: ({ state }) => [
        objectiveEval({
          id: 'count>=1',
          passed: state.count >= 1,
          score: state.count,
          severity: 'critical',
        }),
      ],
      decide: () => ({ type: 'continue', action: { type: 'increment' } }),
      act: () => {
        state.count += 1
        return { ...state }
      },
      getActionCostUsd: () => 0.1,
    })

    expect(result.runId).toBeTruthy()
    const run = await store.getRun(result.runId!)
    expect(run?.status).toBe('completed')
    expect(run?.outcome?.pass).toBe(true)
    const spans = await store.spans({ runId: result.runId! })
    const stepSpan = spans.find((span) => span.name === 'control-step-0')
    expect(stepSpan).toMatchObject({
      kind: 'tool',
      toolName: 'agent-control-action',
      args: { type: 'increment' },
    })
    expect(spans.some((span) => span.name === 'control-eval/count>=1')).toBe(true)
    const budget = await store.budget(result.runId!)
    expect(budget).toHaveLength(1)
    expect(budget[0].dimension).toBe('usd')
    expect(budget[0].consumed).toBe(0.1)
  })
})
