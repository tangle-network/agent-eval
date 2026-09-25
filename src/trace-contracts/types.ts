import type { SpanKind } from '@tangle-network/agent-trace-contract'
import type { RunStatus } from '../trace/schema'
import type { DefaultVerdict } from '../verdict'

// ── Span surface ──────────────────────────────────────────────────────

/**
 * Minimal structural span the checker reads. The eval-side `Span`
 * (trace/schema), the otel-bridge `ExportableSpan`, and the output of
 * {@link contractSpansFromOtlp} all satisfy it.
 */
export interface ContractSpan {
  spanId?: string
  parentSpanId?: string | null
  name?: string
  /** Eval kinds (`tool`, `llm`, ...) or contract kinds (`TOOL`, `LLM`, ...). */
  kind?: string
  startedAt?: number
  endedAt?: number
  status?: string
  error?: string
  /** Typed field on eval-side ToolSpans; OTLP flattenings drop it (see
   *  {@link contractSpanToolName}). */
  toolName?: string
  /** Typed field on eval-side LlmSpans and ExportableSpans. */
  model?: string
  inputTokens?: number
  outputTokens?: number
  /** Typed field on eval-side ToolSpans. */
  args?: unknown
  /** False when the source observed the call but did not capture its arguments. */
  argsCaptured?: boolean
  attributes?: Record<string, unknown>
}

/**
 * The run a `run` rule reads. The eval-side `Run` satisfies it. When no run is
 * passed, the checker derives it from the trace's single root span; a trace
 * with no unique root leaves the run unknown and every `run` rule fails.
 */
export interface ContractRun {
  status?: string
  startedAt?: number
  endedAt?: number
}

/** JSON-safe RegExp form — what the builder normalizes RegExp matchers to. */
export interface SerializedRegex {
  $regex: string
  flags: string
}

/** Matches when the value equals one of the listed strings. */
export interface OneOfMatcher {
  oneOf: string[]
}

export type TextMatcher = string | RegExp | SerializedRegex | OneOfMatcher

/**
 * Proposition over one span. All specified fields must match (AND); `not`
 * must NOT match. At least one field is required — an empty predicate would
 * match every span and is rejected.
 *
 * `kind` compares against the span's contract kind (`TOOL`, `LLM`, `AGENT`,
 * ...), resolved by agent-trace-contract's classifier, so eval kinds
 * (`tool`, `llm`) and OTLP spans that declare no kind are read the same way.
 *
 * `tool` resolves through {@link contractSpanToolName}; `model` through the
 * typed `model` field and the gen_ai model attributes.
 *
 * `attr` values match by strict equality, or regex-test when the value is a
 * RegExp/SerializedRegex and the attribute is a string. Structured attribute
 * values need `custom`, or an `argument` rule for tool arguments.
 */
export interface SpanPredicate {
  name?: TextMatcher
  tool?: TextMatcher
  model?: TextMatcher
  kind?: SpanKind
  attr?: Record<string, unknown>
  not?: SpanPredicate
  custom?: (span: ContractSpan) => boolean
  /** Stamped by the builder when `custom` is present. Survives JSON while
   *  the function does not, so evaluation of a deserialized contract throws
   *  instead of silently dropping the check. */
  requiresCustom?: true
}

// ── Contract shape ────────────────────────────────────────────────────

export const ORDER_MODES = ['start-order', 'finish-before-start', 'all-occurrences'] as const
export type OrderMode = (typeof ORDER_MODES)[number]

export const RUN_STATUSES: readonly RunStatus[] = ['running', 'completed', 'failed', 'aborted']

export const ARGUMENT_OCCURRENCES = ['first', 'last', 'any', 'all'] as const
export type ArgumentOccurrence = (typeof ARGUMENT_OCCURRENCES)[number]

export const ARGUMENT_TYPES = ['string', 'number', 'boolean', 'object', 'array', 'null'] as const
export type ArgumentType = (typeof ARGUMENT_TYPES)[number]

export type ArgumentCheck =
  | { op: 'exists' }
  | { op: 'equals'; value: unknown }
  | { op: 'oneOf'; values: unknown[] }
  | { op: 'type'; type: ArgumentType }

