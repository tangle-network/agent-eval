import { ValidationError } from '../errors'
import type { WorkflowTraceEventKind } from './types'

const WORKFLOW_EVENT_KINDS = [
  'workflow.started',
  'workflow.phase',
  'workflow.log',
  'workflow.parallel.started',
  'workflow.parallel.ended',
  'workflow.pipeline.started',
  'workflow.pipeline.ended',
  'workflow.branch.started',
  'workflow.branch.ended',
  'workflow.branch.failed',
  'workflow.agent.started',
  'workflow.agent.ended',
  'workflow.agent.failed',
  'workflow.loop.started',
  'workflow.loop.ended',
  'workflow.loop.failed',
  'workflow.verifier.started',
  'workflow.verifier.ended',
  'workflow.verifier.failed',
  'workflow.analyst.started',
  'workflow.analyst.ended',
  'workflow.analyst.failed',
  'workflow.reviewer.started',
  'workflow.reviewer.ended',
  'workflow.reviewer.failed',
  'workflow.failed',
  'workflow.ended',
] as const satisfies readonly WorkflowTraceEventKind[]

export const WORKFLOW_TRACE_EVENT_KINDS: readonly WorkflowTraceEventKind[] = WORKFLOW_EVENT_KINDS

const WORKFLOW_EVENT_KIND_SET = new Set<string>(WORKFLOW_EVENT_KINDS)
const BRANCH_OPERATIONS = new Set(['parallel', 'pipeline'])

export function validateWorkflowTraceEventKind(kind: string): WorkflowTraceEventKind {
  if (!WORKFLOW_EVENT_KIND_SET.has(kind)) {
    throw new ValidationError(`unknown workflow trace event kind: ${kind}`)
  }
  return kind as WorkflowTraceEventKind
}

export function validateWorkflowTraceEventPayload(
  kind: WorkflowTraceEventKind,
  payload: Record<string, unknown>,
): Record<string, unknown> {
  switch (kind) {
    case 'workflow.started':
      requireRecord(payload.meta, `${kind}.payload.meta`)
      requireInteger(payload.depth, `${kind}.payload.depth`, { min: 0 })
      requireRecord(payload.caps, `${kind}.payload.caps`)
      return payload
    case 'workflow.phase':
      requireString(payload.title, `${kind}.payload.title`)
      return payload
    case 'workflow.log':
      requireString(payload.message, `${kind}.payload.message`)
      optionalString(payload.phase, `${kind}.payload.phase`)
      return payload
    case 'workflow.parallel.started':
      requireInteger(payload.branchCount, `${kind}.payload.branchCount`, { min: 0 })
      optionalString(payload.phase, `${kind}.payload.phase`)
      return payload
    case 'workflow.parallel.ended':
      requireInteger(payload.branchCount, `${kind}.payload.branchCount`, { min: 0 })
      requireNonNegativeNumber(payload.durationMs, `${kind}.payload.durationMs`)
      optionalString(payload.phase, `${kind}.payload.phase`)
      return payload
    case 'workflow.pipeline.started':
      requireInteger(payload.itemCount, `${kind}.payload.itemCount`, { min: 0 })
      requireInteger(payload.stageCount, `${kind}.payload.stageCount`, { min: 1 })
      optionalString(payload.phase, `${kind}.payload.phase`)
      return payload
    case 'workflow.pipeline.ended':
      requireInteger(payload.itemCount, `${kind}.payload.itemCount`, { min: 0 })
      requireInteger(payload.stageCount, `${kind}.payload.stageCount`, { min: 1 })
      requireNonNegativeNumber(payload.durationMs, `${kind}.payload.durationMs`)
      optionalString(payload.phase, `${kind}.payload.phase`)
      return payload
    case 'workflow.branch.started':
      validateBranchPayload(kind, payload, { terminal: false })
      return payload
    case 'workflow.branch.ended':
      validateBranchPayload(kind, payload, { terminal: true })
      return payload
    case 'workflow.branch.failed':
      validateBranchPayload(kind, payload, { terminal: true })
      requireString(payload.message, `${kind}.payload.message`)
      optionalString(payload.code, `${kind}.payload.code`)
      if (payload.stageIndex !== undefined) {
        requireInteger(payload.stageIndex, `${kind}.payload.stageIndex`, { min: 0 })
      }
      return payload
    case 'workflow.agent.started':
      validateIndexedPayload(kind, payload)
      requireInteger(payload.promptChars, `${kind}.payload.promptChars`, { min: 0 })
      optionalRecord(payload.metadata, `${kind}.payload.metadata`)
      return payload
    case 'workflow.agent.ended':
      validateDelegateEndedPayload(kind, payload)
      return payload
    case 'workflow.agent.failed':
      validateDelegateFailedPayload(kind, payload)
      return payload
    case 'workflow.loop.started':
    case 'workflow.verifier.started':
    case 'workflow.analyst.started':
    case 'workflow.reviewer.started':
      validateIndexedPayload(kind, payload)
      optionalRecord(payload.metadata, `${kind}.payload.metadata`)
      return payload
    case 'workflow.loop.ended':
    case 'workflow.verifier.ended':
    case 'workflow.analyst.ended':
    case 'workflow.reviewer.ended':
      validateDelegateEndedPayload(kind, payload)
      return payload
    case 'workflow.loop.failed':
    case 'workflow.verifier.failed':
    case 'workflow.analyst.failed':
    case 'workflow.reviewer.failed':
      validateDelegateFailedPayload(kind, payload)
      return payload
    case 'workflow.failed':
      requireString(payload.message, `${kind}.payload.message`)
      optionalString(payload.code, `${kind}.payload.code`)
      optionalString(payload.phase, `${kind}.payload.phase`)
      return payload
    case 'workflow.ended':
      requireNonNegativeNumber(payload.durationMs, `${kind}.payload.durationMs`)
      requireNonNegativeNumber(payload.costUsd, `${kind}.payload.costUsd`)
      validateTokenUsage(payload.tokenUsage, `${kind}.payload.tokenUsage`)
      requireInteger(payload.agentCalls, `${kind}.payload.agentCalls`, { min: 0 })
      requireInteger(payload.loopCalls, `${kind}.payload.loopCalls`, { min: 0 })
      return payload
  }
}

