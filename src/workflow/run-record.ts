import { type RunRecord, validateRunRecord } from '../run-record'
import { summarizeWorkflowTrace, validateWorkflowTraceEnvelope } from './schema'
import type { WorkflowTraceEnvelope, WorkflowTraceProjectionMetadata } from './types'

export interface WorkflowTraceRunRecordOptions extends WorkflowTraceProjectionMetadata {
  runId?: string
  score?: number
  raw?: Record<string, number>
  failureMode?: string
  judgeMetadata?: RunRecord['judgeMetadata']
  agentProfile?: RunRecord['agentProfile']
}

export function workflowTraceToRunRecord(
  input: WorkflowTraceEnvelope | unknown,
  options: WorkflowTraceRunRecordOptions,
): RunRecord {
  const envelope = validateWorkflowTraceEnvelope(input)
  const summary = summarizeWorkflowTrace(envelope)
  const score = clampScore(options.score ?? (summary.failed ? 0 : 1))
  const raw = {
    ...finiteOnly(options.raw ?? {}),
    score,
    workflow_failed: summary.failed ? 1 : 0,
    workflow_events: summary.eventCount,
    workflow_phases: summary.phaseCount,
    workflow_branches: summary.branchCount,
    workflow_branch_failures: summary.failedBranchCount,
    workflow_agent_calls: summary.agentCalls,
    workflow_loop_calls: summary.loopCalls,
    workflow_verifier_calls: summary.verifierCalls,
    workflow_analyst_calls: summary.analystCalls,
    workflow_reviewer_calls: summary.reviewerCalls,
  }
  const outcome =
    options.splitTag === 'holdout' ? { holdoutScore: score, raw } : { searchScore: score, raw }

  return validateRunRecord({
    runId: options.runId ?? envelope.runId,
    experimentId: options.experimentId,
    candidateId: options.candidateId,
    seed: options.seed,
    model: options.model,
    promptHash: options.promptHash,
    configHash: options.configHash,
    commitSha: options.commitSha,
    wallMs: summary.durationMs,
    costUsd: summary.costUsd,
    tokenUsage: summary.tokenUsage,
    ...(options.judgeMetadata ? { judgeMetadata: options.judgeMetadata } : {}),
    outcome,
    failureMode: options.failureMode ?? (summary.failed ? 'workflow_failed' : undefined),
    splitTag: options.splitTag,
    ...(options.scenarioId ? { scenarioId: options.scenarioId } : {}),
    ...(options.agentProfile ? { agentProfile: options.agentProfile } : {}),
  })
}

function finiteOnly(values: Record<string, number>): Record<string, number> {
  const out: Record<string, number> = {}
  for (const [key, value] of Object.entries(values)) {
    if (Number.isFinite(value)) out[key] = value
  }
  return out
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(1, value))
}
