import { describe, expect, it } from 'vitest'
import { InMemoryTraceStore } from '../trace/store'
import { extractBeliefDecisionPoints } from './extract'

describe('belief-state extraction', () => {
  it('extracts decision points from trace custom events', async () => {
    const store = new InMemoryTraceStore()
    await store.appendRun({
      runId: 'run-1',
      scenarioId: 'scenario-1',
      startedAt: 1,
      status: 'completed',
      outcome: { score: 1, pass: true },
    })
    await store.appendSpan({
      kind: 'agent',
      runId: 'run-1',
      spanId: 'span-1',
      name: 'decide',
      startedAt: 2,
    })
    await store.appendEvent({
      eventId: 'event-1',
      runId: 'run-1',
      spanId: 'span-1',
      kind: 'custom',
      timestamp: 3,
      payload: {
        kind: 'belief_decision',
        decisionKind: 'verify',
        chosenAction: 'run-check',
        confidence: 0.4,
        candidateActions: ['run-check', 'continue'],
        qHatChosen: 0.6,
        vHatTarget: 0.7,
        outcome: { success: true, score: 1 },
      },
    })

    const report = await extractBeliefDecisionPoints(store)

    expect(report.diagnostics).toEqual([])
    expect(report.decisions).toHaveLength(1)
    expect(report.decisions[0]).toMatchObject({
      id: 'event-1',
      runId: 'run-1',
      scenarioId: 'scenario-1',
      stepIndex: 0,
      kind: 'verify',
      chosenAction: 'run-check',
      confidence: 0.4,
      qHatChosen: 0.6,
      vHatTarget: 0.7,
    })
    expect(report.decisions[0]!.evidence.map((evidence) => evidence.source)).toEqual([
      'event',
      'span',
    ])
  })

  it('diagnoses malformed belief decision events without throwing', async () => {
    const store = new InMemoryTraceStore()
    await store.appendRun({
      runId: 'run-1',
      scenarioId: 'scenario-1',
      startedAt: 1,
      status: 'completed',
    })
    await store.appendEvent({
      eventId: 'bad-event',
      runId: 'run-1',
      kind: 'custom',
      timestamp: 2,
      payload: {
        kind: 'belief_decision',
        decisionKind: 'unknown',
      },
    })

    const report = await extractBeliefDecisionPoints(store)

    expect(report.decisions).toEqual([])
    expect(report.diagnostics).toEqual([
      {
        runId: 'run-1',
        eventId: 'bad-event',
        severity: 'warning',
        reason: 'belief decision event has unsupported decisionKind "unknown"',
      },
    ])
  })

  it('preserves malformed propensities for OPE diagnostics instead of clamping', async () => {
    const store = new InMemoryTraceStore()
    await store.appendRun({
      runId: 'run-1',
      scenarioId: 'scenario-1',
      startedAt: 1,
      status: 'completed',
    })
    await store.appendEvent({
      eventId: 'event-1',
      runId: 'run-1',
      kind: 'custom',
      timestamp: 2,
      payload: {
        kind: 'belief_decision',
        decisionKind: 'continue',
        chosenAction: 'continue',
        behaviorProb: -0.1,
        targetProb: 1.2,
        outcome: { score: 1 },
      },
    })

    const report = await extractBeliefDecisionPoints(store)

    expect(report.decisions[0]).toMatchObject({
      behaviorProb: -0.1,
      targetProb: 1.2,
    })
  })
})
