import { ValidationError } from '../errors'
import { validateWorkflowTraceEventKind, validateWorkflowTraceEventPayload } from './event-schema'
import type {
  WorkflowTraceEnvelope,
  WorkflowTraceEvent,
  WorkflowTraceSummary,
  WorkflowTraceVersion,
} from './types'

const TRACE_VERSION: WorkflowTraceVersion = 'workflow-trace-v1'

export function validateWorkflowTraceEvent(input: unknown): WorkflowTraceEvent {
  const obj = expectRecord(input, 'event')
  const kind = validateWorkflowTraceEventKind(expectString(obj.kind, 'event.kind'))
  const runId = expectString(obj.runId, 'event.runId')
  const timestamp = expectFinite(obj.timestamp, 'event.timestamp')
  const payload = validateWorkflowTraceEventPayload(
    kind,
    expectRecord(obj.payload, 'event.payload'),
  )
  return { kind, runId, timestamp, payload }
}

export function validateWorkflowTraceEnvelope(input: unknown): WorkflowTraceEnvelope {
  const obj = expectRecord(input, 'workflow trace envelope')
  if (obj.traceVersion !== TRACE_VERSION) {
    throw new ValidationError(`workflow traceVersion must be ${TRACE_VERSION}`)
  }
  const runId = expectString(obj.runId, 'workflow trace runId')
  if (!Array.isArray(obj.events) || obj.events.length === 0) {
    throw new ValidationError('workflow trace envelope must include at least one event')
  }
  const events = obj.events.map(validateWorkflowTraceEvent)
  for (const event of events) {
    if (event.runId !== runId) {
      throw new ValidationError(`workflow trace event runId ${event.runId} does not match ${runId}`)
    }
  }
  validateWorkflowTraceLifecycle(events)
  return {
    traceVersion: TRACE_VERSION,
    runId,
    ...(obj.topology !== undefined ? { topology: obj.topology as never } : {}),
    events,
    ...(obj.artifacts !== undefined ? { artifacts: validateArtifacts(obj.artifacts) } : {}),
    ...(obj.metadata !== undefined ? { metadata: expectRecord(obj.metadata, 'metadata') } : {}),
  }
}

function validateWorkflowTraceLifecycle(events: readonly WorkflowTraceEvent[]): void {
  const first = events[0]
  if (first?.kind !== 'workflow.started') {
    throw new ValidationError('workflow trace first event must be workflow.started')
  }
  for (let index = 1; index < events.length; index += 1) {
    if (events[index]!.timestamp < events[index - 1]!.timestamp) {
      throw new ValidationError(`workflow trace timestamps must be nondecreasing at event ${index}`)
    }
  }
  const terminalEvents = events.filter(
    (event) => event.kind === 'workflow.ended' || event.kind === 'workflow.failed',
  )
  if (terminalEvents.length !== 1) {
    throw new ValidationError(
      `workflow trace must include exactly one terminal event, got ${terminalEvents.length}`,
    )
  }
  const last = events.at(-1)
  if (last?.kind !== terminalEvents[0]?.kind) {
    throw new ValidationError('workflow trace terminal event must be last')
  }
}

export function summarizeWorkflowTrace(
  input: WorkflowTraceEnvelope | unknown,
): WorkflowTraceSummary {
  const envelope = validateWorkflowTraceEnvelope(input)
  const started = envelope.events.find((e) => e.kind === 'workflow.started')
  const ended = envelope.events.find((e) => e.kind === 'workflow.ended')
  const failed = envelope.events.find((e) => e.kind === 'workflow.failed')
  const endedPayload = ended?.payload ?? {}
  const tokenUsage = tokenUsageOf(endedPayload.tokenUsage)
  return {
    runId: envelope.runId,
    startedAt: started?.timestamp,
    endedAt: ended?.timestamp,
    durationMs: finiteOr(endedPayload.durationMs, durationFromEvents(envelope.events)),
    costUsd: finiteOr(endedPayload.costUsd, 0),
    tokenUsage,
    phaseCount: envelope.events.filter((e) => e.kind === 'workflow.phase').length,
    branchCount: envelope.events.filter((e) => e.kind === 'workflow.branch.ended').length,
    failedBranchCount: envelope.events.filter((e) => e.kind === 'workflow.branch.failed').length,
    agentCalls: finiteOr(
      endedPayload.agentCalls,
      envelope.events.filter((e) => e.kind === 'workflow.agent.ended').length,
    ),
    loopCalls: finiteOr(
      endedPayload.loopCalls,
      envelope.events.filter((e) => e.kind === 'workflow.loop.ended').length,
    ),
    verifierCalls: envelope.events.filter((e) => e.kind === 'workflow.verifier.ended').length,
    analystCalls: envelope.events.filter((e) => e.kind === 'workflow.analyst.ended').length,
    reviewerCalls: envelope.events.filter((e) => e.kind === 'workflow.reviewer.ended').length,
    eventCount: envelope.events.length,
    failed: failed !== undefined,
    failureMessage:
      typeof failed?.payload.message === 'string' ? failed.payload.message : undefined,
  }
}

function validateArtifacts(value: unknown): WorkflowTraceEnvelope['artifacts'] {
  if (!Array.isArray(value)) throw new ValidationError('workflow artifacts must be an array')
  return value.map((artifact, index) => {
    const obj = expectRecord(artifact, `artifacts[${index}]`)
    return {
      kind: expectString(obj.kind, `artifacts[${index}].kind`),
      uri: expectString(obj.uri, `artifacts[${index}].uri`),
      ...(obj.contentType !== undefined
        ? { contentType: expectString(obj.contentType, `artifacts[${index}].contentType`) }
        : {}),
      ...(obj.sha256 !== undefined
        ? { sha256: expectString(obj.sha256, `artifacts[${index}].sha256`) }
        : {}),
      ...(obj.metadata !== undefined
        ? { metadata: expectRecord(obj.metadata, `artifacts[${index}].metadata`) }
        : {}),
    }
  })
}

function durationFromEvents(events: readonly WorkflowTraceEvent[]): number {
  const first = events[0]?.timestamp
  const last = events.at(-1)?.timestamp
  if (!Number.isFinite(first) || !Number.isFinite(last)) return 0
  return Math.max(0, (last as number) - (first as number))
}

function tokenUsageOf(value: unknown): { input: number; output: number; cached?: number } {
  const obj = value && typeof value === 'object' ? (value as Record<string, unknown>) : {}
  const cached = finiteOrUndefined(obj.cached)
  return {
    input: finiteOr(obj.input, 0),
    output: finiteOr(obj.output, 0),
    ...(cached !== undefined ? { cached } : {}),
  }
}

function finiteOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function finiteOrUndefined(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${path}: expected object`)
  }
  return value as Record<string, unknown>
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${path}: expected non-empty string`)
  }
  return value
}

function expectFinite(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new ValidationError(`${path}: expected finite number`)
  }
  return value
}