function validateBranchPayload(
  kind: WorkflowTraceEventKind,
  payload: Record<string, unknown>,
  options: { terminal: boolean },
): void {
  const operation = requireString(payload.operation, `${kind}.payload.operation`)
  if (!BRANCH_OPERATIONS.has(operation)) {
    throw new ValidationError(`${kind}.payload.operation: expected parallel or pipeline`)
  }
  requireInteger(payload.branchIndex, `${kind}.payload.branchIndex`, { min: 0 })
  optionalString(payload.phase, `${kind}.payload.phase`)
  if (payload.stageCount !== undefined) {
    requireInteger(payload.stageCount, `${kind}.payload.stageCount`, { min: 1 })
  }
  if (options.terminal) {
    requireNonNegativeNumber(payload.durationMs, `${kind}.payload.durationMs`)
  }
}

function validateIndexedPayload(
  kind: WorkflowTraceEventKind,
  payload: Record<string, unknown>,
): void {
  requireInteger(payload.index, `${kind}.payload.index`, { min: 0 })
  optionalString(payload.label, `${kind}.payload.label`)
  optionalString(payload.phase, `${kind}.payload.phase`)
}

function validateDelegateEndedPayload(
  kind: WorkflowTraceEventKind,
  payload: Record<string, unknown>,
): void {
  validateIndexedPayload(kind, payload)
  requireNonNegativeNumber(payload.durationMs, `${kind}.payload.durationMs`)
  requireNonNegativeNumber(payload.costUsd, `${kind}.payload.costUsd`)
  validateTokenUsage(payload.tokenUsage, `${kind}.payload.tokenUsage`)
}

function validateDelegateFailedPayload(
  kind: WorkflowTraceEventKind,
  payload: Record<string, unknown>,
): void {
  validateIndexedPayload(kind, payload)
  requireNonNegativeNumber(payload.durationMs, `${kind}.payload.durationMs`)
  requireString(payload.message, `${kind}.payload.message`)
  optionalString(payload.code, `${kind}.payload.code`)
}

function validateTokenUsage(value: unknown, path: string): void {
  const tokenUsage = requireRecord(value, path)
  requireNonNegativeNumber(tokenUsage.input, `${path}.input`)
  requireNonNegativeNumber(tokenUsage.output, `${path}.output`)
  if (tokenUsage.cached !== undefined) {
    requireNonNegativeNumber(tokenUsage.cached, `${path}.cached`)
  }
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${path}: expected object`)
  }
  return value as Record<string, unknown>
}

function optionalRecord(value: unknown, path: string): void {
  if (value !== undefined) requireRecord(value, path)
}

function requireString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new ValidationError(`${path}: expected non-empty string`)
  }
  return value
}

function optionalString(value: unknown, path: string): void {
  if (value !== undefined) requireString(value, path)
}

function requireNonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ValidationError(`${path}: expected finite non-negative number`)
  }
  return value
}

function requireInteger(value: unknown, path: string, options: { min?: number } = {}): number {
  if (typeof value !== 'number' || !Number.isInteger(value)) {
    throw new ValidationError(`${path}: expected integer`)
  }
  if (options.min !== undefined && value < options.min) {
    throw new ValidationError(`${path}: expected integer >= ${options.min}`)
  }
  return value
}
