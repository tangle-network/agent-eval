import { describe, expect, it } from 'vitest'
import {
  parseRuntimeTrajectoryHookEvent,
  projectRuntimeTrajectoryEvidence,
} from '../src/runtime-trajectory'

describe('runtime trajectory evidence projection', () => {
  it('extracts run joins and lifecycle events from benchmark records', () => {
    const projection = projectRuntimeTrajectoryEvidence({
      records: [
        {
          id: 'commit0:task-1:0',
          scenarioId: 'task-1',
          runtimeEvents: runtimeEvents('commit0:task-1:0', undefined, 0),
        },
        {
          id: 'commit0:task-1:1',
          scenarioId: 'task-1',
          runtimeEvents: runtimeEvents('commit0:task-1:1', undefined, 1),
        },
      ],
      defaultSplitTag: 'holdout',
    })

    expect(projection.runs).toEqual([
      { runId: 'commit0:task-1:0', scenarioId: 'task-1', splitTag: 'holdout' },
      { runId: 'commit0:task-1:1', scenarioId: 'task-1', splitTag: 'holdout' },
    ])
    expect(projection.events).toHaveLength(6)
    expect(projection.summary).toEqual({
      recordCount: 2,
      recordWithRuntimeEventsCount: 2,
      runtimeRunCount: 2,
      lifecycleEventCount: 6,
      defaultedSplitCount: 2,
    })
    expect(projection.diagnostics).toEqual([])
  })

  it('diagnoses missing and malformed runtime event arrays without inventing runs', () => {
    const projection = projectRuntimeTrajectoryEvidence({
      records: [
        {
          id: 'case-empty',
          runtimeEvents: [],
        },
        {
          id: 'case-not-array',
          runtimeEvents: 'bad',
        },
        {
          id: 'case-bad',
          runtimeEvents: [{ id: 'bad' }],
        },
      ],
    })

    expect(projection.runs).toEqual([])
    expect(projection.events).toEqual([])
    expect(projection.diagnostics).toEqual([
      'case-empty: no runtimeEvents; no runtime run join can be extracted',
      'case-not-array: runtimeEvents is not an array; no runtime run join can be extracted',
      'case-bad: runtimeEvents[0] is not a RuntimeHookEvent',
    ])
  })

  it('parses only structurally complete runtime hook events', () => {
    expect(parseRuntimeTrajectoryHookEvent({ id: 'bad' })).toBeNull()
    expect(
      parseRuntimeTrajectoryHookEvent({
        id: 'event-1',
        runId: 'run-1',
        target: 'agent.turn',
        phase: 'after',
        timestamp: 1,
        stepIndex: 0,
        payload: { eventCount: 1 },
        metadata: { producer: 'openSandboxRun' },
      }),
    ).toEqual({
      id: 'event-1',
      runId: 'run-1',
      target: 'agent.turn',
      phase: 'after',
      timestamp: 1,
      stepIndex: 0,
      payload: { eventCount: 1 },
      metadata: { producer: 'openSandboxRun' },
    })
  })
})

function runtimeEvents(runId: string, scenarioId: string | undefined, stepIndex: number) {
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
