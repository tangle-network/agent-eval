import { describe, expect, it } from 'vitest'
import { buildRuntimeBeliefPhase0Measurement } from './phase0-measurement'
import type { RuntimeBeliefDecisionPoint, RuntimeBeliefHookEvent } from './runtime-hooks'

describe('runtime belief-state Phase 0 measurement', () => {
  it('joins runtime producer decisions, lifecycle evidence, labels, and run records into a selective packet', () => {
    const measurement = buildRuntimeBeliefPhase0Measurement({
      runs: [{ runId: 'run-1', scenarioId: 'scenario-1', splitTag: 'holdout' }],
      decisions: runtimeDecisionPoints(12),
      events: runtimeLifecycleEvents(12),
      labels: runtimeLabels(12),
      targetId: 'failure-recovery',
      minN: 12,
      minAccepted: 6,
      confidenceThreshold: 0.6,
      claimScope: 'selective',
    })

    expect(measurement.diagnostics).toEqual([])
    expect(measurement.points).toHaveLength(12)
    expect(measurement.summary).toMatchObject({
      runCount: 1,
      producerDecisionCount: 12,
      lifecycleEventCount: 12,
      labelCount: 12,
      completedPointCount: 12,
      runJoinRate: 1,
      labelJoinRate: 1,
      missingRunRecordCount: 0,
      missingLabelCount: 0,
      withEvidence: 12,
      withOutcome: 12,
      withSplit: 12,
      withBehaviorProb: 0,
      withTargetProb: 0,
      baselinePolicyId: 'always-accept-observed-action',
      packetStatus: 'supported',
      claimScope: 'selective',
    })
    expect(measurement.points[0]).toMatchObject({
      runId: 'run-1',
      scenarioId: 'scenario-1',
      chosenAction: 'verify',
      metadata: {
        target: 'failure-recovery',
        splitTag: 'holdout',
        baselinePolicyId: 'always-accept-observed-action',
        lifecycleEventCount: 1,
      },
    })
    expect(measurement.points[0]?.evidence.map((ref) => ref.id)).toContain(
      'run-1:agent.plan:0:after',
    )
    expect(measurement.packet.status).toBe('supported')
    expect(measurement.packet.gates.map((gate) => gate.id)).toEqual([
      'corpus',
      'selective',
      'calibration',
    ])
    expect(measurement.packet.analysis.target?.id).toBe('failure-recovery')
    expect(measurement.packet.analysis.evaluation?.selectiveStatus).toBe('ship')
  })

  it('keeps counterfactual claims blocked when propensities are absent', () => {
    const measurement = buildRuntimeBeliefPhase0Measurement({
      runs: [{ runId: 'run-1', scenarioId: 'scenario-1', splitTag: 'holdout' }],
      decisions: runtimeDecisionPoints(12),
      labels: runtimeLabels(12),
      targetId: 'failure-recovery',
      minN: 12,
      minAccepted: 6,
      confidenceThreshold: 0.6,
      claimScope: 'counterfactual',
    })

    expect(measurement.summary.packetStatus).toBe('blocked')
    expect(measurement.summary.withBehaviorProb).toBe(0)
    expect(measurement.summary.withTargetProb).toBe(0)
    expect(measurement.packet.blockers.join('\n')).toMatch(/behaviorProb/)
    expect(measurement.packet.gates.find((gate) => gate.id === 'ope')?.status).toBe('blocked')
  })

  it('diagnoses missing run and label joins without fabricating completed rows', () => {
    const measurement = buildRuntimeBeliefPhase0Measurement({
      runs: [{ runId: 'run-1', scenarioId: 'scenario-1', splitTag: 'dev' }],
      decisions: [
        runtimeDecisionPoint(0),
        runtimeDecisionPoint(1, { id: 'run-1:agent.turn:1:failure-recovery' }),
        runtimeDecisionPoint(2, {
          id: 'run-missing:agent.turn:2:failure-recovery',
          runId: 'run-missing',
        }),
      ],
      labels: [runtimeLabel(0)],
      targetId: 'failure-recovery',
      minN: 3,
      claimScope: 'selective',
    })

    expect(measurement.points).toHaveLength(1)
    expect(measurement.summary).toMatchObject({
      producerDecisionCount: 3,
      completedPointCount: 1,
      missingRunRecordCount: 1,
      missingLabelCount: 1,
      runJoinRate: 2 / 3,
      labelJoinRate: 1 / 3,
      packetStatus: 'blocked',
    })
    expect(measurement.diagnostics).toEqual([
      'run-1:agent.turn:1:failure-recovery: missing observed action/outcome label',
      'run-missing:agent.turn:2:failure-recovery: missing RunRecord join for runId run-missing',
    ])
  })
})

function runtimeDecisionPoints(n: number): RuntimeBeliefDecisionPoint[] {
  return Array.from({ length: n }, (_, index) => runtimeDecisionPoint(index))
}

function runtimeDecisionPoint(
  index: number,
  overrides: Partial<RuntimeBeliefDecisionPoint> = {},
): RuntimeBeliefDecisionPoint {
  return {
    id: `run-1:agent.turn:${index}:failure-recovery`,
    runId: 'run-1',
    scenarioId: 'scenario-1',
    stepIndex: index,
    kind: 'retry',
    candidateActions: ['retry', 'verify', 'continue', 'stop'],
    context: `tool edit_file failed at step ${index}`,
    evidence: [
      {
        source: 'tool_result',
        id: `result-${index}`,
        detail: 'edit_file failed',
        quality: 'direct',
      },
    ],
    metadata: { target: 'failure-recovery', producer: 'agent-runtime' },
    ...overrides,
  }
}

function runtimeLifecycleEvents(n: number): RuntimeBeliefHookEvent[] {
  return Array.from({ length: n }, (_, index) => ({
    id: `run-1:agent.plan:${index}:after`,
    runId: 'run-1',
    scenarioId: 'scenario-1',
    target: 'agent.plan',
    phase: 'after',
    timestamp: 1_788_624_000_000 + index,
    stepIndex: index,
    payload: { proposedAction: index % 2 === 0 ? 'verify' : 'stop' },
    metadata: { producer: 'run-loop' },
  }))
}

function runtimeLabels(n: number) {
  return Array.from({ length: n }, (_, index) => runtimeLabel(index))
}

function runtimeLabel(index: number) {
  const success = index % 2 === 0
  return {
    decisionId: `run-1:agent.turn:${index}:failure-recovery`,
    chosenAction: success ? 'verify' : 'stop',
    confidence: success ? 0.8 : 0.4,
    outcome: { success, score: success ? 1 : 0, reward: success ? 1 : 0 },
  }
}
