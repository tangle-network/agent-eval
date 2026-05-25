import { describe, expect, it } from 'vitest'
import { classifyFailure } from '../src/failure-taxonomy'
import {
  integrationAsi,
  integrationGateEvals,
  integrationInvokeFailedPayload,
  integrationManifestResolvedPayload,
  integrationManifestValidatedPayload,
} from '../src/integration-gates'
import type { Run, TraceEvent } from '../src/trace/schema'

const failedRun: Run = {
  runId: 'run-1',
  scenarioId: 'scenario-1',
  startedAt: 0,
  status: 'failed',
  outcome: { pass: false },
}

describe('integration gate helpers', () => {
  it('builds manifest evals and taxonomy-compatible trace payloads', () => {
    const input = {
      connectorId: 'google-calendar',
      actionId: 'events.create',
      valid: true,
      missingConnections: ['google-calendar'],
      missingScopes: ['calendar.events.write'],
      requiredScopes: ['calendar.events.write'],
    }

    const evals = integrationGateEvals(input)
    expect(evals.map((e) => [e.id, e.passed])).toEqual([
      ['integration-manifest-valid:google-calendar:events.create', true],
      ['integration-connection-ready:google-calendar', false],
      ['integration-scopes-ready:google-calendar', false],
    ])

    expect(integrationManifestValidatedPayload(input)).toMatchObject({
      kind: 'integration_manifest_validated',
      valid: true,
    })
    expect(integrationManifestResolvedPayload(input)).toMatchObject({
      kind: 'integration_manifest_resolved',
      status: 'blocked',
      missingConnections: ['google-calendar'],
      missingScopes: ['calendar.events.write'],
      missing: [
        {
          status: 'missing_connection',
          connectorId: 'google-calendar',
        },
        {
          status: 'missing_scope',
          connectorId: 'google-calendar',
          missingScopes: ['calendar.events.write'],
        },
      ],
    })
  })

  it('emits manifest payloads that classify missing connections', () => {
    const event: TraceEvent = {
      eventId: 'evt-1',
      runId: 'run-1',
      kind: 'custom',
      timestamp: 1,
      payload: integrationManifestResolvedPayload({
        connectorId: 'google-calendar',
        actionId: 'events.list',
        valid: true,
        missingConnections: ['google-calendar'],
      }),
    }

    expect(classifyFailure({ run: failedRun, spans: [], events: [event] }).failureClass).toBe(
      'missing_integration_connection',
    )
  })

  it('emits manifest payloads that classify missing scopes', () => {
    const event: TraceEvent = {
      eventId: 'evt-1',
      runId: 'run-1',
      kind: 'custom',
      timestamp: 1,
      payload: integrationManifestResolvedPayload({
        connectorId: 'google-calendar',
        actionId: 'events.create',
        valid: true,
        missingScopes: ['calendar.events.write'],
      }),
    }

    expect(classifyFailure({ run: failedRun, spans: [], events: [event] }).failureClass).toBe(
      'missing_integration_scope',
    )
  })

  it.each([
    ['scope_denied', 'missing_integration_scope'],
    ['auth_expired', 'integration_auth_expired'],
    ['unsafe_write_denied', 'unsafe_integration_write_denied'],
    ['manifest_invalid', 'bad_integration_manifest'],
    ['approval_required', 'integration_approval_required'],
    ['provider_failure', 'integration_provider_failure'],
  ] as const)('classifies invoke failure code %s', (code, failureClass) => {
    const event: TraceEvent = {
      eventId: `evt-${code}`,
      runId: 'run-1',
      kind: 'custom',
      timestamp: 1,
      payload: integrationInvokeFailedPayload({
        connectorId: 'slack',
        actionId: 'chat.postMessage',
        code,
        message: code,
      }),
    }

    expect(classifyFailure({ run: failedRun, spans: [], events: [event] }).failureClass).toBe(
      failureClass,
    )
  })

  it('maps blocked gates into actionable side information', () => {
    expect(
      integrationAsi({
        connectorId: 'github',
        actionId: 'issues.create',
        valid: true,
        approvalRequired: true,
      }),
    ).toMatchObject({
      responsibleSurface: 'integration-approval',
      severity: 'error',
    })
  })
})
