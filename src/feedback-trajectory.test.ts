import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  FileSystemFeedbackTrajectoryStore,
  InMemoryFeedbackTrajectoryStore,
  controlRunToFeedbackTrajectory,
  createFeedbackTrajectory,
  feedbackTrajectoryToDatasetScenario,
  feedbackTrajectoryToOptimizerRow,
  parseFeedbackTrajectoriesJsonl,
  renderPreferenceMemoryMarkdown,
  serializeFeedbackTrajectoriesJsonl,
  summarizePreferenceMemory,
  withAssignedFeedbackSplit,
  type ControlRunResult,
} from './index'

describe('feedback trajectories', () => {
  it('stores trajectories and appends attempt-scoped feedback immutably', async () => {
    const store = new InMemoryFeedbackTrajectoryStore()
    const trajectory = createFeedbackTrajectory({
      id: 'ft_1',
      projectId: 'agent-builder',
      scenarioId: 'scenario_1',
      task: { intent: 'build an agent' },
      attempts: [{
        id: 'a1',
        stepIndex: 0,
        artifactType: 'code',
        artifact: { files: ['agent.ts'] },
        createdAt: '2026-04-29T00:00:00.000Z',
      }],
      createdAt: '2026-04-29T00:00:00.000Z',
    })

    await store.save(trajectory)
    const next = await store.appendLabel('ft_1', {
      id: 'l1',
      source: 'user',
      kind: 'revision_request',
      value: 'needs validation',
      reason: 'add objective validators before claiming success',
      severity: 'critical',
      createdAt: '2026-04-29T00:01:00.000Z',
    }, 'a1')

    expect(next.labels).toHaveLength(1)
    expect(next.attempts[0].feedback).toHaveLength(1)
    expect(trajectory.labels).toHaveLength(0)
  })

  it('round-trips filesystem stores and deterministic jsonl serialization', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agent-eval-feedback-'))
    try {
      const store = new FileSystemFeedbackTrajectoryStore({ dir })
      const trajectory = withAssignedFeedbackSplit(createFeedbackTrajectory({
        id: 'ft_2',
        task: { intent: 'draft retail pitch' },
        labels: [{
          source: 'judge',
          kind: 'approve',
          value: true,
          reason: 'specific enough to execute this week',
          createdAt: '2026-04-29T00:00:00.000Z',
        }],
        createdAt: '2026-04-29T00:00:00.000Z',
      }))

      await store.save(trajectory)
      const reloaded = new FileSystemFeedbackTrajectoryStore({ dir })
      expect(await reloaded.get('ft_2')).toEqual(trajectory)

      const jsonl = serializeFeedbackTrajectoriesJsonl([trajectory])
      expect(parseFeedbackTrajectoriesJsonl(jsonl)).toEqual([trajectory])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('converts feedback trajectories to dataset and optimizer rows', () => {
    const trajectory = withAssignedFeedbackSplit(createFeedbackTrajectory({
      id: 'ft_3',
      projectId: 'gtm',
      scenarioId: 'cpg-founder',
      task: { intent: 'create one-page operator brief' },
      labels: [{
        source: 'metric',
        kind: 'rate',
        value: 0.82,
        reason: 'brief changed the operator plan',
        createdAt: '2026-04-29T00:00:00.000Z',
      }],
      createdAt: '2026-04-29T00:00:00.000Z',
    }))

    const scenario = feedbackTrajectoryToDatasetScenario(trajectory)
    const row = feedbackTrajectoryToOptimizerRow(trajectory)

    expect(scenario.id).toBe('cpg-founder')
    expect(scenario.tags).toMatchObject({ projectId: 'gtm', source: 'feedback-trajectory' })
    expect(row).toMatchObject({
      scenarioId: 'cpg-founder',
      trajectoryId: 'ft_3',
      labelKinds: ['rate'],
      score: 0.82,
    })
  })

  it('converts control runs into preference memory', () => {
    const run: ControlRunResult<{ count: number }, { type: 'increment' }, { count: number }> = {
      intent: 'make count one',
      pass: false,
      completed: true,
      reason: 'missing source validation',
      steps: [{
        index: 0,
        decision: { type: 'continue', action: { type: 'increment' }, reason: 'count low' },
        beforeState: { count: 0 },
        afterState: { count: 1 },
        evalsBefore: [],
        evalsAfter: [],
        actionOutcome: { ok: true, result: { count: 1 }, durationMs: 1 },
        startedAt: '2026-04-29T00:00:00.000Z',
        endedAt: '2026-04-29T00:00:01.000Z',
      }],
      finalState: { count: 1 },
      finalEvals: [],
      wallMs: 1,
      spentCostUsd: 0.01,
      runId: 'run_1',
      runtimeErrors: [],
      stoppedBy: 'policy',
    }

    const trajectory = controlRunToFeedbackTrajectory(run, {
      projectId: 'tax-agent',
      scenarioId: 'tax-source-check',
      createdAt: '2026-04-29T00:00:00.000Z',
    })
    const memory = summarizePreferenceMemory([trajectory])
    const markdown = renderPreferenceMemoryMarkdown(memory)

    expect(trajectory.id).toBe('run_1')
    expect(trajectory.attempts).toHaveLength(1)
    expect(trajectory.outcome?.success).toBe(false)
    expect(memory[0].instruction).toContain('missing source validation')
    expect(markdown).toContain('Preference Memory')
  })
})
