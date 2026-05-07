import { describe, expect, it } from 'vitest'
import {
  integrationAsi,
  integrationGateEvals,
  integrationInvokeFailedPayload,
  integrationManifestResolvedPayload,
  integrationManifestValidatedPayload,
} from '../src'
import { classifyFailure } from '../src/failure-taxonomy'
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
    })
  })

  it('emits payloads that classify integration failures', () => {
    const event: TraceEvent = {
      eventId: 'evt-1',
      runId: 'run-1',
      kind: 'custom',
      timestamp: 1,
      payload: integrationInvokeFailedPayload({
        connectorId: 'slack',
        actionId: 'chat.postMessage',
        code: 'scope_denied',
        message: 'missing chat:write',
      }),
    }

    expect(classifyFailure({ run: failedRun, spans: [], events: [event] }).failureClass).toBe('missing_integration_scope')
  })

  it('maps blocked gates into actionable side information', () => {
    expect(integrationAsi({
      connectorId: 'github',
      actionId: 'issues.create',
      valid: true,
      approvalRequired: true,
    })).toMatchObject({
      responsibleSurface: 'integration-approval',
      severity: 'error',
    })
  })
})
