/**
 * Failure taxonomy — canonical classes, who each one is charged to, and two
 * default classifiers.
 *
 * Every failed run should end up in a named class. The classifiers here are
 * rule-based (fast, deterministic); an LLM fallback can be added by the
 * consumer for novel cases and trained into the rule base over time.
 *
 * Two entry points, because a dead run does not always leave a trace:
 *   - `classifyFailure(ctx)` reads a run with its spans and events, and
 *     persists as `Run.outcome.failureClass`;
 *   - `classifyFailureReason(text)` reads the one thing a run that died before
 *     any span always leaves — a reason string on its terminal record.
 * `classifyFailure` calls the reason classifier itself when no structural rule
 * matches, so a run whose only evidence is `ECONNREFUSED` no longer lands in
 * `unknown`.
 *
 * Every classification carries a `blame`. Without it a comparison charges
 * infrastructure outages to the agent under test: a run that never reached a
 * model is not evidence about the agent and must be voided, not counted as a
 * loss.
 */

import type { FailureClass, Run, Span, TraceEvent } from './trace/schema'
import { FAILURE_CLASSES } from './trace/schema'

export { FAILURE_CLASSES, type FailureClass }

/**
 * Who a failure is charged to. This is the axis a comparison reads before it
 * counts a loss.
 *
 * `machine`  — the run never reached a model. The bridge refused, its lane was
 *              full, the box never provisioned, the credential was absent. An
 *              agent cannot route around this, so a run that recorded nothing
 *              behind only machine failures is not evidence about the agent.
 * `provider` — the model was reached and the turn did not complete: an empty
 *              completion, a torn stream, a killed process. Every arm faces
 *              the same provider on the same day, so this stays charged.
 * `agent`    — the agent's own reasoning, tool use, budgeting, or scheduling
 *              produced the failure. Charged.
 * `unknown`  — the record does not say. Never voids a run: an unread reason is
 *              not a proven outage.
 * `none`     — no failure to charge.
 */
export type FailureBlame = 'none' | 'machine' | 'provider' | 'agent' | 'unknown'

/**
 * Blame for every canonical class. The `Record` is exhaustive on purpose: a
 * class added to `FAILURE_CLASSES` without a blame here fails to compile, so
 * the axis cannot silently acquire a hole that reads as `undefined` — and a
 * missing blame would void or charge a run by accident.
 *
 * The assignment rule, applied member by member: a class is `machine` only
 * when the run demonstrably never reached a model. An environment that refuses
 * one specific action the agent chose (a denied write, an out-of-scope call,
 * an approval hold) stays `agent`, because the agent selected the action and
 * every arm faces the same policy.
 */
export const FAILURE_BLAME: Readonly<Record<FailureClass, FailureBlame>> = {
  success: 'none',

  // Behaviour: the agent ran and its own work is what failed.
  reasoning_error: 'agent',
  tool_selection_error: 'agent',
  tool_argument_error: 'agent',
  tool_recovery_failure: 'agent',
  hallucination: 'agent',
  instruction_following: 'agent',
  safety_refusal_miss: 'agent',
  policy_violation: 'agent',
  budget_exceeded: 'agent',
  format_drift: 'agent',
  permission_escalation: 'agent',
  pii_leak: 'agent',
  cost_overrun: 'agent',
  timeout: 'agent',
  // A command the agent ran exited non-zero inside a live box. The box worked.
  sandbox_failure: 'agent',

  // Knowledge and evidence: a model answered, and how the agent handled the
  // gap is exactly what is under test. Every arm faces the same gap.
  missing_user_data: 'agent',
  missing_domain_data: 'agent',
  missing_codebase_context: 'agent',
  missing_runtime_context: 'agent',
  stale_external_data: 'agent',
  bad_retrieval: 'agent',
  insufficient_evidence: 'agent',
  contradictory_evidence: 'agent',
  ambiguous_user_intent: 'agent',

  // Environment provisioning: the run could not reach the model or was stopped
  // before execution, through no act of the agent.
  missing_credentials: 'machine',
  missing_integration_connection: 'machine',
  integration_auth_expired: 'machine',
  bad_integration_manifest: 'machine',
  knowledge_readiness_blocked: 'machine',

  // Environment refusing one action the agent chose.
  missing_integration_scope: 'agent',
  integration_approval_required: 'agent',
  unsafe_integration_write_denied: 'agent',

  // A third-party invocation the agent reached and that did not complete.
  integration_provider_failure: 'provider',

  // Transport: never reached a model.
  bridge_unreachable: 'machine',
  bridge_lane_saturated: 'machine',
  router_usage_mismatch: 'machine',
  session_profile_conflict: 'machine',
  runtime_restart: 'machine',
  root_driver_failed: 'machine',
  box_provision_failure: 'machine',
  box_teardown_failure: 'machine',

  // The agent wrote the broken instrument, so the run is charged: the machine
  // answered, and a run dying on its own profile is not an outage.
  profile_refused: 'agent',

  // Transport: reached the model, the turn did not complete.
  empty_completion: 'provider',
  stream_protocol_error: 'provider',
  stream_incomplete: 'provider',
  message_sealed: 'provider',
  process_killed: 'provider',
  cancelled: 'provider',
  terminated: 'provider',

  traversal_cap_exhausted: 'agent',

  unreported: 'unknown',
  unknown: 'unknown',
}

