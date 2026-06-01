import type { RunTokenUsage } from '../run-record'
import { type WorkflowPhaseGraph, workflowPhaseGraph } from './phase-graph'
import { summarizeWorkflowTrace, validateWorkflowTraceEnvelope } from './schema'
import { numberField, objectRecord, stringField, tokenUsageField } from './trace-event-fields'
import type { WorkflowTraceEnvelope, WorkflowTraceEvent, WorkflowTraceSummary } from './types'

export interface WorkflowDelegateTraceSummary {
  index: number | null
  label: string | null
  phase: string | null
  costUsd: number | null
  tokenUsage: RunTokenUsage | null
  trace: unknown
}

export interface WorkflowDelegateFailureSummary {
  index: number | null
  label: string | null
  phase: string | null
  durationMs: number | null
  message: string | null
  code: string | null
}

export interface WorkflowCheckpointTraceSummary extends WorkflowDelegateTraceSummary {
  output: unknown
}

export interface WorkflowExecutionSummary extends WorkflowTraceSummary {
  source?: string
  eventKinds: Record<string, number>
  phases: string[]
  phaseGraph: WorkflowPhaseGraph
  agentRuns: WorkflowDelegateTraceSummary[]
  loopRuns: WorkflowDelegateTraceSummary[]
  verifierOutputs: WorkflowCheckpointTraceSummary[]
  analystOutputs: WorkflowCheckpointTraceSummary[]
  reviewerOutputs: WorkflowCheckpointTraceSummary[]
  agentFailureDetails: WorkflowDelegateFailureSummary[]
  loopFailureDetails: WorkflowDelegateFailureSummary[]
  verifierFailureDetails: WorkflowDelegateFailureSummary[]
  analystFailureDetails: WorkflowDelegateFailureSummary[]
  reviewerFailureDetails: WorkflowDelegateFailureSummary[]
}

export interface SummarizeWorkflowExecutionOptions {
  source?: string
}

export function summarizeWorkflowExecution(
  input: WorkflowTraceEnvelope | unknown,
  options: SummarizeWorkflowExecutionOptions = {},
): WorkflowExecutionSummary {
  const envelope = validateWorkflowTraceEnvelope(input)
  const base = summarizeWorkflowTrace(envelope)
  return {
    ...base,
    ...(options.source !== undefined ? { source: options.source } : {}),
    eventKinds: workflowEventKinds(envelope.events),
    phases: workflowPhaseTitles(envelope.events),
    phaseGraph: workflowPhaseGraph(envelope.events),
    agentRuns: workflowDelegateTraceSummaries(envelope.events, 'workflow.agent.ended'),
    loopRuns: workflowDelegateTraceSummaries(envelope.events, 'workflow.loop.ended'),
    verifierOutputs: workflowCheckpointTraceSummaries(envelope.events, 'workflow.verifier.ended'),
    analystOutputs: workflowCheckpointTraceSummaries(envelope.events, 'workflow.analyst.ended'),
    reviewerOutputs: workflowCheckpointTraceSummaries(envelope.events, 'workflow.reviewer.ended'),
    agentFailureDetails: workflowDelegateFailureSummaries(envelope.events, 'workflow.agent.failed'),
    loopFailureDetails: workflowDelegateFailureSummaries(envelope.events, 'workflow.loop.failed'),
    verifierFailureDetails: workflowDelegateFailureSummaries(
      envelope.events,
      'workflow.verifier.failed',
    ),
    analystFailureDetails: workflowDelegateFailureSummaries(
      envelope.events,
      'workflow.analyst.failed',
    ),
    reviewerFailureDetails: workflowDelegateFailureSummaries(
      envelope.events,
      'workflow.reviewer.failed',
    ),
  }
}

function workflowEventKinds(events: readonly WorkflowTraceEvent[]): Record<string, number> {
  return events.reduce<Record<string, number>>((acc, event) => {
    acc[event.kind] = (acc[event.kind] ?? 0) + 1
    return acc
  }, {})
}

function workflowPhaseTitles(events: readonly WorkflowTraceEvent[]): string[] {
  const titles: string[] = []
  const seen = new Set<string>()
  for (const event of events) {
    const title =
      event.kind === 'workflow.phase'
        ? stringField(event.payload, 'title')
        : stringField(event.payload, 'phase')
    if (!title || seen.has(title)) continue
    seen.add(title)
    titles.push(title)
  }
  return titles
}

function workflowDelegateTraceSummaries(
  events: readonly WorkflowTraceEvent[],
  endedKind: WorkflowTraceEvent['kind'],
): WorkflowDelegateTraceSummary[] {
  return events
    .filter((event) => event.kind === endedKind)
    .map((event) => ({
      index: numberField(event.payload, 'index'),
      label: stringField(event.payload, 'label'),
      phase: stringField(event.payload, 'phase'),
      costUsd: numberField(event.payload, 'costUsd'),
      tokenUsage: tokenUsageField(event.payload.tokenUsage),
      trace: event.payload.trace ?? null,
    }))
}

function workflowCheckpointTraceSummaries(
  events: readonly WorkflowTraceEvent[],
  endedKind: WorkflowTraceEvent['kind'],
): WorkflowCheckpointTraceSummary[] {
  return workflowDelegateTraceSummaries(events, endedKind).map((summary) => ({
    ...summary,
    output: checkpointOutput(summary.trace),
  }))
}

function workflowDelegateFailureSummaries(
  events: readonly WorkflowTraceEvent[],
  failedKind: WorkflowTraceEvent['kind'],
): WorkflowDelegateFailureSummary[] {
  return events
    .filter((event) => event.kind === failedKind)
    .map((event) => ({
      index: numberField(event.payload, 'index'),
      label: stringField(event.payload, 'label'),
      phase: stringField(event.payload, 'phase'),
      durationMs: numberField(event.payload, 'durationMs'),
      message: stringField(event.payload, 'message'),
      code: stringField(event.payload, 'code'),
    }))
}

function checkpointOutput(trace: unknown): unknown {
  const record = objectRecord(trace)
  if (record && Object.hasOwn(record, 'checkpointOutput')) {
    return record.checkpointOutput
  }
  if (record && Object.hasOwn(record, 'output')) return record.output
  return trace
}
