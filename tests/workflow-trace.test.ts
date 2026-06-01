import { describe, expect, it } from 'vitest'
import { makeFinding } from '../src/analyst/types'
import type { VerificationReport } from '../src/multi-layer-verifier'
import type { FailureClusterReport } from '../src/pipelines'
import type { RunRecord } from '../src/run-record'
import {
  buildWorkflowAnalystFeedbackPack,
  buildWorkflowPartnerReport,
  buildWorkflowTraceIntelligenceEnvelope,
  decideWorkflowDriverPromotion,
  renderWorkflowFeedbackPack,
  renderWorkflowPartnerReport,
  sanitizeWorkflowTraceEnvelope,
  summarizeWorkflowExecution,
  summarizeWorkflowTrace,
  validateWorkflowTraceEnvelope,
  validateWorkflowTraceIntelligenceEnvelope,
  type WorkflowTraceEnvelope,
  workflowEventsToTraceEnvelope,
  workflowRuntimeResultToTraceEnvelope,
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
    {
      kind: 'workflow.started',
      runId: 'wf-1',
      timestamp: 1000,
      payload: {
        meta: { name: 'driver-authored', description: 'Runtime-generated workflow' },
        depth: 0,
        caps: { maxFanout: 2, maxDepth: 1 },
      },
    },
    { kind: 'workflow.phase', runId: 'wf-1', timestamp: 1010, payload: { title: 'Plan' } },
    {
      kind: 'workflow.branch.started',
      runId: 'wf-1',
      timestamp: 1020,
      payload: { operation: 'parallel', branchIndex: 0, phase: 'Plan' },
    },
    {
      kind: 'workflow.agent.ended',
      runId: 'wf-1',
      timestamp: 1200,
      payload: {
        index: 0,
        label: 'planner',
        phase: 'Plan',
        durationMs: 180,
        costUsd: 0.01,
        tokenUsage: { input: 10, output: 20 },
        trace: { text: 'plan' },
      },
    },
    {
      kind: 'workflow.branch.ended',
      runId: 'wf-1',
      timestamp: 1210,
      payload: { operation: 'parallel', branchIndex: 0, durationMs: 190, phase: 'Plan' },
    },
    {
      kind: 'workflow.loop.ended',
      runId: 'wf-1',
      timestamp: 1500,
      payload: {
        index: 0,
        label: 'implement',
        durationMs: 250,
        costUsd: 0.02,
        tokenUsage: { input: 30, output: 40 },
        trace: { winner: 1 },
      },
    },
    {
      kind: 'workflow.verifier.ended',
      runId: 'wf-1',
      timestamp: 1550,
      payload: {
        index: 0,
        label: 'acceptance',
        durationMs: 20,
        costUsd: 0,
        tokenUsage: { input: 0, output: 0 },
        trace: { checkpointOutput: { allPass: true } },
      },
    },
    {
      kind: 'workflow.analyst.ended',
      runId: 'wf-1',
      timestamp: 1560,
      payload: {
        index: 0,
        label: 'trace-analyst',
        durationMs: 10,
        costUsd: 0,
        tokenUsage: { input: 0, output: 0 },
        trace: { output: { findings: [] } },
      },
    },
    {
      kind: 'workflow.reviewer.ended',
      runId: 'wf-1',
      timestamp: 1570,
      payload: {
        index: 0,
        label: 'next-shot',
        durationMs: 10,
        costUsd: 0,
        tokenUsage: { input: 0, output: 0 },
        trace: { shouldContinue: false },
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

function workflowRunRecord(args: {
  candidateId: string
  scenarioId?: string
  seed: number
  score: number
  costUsd?: number
}): RunRecord {
  return {
    runId: `${args.candidateId}-${args.scenarioId ?? 'missing'}-${args.seed}`,
    experimentId: 'workflow-driver-promotion',
    candidateId: args.candidateId,
    seed: args.seed,
    model: 'claude-sonnet-4-6@2025-04-15',
    promptHash: 'p'.repeat(64),
    configHash: 'c'.repeat(64),
    commitSha: 'cafebabe',
    wallMs: 1000,
    costUsd: args.costUsd ?? 0.01,
    tokenUsage: { input: 10, output: 5 },
    outcome: {
      holdoutScore: args.score,
      raw: { workflow_driver_score: args.score },
    },
    splitTag: 'holdout',
    ...(args.scenarioId ? { scenarioId: args.scenarioId } : {}),
  }
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
      branchCount: 1,
      failedBranchCount: 0,
      agentCalls: 1,
      loopCalls: 1,
      verifierCalls: 1,
      analystCalls: 1,
      reviewerCalls: 1,
      failed: false,
    })
  })

  it('summarizes failed workflow branches as first-class trace evidence', () => {
    const failedEnvelope: WorkflowTraceEnvelope = {
      traceVersion: 'workflow-trace-v1',
      runId: 'wf-failed-branch',
      events: [
        {
          kind: 'workflow.started',
          runId: 'wf-failed-branch',
          timestamp: 1,
          payload: {
            meta: { name: 'failed-branch', description: 'Failed branch trace' },
            depth: 0,
            caps: { maxFanout: 1, maxDepth: 1 },
          },
        },
        {
          kind: 'workflow.branch.started',
          runId: 'wf-failed-branch',
          timestamp: 2,
          payload: { operation: 'parallel', branchIndex: 0, phase: 'Build' },
        },
        {
          kind: 'workflow.branch.failed',
          runId: 'wf-failed-branch',
          timestamp: 3,
          payload: {
            operation: 'parallel',
            branchIndex: 0,
            phase: 'Build',
            durationMs: 1,
            message: 'worker failed',
          },
        },
        {
          kind: 'workflow.failed',
          runId: 'wf-failed-branch',
          timestamp: 4,
          payload: { message: 'worker failed', phase: 'Build' },
        },
      ],
    }

    const summary = summarizeWorkflowTrace(failedEnvelope)
    expect(summary.branchCount).toBe(0)
    expect(summary.failedBranchCount).toBe(1)
    expect(summary.failed).toBe(true)

    const executionSummary = summarizeWorkflowExecution(failedEnvelope)
    expect(executionSummary.phaseGraph.nodes[0]).toMatchObject({
      title: 'Build',
      eventCount: 3,
      failedBranchCount: 1,
    })
    expect(executionSummary.phaseGraph.branches[0]).toMatchObject({
      operation: 'parallel',
      branchIndex: 0,
      phase: 'Build',
      status: 'failed',
      durationMs: 1,
      message: 'worker failed',
    })

    const record = workflowTraceToRunRecord(failedEnvelope, projection)
    expect(record.outcome.searchScore).toBe(0)
    expect(record.outcome.raw.workflow_branch_failures).toBe(1)
  })

  it('builds rich execution summaries from runtime workflow events', () => {
    const summary = summarizeWorkflowExecution(envelope, { source: 'export const meta = {}' })

    expect(summary.source).toBe('export const meta = {}')
    expect(summary.eventKinds).toMatchObject({
      'workflow.started': 1,
      'workflow.phase': 1,
      'workflow.branch.started': 1,
      'workflow.branch.ended': 1,
      'workflow.agent.ended': 1,
      'workflow.verifier.ended': 1,
      'workflow.ended': 1,
    })
    expect(summary.phases).toEqual(['Plan'])
    expect(summary.phaseGraph.nodes[0]).toMatchObject({
      id: 'phase-0',
      title: 'Plan',
      startedAt: 1010,
      endedAt: 1210,
      eventCount: 4,
      branchCount: 1,
      failedBranchCount: 0,
      agentCalls: 1,
      loopCalls: 0,
      costUsd: 0.01,
      tokenUsage: { input: 10, output: 20 },
    })
    expect(summary.phaseGraph.branches[0]).toMatchObject({
      id: 'branch-0',
      operation: 'parallel',
      branchIndex: 0,
      phase: 'Plan',
      status: 'ended',
      startedAt: 1020,
      endedAt: 1210,
      durationMs: 190,
    })
    expect(summary.agentRuns[0]).toMatchObject({
      index: 0,
      label: 'planner',
      phase: 'Plan',
      costUsd: 0.01,
      tokenUsage: { input: 10, output: 20 },
      trace: { text: 'plan' },
    })
    expect(summary.loopRuns[0]).toMatchObject({
      index: 0,
      label: 'implement',
      costUsd: 0.02,
    })
    expect(summary.verifierOutputs[0]?.output).toEqual({ allPass: true })
    expect(summary.analystOutputs[0]?.output).toEqual({ findings: [] })
    expect(summary.reviewerOutputs[0]?.output).toEqual({ shouldContinue: false })
  })

  it('projects workflow traces into canonical RunRecords', () => {
    const record = workflowTraceToRunRecord(envelope, { ...projection, score: 0.82 })
    expect(record.runId).toBe('wf-1')
    expect(record.candidateId).toBe('workflow-driver-v1')
    expect(record.outcome.searchScore).toBe(0.82)
    expect(record.outcome.raw.workflow_agent_calls).toBe(1)
    expect(record.outcome.raw.workflow_branches).toBe(1)
    expect(record.outcome.raw.workflow_branch_failures).toBe(0)
    expect(record.outcome.raw.workflow_loop_calls).toBe(1)
    expect(record.outcome.raw.workflow_verifier_calls).toBe(1)
    expect(record.outcome.raw.workflow_analyst_calls).toBe(1)
    expect(record.outcome.raw.workflow_reviewer_calls).toBe(1)
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
    expect(trajectory.attempts).toHaveLength(5)
    expect(trajectory.attempts.map((a) => a.artifactType)).toEqual([
      'action',
      'decision',
      'decision',
      'data',
      'decision',
    ])
    expect(trajectory.outcome?.metrics?.workflow_tokens_output).toBe(60)
    expect(trajectory.outcome?.metrics?.workflow_branches).toBe(1)
    expect(trajectory.outcome?.metrics?.workflow_branch_failures).toBe(0)
    expect(trajectory.outcome?.metrics?.workflow_analyst_calls).toBe(1)
    expect(trajectory.tags?.driver).toBe('workflow-driver-v1')
  })

  it('wraps agent-runtime WorkflowResult objects into eval trace envelopes', () => {
    const runtimeResult = {
      runId: envelope.runId,
      meta: { name: 'driver-authored', description: 'Runtime-generated workflow' },
      output: { files: ['src/App.tsx'] },
      events: envelope.events,
    }

    const wrapped = workflowRuntimeResultToTraceEnvelope(runtimeResult, {
      topology: envelope.topology,
      metadata: { productId: 'blueprint-agent' },
    })
    const record = workflowTraceToRunRecord(wrapped, projection)

    expect(wrapped.traceVersion).toBe('workflow-trace-v1')
    expect(wrapped.metadata).toMatchObject({
      productId: 'blueprint-agent',
      runtimeResult: { meta: runtimeResult.meta },
    })
    expect(JSON.stringify(wrapped.metadata)).not.toContain('src/App.tsx')
    expect(record.outcome.searchScore).toBe(1)
  })

  it('wraps emitted runtime events from failed workflows without needing a WorkflowResult', () => {
    const failed = workflowEventsToTraceEnvelope([
      {
        kind: 'workflow.started',
        runId: 'wf-failed',
        timestamp: 1000,
        payload: {
          meta: { name: 'failed-workflow', description: 'Failed workflow trace' },
          depth: 0,
          caps: { maxFanout: 1, maxDepth: 1 },
        },
      },
      {
        kind: 'workflow.failed',
        runId: 'wf-failed',
        timestamp: 1100,
        payload: { message: 'worker exhausted its budget' },
      },
    ])

    expect(summarizeWorkflowTrace(failed)).toMatchObject({
      runId: 'wf-failed',
      durationMs: 100,
      failed: true,
      failureMessage: 'worker exhausted its budget',
    })
    expect(workflowTraceToRunRecord(failed, projection).failureMode).toBe('workflow_failed')
  })

  it('rejects events from mixed run ids', () => {
    expect(() =>
      validateWorkflowTraceEnvelope({
        ...envelope,
        events: [
          ...envelope.events,
          {
            kind: 'workflow.log',
            runId: 'other',
            timestamp: 1700,
            payload: { message: 'other run' },
          },
        ],
      }),
    ).toThrow(/does not match/)
  })

  it('rejects non-canonical workflow event kinds', () => {
    expect(() =>
      validateWorkflowTraceEnvelope({
        ...envelope,
        events: envelope.events.map((event, index) =>
          index === 3 ? { ...event, kind: 'workflow.agent.done' } : event,
        ),
      }),
    ).toThrow(/unknown workflow trace event kind/)
  })

  it('rejects malformed typed workflow event payloads', () => {
    expect(() =>
      validateWorkflowTraceEnvelope({
        ...envelope,
        events: envelope.events.map((event, index) =>
          index === 3
            ? {
                ...event,
                payload: {
                  ...event.payload,
                  costUsd: -1,
                },
              }
            : event,
        ),
      }),
    ).toThrow(/workflow\.agent\.ended\.payload\.costUsd/)
  })

  it('rejects workflow events emitted after terminal completion', () => {
    expect(() =>
      validateWorkflowTraceEnvelope({
        ...envelope,
        events: [
          ...envelope.events,
          {
            kind: 'workflow.log',
            runId: 'wf-1',
            timestamp: 1700,
            payload: { message: 'late log' },
          },
        ],
      }),
    ).toThrow(/terminal event must be last/)
  })

  it('rejects empty emitted runtime event buffers', () => {
    expect(() => workflowEventsToTraceEnvelope([])).toThrow(/non-empty array/)
  })

  it('builds a bounded analyst feedback pack for the next workflow driver shot', () => {
    const feedbackEnvelope: WorkflowTraceEnvelope = {
      ...envelope,
      events: [
        ...envelope.events.slice(0, 3),
        {
          kind: 'workflow.agent.ended',
          runId: 'wf-1',
          timestamp: 1190,
          payload: {
            index: 1,
            label: 'implementation',
            durationMs: 90,
            costUsd: 0,
            tokenUsage: { input: 0, output: 0 },
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

  it('sanitizes workflow traces for intelligence export without losing clustering evidence', () => {
    const sensitiveEnvelope: WorkflowTraceEnvelope = {
      ...envelope,
      events: [
        ...envelope.events.slice(0, 2),
        {
          kind: 'workflow.agent.ended',
          runId: 'wf-1',
          timestamp: 1200,
          payload: {
            index: 1,
            label: 'implementation',
            durationMs: 90,
            costUsd: 0,
            tokenUsage: { input: 0, output: 0 },
            apiKey: 'sk-test-secret-value',
            toolArgs: { prompt: 'Use Bearer abcdefghijklmnop', count: 2 },
            filePath: 'src/App.tsx',
            content: 'const apiKey = "sk-another-secret-value"',
          },
        },
        ...envelope.events.slice(3),
      ],
      artifacts: [
        {
          kind: 'source-file',
          uri: 'artifact://src/App.tsx',
          metadata: {
            path: 'src/App.tsx',
            contents: 'export const secret = "sk-file-secret-value"',
          },
        },
      ],
    }

    const sanitized = sanitizeWorkflowTraceEnvelope(sensitiveEnvelope, { hashSalt: 'test' })

    const agentPayload = sanitized.envelope.events[2]?.payload as Record<string, unknown>
    expect(agentPayload.apiKey).toBe('[redacted:apiKey]')
    expect(agentPayload.toolArgs).toMatchObject({ redacted: true, shape: { type: 'object' } })
    expect(agentPayload.content).toMatchObject({ redacted: true, shape: { type: 'string' } })
    expect(JSON.stringify(sanitized.envelope)).not.toContain('sk-test-secret-value')
    expect(JSON.stringify(sanitized.envelope)).not.toContain('sk-file-secret-value')
    expect(sanitized.report.hashedArgs).toBe(1)
    expect(sanitized.report.droppedArtifactContents).toBe(2)
    expect(sanitized.report.droppedPayloadKeys.apiKey).toBe(1)
  })

  it('builds a grant-gated intelligence export envelope from the sanitized workflow trace', () => {
    const sensitiveEnvelope: WorkflowTraceEnvelope = {
      ...envelope,
      metadata: {
        requestId: 'req-1',
        authorization: 'Bearer metadata-secret-token',
      },
      events: [
        ...envelope.events.slice(0, 2),
        {
          kind: 'workflow.agent.ended',
          runId: 'wf-1',
          timestamp: 1200,
          payload: {
            index: 1,
            label: 'implementation',
            durationMs: 90,
            costUsd: 0,
            tokenUsage: { input: 0, output: 0 },
            apiKey: 'sk-test-secret-value',
            toolCalls: [
              {
                toolName: 'write_file',
                toolArgs: { path: 'src/App.tsx', content: 'const key = "sk-tool-secret-value"' },
                status: 'ok',
              },
            ],
            filePath: 'src/App.tsx',
            content: 'const apiKey = "sk-file-secret-value"',
          },
        },
        ...envelope.events.slice(3),
      ],
      artifacts: [
        {
          kind: 'source-file',
          uri: 'artifact://src/App.tsx',
          sha256: 'a'.repeat(64),
          metadata: {
            path: 'src/App.tsx',
            contents: 'export const secret = "sk-artifact-secret-value"',
          },
        },
      ],
    }

    expect(() =>
      buildWorkflowTraceIntelligenceEnvelope({
        envelope: sensitiveEnvelope,
        productId: 'blueprint-agent',
        grants: [],
      }),
    ).toThrow(/requires at least one opt-in grant/)

    const exported = buildWorkflowTraceIntelligenceEnvelope({
      envelope: sensitiveEnvelope,
      productId: 'blueprint-agent',
      partnerId: 'partner-acme',
      generatedAt: '2026-06-01T00:00:03.000Z',
      grants: [
        {
          grantId: 'grant-product-export',
          subject: 'product',
          subjectId: 'blueprint-agent',
          scopes: ['workflow-trace:export'],
          grantedAt: '2026-06-01T00:00:00.000Z',
        },
      ],
      sanitize: { hashSalt: 'intelligence-test' },
      links: {
        traceArtifactUri: 'artifact://wf-1/trace.json',
        exportBundleUri: 'artifact://wf-1/export-bundle.json',
        partnerReportUri: 'artifact://wf-1/partner-report.md',
      },
      metadata: {
        route: 'vb.workflow-driver-v1',
        cookie: 'session=secret',
      },
    })

    expect(validateWorkflowTraceIntelligenceEnvelope(exported).schemaVersion).toBe(
      'workflow-trace-intelligence-envelope-v1',
    )
    expect(exported.destination).toBe('intelligence.tangle.tools')
    expect(exported.grantIds).toEqual(['grant-product-export'])
    expect(exported.summary.agentRuns[0]?.label).toBe('implementation')
    expect(exported.compactEvidence.toolNames).toEqual(['write_file'])
    expect(exported.compactEvidence.artifacts[0]).toMatchObject({
      kind: 'source-file',
      uri: 'artifact://src/App.tsx',
      sha256: 'a'.repeat(64),
    })
    expect(exported.compactEvidence.redactedHashes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: 'events[2].payload.toolCalls[0].toolArgs',
          shape: { type: 'object', keys: ['content', 'path'] },
        }),
        expect.objectContaining({
          path: 'events[2].payload.content',
          shape: { type: 'string' },
        }),
        expect.objectContaining({
          path: 'artifacts[0].metadata.contents',
          shape: { type: 'string' },
        }),
      ]),
    )
    expect(exported.links?.exportBundleUri).toBe('artifact://wf-1/export-bundle.json')
    const serialized = JSON.stringify(exported)
    expect(serialized).not.toContain('sk-test-secret-value')
    expect(serialized).not.toContain('sk-tool-secret-value')
    expect(serialized).not.toContain('sk-file-secret-value')
    expect(serialized).not.toContain('sk-artifact-secret-value')
    expect(serialized).not.toContain('metadata-secret-token')
    expect(serialized).not.toContain('session=secret')
    expect(exported.sanitization.hashedArgs).toBe(1)
    expect(exported.sanitization.droppedArtifactContents).toBeGreaterThanOrEqual(2)

    const tampered = structuredClone(exported)
    tampered.compactEvidence.toolNames = []
    expect(() => validateWorkflowTraceIntelligenceEnvelope(tampered)).toThrow(
      /compactEvidence.toolNames/,
    )
  })

  it('builds a partner-facing workflow report with sanitized trace, RL trajectory, and PR-ready findings', () => {
    const docsFinding = makeFinding({
      analyst_id: 'knowledge-gap',
      severity: 'high',
      area: 'api-docs',
      claim: 'The generated app guessed an SDK method that is missing from the partner docs',
      confidence: 0.88,
      evidence_refs: [{ kind: 'event', uri: 'workflow://wf-1/analyst' }],
      recommended_action: 'Open a docs PR adding the SDK method and a runnable example',
      validation_plan: 'Regenerate the workflow against the updated docs',
    })

    const report = buildWorkflowPartnerReport({
      envelope,
      analystFindings: [docsFinding],
      generatedAt: '2026-06-01T00:00:02.000Z',
      trajectory: {
        projectId: 'blueprint-agent',
        scenarioId: 'scenario-1',
        task: 'Build the app',
        score: 0.82,
        tags: { driver: 'workflow-driver-v1' },
      },
      runRecord: { ...projection, score: 0.82 },
      links: {
        traceArtifactUri: 'artifact://wf-1/trace.json',
        exportBundleUri: 'artifact://wf-1/export-bundle.json',
        partnerReportUri: 'artifact://wf-1/partner-report.md',
      },
    })

    expect(report.schemaVersion).toBe('workflow-partner-report-v1')
    expect(report.docsApiGaps[0]?.claim).toContain('partner docs')
    expect(report.prReadyFindings[0]?.recommendedAction).toContain('docs PR')
    expect(report.links?.traceArtifactUri).toBe('artifact://wf-1/trace.json')
    expect(report.links?.exportBundleUri).toBe('artifact://wf-1/export-bundle.json')
    expect(report.exportBundle.trajectory.attempts).toHaveLength(5)
    expect(report.exportBundle.runRecord?.outcome.searchScore).toBe(0.82)
    expect(renderWorkflowPartnerReport(report)).toContain('Docs/API gaps')
  })

  it('gates workflow-driver promotion against reviewer-loop baseline on paired heldout scenarios', () => {
    const records = ['auction', 'dex', 'payroll'].flatMap((scenarioId) => [
      workflowRunRecord({
        candidateId: 'reviewer-loop-v1',
        scenarioId,
        seed: 7,
        score: 0.6,
      }),
      workflowRunRecord({
        candidateId: 'workflow-driver-v1',
        scenarioId,
        seed: 7,
        score: 0.82,
      }),
    ])
    records.push(
      workflowRunRecord({
        candidateId: 'reviewer-loop-v1',
        scenarioId: 'out-of-scope',
        seed: 7,
        score: 1,
      }),
      workflowRunRecord({
        candidateId: 'workflow-driver-v1',
        scenarioId: 'out-of-scope',
        seed: 7,
        score: 0,
      }),
    )

    const decision = decideWorkflowDriverPromotion({
      records,
      expectedScenarioIds: ['auction', 'dex', 'payroll'],
      minPairedHoldoutRuns: 3,
      resamples: 200,
      seed: 1,
      generatedAt: '2026-06-01T00:00:04.000Z',
    })

    expect(decision.schemaVersion).toBe('workflow-driver-promotion-v1')
    expect(decision.promote).toBe(true)
    expect(decision.rejectionCode).toBeNull()
    expect(decision.baselineStrategyId).toBe('reviewer-loop-v1')
    expect(decision.candidateStrategyId).toBe('workflow-driver-v1')
    expect(decision.evidence.pairedRuns).toBe(3)
    expect(decision.evidence.pairedScenarioIds).toEqual(['auction', 'dex', 'payroll'])
    expect(decision.evidence.lift).toBeCloseTo(0.22, 6)
    expect(decision.evidence.liftCi.low).toBeGreaterThan(0)
    expect(decision.evidence.pairs.map((pair) => pair.key)).toEqual([
      'auction::7',
      'dex::7',
      'payroll::7',
    ])
  })

  it('fails closed when a workflow promotion gate is missing a heldout scenario pair', () => {
    const decision = decideWorkflowDriverPromotion({
      records: [
        workflowRunRecord({
          candidateId: 'reviewer-loop-v1',
          scenarioId: 'auction',
          seed: 1,
          score: 0.7,
        }),
        workflowRunRecord({
          candidateId: 'workflow-driver-v1',
          scenarioId: 'auction',
          seed: 1,
          score: 0.9,
        }),
        workflowRunRecord({
          candidateId: 'reviewer-loop-v1',
          scenarioId: 'dex',
          seed: 1,
          score: 0.7,
        }),
      ],
      expectedScenarioIds: ['auction', 'dex'],
      minPairedHoldoutRuns: 2,
      resamples: 50,
      seed: 2,
    })

    expect(decision.promote).toBe(false)
    expect(decision.rejectionCode).toBe('missing_holdout_pairs')
    expect(decision.evidence.missingScenarioIds).toEqual(['dex'])
    expect(decision.reason).toContain('no paired baseline/candidate holdout record')
  })

  it('rejects workflow promotion records without scenarioId instead of pairing by seed only', () => {
    expect(() =>
      decideWorkflowDriverPromotion({
        records: [
          workflowRunRecord({ candidateId: 'reviewer-loop-v1', seed: 1, score: 0.7 }),
          workflowRunRecord({ candidateId: 'workflow-driver-v1', seed: 1, score: 0.9 }),
        ],
        minPairedHoldoutRuns: 1,
      }),
    ).toThrow(/missing scenarioId/)
  })
})