/**
 * The blames that mean the run got no usable turn out of the machine or the
 * provider. A reader counting an outage streak counts these.
 */
export const INFRA_FAILURE_BLAMES: ReadonlySet<FailureBlame> = new Set<FailureBlame>([
  'machine',
  'provider',
])

/** Who the named class is charged to. */
export function failureBlame(failureClass: FailureClass): FailureBlame {
  return FAILURE_BLAME[failureClass]
}

export interface FailureContext {
  run: Run
  spans: Span[]
  events: TraceEvent[]
}

export interface FailureClassification {
  failureClass: FailureClass
  /** Who the failure is charged to. Derived from the class unless a rule overrode it. */
  blame: FailureBlame
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
    /** Overrides the class's canonical blame. State why at the call site. */
    blame?: FailureBlame
    triggerSpanId?: string
    triggerEventId?: string
  } | null
}

/**
 * One ordered rule over a failure reason string.
 *
 * Order is load-bearing, because one reason string carries two signals: a seat
 * killed by SIGKILL while the bridge refuses connections is a bridge failure,
 * not a process failure, so the bridge patterns are tested first.
 */
export interface FailureReasonRule {
  /** The class the first matching pattern names. */
  failureClass: FailureClass
  pattern: RegExp
  /** Overrides the class's canonical blame. State why at the call site. */
  blame?: FailureBlame
}

/**
 * The default ordered reason rules, measured against the transport death
 * strings this stack records — runtime settle reasons, bridge errors, sandbox
 * provisioning errors, and provider stream errors.
 *
 * A consumer with a different transport passes its own set to
 * `classifyFailureReason`; nothing here is a gate.
 */
export const DEFAULT_FAILURE_REASON_RULES: readonly FailureReasonRule[] = [
  {
    failureClass: 'bridge_unreachable',
    pattern: /ECONNREFUSED|disconnected before terminal acknowledgement|bridge .* unreachable/i,
  },
  {
    failureClass: 'bridge_lane_saturated',
    pattern: /acquire timeout after \d+ms|in_flight=\d+\/\d+/i,
  },
  { failureClass: 'router_usage_mismatch', pattern: /did not match its recorded usage/i },
  {
    failureClass: 'session_profile_conflict',
    pattern:
      /bound to a different AgentProfile|profile materialization changed across session turns/i,
  },
  { failureClass: 'runtime_restart', pattern: /agent runtime restarted/i },
  { failureClass: 'root_driver_failed', pattern: /root driver failed/i },
  {
    failureClass: 'box_provision_failure',
    pattern:
      /Sandbox create did not complete within|failed to (create|provision) (a )?box|box .*: (create|provision) failed/i,
  },
  { failureClass: 'box_teardown_failure', pattern: /teardown reported destroyed=false/i },
  {
    failureClass: 'profile_refused',
    pattern:
      /workspace materialization failed|cannot replace its harness's system prompt|has no explicit entry in .*models\.json|conflicts with agent_profile\.model/i,
  },
  { failureClass: 'empty_completion', pattern: /without emitting any visible output/i },
  { failureClass: 'stream_protocol_error', pattern: /JSON error injected into SSE stream/i },
  {
    failureClass: 'stream_incomplete',
    pattern: /Prompt stream ended before a terminal event/i,
  },
  { failureClass: 'message_sealed', pattern: /already rolled up \(sealed\)/i },
  { failureClass: 'process_killed', pattern: /killed by SIGKILL|exited with code null/i },
  { failureClass: 'cancelled', pattern: /cancelled by user/i },
  { failureClass: 'terminated', pattern: /(^|: )terminated\b/i },
  { failureClass: 'budget_exceeded', pattern: /budget pool: ticket \d+ spent/i },
  { failureClass: 'timeout', pattern: /deadline|timed out|timeout/i },
  { failureClass: 'traversal_cap_exhausted', pattern: /traversal|iteration cap|exhausted/i },
]

