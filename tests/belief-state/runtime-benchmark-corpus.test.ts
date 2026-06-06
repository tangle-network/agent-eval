import { describe, expect, it } from 'vitest'
import { buildRuntimeBenchmarkBeliefPhase0Measurement } from '../../src/belief-state/runtime-benchmark-corpus'
import type { RuntimeBeliefDecisionPoint } from '../../src/belief-state/runtime-hooks'

describe('runtime benchmark corpus belief-state projection', () => {
  it('extracts lifecycle run evidence while keeping policy claims blocked without decisions', () => {
    const report = buildRuntimeBenchmarkBeliefPhase0Measurement({
      records: [
        {
          benchmark: 'commit0',
          instanceId: 'task-1',
          condition: 'random@2',
          model: 'gpt-5',
          runtimeEvents: runtimeEvents('commit0:task-1:0', 'task-1', 0),
        },
        {
          benchmark: 'commit0',
          instanceId: 'task-1',
          condition: 'random@2',
          model: 'gpt-5',
          runtimeEvents: runtimeEvents('commit0:task-1:1', 'task-1', 1),
        },
      ],
      targetId: 'failure-recovery',
      minN: 2,
      claimScope: 'selective',
    })

    expect(report.runs).toEqual([
      { runId: 'commit0:task-1:0', scenarioId: 'task-1', splitTag: 'search' },
      { runId: 'commit0:task-1:1', scenarioId: 'task-1', splitTag: 'search' },
    ])
    expect(report.events).toHaveLength(6)
    expect(report.trajectory.summary).toEqual({
      recordCount: 2,
      recordWithRuntimeEventsCount: 2,
      runtimeRunCount: 2,
      lifecycleEventCount: 6,
      defaultedSplitCount: 2,
    })
    expect(report.summary).toEqual({
      decisionCount: 0,
      labelCount: 0,
    })
    expect(report.measurement.points).toEqual([])
    expect(report.measurement.summary.packetStatus).toBe('blocked')
    expect(report.diagnostics).toContain(
      'no runtime decision points supplied; benchmark lifecycle events alone cannot produce belief decision rows',
    )
  })

  it('feeds explicit runtime decisions and labels into the existing Phase 0 measurement', () => {
    const decisions = Array.from({ length: 12 }, (_, index) => decision(index))
    const labels = decisions.map((item, index) => ({
      decisionId: item.id,
      chosenAction: index % 2 === 0 ? 'verify' : 'stop',
      confidence: index % 2 === 0 ? 0.8 : 0.4,
      outcome: { success: index % 2 === 0, score: index % 2 === 0 ? 1 : 0 },
    }))

    const report = buildRuntimeBenchmarkBeliefPhase0Measurement({
      records: [
        {
          benchmark: 'commit0',
          instanceId: 'task-1',
          condition: 'random@2',
          model: 'gpt-5',
          splitTag: 'holdout',
          runtimeEvents: [...runtimeEvents('commit0:task-1:0', 'task-1', 0)],
        },
      ],
      decisions,
      labels,
      targetId: 'failure-recovery',
      minN: 12,
      minAccepted: 6,
      confidenceThreshold: 0.6,
      claimScope: 'selective',
    })

    expect(report.diagnostics).toEqual([])
    expect(report.measurement.points).toHaveLength(12)
    expect(report.measurement.summary).toMatchObject({
      completedPointCount: 12,
      lifecycleEventCount: 3,
      packetStatus: 'supported',
      claimScope: 'selective',
    })
    expect(report.measurement.points[0]).toMatchObject({
      id: 'commit0:task-1:0:agent.turn:0:failure-recovery',
      runId: 'commit0:task-1:0',
      scenarioId: 'task-1',
      chosenAction: 'verify',
      metadata: { splitTag: 'holdout', lifecycleEventCount: 3 },
    })
    expect(report.measurement.points[0]?.evidence.map((ref) => ref.id)).toEqual(
      expect.arrayContaining([
        'commit0:task-1:0:agent.run:before',
        'commit0:task-1:0:agent.turn:after:0',
      ]),
    )
    expect(report.measurement.packet.analysis.evaluation?.selectiveStatus).toBe('ship')
  })

  it('diagnoses missing or malformed runtime event arrays without inventing runs', () => {
    const report = buildRuntimeBenchmarkBeliefPhase0Measurement({
      records: [
        {
          benchmark: 'swe-bench',
          instanceId: 'case-empty',
          condition: 'blind@1',
          runtimeEvents: [],
        },
        {
          benchmark: 'swe-bench',
          instanceId: 'case-bad',
          condition: 'blind@1',
          runtimeEvents: [{ id: 'bad' }],
        },
      ],
      targetId: 'failure-recovery',
      minN: 1,
      claimScope: 'selective',
    })

    expect(report.runs).toEqual([])
    expect(report.events).toEqual([])
    expect(report.diagnostics).toEqual([
      'swe-bench:case-empty:blind@1: no runtimeEvents; no runtime run join can be extracted',
      'swe-bench:case-bad:blind@1: runtimeEvents[0] is not a RuntimeHookEvent',
      'no runtime decision points supplied; benchmark lifecycle events alone cannot produce belief decision rows',
    ])
  })
})

function runtimeEvents(runId: string, scenarioId: string, stepIndex: number) {
  return [
    {
      id: `${runId}:agent.run:before`,
      runId,
      scenarioId,
      target: 'agent.run',
      phase: 'before',
      timestamp: 1_788_624_000_000,
      metadata: { producer: 'openSandboxRun' },
    },
    {
      id: `${runId}:agent.turn:before:${stepIndex}`,
      runId,
      scenarioId,
      target: 'agent.turn',
      phase: 'before',
      timestamp: 1_788_624_000_001,
      stepIndex,
      payload: { promptHash: 'abc123' },
      metadata: { producer: 'openSandboxRun' },
    },
    {
      id: `${runId}:agent.turn:after:${stepIndex}`,
      runId,
      scenarioId,
      target: 'agent.turn',
      phase: 'after',
      timestamp: 1_788_624_000_002,
      stepIndex,
      payload: { eventCount: 1, eventTypes: { result: 1 } },
      metadata: { producer: 'openSandboxRun' },
    },
  ]
}

function decision(index: number): RuntimeBeliefDecisionPoint {
  return {
    id: `commit0:task-1:0:agent.turn:${index}:failure-recovery`,
    runId: 'commit0:task-1:0',
    scenarioId: 'task-1',
    stepIndex: index,
    kind: 'retry',
    candidateActions: ['retry', 'verify', 'continue', 'stop'],
    context: `failed patch attempt ${index}`,
    evidence: [
      {
        source: 'event',
        id: `attempt-${index}`,
        detail: `attempt ${index}`,
        quality: 'direct',
      },
    ],
    metadata: { target: 'failure-recovery' },
  }
}
