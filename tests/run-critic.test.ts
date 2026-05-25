import { describe, expect, it } from 'vitest'
import type { RunTrace } from '../src/run-critic'
import { RunCritic } from '../src/run-critic'

describe('RunCritic', () => {
  it('scores final gate pass and reviewer blockers from judge spans', () => {
    const score = new RunCritic().scoreTrace(trace())
    expect(score.finalGate).toBe(1)
    expect(score.reviewerBlockers).toBe(0.5)
    expect(score.notes).toContain('detected 1 blocking reviewer signal(s)')
  })
})

function trace(): RunTrace {
  return {
    run: {
      runId: 'r1',
      scenarioId: 's1',
      startedAt: 0,
      endedAt: 1000,
      status: 'completed',
      outcome: { pass: true, score: 0.8 },
    },
    spans: [
      {
        runId: 'r1',
        spanId: 'j1',
        kind: 'judge',
        name: 'security final gate',
        judgeId: 'security',
        targetSpanId: 'commit-a',
        dimension: 'final_gate',
        score: 8,
        startedAt: 1,
        attributes: { finalGate: true, blocking: false },
      },
      {
        runId: 'r1',
        spanId: 'j2',
        kind: 'judge',
        name: 'patch audit',
        judgeId: 'patch',
        targetSpanId: 'commit-a',
        dimension: 'patch',
        score: 2,
        startedAt: 2,
        attributes: { blocking: true },
      },
    ],
    events: [],
    artifacts: [
      { artifactId: 'a', runId: 'r1', contentType: 'text/plain', sizeBytes: 1, hash: 'h' },
    ],
    budget: [],
  }
}
