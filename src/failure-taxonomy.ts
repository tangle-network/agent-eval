/**
 * Failure taxonomy — canonical classes + a default classifier.
 *
 * Every failed run should end up in a named class. The classifier here
 * is rule-based (fast, deterministic); an LLM fallback can be added by
 * the consumer for novel cases and trained into the rule base over time.
 *
 * Consumers call `classifyFailure(run, spans, events)` and persist the
 * returned class as `Run.outcome.failureClass`.
 */

import type { FailureClass, Run, Span, TraceEvent } from './trace/schema'
import { FAILURE_CLASSES } from './trace/schema'

export { FAILURE_CLASSES, type FailureClass }

export interface FailureContext {
  run: Run
  spans: Span[]
  events: TraceEvent[]
}

export interface FailureClassification {
  failureClass: FailureClass
  reason: string
  triggerSpanId?: string
  triggerEventId?: string
}

/** Ordered rules — first match wins. */
export interface FailureRule {
  id: string
  match: (ctx: FailureContext) => {
    failureClass: FailureClass
    reason: string
    triggerSpanId?: string
    triggerEventId?: string
  } | null
}

export const DEFAULT_RULES: FailureRule[] = [
  // Outcome already named? Respect it.
  {
    id: 'explicit-outcome',
    match: ({ run }) => {
      const fc = run.outcome?.failureClass
      if (fc && fc !== 'unknown')
        return { failureClass: fc, reason: 'outcome.failureClass set explicitly' }
      return null
    },
  },
  {
    id: 'knowledge-readiness-blocked',
    match: ({ events }) => {
      const event = events.find(
        (e) =>
          e.kind === 'custom' &&
          e.payload.kind === 'readiness_scored' &&
          e.payload.passed === false,
      )
      return event
        ? {
            failureClass: 'knowledge_readiness_blocked',
            reason: 'knowledge readiness report blocked execution',
            triggerEventId: event.eventId,
          }
        : null
    },
  },
  {
    id: 'bad-integration-manifest',
    match: ({ events }) => {
      const event = events.find(
        (e) =>
          e.kind === 'custom' &&
          ((e.payload.kind === 'integration_manifest_validated' && e.payload.valid === false) ||
            (e.payload.kind === 'integration_invoke_failed' &&
              e.payload.code === 'manifest_invalid')),
      )
      return event
        ? {
            failureClass: 'bad_integration_manifest',
            reason: 'integration manifest validation failed before launch',
            triggerEventId: event.eventId,
          }
        : null
    },
  },
  {
    id: 'missing-integration-connection',
    match: ({ events }) => {
      const event = events.find(
        (e) =>
          e.kind === 'custom' &&
          e.payload.kind === 'integration_manifest_resolved' &&
          hasResolutionStatus(e.payload, 'missing_connection'),
      )
      return event
        ? {
            failureClass: 'missing_integration_connection',
            reason: 'required integration connection was missing',
            triggerEventId: event.eventId,
          }
        : null
    },
  },
  {
    id: 'missing-integration-scope',
    match: ({ events }) => {
      const event = events.find(
        (e) =>
          e.kind === 'custom' &&
          ((e.payload.kind === 'integration_manifest_resolved' && hasMissingScopes(e.payload)) ||
            (e.payload.kind === 'integration_invoke_failed' && e.payload.code === 'scope_denied')),
      )
      return event
        ? {
            failureClass: 'missing_integration_scope',
            reason: 'integration grant or connection lacks required scopes',
            triggerEventId: event.eventId,
          }
        : null
    },
  },
  {
    id: 'integration-approval-required',
    match: ({ events }) => {
      const event = events.find(
        (e) =>
          e.kind === 'custom' &&
          ((e.payload.kind === 'integration_invoke' && e.payload.status === 'approval_required') ||
            (e.payload.kind === 'integration_invoke_failed' &&
              e.payload.code === 'approval_required') ||
            e.payload.kind === 'integration_approval_required'),
      )
      return event
        ? {
            failureClass: 'integration_approval_required',
            reason: 'integration write paused for user approval',
            triggerEventId: event.eventId,
          }
        : null
    },
  },
  {
    id: 'integration-auth-expired',
    match: ({ events }) => {
      const event = events.find(
        (e) =>
          e.kind === 'custom' &&
          e.payload.kind === 'integration_invoke_failed' &&
          (e.payload.code === 'auth_expired' ||
            e.payload.code === 'connection_not_active' ||
            e.payload.code === 'capability_expired' ||
            e.payload.status === 'expired'),
      )
      return event
        ? {
            failureClass: 'integration_auth_expired',
            reason: 'integration connection or capability expired',
            triggerEventId: event.eventId,
          }
        : null
    },
  },
  {
    id: 'unsafe-integration-write-denied',
    match: ({ events }) => {
      const event = events.find(
        (e) =>
          e.kind === 'custom' &&
          e.payload.kind === 'integration_invoke_failed' &&
          (e.payload.code === 'unsafe_write_denied' ||
            e.payload.code === 'policy_denied' ||
            e.payload.code === 'action_denied'),
      )
      return event
        ? {
            failureClass: 'unsafe_integration_write_denied',
            reason: 'integration write was denied by policy or capability scope',
            triggerEventId: event.eventId,
          }
        : null
    },
  },
  {
    id: 'integration-provider-failure',
    match: ({ events }) => {
      const event = events.find(
        (e) =>
          e.kind === 'custom' &&
          e.payload.kind === 'integration_invoke_failed' &&
          ![
            'scope_denied',
            'approval_required',
            'auth_expired',
            'connection_not_active',
            'capability_expired',
            'unsafe_write_denied',
            'policy_denied',
            'action_denied',
            'manifest_invalid',
          ].includes(String(e.payload.code)),
      )
      return event
        ? {
            failureClass: 'integration_provider_failure',
            reason: 'integration provider invocation failed',
            triggerEventId: event.eventId,
          }
        : null
    },
  },
  {
    id: 'missing-credentials',
    match: ({ events }) => {
      const event = events.find(
        (e) =>
          e.kind === 'custom' &&
          e.payload.kind === 'knowledge_gap' &&
          e.payload.category === 'credential_or_secret',
      )
      return event
        ? {
            failureClass: 'missing_credentials',
            reason: 'required credential or secret was missing',
            triggerEventId: event.eventId,
          }
        : null
    },
  },
  {
    id: 'bad-retrieval',
    match: ({ run, spans }) => {
      if (run.outcome?.pass !== false) return null
      const retrieval = spans.find(
        (s) =>
          s.kind === 'retrieval' && (s.hits.length === 0 || s.hits.every((hit) => hit.score <= 0)),
      )
      return retrieval
        ? {
            failureClass: 'bad_retrieval',
            reason: 'retrieval returned no useful hits for a failed run',
            triggerSpanId: retrieval.spanId,
          }
        : null
    },
  },
  {
    id: 'insufficient-evidence',
    match: ({ events }) => {
      const event = events.find(
        (e) =>
          e.kind === 'custom' &&
          e.payload.kind === 'knowledge_gap' &&
          e.payload.reason === 'insufficient_evidence',
      )
      return event
        ? {
            failureClass: 'insufficient_evidence',
            reason: 'task proceeded with insufficient supporting evidence',
            triggerEventId: event.eventId,
          }
        : null
    },
  },
  {
    id: 'contradictory-evidence',
    match: ({ events }) => {
      const event = events.find(
        (e) =>
          e.kind === 'custom' &&
          e.payload.kind === 'knowledge_gap' &&
          e.payload.reason === 'contradictory_evidence',
      )
      return event
        ? {
            failureClass: 'contradictory_evidence',
            reason: 'supporting evidence contradicted itself',
            triggerEventId: event.eventId,
          }
        : null
    },
  },
  // Budget breach events
  {
    id: 'budget-breach',
    match: ({ events }) => {
      const breach = events.find((e) => e.kind === 'budget_breach')
      return breach
        ? {
            failureClass: 'budget_exceeded',
            reason: `budget breached on ${breach.payload.dimension ?? 'unknown dimension'}`,
            triggerEventId: breach.eventId,
          }
        : null
    },
  },
  // Policy violations
  {
    id: 'policy-violation',
    match: ({ events }) => {
      const e = events.find((x) => x.kind === 'policy_violation')
      return e
        ? {
            failureClass: 'policy_violation',
            reason: 'policy_violation event emitted',
            triggerEventId: e.eventId,
          }
        : null
    },
  },
  // Sandbox non-zero exit code
  {
    id: 'sandbox-failure',
    match: ({ spans }) => {
      const s = spans.find(
        (x) => x.kind === 'sandbox' && typeof x.exitCode === 'number' && x.exitCode !== 0,
      )
      if (!s) return null
      return {
        failureClass: 'sandbox_failure',
        reason: `sandbox exited ${(s as Extract<Span, { kind: 'sandbox' }>).exitCode}`,
        triggerSpanId: s.spanId,
      }
    },
  },
  // Timeout: run aborted by external signal
  {
    id: 'timeout',
    match: ({ run, events }) => {
      if (run.status !== 'aborted') return null
      const hasTimeout = events.some(
        (e) =>
          e.kind === 'error' &&
          String(e.payload.reason ?? '')
            .toLowerCase()
            .includes('timeout'),
      )
      const note = (run.outcome?.notes ?? '').toLowerCase()
      if (hasTimeout || note.includes('timeout') || note.includes('deadline')) {
        return { failureClass: 'timeout', reason: 'timeout signal observed' }
      }
      return null
    },
  },
  // Tool recovery failure: many consecutive tool errors on the same tool
  {
    id: 'tool-recovery-failure',
    match: ({ spans }) => {
      const tools = spans.filter((s) => s.kind === 'tool')
      const byTool = new Map<string, Span[]>()
      for (const t of tools) {
        const name = (t as Extract<Span, { kind: 'tool' }>).toolName
        const arr = byTool.get(name) ?? []
        arr.push(t)
        byTool.set(name, arr)
      }
      for (const [name, arr] of byTool) {
        const errs = arr.filter((s) => s.status === 'error')
        if (errs.length >= 3 && errs.length === arr.length) {
          return {
            failureClass: 'tool_recovery_failure',
            reason: `${errs.length} consecutive errors on tool "${name}"`,
            triggerSpanId: errs[errs.length - 1]!.spanId,
          }
        }
      }
      return null
    },
  },
  // Tool selection error: the run failed and agent called zero tools despite having them
  {
    id: 'tool-selection-error',
    match: ({ run, spans }) => {
      if (run.outcome?.pass !== false) return null
      const hasToolsAvailable = spans.some(
        (s) =>
          s.kind === 'agent' &&
          (s.attributes?.toolsAvailable as number | undefined) !== undefined &&
          (s.attributes?.toolsAvailable as number) > 0,
      )
      const tools = spans.filter((s) => s.kind === 'tool')
      if (hasToolsAvailable && tools.length === 0) {
        return {
          failureClass: 'tool_selection_error',
          reason: 'tools were available but none were called',
        }
      }
      return null
    },
  },
  // Format drift: scored by a judge with dimension='format' below threshold
  {
    id: 'format-drift',
    match: ({ spans }) => {
      const judge = spans.find(
        (s) =>
          s.kind === 'judge' &&
          (s as Extract<Span, { kind: 'judge' }>).dimension === 'format' &&
          (s as Extract<Span, { kind: 'judge' }>).score < 0.5,
      )
      return judge
        ? {
            failureClass: 'format_drift',
            reason: 'format judge scored below 0.5',
            triggerSpanId: judge.spanId,
          }
        : null
    },
  },
]

