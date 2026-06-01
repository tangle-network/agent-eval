import { ValidationError } from '../errors'
import { validateWorkflowTraceEnvelope, validateWorkflowTraceEvent } from './schema'
import type { WorkflowTopology, WorkflowTraceArtifact, WorkflowTraceEnvelope } from './types'

export interface WorkflowTraceEnvelopeFromEventsOptions {
  runId?: string
  topology?: WorkflowTopology
  artifacts?: readonly WorkflowTraceArtifact[]
  metadata?: Record<string, unknown>
}

export interface WorkflowRuntimeResultLike {
  runId?: string
  meta?: unknown
  output?: unknown
  events: readonly unknown[]
}

export interface WorkflowRuntimeResultToTraceEnvelopeOptions
  extends Omit<WorkflowTraceEnvelopeFromEventsOptions, 'runId'> {
  runId?: string
  includeOutputInMetadata?: boolean
}

export function workflowEventsToTraceEnvelope(
  events: readonly unknown[],
  options: WorkflowTraceEnvelopeFromEventsOptions = {},
): WorkflowTraceEnvelope {
  if (!Array.isArray(events) || events.length === 0) {
    throw new ValidationError('workflow trace events must be a non-empty array')
  }
  const first = validateWorkflowTraceEvent(events[0])
  const runId = options.runId ?? first.runId
  return validateWorkflowTraceEnvelope({
    traceVersion: 'workflow-trace-v1',
    runId,
    ...(options.topology ? { topology: options.topology } : {}),
    events,
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(options.metadata ? { metadata: options.metadata } : {}),
  })
}

export function workflowRuntimeResultToTraceEnvelope(
  result: WorkflowRuntimeResultLike,
  options: WorkflowRuntimeResultToTraceEnvelopeOptions = {},
): WorkflowTraceEnvelope {
  if (!result || typeof result !== 'object') {
    throw new ValidationError('workflow runtime result must be an object')
  }
  const metadata = runtimeResultMetadata(result, options)
  return workflowEventsToTraceEnvelope(result.events, {
    runId: options.runId ?? result.runId,
    ...(options.topology ? { topology: options.topology } : {}),
    ...(options.artifacts ? { artifacts: options.artifacts } : {}),
    ...(metadata ? { metadata } : {}),
  })
}

function runtimeResultMetadata(
  result: WorkflowRuntimeResultLike,
  options: WorkflowRuntimeResultToTraceEnvelopeOptions,
): Record<string, unknown> | undefined {
  const runtimeResult: Record<string, unknown> = {}
  if (result.meta !== undefined) runtimeResult.meta = result.meta
  if (options.includeOutputInMetadata && result.output !== undefined) {
    runtimeResult.output = result.output
  }
  const hasRuntimeMetadata = Object.keys(runtimeResult).length > 0
  if (!hasRuntimeMetadata && !options.metadata) return undefined
  return {
    ...(options.metadata ?? {}),
    ...(hasRuntimeMetadata ? { runtimeResult } : {}),
  }
}
