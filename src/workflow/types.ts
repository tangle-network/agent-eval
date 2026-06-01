import type { WorkflowTopology } from '../harness-optimizer'
import type { RunSplitTag, RunTokenUsage } from '../run-record'

export type { WorkflowTopology }

export type WorkflowTraceVersion = 'workflow-trace-v1'

export type WorkflowTraceEventKind =
  | 'workflow.started'
  | 'workflow.phase'
  | 'workflow.log'
  | 'workflow.parallel.started'
  | 'workflow.parallel.ended'
  | 'workflow.pipeline.started'
  | 'workflow.pipeline.ended'
  | 'workflow.agent.started'
  | 'workflow.agent.ended'
  | 'workflow.loop.started'
  | 'workflow.loop.ended'
  | 'workflow.verifier.started'
  | 'workflow.verifier.ended'
  | 'workflow.analyst.started'
  | 'workflow.analyst.ended'
  | 'workflow.reviewer.started'
  | 'workflow.reviewer.ended'
  | 'workflow.failed'
  | 'workflow.ended'

export interface WorkflowTraceEvent {
  kind: WorkflowTraceEventKind | (string & {})
  runId: string
  timestamp: number
  payload: Record<string, unknown>
}

export interface WorkflowTraceArtifact {
  kind: string
  uri: string
  contentType?: string
  sha256?: string
  metadata?: Record<string, unknown>
}

export interface WorkflowTraceEnvelope {
  traceVersion: WorkflowTraceVersion
  runId: string
  topology?: WorkflowTopology
  events: WorkflowTraceEvent[]
  artifacts?: WorkflowTraceArtifact[]
  metadata?: Record<string, unknown>
}

export interface WorkflowTraceSummary {
  runId: string
  startedAt?: number
  endedAt?: number
  durationMs: number
  costUsd: number
  tokenUsage: RunTokenUsage
  phaseCount: number
  agentCalls: number
  loopCalls: number
  verifierCalls: number
  analystCalls: number
  reviewerCalls: number
  eventCount: number
  failed: boolean
  failureMessage?: string
}

export interface WorkflowTraceProjectionMetadata {
  experimentId: string
  candidateId: string
  seed: number
  model: string
  promptHash: string
  configHash: string
  commitSha: string
  splitTag: RunSplitTag
  scenarioId?: string
}
