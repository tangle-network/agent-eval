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

export type SpanKind =
  | 'agent'
  | 'llm'
  | 'tool'
  | 'retrieval'
  | 'judge'
  | 'sandbox'
  | 'custom'

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
  outputTokens?: number
  cachedTokens?: number
  reasoningTokens?: number
  costUsd?: number
  finishReason?: string
}

export interface ToolSpan extends SpanBase {
  kind: 'tool'
  toolName: string
  args: unknown
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

export type FailureClass =
  | 'success'
  | 'reasoning_error'
  | 'tool_selection_error'
  | 'tool_argument_error'
  | 'tool_recovery_failure'
  | 'hallucination'
  | 'instruction_following'
  | 'safety_refusal_miss'
  | 'policy_violation'
  | 'budget_exceeded'
  | 'format_drift'
  | 'permission_escalation'
  | 'pii_leak'
  | 'cost_overrun'
  | 'timeout'
  | 'sandbox_failure'
  | 'unknown'

export const FAILURE_CLASSES: readonly FailureClass[] = [
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
  'unknown',
] as const

// ── Helpers ──────────────────────────────────────────────────────────

export function isLlmSpan(s: Span): s is LlmSpan { return s.kind === 'llm' }
export function isToolSpan(s: Span): s is ToolSpan { return s.kind === 'tool' }
export function isRetrievalSpan(s: Span): s is RetrievalSpan { return s.kind === 'retrieval' }
export function isJudgeSpan(s: Span): s is JudgeSpan { return s.kind === 'judge' }
export function isSandboxSpan(s: Span): s is SandboxSpan { return s.kind === 'sandbox' }
