import { describe, expect, it } from 'vitest'
import {
  createBeliefRuntimeHookCollector,
  type RuntimeBeliefDecisionPoint,
  type RuntimeBeliefHookEvent,
  runtimeDecisionPointToBeliefDecisionPoint,
  runtimeDecisionPointToBeliefShadowProbeInput,
} from './runtime-hooks'

describe('belief runtime hooks bridge', () => {
  it('converts a runtime decision point to an outcome-blind shadow probe input', () => {
    const report = runtimeDecisionPointToBeliefShadowProbeInput(runtimeDecisionPoint(), {
      probeId: 'failure-recovery-shadow',
      includeEvidenceDetail: true,
    })

    expect(report.diagnostics).toEqual([])
    expect(report.input).toMatchObject({
      probeId: 'failure-recovery-shadow',
      decisionId: 'run-1:agent.turn:0:failure-recovery',
      runId: 'run-1',
      scenarioId: 'scenario-1',
      stepIndex: 0,
      decisionKind: 'retry',
      candidateActions: ['retry', 'verify', 'continue', 'stop'],
      context: 'tool submit_proposal failed: missing owner',
      metadata: {
        target: 'failure-recovery',
        source: 'agent.turn',
      },
    })
    expect(report.input?.observedAction).toBeUndefined()
    expect(report.input?.evidence).toEqual([
      { id: 'call-1', source: 'tool_call', detail: 'submit_proposal', quality: 'direct' },
      { id: 'result-1', source: 'tool_result', detail: 'missing owner' },
    ])
  })

  it('requires an observed action before creating a full belief decision point', () => {
    const missing = runtimeDecisionPointToBeliefDecisionPoint(runtimeDecisionPoint(), {})
    expect(missing.point).toBeUndefined()
    expect(missing.diagnostics).toEqual([
      {
        decisionId: 'run-1:agent.turn:0:failure-recovery',
        severity: 'error',
        reason: 'missing chosenAction',
      },
    ])

    const converted = runtimeDecisionPointToBeliefDecisionPoint(runtimeDecisionPoint(), {
      chosenAction: 'verify',
      confidence: 0.7,
      behaviorProb: 0.5,
      targetProb: 0.8,
      qHatChosen: 0.6,
      vHatTarget: 0.65,
      outcome: { success: true, score: 1 },
      metadata: { observedAt: 'after-turn' },
    })

    expect(converted.diagnostics).toEqual([])
    expect(converted.point).toMatchObject({
      id: 'run-1:agent.turn:0:failure-recovery',
      runId: 'run-1',
      scenarioId: 'scenario-1',
      stepIndex: 0,
      kind: 'retry',
      chosenAction: 'verify',
      confidence: 0.7,
      behaviorProb: 0.5,
      targetProb: 0.8,
      qHatChosen: 0.6,
      vHatTarget: 0.65,
      outcome: { success: true, score: 1 },
      metadata: {
        target: 'failure-recovery',
        source: 'agent.turn',
        observedAt: 'after-turn',
      },
    })
    expect(converted.point?.evidence).toEqual([
      {
        source: 'event',
        id: 'call-1',
        runId: 'run-1',
        detail: 'submit_proposal',
        quality: 'direct',
        metadata: { runtimeSource: 'tool_call' },
      },
      {
        source: 'event',
        id: 'result-1',
        runId: 'run-1',
        detail: 'missing owner',
        metadata: { runtimeSource: 'tool_result', code: 'invalid_input' },
      },
    ])
  })

  it('collects runtime decisions through a structurally compatible hook object', async () => {
    const collector = createBeliefRuntimeHookCollector({
      probeId: 'runtime-shadow',
    })
    await collector.hooks.onDecisionPoint?.(runtimeDecisionPoint(), {})

    expect(collector.decisions).toHaveLength(1)
    const report = collector.toShadowProbeInputs()
    expect(report.diagnostics).toEqual([])
    expect(report.inputs.map((input) => input.decisionId)).toEqual([
      'run-1:agent.turn:0:failure-recovery',
    ])

    collector.clear()
    expect(collector.decisions).toEqual([])
  })

  it('attaches matching lifecycle hook events as evidence without creating decisions', async () => {
    const collector = createBeliefRuntimeHookCollector({
      probeId: 'runtime-shadow',
      includeEvidenceDetail: true,
    })
    await collector.hooks.onEvent?.(runtimeHookEvent(), {})
    await collector.hooks.onDecisionPoint?.(runtimeDecisionPoint(), {})

    expect(collector.decisions).toHaveLength(1)
    expect(collector.events).toHaveLength(1)

    const report = collector.toShadowProbeInputs()
    expect(report.diagnostics).toEqual([])
    expect(report.inputs).toHaveLength(1)
    expect(report.inputs[0]?.evidence).toContainEqual({
      id: 'run-1:agent.plan:0:after',
      source: 'runtime_event',
      detail: 'agent.plan:after',
      quality: 'direct',
    })
    expect(report.inputs[0]?.metadata).toMatchObject({
      lifecycleEventCount: 1,
      lifecycleEventIds: ['run-1:agent.plan:0:after'],
    })

    collector.clear()
    expect(collector.decisions).toEqual([])
    expect(collector.events).toEqual([])
  })

  it('keeps unrelated lifecycle hook events out of probe evidence', () => {
    const report = runtimeDecisionPointToBeliefShadowProbeInput(runtimeDecisionPoint(), {
      probeId: 'runtime-shadow',
      lifecycleEvents: [
        runtimeHookEvent({ runId: 'other-run' }),
        runtimeHookEvent({
          id: 'run-1:agent.plan:1:after',
          stepIndex: 1,
        }),
      ],
    })

    expect(report.diagnostics).toEqual([])
    expect(report.input?.evidence.map((ref) => ref.id)).toEqual(['call-1', 'result-1'])
    expect(report.input?.metadata).not.toHaveProperty('lifecycleEventCount')
  })

  it('maps lifecycle hook events to full belief evidence when observed action is supplied', () => {
    const converted = runtimeDecisionPointToBeliefDecisionPoint(runtimeDecisionPoint(), {
      chosenAction: 'verify',
      lifecycleEvents: [runtimeHookEvent()],
    })

    expect(converted.diagnostics).toEqual([])
    expect(converted.point?.evidence.at(-1)).toMatchObject({
      source: 'event',
      id: 'run-1:agent.plan:0:after',
      runId: 'run-1',
      detail: 'agent.plan:after',
      quality: 'direct',
      metadata: {
        runtimeSource: 'runtime_event',
        target: 'agent.plan',
        phase: 'after',
        stepIndex: 0,
        producer: 'run-loop',
        payloadPreview: '{"moveKind":"verify"}',
      },
    })
    expect(converted.point?.metadata).toMatchObject({
      lifecycleEventCount: 1,
      lifecycleEventIds: ['run-1:agent.plan:0:after'],
    })
  })

  it('diagnoses unsupported runtime decision kinds unless an explicit belief kind is supplied', () => {
    const unsupported = runtimeDecisionPoint({ kind: 'driver-specific' })
    const missingOverride = runtimeDecisionPointToBeliefShadowProbeInput(unsupported, {
      probeId: 'runtime-shadow',
    })
    expect(missingOverride.input).toBeUndefined()
    expect(missingOverride.diagnostics).toEqual([
      {
        decisionId: 'run-1:agent.turn:0:failure-recovery',
        severity: 'error',
        reason: 'unsupported decisionKind "driver-specific"',
      },
    ])

    const withOverride = runtimeDecisionPointToBeliefShadowProbeInput(unsupported, {
      probeId: 'runtime-shadow',
      decisionKind: 'verify',
    })
    expect(withOverride.diagnostics).toEqual([])
    expect(withOverride.input?.decisionKind).toBe('verify')
  })
})

