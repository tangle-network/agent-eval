import { describe, expect, it } from 'vitest'
import { makeFinding } from '../src/analyst/types'
import type { VerificationReport } from '../src/multi-layer-verifier'
import type { FailureClusterReport } from '../src/pipelines'
import {
  buildWorkflowAnalystFeedbackPack,
  renderWorkflowFeedbackPack,
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

  it('builds a bounded analyst feedback pack for the next workflow driver shot', () => {
    const feedbackEnvelope: WorkflowTraceEnvelope = {
      ...envelope,
      events: [
        ...envelope.events.slice(0, 3),
        {
          kind: 'workflow.agent.ended',
          runId: 'wf-1',
          timestamp: 1300,
          payload: {
            label: 'implementation',
            toolUsage: {
              byTool: {
                read: { calls: 2, errors: 1 },
              },
            },
            toolCalls: [
              { toolName: 'write', status: 'ok' },
              { toolName: 'test', error: 'vitest failed' },
            ],
          },
        },
        ...envelope.events.slice(3),
      ],
    }
    const verifier: VerificationReport = {
      layers: [
        {
          layer: 'typecheck',
          status: 'fail',
          score: 0.2,
          durationMs: 1200,
          findings: [
            {
              severity: 'major',
              message: 'Type error in Auction.ts',
              evidence: 'Auction.ts:12',
            },
          ],
          reason: 'tsc failed',
          diagnostics: { errors: 1 },
        },
      ],
      passCount: 0,
      failCount: 1,
      skippedCount: 0,
      errorCount: 0,
      allPass: false,
      blendedScore: 0.2,
      durationMs: 1200,
      startedAt: '2026-06-01T00:00:00.000Z',
      finishedAt: '2026-06-01T00:00:01.200Z',
    }
    const failureClusters: FailureClusterReport = {
      totalRuns: 3,
      totalFailures: 2,
      clusters: [
        {
          failureClass: 'tool_recovery_failure',
          toolName: 'test',
          argPrefix: 'abc123',
          runCount: 2,
          scenarioIds: ['scenario-1'],
          exampleRunId: 'wf-1',
          exampleError: 'vitest failed',
        },
      ],
    }
    const finding = makeFinding({
      analyst_id: 'failure-mode',
      severity: 'high',
      area: 'verification',
      claim: 'The implementation loop keeps proceeding after typecheck failure',
      confidence: 0.9,
      evidence_refs: [{ kind: 'event', uri: 'workflow://wf-1/typecheck' }],
      recommended_action: 'Stop the next workflow at typecheck until Auction.ts is fixed',
      validation_plan: 'Run pnpm typecheck before fanout review',
    })

    const pack = buildWorkflowAnalystFeedbackPack({
      envelope: feedbackEnvelope,
      verifier,
      failureClusters,
      analystFindings: [finding],
      generatedAt: '2026-06-01T00:00:02.000Z',
    })

    expect(pack.schemaVersion).toBe('workflow-feedback-pack-v1')
    expect(pack.summary.agentCalls).toBe(1)
    expect(pack.verifier?.failedLayers).toEqual(['typecheck'])
    expect(pack.verifier?.layers[0]?.findings[0]?.severity).toBe('high')
    expect(pack.toolUsage).toEqual({
      totalCalls: 4,
      erroredCalls: 2,
      byTool: {
        read: { calls: 2, errors: 1 },
        write: { calls: 1, errors: 0 },
        test: { calls: 1, errors: 1 },
      },
    })
    expect(pack.failureClusters[0]).toMatchObject({
      id: 'tool_recovery_failure|test|abc123|',
      share: 1,
      runCount: 2,
      source: 'failure-cluster-view',
    })
    expect(pack.findings[0]?.findingId).toBe(finding.finding_id)
    expect(pack.recommendations).toContain('Fix verifier layer "typecheck": tsc failed')
    expect(pack.recommendations).toContain(
      'Stop the next workflow at typecheck until Auction.ts is fixed',
    )
    expect(pack.driverContextLines.join('\n')).toContain('verifier=fail')
  })

  it('renders feedback packs into a capped driver context block', () => {
    const pack = buildWorkflowAnalystFeedbackPack({
      envelope,
      generatedAt: '2026-06-01T00:00:02.000Z',
    })

    expect(renderWorkflowFeedbackPack(pack)).toContain('Workflow feedback pack for wf-1')
    expect(renderWorkflowFeedbackPack(pack, { maxChars: 12 })).toHaveLength(12)
  })
})
