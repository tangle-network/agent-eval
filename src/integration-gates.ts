import {
  objectiveEval,
  type ControlEvalResult,
} from './control-runtime'
import type { ActionableSideInfo } from './multi-shot-optimization'

export type IntegrationGateSurface =
  | 'integration-manifest'
  | 'integration-connection'
  | 'integration-scope'
  | 'integration-approval'
  | 'integration-auth'
  | 'integration-provider'
  | 'integration-policy'

export interface IntegrationManifestGateInput {
  connectorId: string
  actionId?: string
  valid: boolean
  missingConnections?: string[]
  missingScopes?: string[]
  requiredScopes?: string[]
  approvalRequired?: boolean
  status?: 'ready' | 'blocked' | 'approval_required'
  reason?: string
  metadata?: Record<string, unknown>
}

export interface IntegrationInvokeFailureInput {
  connectorId: string
  actionId: string
  code:
    | 'auth_expired'
    | 'scope_denied'
    | 'approval_required'
    | 'unsafe_write_denied'
    | 'provider_failure'
    | 'manifest_invalid'
  message: string
  status?: number
  retryable?: boolean
  metadata?: Record<string, unknown>
}

export function integrationManifestValidatedPayload(input: IntegrationManifestGateInput): Record<string, unknown> {
  return {
    kind: 'integration_manifest_validated',
    connectorId: input.connectorId,
    ...(input.actionId ? { actionId: input.actionId } : {}),
    valid: input.valid,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
}

export function integrationManifestResolvedPayload(input: IntegrationManifestGateInput): Record<string, unknown> {
  const missingConnections = input.missingConnections ?? []
  const missingScopes = input.missingScopes ?? []
  const requiredScopes = input.requiredScopes ?? []
  const status = input.status ?? statusForManifest(input)

  return {
    kind: 'integration_manifest_resolved',
    connectorId: input.connectorId,
    ...(input.actionId ? { actionId: input.actionId } : {}),
    status,
    missingConnections,
    missingScopes,
    requiredScopes,
    missing: resolutionMissingItems(input, missingConnections, missingScopes, requiredScopes),
    optionalMissing: [],
    ready: status === 'ready'
      ? [{
          status: 'ready',
          connectorId: input.connectorId,
          ...(input.actionId ? { actionId: input.actionId } : {}),
          requiredScopes,
        }]
      : [],
    approvalRequired: input.approvalRequired ?? false,
    ...(input.reason ? { reason: input.reason } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
}

export function integrationInvokeFailedPayload(input: IntegrationInvokeFailureInput): Record<string, unknown> {
  return {
    kind: 'integration_invoke_failed',
    connectorId: input.connectorId,
    actionId: input.actionId,
    code: input.code,
    message: input.message,
    ...(input.status !== undefined ? { status: input.status } : {}),
    ...(input.retryable !== undefined ? { retryable: input.retryable } : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
  }
}

export function integrationGateEvals(input: IntegrationManifestGateInput): ControlEvalResult[] {
  const evals: ControlEvalResult[] = []
  evals.push(objectiveEval({
    id: `integration-manifest-valid:${input.connectorId}${input.actionId ? `:${input.actionId}` : ''}`,
    passed: input.valid,
    score: input.valid ? 1 : 0,
    severity: input.valid ? 'info' : 'critical',
    detail: input.valid ? 'Integration manifest is valid.' : input.reason ?? 'Integration manifest is invalid.',
    metadata: { integration: input },
  }))

  const missingConnections = input.missingConnections ?? []
  evals.push(objectiveEval({
    id: `integration-connection-ready:${input.connectorId}`,
    passed: missingConnections.length === 0,
    score: missingConnections.length === 0 ? 1 : 0,
    severity: missingConnections.length === 0 ? 'info' : 'critical',
    detail: missingConnections.length === 0
      ? 'Required integration connections are present.'
      : `Missing integration connection(s): ${missingConnections.join(', ')}`,
    evidence: missingConnections.join(', ') || undefined,
    metadata: { connectorId: input.connectorId, missingConnections },
  }))

  const missingScopes = input.missingScopes ?? []
  evals.push(objectiveEval({
    id: `integration-scopes-ready:${input.connectorId}`,
    passed: missingScopes.length === 0,
    score: missingScopes.length === 0 ? 1 : 0,
    severity: missingScopes.length === 0 ? 'info' : 'critical',
    detail: missingScopes.length === 0
      ? 'Required integration scopes are granted.'
      : `Missing integration scope(s): ${missingScopes.join(', ')}`,
    evidence: missingScopes.join(', ') || undefined,
    metadata: {
      connectorId: input.connectorId,
      missingScopes,
      requiredScopes: input.requiredScopes ?? [],
    },
  }))

  if (input.approvalRequired) {
    evals.push(objectiveEval({
      id: `integration-approval-required:${input.connectorId}`,
      passed: false,
      score: 0,
      severity: 'warning',
      detail: 'Integration action requires approval before execution.',
      metadata: { connectorId: input.connectorId, actionId: input.actionId },
    }))
  }

  return evals
}

export function integrationAsi(input: IntegrationManifestGateInput | IntegrationInvokeFailureInput): ActionableSideInfo {
  if ('code' in input) {
    return {
      expectationId: `integration-invoke:${input.connectorId}:${input.actionId}`,
      message: input.message,
      severity: severityForInvokeFailure(input.code),
      responsibleSurface: surfaceForInvokeFailure(input.code),
      suggestion: suggestionForInvokeFailure(input),
      metadata: { integration: input },
    }
  }

  const missingConnections = input.missingConnections ?? []
  const missingScopes = input.missingScopes ?? []
  const surface: IntegrationGateSurface = !input.valid
    ? 'integration-manifest'
    : missingConnections.length > 0
      ? 'integration-connection'
      : missingScopes.length > 0
        ? 'integration-scope'
        : input.approvalRequired
          ? 'integration-approval'
          : 'integration-policy'

  return {
    expectationId: `integration-ready:${input.connectorId}${input.actionId ? `:${input.actionId}` : ''}`,
    message: input.reason ?? messageForManifest(input),
    severity: input.valid && missingConnections.length === 0 && missingScopes.length === 0 && !input.approvalRequired ? 'info' : 'error',
    responsibleSurface: surface,
    suggestion: suggestionForManifest(input),
    metadata: { integration: input },
  }
}

function statusForManifest(input: IntegrationManifestGateInput): 'ready' | 'blocked' | 'approval_required' {
  if (input.approvalRequired) return 'approval_required'
  if (!input.valid || (input.missingConnections?.length ?? 0) > 0 || (input.missingScopes?.length ?? 0) > 0) return 'blocked'
  return 'ready'
}

function resolutionMissingItems(
  input: IntegrationManifestGateInput,
  missingConnections: string[],
  missingScopes: string[],
  requiredScopes: string[],
): Array<Record<string, unknown>> {
  const connectionItems = missingConnections.map((connectorId) => ({
    status: 'missing_connection',
    connectorId,
    ...(input.actionId ? { actionId: input.actionId } : {}),
    requiredScopes,
  }))

  if (missingScopes.length === 0) return connectionItems

  return [
    ...connectionItems,
    {
      status: 'missing_scope',
      connectorId: input.connectorId,
      ...(input.actionId ? { actionId: input.actionId } : {}),
      missingScopes,
      requiredScopes,
    },
  ]
}

function surfaceForInvokeFailure(code: IntegrationInvokeFailureInput['code']): IntegrationGateSurface {
  if (code === 'auth_expired') return 'integration-auth'
  if (code === 'scope_denied') return 'integration-scope'
  if (code === 'approval_required') return 'integration-approval'
  if (code === 'unsafe_write_denied') return 'integration-policy'
  if (code === 'manifest_invalid') return 'integration-manifest'
  return 'integration-provider'
}

function severityForInvokeFailure(code: IntegrationInvokeFailureInput['code']): ActionableSideInfo['severity'] {
  return code === 'provider_failure' ? 'warning' : 'error'
}

function suggestionForInvokeFailure(input: IntegrationInvokeFailureInput): string {
  if (input.code === 'auth_expired') return `Reconnect ${input.connectorId} before retrying.`
  if (input.code === 'scope_denied') return `Request the missing scope for ${input.connectorId}.${input.actionId}.`
  if (input.code === 'approval_required') return `Ask the user to approve ${input.connectorId}.${input.actionId}.`
  if (input.code === 'unsafe_write_denied') return `Route ${input.connectorId}.${input.actionId} through the write-approval policy.`
  if (input.code === 'manifest_invalid') return `Fix the integration manifest for ${input.connectorId}.${input.actionId}.`
  return `Retry or degrade gracefully after ${input.connectorId} provider failure.`
}

function messageForManifest(input: IntegrationManifestGateInput): string {
  if (!input.valid) return `Integration manifest for ${input.connectorId} is invalid.`
  if ((input.missingConnections?.length ?? 0) > 0) return `Missing connection for ${input.connectorId}.`
  if ((input.missingScopes?.length ?? 0) > 0) return `Missing required scopes for ${input.connectorId}.`
  if (input.approvalRequired) return `Approval required for ${input.connectorId}${input.actionId ? `.${input.actionId}` : ''}.`
  return `${input.connectorId} is ready.`
}

function suggestionForManifest(input: IntegrationManifestGateInput): string {
  if (!input.valid) return 'Fix or regenerate the integration manifest before running the agent.'
  if ((input.missingConnections?.length ?? 0) > 0) return `Connect ${input.missingConnections!.join(', ')} before replaying the workflow.`
  if ((input.missingScopes?.length ?? 0) > 0) return `Request scopes: ${input.missingScopes!.join(', ')}.`
  if (input.approvalRequired) return 'Create an approval request and replay after approval.'
  return 'No action required.'
}