/**
 * Name the failure one reason string describes.
 *
 * This is the entry point for a run that died before it produced a span: a
 * terminal record, a settle row, a spawn journal line. An unmatched reason is
 * never dropped — it returns `unknown` and keeps the text, so a new failure
 * mode shows up as a named gap instead of a silent bucket. An absent reason
 * returns `unreported`, which is a different fact: the record itself is
 * incomplete.
 */
export function classifyFailureReason(
  reason: string | null | undefined,
  rules: readonly FailureReasonRule[] = DEFAULT_FAILURE_REASON_RULES,
): FailureClassification {
  const text = String(reason ?? '').trim()
  if (text === '') {
    return { failureClass: 'unreported', blame: FAILURE_BLAME.unreported, reason: '' }
  }
  for (const rule of rules) {
    if (rule.pattern.test(text)) {
      return {
        failureClass: rule.failureClass,
        blame: rule.blame ?? FAILURE_BLAME[rule.failureClass],
        reason: text,
      }
    }
  }
  return { failureClass: 'unknown', blame: FAILURE_BLAME.unknown, reason: text }
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

/**
 * Classify the failure mode of a run using an ordered rule list.
 *
 * Structural rules run first, in their declared order. When none matches, the
 * reason strings the run did record are classified with
 * `classifyFailureReason`, so a run whose only evidence is a transport error
 * on an error event is named instead of landing in `unknown`. Only a run that
 * would already have returned `unknown` can change class this way.
 */
export function classifyFailure(
  ctx: FailureContext,
  rules: FailureRule[] = DEFAULT_RULES,
  reasonRules: readonly FailureReasonRule[] = DEFAULT_FAILURE_REASON_RULES,
): FailureClassification {
  if (ctx.run.outcome?.pass !== false && ctx.run.status === 'completed') {
    return {
      failureClass: 'success',
      blame: FAILURE_BLAME.success,
      reason: 'run completed with pass=true (or no explicit fail)',
    }
  }
  for (const rule of rules) {
    const hit = rule.match(ctx)
    if (hit) return { ...hit, blame: hit.blame ?? FAILURE_BLAME[hit.failureClass] }
  }
  for (const candidate of recordedReasons(ctx)) {
    const classified = classifyFailureReason(candidate.text, reasonRules)
    if (classified.failureClass === 'unknown' || classified.failureClass === 'unreported') continue
    return {
      ...classified,
      ...(candidate.eventId === undefined ? {} : { triggerEventId: candidate.eventId }),
    }
  }
  return {
    failureClass: 'unknown',
    blame: FAILURE_BLAME.unknown,
    reason: 'no rule matched; run failed for unclassified reason',
  }
}

/**
 * The reason strings a failed run recorded, error events first because they
 * sit closest to the failure, then the outcome notes.
 */
function recordedReasons(ctx: FailureContext): Array<{ text: string; eventId?: string }> {
  const found: Array<{ text: string; eventId?: string }> = []
  for (const event of ctx.events) {
    if (event.kind !== 'error') continue
    for (const field of ['reason', 'message', 'error'] as const) {
      const value = event.payload[field]
      if (typeof value === 'string' && value.trim()) {
        found.push({ text: value, eventId: event.eventId })
      }
    }
  }
  const notes = ctx.run.outcome?.notes
  if (typeof notes === 'string' && notes.trim()) found.push({ text: notes })
  return found
}
