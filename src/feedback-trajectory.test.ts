import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  FileSystemFeedbackTrajectoryStore,
  InMemoryFeedbackTrajectoryStore,
  controlRunToFeedbackTrajectory,
  createFeedbackTrajectory,
  feedbackTrajectoryToOptimizerRow,
  parseFeedbackTrajectoriesJsonl,
  renderPreferenceMemoryMarkdown,
  serializeFeedbackTrajectoriesJsonl,
  summarizePreferenceMemory,
  withAssignedFeedbackSplit,
  type FeedbackAttempt,
  type FeedbackLabel,
} from './feedback-trajectory'
import type { ControlRunResult } from './control-runtime'

describe('feedback trajectories', () => {
  it('turns control runs into stable feedback trajectories for optimization', () => {
    const run: ControlRunResult<{ count: number }, { type: 'increment' }, { count: number }> = {
      intent: 'make count positive',
      pass: true,
      completed: true,
      reason: 'all critical evals passed',
      score: 1,
      steps: [
        {
          index: 0,
          decision: { type: 'continue', action: { type: 'increment' } },
          beforeState: { count: 0 },
          afterState: { count: 1 },
          evalsBefore: [],
          evalsAfter: [{ id: 'count-positive', passed: true, severity: 'critical', objective: true }],
          actionOutcome: { ok: true, result: { count: 1 }, durationMs: 5 },
          startedAt: '2026-01-01T00:00:00.000Z',
          endedAt: '2026-01-01T00:00:00.005Z',
        },
      ],
      finalState: { count: 1 },
      finalEvals: [{ id: 'count-positive', passed: true, severity: 'critical', objective: true }],
      wallMs: 5,
      spentCostUsd: 0.01,
      runId: null,
      runtimeErrors: [],
      stoppedBy: 'stop-policy',
    }

    const trajectory = controlRunToFeedbackTrajectory(run, {
      projectId: 'project-1',
      scenarioId: 'scenario-1',
      createdAt: '2026-01-01T00:00:00.000Z',
    })
    const row = feedbackTrajectoryToOptimizerRow(trajectory)

    expect(trajectory.id).toMatch(/^ft_control_/)
    expect(trajectory.attempts[0].id).toBe(`${trajectory.id}_step_0`)
    expect(trajectory.outcome?.metadata?.stoppedBy).toBe('stop-policy')
    expect(row).toMatchObject({
      scenarioId: 'scenario-1',
      trajectoryId: trajectory.id,
      score: 1,
    })
  })

  it('keeps attempt feedback scoped and deduplicated for preference memory', async () => {
    const store = new InMemoryFeedbackTrajectoryStore()
    const trajectory = createFeedbackTrajectory({
      id: 'feedback-1',
      task: { intent: 'draft a launch plan' },
      createdAt: '2026-01-01T00:00:00.000Z',
      attempts: [attempt('attempt-1')],
    })
    const label: FeedbackLabel = {
      id: 'label-1',
      source: 'user',
      kind: 'revision_request',
      value: 'too vague',
      reason: 'make the rollout steps concrete',
      severity: 'critical',
      createdAt: '2026-01-01T00:01:00.000Z',
    }

    await store.save(trajectory)
    const updated = await store.appendLabel('feedback-1', label, 'attempt-1')
    const entries = summarizePreferenceMemory([updated])

    expect(updated.labels).toHaveLength(0)
    expect(updated.attempts[0].feedback).toEqual([label])
    expect(entries).toHaveLength(1)
    expect(renderPreferenceMemoryMarkdown(entries)).toContain('make the rollout steps concrete')
  })

  it('round-trips deterministic JSONL and assigns stable dataset splits', () => {
    const trajectory = withAssignedFeedbackSplit(createFeedbackTrajectory({
      id: 'feedback-2',
      projectId: 'project-2',
      scenarioId: 'scenario-2',
      task: { intent: 'fix checkout' },
      createdAt: '2026-01-01T00:00:00.000Z',
      tags: { product: 'checkout' },
    }))

    const jsonl = serializeFeedbackTrajectoriesJsonl([trajectory])
    const parsed = parseFeedbackTrajectoriesJsonl(jsonl)

    expect(parsed).toEqual([trajectory])
    expect(parsed[0].split).toBe(trajectory.split)
  })

  it('persists trajectories and skips corrupt JSONL records without losing valid data', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'feedback-trajectories-'))
    try {
      const file = join(dir, 'feedback-trajectories.ndjson')
      const saved = createFeedbackTrajectory({
        id: 'feedback-3',
        task: { intent: 'ship docs' },
        createdAt: '2026-01-01T00:00:00.000Z',
      })
      await writeFile(file, [
        JSON.stringify({ op: 'save', trajectory: saved }),
        '{bad json',
        JSON.stringify({ op: 'appendAttempt', id: 'feedback-3', attempt: attempt('attempt-3') }),
        '',
      ].join('\n'), 'utf8')

      const store = new FileSystemFeedbackTrajectoryStore({ dir })
      const loaded = await store.get('feedback-3')

      expect(loaded?.attempts.map((item) => item.id)).toEqual(['attempt-3'])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

function attempt(id: string): FeedbackAttempt {
  return {
    id,
    stepIndex: 0,
    artifactType: 'plan',
    artifact: { title: 'draft' },
    createdAt: '2026-01-01T00:00:00.000Z',
  }
}
