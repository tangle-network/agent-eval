/**
 * TraceSchema v1 — the canonical data model for agent-eval.
 *
 * Every score, every failure class, every pipeline in the framework is
 * a view over this data. Shape it once, live with it.
 *
 * Wire-compatible with OpenTelemetry span semantics (see trace/otel.ts)
 * but extended with agent-specific span kinds (llm, tool, retrieval,
 * judge, sandbox) and first-class BudgetLedger / Artifact / JudgeVerdict
 * entities that OTEL leaves as free-form attributes.
 */

export const TRACE_SCHEMA_VERSION = '1.0.0'

// ── Run ──────────────────────────────────────────────────────────────

export type RunStatus = 'running' | 'completed' | 'failed' | 'aborted'

export interface BudgetSpec {
  tokens?: number
  wallMs?: number
  calls?: number
  usd?: number
}

export interface RunOutcome {
  score?: number
  pass?: boolean
  failureClass?: FailureClass
  notes?: string
}

/**
 * Layer — optional classification in a nested build workflow.
 * `builder`: the meta-agent editing a project (e.g. agent-builder Forge chat).
 * `app-build`: sandbox harness that compiled + tested the generated scaffold.
 * `app-runtime`: a run of the generated agent against a domain scenario.
 * `meta`: any meta-eval (judge replay, correlation analysis).
 */
export type RunLayer = 'builder' | 'app-build' | 'app-runtime' | 'meta' | 'custom'

export interface Run {
  runId: string
  /**
   * Stable identifier of the scenario being executed.
   *
   * Always populated on the persisted Run — but `TraceEmitter.startRun` accepts
   * input WITHOUT this field, substituting a sensible default
   * (`run.layer ?? run.tags?.['kind'] ?? 'runtime'`) when the caller has no
   * curated scenario to anchor to (runtime / operator / meta-eval runs). This
   * keeps the persisted shape unambiguous for downstream filters + aggregations
   * while removing the boilerplate of inventing placeholder ids at the call site.
   */
  scenarioId: string
  variantId?: string
  datasetVersion?: string
  /** Git SHA of agent code at run time. */
  codeSha?: string
  /** Hash of the prompt template + any system prompt. */
  promptSha?: string
  /** Model id + date + system-prompt hash, concatenated. */
  modelFingerprint?: string
  seed?: number
  /** Arbitrary environment markers (shell, docker version, tz). */
  envFingerprint?: Record<string, string>
  /** Version of the redaction rules applied to this run. */
  redactionVersion?: string
  /** Parent run in a nested build workflow. A builder run's children are
   *  app-build runs; those children are app-runtime runs. */
  parentRunId?: string
  /** Stable project identifier — groups runs across chats + sessions. */
  projectId?: string
  /** Chat/conversation identifier within a project. */
  chatId?: string
  /** Layer classification — hint for aggregation; not enforced. */
  layer?: RunLayer
  startedAt: number
  endedAt?: number
  status: RunStatus
  outcome?: RunOutcome
  budget?: BudgetSpec
  /** Free-form labels for downstream grouping. */
  tags?: Record<string, string>
}

// ── Spans (hierarchical work units) ──────────────────────────────────

export type SpanKind = 'agent' | 'llm' | 'tool' | 'retrieval' | 'judge' | 'sandbox' | 'custom'

export type SpanStatus = 'ok' | 'error'

export interface SpanBase {
  spanId: string
  parentSpanId?: string
  runId: string
  kind: SpanKind
  name: string
  startedAt: number
  endedAt?: number
  status?: SpanStatus
  error?: string
  /** Anything not covered by typed fields. Kept deliberately free-form. */
  attributes?: Record<string, unknown>
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  tokens?: number
  /** Multi-modal content descriptors; blobs themselves live in Artifacts. */
  images?: Array<{ artifactId?: string; url?: string; mime?: string }>
}

export interface LlmSpan extends SpanBase {
  kind: 'llm'
  model: string
  messages: Message[]
  output?: string
  inputTokens?: number
  /** All generated tokens, including the reasoning subset when present. */
  outputTokens?: number
  cachedTokens?: number
  cacheWriteTokens?: number
  /** Reasoning-token subset of `outputTokens`. */
  reasoningTokens?: number
  costUsd?: number
  finishReason?: string
}

export interface ToolSpan extends SpanBase {
  kind: 'tool'
  toolName: string
  args: unknown
  /** False when the source observed the call but did not capture its arguments. */
  argsCaptured?: boolean
  result?: unknown
  latencyMs?: number
}

export interface RetrievalSpan extends SpanBase {
  kind: 'retrieval'
  query: string
  hits: Array<{ docId: string; score: number; content?: string }>
}

export interface JudgeSpan extends SpanBase {
  kind: 'judge'
  judgeId: string
  /** Span this judgment applies to. */
  targetSpanId: string
  dimension: string
  /** Numeric score (free-range; interpretation up to the judge). */
  score: number
  rationale?: string
  evidence?: string
}

export interface SandboxSpan extends SpanBase {
  kind: 'sandbox'
  image?: string
  command?: string
  exitCode?: number
  testsTotal?: number
  testsPassed?: number
  stdoutHash?: string
  stderrHash?: string
  /** Duration in ms; the harness fills this explicitly (endedAt - startedAt may miss setup). */
  wallMs?: number
}

export interface GenericSpan extends SpanBase {
  kind: 'agent' | 'custom'
}