function runtimeDecisionPoint(
  overrides: Partial<RuntimeBeliefDecisionPoint> = {},
): RuntimeBeliefDecisionPoint {
  return {
    id: 'run-1:agent.turn:0:failure-recovery',
    runId: 'run-1',
    scenarioId: 'scenario-1',
    stepIndex: 0,
    kind: 'retry',
    candidateActions: ['retry', 'verify', 'continue', 'stop'],
    context: 'tool submit_proposal failed: missing owner',
    evidence: [
      {
        source: 'tool_call',
        id: 'call-1',
        detail: 'submit_proposal',
        quality: 'direct',
      },
      {
        source: 'tool_result',
        id: 'result-1',
        detail: 'missing owner',
        metadata: { code: 'invalid_input' },
      },
    ],
    metadata: {
      target: 'failure-recovery',
      source: 'agent.turn',
    },
    ...overrides,
  }
}

function runtimeHookEvent(overrides: Partial<RuntimeBeliefHookEvent> = {}): RuntimeBeliefHookEvent {
  return {
    id: 'run-1:agent.plan:0:after',
    runId: 'run-1',
    scenarioId: 'scenario-1',
    target: 'agent.plan',
    phase: 'after',
    timestamp: 1_788_538_000_000,
    stepIndex: 0,
    payload: { moveKind: 'verify' },
    metadata: { producer: 'run-loop' },
    ...overrides,
  }
}