/** A tool whose calls change state outside the run. */
export interface RetryWrite {
  tool: string
  /** RFC 6901 JSON Pointer to the idempotency key in the call's arguments.
   *  Without it, a repeated call of this tool always fails. */
  idempotencyKey?: string
}

export interface RunChecks {
  /** The run's status is `completed` and its end time is recorded. A failed
   *  or aborted run fails this check. */
  requireCompleted?: boolean
  /** The run's status must be one of these. */
  allowedStatuses?: RunStatus[]
  /** End minus start, in milliseconds. An unknown duration fails. */
  maxDurationMs?: number
}

export type ContractRule =
  | { kind: 'always' | 'never' | 'eventually'; label: string; p: SpanPredicate }
  | { kind: 'precedes'; label: string; a: SpanPredicate; b: SpanPredicate; order?: OrderMode }
  | {
      kind: 'neverUnless'
      label: string
      p: SpanPredicate
      prior: SpanPredicate
      order?: OrderMode
    }
  | { kind: 'atMost'; label: string; p: SpanPredicate; max: number }
  | { kind: 'tokensAtMost'; label: string; p: SpanPredicate; max: number }
  | ({ kind: 'run'; label: string } & RunChecks)
  | {
      kind: 'argument'
      label: string
      p: SpanPredicate
      /** RFC 6901 JSON Pointer into the call's arguments; `''` is the whole value. */
      pointer: string
      check: ArgumentCheck
      /** Which matching calls must satisfy the check. Default `all`. */
      occurrence?: ArgumentOccurrence
    }
  | {
      /**
       * The tools the harness offered the model (the OTel GenAI
       * `gen_ai.tool.definitions` attribute) are recorded, every tool call is
       * one of them, and, when `declared` is set, every offered tool is
       * declared. A trace that records no offered tools fails: what the
       * harness enforced is unknown.
       */
      kind: 'toolsOffered'
      label: string
      declared?: string[]
    }
  | {
      /**
       * A tool called again with the same arguments repeats its side effect.
       * A repeated `reads` call passes; a repeated `writes` call passes only
       * when every call carries the same idempotency key; a repeated call of
       * any other tool fails, because its side effect is unknown.
       */
      kind: 'retrySafe'
      label: string
      reads?: string[]
      writes?: RetryWrite[]
    }

export type ContractRuleKind = ContractRule['kind']

/** One legitimate alternate path. The contract passes only when the base
 *  rules pass and at least one alternative passes completely. */
export interface ContractAlternative {
  id: string
  rules: ContractRule[]
}

/** Serializable plain object — `traceContract(name)....build()` output. */
export interface TraceContract {
  name: string
  /** What the contract protects, for reports and `explainTraceContract`. */
  description?: string
  /** Evaluate only the span matching `root` and its descendants. Exactly one
   *  span must match; zero or several make every rule an error. */
  scope?: { root: SpanPredicate }
  rules: ContractRule[]
  alternatives?: ContractAlternative[]
}

export type ContractStatus = 'pass' | 'fail' | 'error'

export interface ContractViolation {
  rule: string
  spanId?: string
  detail: string
}

/** What happened to one rule. `error` means it could not be evaluated. */
export interface ContractRuleExecution {
  rule: string
  /** Set for rules inside `alternatives`. */
  alternative?: string
  status: ContractStatus
  violations: number
  error?: string
}

export interface ContractVerdict extends DefaultVerdict {
  /** Contract name — keys this verdict in multi-contract reports. */
  contract: string
  status: ContractStatus
  /** `status === 'pass'`. */
  valid: boolean
  /** Fraction of rules that passed, in [0, 1]. An errored rule is not a pass. */
  score: number
  /** 0|1 per evaluated base rule, keyed by label, plus `anyOf` when the
   *  contract has alternatives. Errored rules are absent, never 0. */
  scores: Record<string, number>
  violations: ContractViolation[]
  ruleExecutions: ContractRuleExecution[]
  /** Why rules errored, one line per errored rule or scope failure. */
  errors: string[]
}

export interface ContractCheckResult {
  verdicts: ContractVerdict[]
  /** `error` if any verdict errored, else `fail` if any failed, else `pass`. */
  status: ContractStatus
  allValid: boolean
}

export interface EvaluateTraceContractOptions {
  /** The run `run` rules read. Ignored under `scope`, where the scope root is the run. */
  run?: ContractRun
}