export type Span = LlmSpan | ToolSpan | RetrievalSpan | JudgeSpan | SandboxSpan | GenericSpan

// ── Events (point-in-time occurrences within a span) ─────────────────

export type EventKind =
  | 'log'
  | 'error'
  | 'budget_decrement'
  | 'budget_breach'
  | 'state_mutation'
  | 'policy_violation'
  | 'redaction_applied'
  | 'custom'

export interface TraceEvent {
  eventId: string
  runId: string
  spanId?: string
  kind: EventKind
  timestamp: number
  payload: Record<string, unknown>
}

// ── Budget ledger (running token/wall/call/$ accounting) ─────────────

export interface BudgetLedgerEntry {
  runId: string
  dimension: keyof BudgetSpec
  limit: number
  consumed: number
  remaining: number
  timestamp: number
  breached: boolean
  /** Span that triggered this entry, if any. */
  spanId?: string
}

// ── Artifacts (blobs addressed by hash) ──────────────────────────────

export interface Artifact {
  artifactId: string
  runId: string
  spanId?: string
  contentType: string
  sizeBytes: number
  /** sha256 in hex. */
  hash: string
  /** External storage URL (R2, S3, filesystem path). */
  storageUrl?: string
  /** Inline content for small blobs — keep under ~64KB. */
  inlineContent?: string
}

// ── Failure taxonomy ─────────────────────────────────────────────────

/**
 * The failure taxonomy. `FailureClass` derives from this array, so the type
 * and the runtime list cannot name different sets.
 *
 * Two layers, and the split is what `FAILURE_BLAME` reads
 * (`src/failure-taxonomy.ts`):
 *   - behaviour classes name what the agent did wrong, and a run that ends in
 *     one is evidence about the agent;
 *   - transport classes name a death before or around the model turn — the
 *     bridge refused, the box never provisioned, the stream tore — and a run
 *     that ends in one of the machine-blamed members is not evidence about the
 *     agent at all.
 *
 * The transport layer exists because a taxonomy with no name for "the run
 * never reached a model" charges an infrastructure outage to the agent under
 * test. Measured: six director cells settled with the runtime journal's own
 * `infra` flag reading FALSE while the real reason was
 * `host-executor: acquire timeout after 900000ms (in_flight=10/10)` — the
 * bridge's host lane had saturated.
 */
export const FAILURE_CLASSES = [
  'success',
  'reasoning_error',
  'tool_selection_error',
  'tool_argument_error',
  'tool_recovery_failure',
  'hallucination',
  'instruction_following',
  'safety_refusal_miss',
  'policy_violation',
  'budget_exceeded',
  'format_drift',
  'permission_escalation',
  'pii_leak',
  'cost_overrun',
  'timeout',
  'sandbox_failure',
  'missing_user_data',
  'missing_domain_data',
  'missing_codebase_context',
  'missing_runtime_context',
  'missing_credentials',
  'missing_integration_connection',
  'missing_integration_scope',
  'integration_approval_required',
  'integration_auth_expired',
  'integration_provider_failure',
  'bad_integration_manifest',
  'unsafe_integration_write_denied',
  'stale_external_data',
  'bad_retrieval',
  'insufficient_evidence',
  'contradictory_evidence',
  'ambiguous_user_intent',
  'knowledge_readiness_blocked',

  // ── Transport: the run never reached a model, or the turn never completed ──
  /** The bridge refused the connection or dropped it before a terminal event. */
  'bridge_unreachable',
  /** The bridge accepted the request and its execution lane was already full. */
  'bridge_lane_saturated',
  /** The router could not reconcile a completion with its own recorded usage. */
  'router_usage_mismatch',
  /** A session was bound to one AgentProfile and asked to serve another. */
  'session_profile_conflict',
  /** The agent runtime restarted underneath a live run. */
  'runtime_restart',
  /** The root driver of a recursive run failed before it could dispatch work. */
  'root_driver_failed',
  /** A sandbox box never finished provisioning. Distinct from `sandbox_failure`,
   *  which is a command the agent ran exiting non-zero inside a live box. */
  'box_provision_failure',
  /** A sandbox box did not confirm destruction after the run. */
  'box_teardown_failure',
  /** The harness refused an agent-authored profile: an unknown model, a
   *  workspace file it may not overwrite, a system prompt it may not replace. */
  'profile_refused',
  /** The model was reached and returned no visible output. */
  'empty_completion',
  /** The response stream carried malformed protocol content. */
  'stream_protocol_error',
  /** The response stream ended before a terminal event. */
  'stream_incomplete',
  /** A message was appended to a conversation the provider had already sealed. */
  'message_sealed',
  /** The model process was killed by a signal or exited with no code. */
  'process_killed',
  /** The run was cancelled by an operator. */
  'cancelled',
  /** The run was terminated without a more specific reason. */
  'terminated',
  /** The agent exhausted its traversal or iteration cap. */
  'traversal_cap_exhausted',

  /** No reason was recorded at all. Distinct from `unknown`, which means a
   *  reason exists and no rule matched it. */
  'unreported',
  'unknown',
] as const

export type FailureClass = (typeof FAILURE_CLASSES)[number]

// ── Helpers ──────────────────────────────────────────────────────────

export function isLlmSpan(s: Span): s is LlmSpan {
  return s.kind === 'llm'
}
export function isToolSpan(s: Span): s is ToolSpan {
  return s.kind === 'tool'
}
export function isJudgeSpan(s: Span): s is JudgeSpan {
  return s.kind === 'judge'
}
