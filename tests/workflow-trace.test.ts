import { describe, expect, it } from 'vitest'
import {
  summarizeWorkflowTrace,
  validateWorkflowTraceEnvelope,
  type WorkflowTraceEnvelope,
  workflowTraceToFeedbackTrajectory,
  workflowTraceToRunRecord,
} from '../src/workflow'

const envelope: WorkflowTraceEnvelope = {
  traceVersion: 'workflow-trace-v1',
  runId: 'wf-1',
  topology: {
    id: 'driver-authored',
    interventions: ['plan', 'verify'],
    maxParallelBranches: 2,
  },
  events: [
    { kind: 'workflow.started', runId: 'wf-1', timestamp: 1000, payload: { depth: 0 } },
    { kind: 'workflow.phase', runId: 'wf-1', timestamp: 1010, payload: { title: 'Plan' } },
    {
      kind: 'workflow.agent.ended',
      runId: 'wf-1',
      timestamp: 1200,
      payload: {
        label: 'planner',
        phase: 'Plan',
        costUsd: 0.01,
        tokenUsage: { input: 10, output: 20 },
        trace: { text: 'plan' },
      },
    },
    {
      kind: 'workflow.loop.ended',
      runId: 'wf-1',
      timestamp: 1500,
      payload: {
        label: 'implement',
        costUsd: 0.02,
        tokenUsage: { input: 30, output: 40 },
        trace: { winner: 1 },
      },
    },
    {
      kind: 'workflow.ended',
      runId: 'wf-1',
      timestamp: 1600,
      payload: {
        durationMs: 600,
        costUsd: 0.03,
        tokenUsage: { input: 40, output: 60 },
        agentCalls: 1,
        loopCalls: 1,
      },
    },
  ],
}

const projection = {
  experimentId: 'exp-1',
  candidateId: 'workflow-driver-v1',
  seed: 7,
  model: 'claude-sonnet-4-6@2025-04-15',
  promptHash: 'p'.repeat(64),
  configHash: 'c'.repeat(64),
  commitSha: 'cafebabe',
  splitTag: 'search' as const,
  scenarioId: 'scenario-1',
}

describe('workflow trace substrate', () => {
  it('validates and summarizes workflow trace envelopes', () => {
    const valid = validateWorkflowTraceEnvelope(envelope)
    expect(valid.runId).toBe('wf-1')
    const summary = summarizeWorkflowTrace(valid)
    expect(summary).toMatchObject({
      runId: 'wf-1',
      durationMs: 600,
      costUsd: 0.03,
      tokenUsage: { input: 40, output: 60 },
      phaseCount: 1,
      agentCalls: 1,
      loopCalls: 1,
      failed: false,
    })
  })

  it('projects workflow traces into canonical RunRecords', () => {
    const record = workflowTraceToRunRecord(envelope, { ...projection, score: 0.82 })
    expect(record.runId).toBe('wf-1')
    expect(record.candidateId).toBe('workflow-driver-v1')
    expect(record.outcome.searchScore).toBe(0.82)
    expect(record.outcome.raw.workflow_agent_calls).toBe(1)
    expect(record.outcome.raw.workflow_loop_calls).toBe(1)
    expect(record.tokenUsage).toEqual({ input: 40, output: 60 })
  })

  it('projects workflow traces into feedback trajectories for RL/export consumers', () => {
    const trajectory = workflowTraceToFeedbackTrajectory(envelope, {
      projectId: 'blueprint-agent',
      scenarioId: 'scenario-1',
      task: 'Build the app',
      score: 0.82,
      tags: { driver: 'workflow-driver-v1' },
    })
    expect(trajectory.id).toBe('wf-1')
    expect(trajectory.attempts).toHaveLength(2)
    expect(trajectory.attempts.map((a) => a.artifactType)).toEqual(['action', 'decision'])
    expect(trajectory.outcome?.metrics?.workflow_tokens_output).toBe(60)
    expect(trajectory.tags?.driver).toBe('workflow-driver-v1')
  })

  it('rejects events from mixed run ids', () => {
    expect(() =>
      validateWorkflowTraceEnvelope({
        ...envelope,
        events: [
          ...envelope.events,
          { kind: 'workflow.log', runId: 'other', timestamp: 1700, payload: {} },
        ],
      }),
    ).toThrow(/does not match/)
  })
})
