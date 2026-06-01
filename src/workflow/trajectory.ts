import type { DatasetSplit } from '../dataset'
import type { FeedbackAttempt, FeedbackTrajectory } from '../feedback-trajectory'
import { summarizeWorkflowTrace, validateWorkflowTraceEnvelope } from './schema'
import type { WorkflowTraceEnvelope, WorkflowTraceEvent } from './types'

export interface WorkflowTraceTrajectoryOptions {
  projectId?: string
  scenarioId?: string
  task: string
  split?: DatasetSplit
  tags?: Record<string, string>
  score?: number
  success?: boolean
  metadata?: Record<string, unknown>
}

export function workflowTraceToFeedbackTrajectory(
  input: WorkflowTraceEnvelope | unknown,
  options: WorkflowTraceTrajectoryOptions,
): FeedbackTrajectory {
  const envelope = validateWorkflowTraceEnvelope(input)
  const summary = summarizeWorkflowTrace(envelope)
  const createdAt = iso(envelope.events[0]?.timestamp)
  const updatedAt = iso(envelope.events.at(-1)?.timestamp)
  return {
    id: envelope.runId,
    projectId: options.projectId,
    scenarioId: options.scenarioId,
    task: {
      intent: options.task,
      context: {
        topology: envelope.topology,
        metadata: envelope.metadata,
      },
    },
    attempts: workflowEventsToAttempts(envelope.events),
    labels: [],
    outcome: {
      success: options.success ?? !summary.failed,
      score: options.score,
      costUsd: summary.costUsd,
      observedAt: updatedAt,
      detail: summary.failureMessage,
      metrics: {
        workflow_events: summary.eventCount,
        workflow_phases: summary.phaseCount,
        workflow_branches: summary.branchCount,
        workflow_branch_failures: summary.failedBranchCount,
        workflow_agent_calls: summary.agentCalls,
        workflow_loop_calls: summary.loopCalls,
        workflow_verifier_calls: summary.verifierCalls,
        workflow_analyst_calls: summary.analystCalls,
        workflow_reviewer_calls: summary.reviewerCalls,
        workflow_agent_failures: summary.agentFailures,
        workflow_loop_failures: summary.loopFailures,
        workflow_verifier_failures: summary.verifierFailures,
        workflow_analyst_failures: summary.analystFailures,
        workflow_reviewer_failures: summary.reviewerFailures,
        workflow_tokens_input: summary.tokenUsage.input,
        workflow_tokens_output: summary.tokenUsage.output,
      },
      metadata: {
        durationMs: summary.durationMs,
        ...(options.metadata ?? {}),
      },
    },
    split: options.split,
    tags: options.tags,
    createdAt,
    updatedAt,
    metadata: {
      traceVersion: envelope.traceVersion,
      artifacts: envelope.artifacts,
    },
  }
}

function workflowEventsToAttempts(events: readonly WorkflowTraceEvent[]): FeedbackAttempt[] {
  const attempts: FeedbackAttempt[] = []
  for (const event of events) {
    const artifactType = artifactTypeForWorkflowEvent(event.kind)
    if (!artifactType) continue
    const stepIndex = attempts.length
    attempts.push({
      id: `${event.runId}:${stepIndex}`,
      stepIndex,
      artifactType,
      artifact: event.payload.trace ?? event.payload,
      createdAt: iso(event.timestamp),
      metadata: {
        eventKind: event.kind,
        label: event.payload.label,
        phase: event.payload.phase,
        costUsd: event.payload.costUsd,
        tokenUsage: event.payload.tokenUsage,
        ...(event.kind.endsWith('.failed')
          ? { failed: true, message: event.payload.message, code: event.payload.code }
          : {}),
      },
    })
  }
  return attempts
}

function artifactTypeForWorkflowEvent(
  kind: WorkflowTraceEvent['kind'],
): FeedbackAttempt['artifactType'] | null {
  switch (kind) {
    case 'workflow.agent.ended':
    case 'workflow.agent.failed':
      return 'action'
    case 'workflow.analyst.ended':
    case 'workflow.analyst.failed':
      return 'data'
    case 'workflow.loop.ended':
    case 'workflow.verifier.ended':
    case 'workflow.reviewer.ended':
    case 'workflow.loop.failed':
    case 'workflow.verifier.failed':
    case 'workflow.reviewer.failed':
      return 'decision'
    default:
      return null
  }
}

function iso(timestamp: number | undefined): string {
  return new Date(Number.isFinite(timestamp) ? timestamp! : 0).toISOString()
}