function hasResolutionStatus(payload: Record<string, unknown>, status: string): boolean {
  if (status === 'missing_connection' && stringArray(payload.missingConnections).length > 0)
    return true
  return resolutionItems(payload).some((item) => item.status === status)
}

function hasMissingScopes(payload: Record<string, unknown>): boolean {
  if (stringArray(payload.missingScopes).length > 0) return true
  return resolutionItems(payload).some(
    (item) => Array.isArray(item.missingScopes) && item.missingScopes.length > 0,
  )
}

function resolutionItems(payload: Record<string, unknown>): Array<Record<string, unknown>> {
  return [
    ...records(payload.missing),
    ...records(payload.optionalMissing),
    ...records(payload.ready),
  ]
}

function records(value: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(value)) return []
  return value.filter(
    (item): item is Record<string, unknown> =>
      Boolean(item) && typeof item === 'object' && !Array.isArray(item),
  )
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : []
}

/** Classify the failure mode of a run using an ordered rule list. */
export function classifyFailure(
  ctx: FailureContext,
  rules: FailureRule[] = DEFAULT_RULES,
): FailureClassification {
  if (ctx.run.outcome?.pass !== false && ctx.run.status === 'completed') {
    return { failureClass: 'success', reason: 'run completed with pass=true (or no explicit fail)' }
  }
  for (const rule of rules) {
    const hit = rule.match(ctx)
    if (hit) return hit
  }
  return { failureClass: 'unknown', reason: 'no rule matched; run failed for unclassified reason' }
}
