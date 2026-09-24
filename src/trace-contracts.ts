/**
 * Trace contracts — deterministic, judge-free checks over the spans one agent
 * run emitted.
 *
 * A contract is a list of rules; each rule is one operator over flat
 * `SpanPredicate`s:
 *
 *   - `always(p)`, `never(p)`, `eventually(p)` — every / no / some span.
 *   - `precedes(a, b, { order })` — both `a` and `b` occur, and `a` comes
 *     first. A missing endpoint FAILS: a required successor that never ran is
 *     a broken path, not a vacuous pass.
 *   - `neverUnless(p, prior, { order })` — the conditional guard: every
 *     `p`-match needs an earlier `prior`-match; a run with no `p` passes.
 *   - `atMost(p, max)` — call-count ceilings.
 *   - `tokensAtMost(p, max)` — token ceilings; a matching span whose token
 *     count is unknown fails the rule rather than counting as zero.
 *   - `run({ requireCompleted, allowedStatuses, maxDurationMs })` — the run's
 *     terminal status and duration.
 *   - `argument(p, { pointer, check, occurrence })` — a JSON Pointer check on
 *     tool-call arguments; a call without captured arguments fails.
 *
 * Ordering has three modes. `start-order` (the default) needs an `a` that
 * started strictly before each `b`; `finish-before-start` needs an `a` that
 * finished at or before each `b` started; `all-occurrences` needs every `a` to
 * finish before each `b` starts. A span whose needed timestamp is missing
 * fails the rule: array position is never taken as evidence of time.
 *
 * A contract may be `scope`d to one subtree — the span matching `scope.root`
 * and its descendants — so one sub-agent or one search-tree node is checked
 * on its own. It may also carry `alternatives`: named rule sets of which at
 * least one must pass, for legitimate alternate paths such as a cache hit.
 *
 * Every rule reports `pass`, `fail`, or `error` (the rule could not be
 * evaluated: its predicate threw, or the scope selected no unique subtree) in
 * `ruleExecutions`. A verdict with any errored rule has status `error` and is
 * never valid. Contracts with no rules are rejected before evaluation.
 *
 * A built `TraceContract` is a serializable plain object (RegExp matchers are
 * normalized to `SerializedRegex`), so one definition checks recorded eval
 * traces (`store.spans({ runId })`), otel-bridge `ExportableSpan`s, and OTLP
 * rows converted with {@link contractSpansFromOtlp}. `custom` predicate
 * functions are the one non-serializable escape hatch: the builder stamps
 * `requiresCustom: true`, which survives JSON, so a deserialized contract that
 * lost its function is rejected instead of silently weakening.
 *
 * The declarative JSON form (`trace-contract-spec.ts`) compiles onto these
 * operators.
 *
 * Naming: the root barrel exports ci-gate's threshold-contract
 * `evaluateContract`, so the evaluators here are `evaluateTraceContract` /
 * `checkTraceContracts`.
 */

import {
  firstNumberAttr,
  firstStringAttr,
  INPUT_TOKEN_ATTR_KEYS,
  MODEL_ATTR_KEYS,
  OUTPUT_TOKEN_ATTR_KEYS,
  resolveSpanKind,
  SPAN_KINDS,
  type SpanKind,
  TOOL_NAME_ATTR_KEYS,
} from '@tangle-network/agent-trace-contract'
import type { JudgeConfig, JudgeDimension, Scenario } from './campaign/types'
import { ValidationError } from './errors'
import { packageVersion } from './package-version'
import type { RunStatus } from './trace/schema'
import { certificationEvidenceDigest, type DefaultVerdict } from './verdict'

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

export interface RunChecks {
  /** The run reached a terminal status (not `running`) with a recorded end. */
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

// ── Span readers ──────────────────────────────────────────────────────

// Eval kinds whose names are not contract kinds. `tool`, `llm`, and `agent`
// already resolve by upper-casing; `sandbox` and `custom` stay undeclared and
// fall through to inference.
const EVAL_KIND_TO_CONTRACT_KIND: ReadonlyMap<string, SpanKind> = new Map([
  ['judge', 'EVALUATOR'],
  ['retrieval', 'RETRIEVER'],
])

/** The span's contract kind: a declared kind when recognised, else inferred. */
export function contractSpanKind(span: ContractSpan): SpanKind {
  const declared =
    typeof span.kind === 'string'
      ? (EVAL_KIND_TO_CONTRACT_KIND.get(span.kind) ?? span.kind)
      : undefined
  return resolveSpanKind({
    ...(declared === undefined ? {} : { kind: declared }),
    name: span.name,
    attributes: span.attributes ?? {},
  })
}

/**
 * Tool name: `span.toolName` (typed ToolSpan) → the tool-name attributes
 * (`gen_ai.tool.name`, `tool.name`, ..., `toolName`) → `span.name` when the
 * span is a TOOL span (otel-bridge's `ExportableSpan` drops `toolName`).
 */
export function contractSpanToolName(span: ContractSpan): string | undefined {
  if (typeof span.toolName === 'string') return span.toolName
  const attributes = span.attributes ?? {}
  const fromAttr =
    firstStringAttr(attributes, TOOL_NAME_ATTR_KEYS) ?? firstStringAttr(attributes, ['toolName'])
  if (fromAttr !== undefined) return fromAttr
  if (typeof span.name === 'string' && contractSpanKind(span) === 'TOOL') return span.name
  return undefined
}

function spanModel(span: ContractSpan): string | undefined {
  if (typeof span.model === 'string' && span.model.length > 0) return span.model
  return firstStringAttr(span.attributes ?? {}, MODEL_ATTR_KEYS)
}

/** Input plus output tokens, or `undefined` when either side is unrecorded. */
function spanTotalTokens(span: ContractSpan): number | undefined {
  const attributes = span.attributes ?? {}
  const input = finite(span.inputTokens) ?? firstNumberAttr(attributes, INPUT_TOKEN_ATTR_KEYS)
  const output = finite(span.outputTokens) ?? firstNumberAttr(attributes, OUTPUT_TOKEN_ATTR_KEYS)
  return input === undefined || output === undefined ? undefined : input + output
}

const ARGUMENT_ATTR_KEYS = ['gen_ai.tool.call.arguments', 'tool.arguments', 'input.value'] as const

type ArgumentEvidence = { known: true; value: unknown } | { known: false; reason: string }

/** The call's arguments: the typed `args` field, else the argument attributes.
 *  JSON strings are parsed; an unparseable string is kept as a string. */
function spanArguments(span: ContractSpan): ArgumentEvidence {
  if (span.argsCaptured === false || span.attributes?.['tool.args_captured'] === false) {
    return { known: false, reason: 'arguments were not captured' }
  }
  if (span.args !== undefined) return { known: true, value: parseJsonString(span.args) }
  for (const key of ARGUMENT_ATTR_KEYS) {
    const value = span.attributes?.[key]
    if (value !== undefined && value !== null) return { known: true, value: parseJsonString(value) }
  }
  return { known: false, reason: 'the span carries no argument evidence' }
}

function parseJsonString(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function finite(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function isSpanError(span: ContractSpan): boolean {
  return typeof span.status === 'string' && /^(?:error|status_code_error)$/i.test(span.status)
}

// ── Predicate matching ────────────────────────────────────────────────

function isSerializedRegex(v: unknown): v is SerializedRegex {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as SerializedRegex).$regex === 'string' &&
    typeof (v as SerializedRegex).flags === 'string'
  )
}

function isOneOfMatcher(v: unknown): v is OneOfMatcher {
  return typeof v === 'object' && v !== null && Array.isArray((v as OneOfMatcher).oneOf)
}

function isRegexValue(v: unknown): v is RegExp | SerializedRegex {
  return v instanceof RegExp || isSerializedRegex(v)
}

function matchText(actual: string | undefined, matcher: TextMatcher): boolean {
  if (typeof actual !== 'string') return false
  if (typeof matcher === 'string') return actual === matcher
  if (matcher instanceof RegExp) return matcher.test(actual)
  if (isOneOfMatcher(matcher)) return matcher.oneOf.includes(actual)
  return new RegExp(matcher.$regex, matcher.flags).test(actual)
}

function assertMatcher(m: unknown, where: string): void {
  if (typeof m === 'string' || m instanceof RegExp) return
  if (isSerializedRegex(m)) {
    try {
      new RegExp(m.$regex, m.flags)
    } catch (error) {
      throw new ValidationError(`${where}: invalid regex /${m.$regex}/${m.flags}: ${String(error)}`)
    }
    return
  }
  if (isOneOfMatcher(m)) {
    if (m.oneOf.length === 0 || !m.oneOf.every((x) => typeof x === 'string')) {
      throw new ValidationError(`${where}: "oneOf" must be a non-empty array of strings`)
    }
    return
  }
  throw new ValidationError(
    `${where}: matcher must be string | RegExp | SerializedRegex | { oneOf }`,
  )
}

function assertPredicate(value: unknown, where: string): asserts value is SpanPredicate {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${where}: predicate must be an object, got ${typeof value}`)
  }
  const p = value as SpanPredicate
  for (const field of ['name', 'tool', 'model'] as const) {
    if (p[field] !== undefined) assertMatcher(p[field], `${where} "${field}"`)
  }
  if (p.kind !== undefined && !(SPAN_KINDS as readonly string[]).includes(p.kind)) {
    throw new ValidationError(`${where}: "kind" must be one of ${SPAN_KINDS.join(', ')}`)
  }
  if (
    p.attr !== undefined &&
    (p.attr === null || typeof p.attr !== 'object' || Array.isArray(p.attr))
  ) {
    throw new ValidationError(`${where}: "attr" must be a plain object`)
  }
  for (const [key, expected] of Object.entries(p.attr ?? {})) {
    if (isSerializedRegex(expected)) assertMatcher(expected, `${where} attr "${key}"`)
  }
  if (p.not !== undefined) assertPredicate(p.not, `${where} "not"`)
  if (p.requiresCustom && typeof p.custom !== 'function') {
    throw new ValidationError(
      `${where}: rule was built with a custom predicate function, which does not survive JSON ` +
        'serialization — re-attach `custom` after deserializing or drop the rule',
    )
  }
  const hasAttr = p.attr !== undefined && Object.keys(p.attr).length > 0
  if (
    p.name === undefined &&
    p.tool === undefined &&
    p.model === undefined &&
    p.kind === undefined &&
    p.not === undefined &&
    !hasAttr &&
    typeof p.custom !== 'function'
  ) {
    throw new ValidationError(
      `${where}: empty predicate would match every span — specify name, tool, model, kind, attr, not, or custom`,
    )
  }
}

function predicateMatches(span: ContractSpan, p: SpanPredicate): boolean {
  if (p.kind !== undefined && contractSpanKind(span) !== p.kind) return false
  if (p.name !== undefined && !matchText(span.name, p.name)) return false
  if (p.tool !== undefined && !matchText(contractSpanToolName(span), p.tool)) return false
  if (p.model !== undefined && !matchText(spanModel(span), p.model)) return false
  if (p.attr !== undefined) {
    for (const [key, expected] of Object.entries(p.attr)) {
      const actual = span.attributes?.[key]
      if (isRegexValue(expected)) {
        if (!matchText(typeof actual === 'string' ? actual : undefined, expected)) return false
      } else if (actual !== expected) {
        return false
      }
    }
  }
  if (p.not !== undefined && predicateMatches(span, p.not)) return false
  if (p.custom !== undefined && !p.custom(span)) return false
  return true
}

/** Test one span against one predicate. All specified fields must match. */
export function matchSpan(span: ContractSpan, predicate: SpanPredicate): boolean {
  assertPredicate(predicate, 'matchSpan')
  return predicateMatches(span, predicate)
}

// ── Descriptions ──────────────────────────────────────────────────────

function describeMatcher(m: TextMatcher): string {
  if (typeof m === 'string') return m
  if (m instanceof RegExp) return `/${m.source}/${m.flags}`
  if (isOneOfMatcher(m)) return `oneOf(${m.oneOf.join('|')})`
  return `/${m.$regex}/${m.flags}`
}

export function describePredicate(p: SpanPredicate): string {
  const parts: string[] = []
  if (p.kind !== undefined) parts.push(`kind=${p.kind}`)
  if (p.name !== undefined) parts.push(`name=${describeMatcher(p.name)}`)
  if (p.tool !== undefined) parts.push(`tool=${describeMatcher(p.tool)}`)
  if (p.model !== undefined) parts.push(`model=${describeMatcher(p.model)}`)
  if (p.attr !== undefined) {
    for (const [k, v] of Object.entries(p.attr)) {
      parts.push(`attr.${k}=${isRegexValue(v) ? describeMatcher(v) : JSON.stringify(v)}`)
    }
  }
  if (p.not !== undefined) parts.push(`not(${describePredicate(p.not)})`)
  if (typeof p.custom === 'function') parts.push(`custom=${p.custom.name || 'fn'}`)
  return parts.join(',')
}

function describeCheck(check: ArgumentCheck): string {
  switch (check.op) {
    case 'exists':
      return 'exists'
    case 'equals':
      return `equals ${JSON.stringify(check.value)}`
    case 'oneOf':
      return `oneOf ${JSON.stringify(check.values)}`
    case 'type':
      return `type ${check.type}`
  }
}

/** One line per rule, stating what it requires. */
export function describeRule(rule: ContractRule): string {
  switch (rule.kind) {
    case 'always':
      return `every span matches ${describePredicate(rule.p)}`
    case 'never':
      return `no span matches ${describePredicate(rule.p)}`
    case 'eventually':
      return `some span matches ${describePredicate(rule.p)}`
    case 'precedes':
      return `${describePredicate(rule.a)} and ${describePredicate(rule.b)} both occur, and the first comes before the second (${rule.order ?? 'start-order'})`
    case 'neverUnless':
      return `every ${describePredicate(rule.p)} has an earlier ${describePredicate(rule.prior)} (${rule.order ?? 'start-order'})`
    case 'atMost':
      return `at most ${rule.max} span(s) match ${describePredicate(rule.p)}`
    case 'tokensAtMost':
      return `spans matching ${describePredicate(rule.p)} use at most ${rule.max} tokens in total`
    case 'run': {
      const parts: string[] = []
      if (rule.requireCompleted) parts.push('the run reached a terminal status')
      if (rule.allowedStatuses)
        parts.push(`its status is one of ${rule.allowedStatuses.join(', ')}`)
      if (rule.maxDurationMs !== undefined) parts.push(`it took at most ${rule.maxDurationMs} ms`)
      return parts.join('; ')
    }
    case 'argument':
      return `${rule.occurrence ?? 'all'} call(s) matching ${describePredicate(rule.p)} have argument ${rule.pointer || '(whole value)'} that ${describeCheck(rule.check)}`
  }
}

// ── Builder ───────────────────────────────────────────────────────────

function normalizeMatcher(m: TextMatcher): Exclude<TextMatcher, RegExp> {
  if (m instanceof RegExp) return { $regex: m.source, flags: m.flags }
  if (isOneOfMatcher(m)) return { oneOf: [...m.oneOf] }
  return m
}

function normalizePredicate(p: SpanPredicate, where: string): SpanPredicate {
  const kind = typeof p?.kind === 'string' ? (p.kind.toUpperCase() as SpanKind) : p?.kind
  const withKind = kind === undefined ? p : { ...p, kind }
  assertPredicate(withKind, where)
  const out: SpanPredicate = {}
  if (withKind.kind !== undefined) out.kind = withKind.kind
  if (withKind.name !== undefined) out.name = normalizeMatcher(withKind.name)
  if (withKind.tool !== undefined) out.tool = normalizeMatcher(withKind.tool)
  if (withKind.model !== undefined) out.model = normalizeMatcher(withKind.model)
  if (withKind.attr !== undefined) {
    out.attr = Object.fromEntries(
      Object.entries(withKind.attr).map(([k, v]) => [
        k,
        v instanceof RegExp ? normalizeMatcher(v) : v,
      ]),
    )
  }
  if (withKind.not !== undefined) out.not = normalizePredicate(withKind.not, `${where} "not"`)
  if (typeof withKind.custom === 'function') {
    out.custom = withKind.custom
    out.requiresCustom = true
  }
  return out
}

export interface OrderOptions {
  order?: OrderMode
}

export interface ArgumentRuleOptions {
  pointer: string
  check: ArgumentCheck
  occurrence?: ArgumentOccurrence
}

export class TraceContractBuilder {
  private readonly rules: ContractRule[] = []
  private readonly alternativeList: ContractAlternative[] = []
  private scopeRoot: SpanPredicate | undefined

  constructor(private readonly name: string) {}

  /** Every span in the trace must satisfy `p`. */
  always(p: SpanPredicate, label?: string): this {
    const np = normalizePredicate(p, this.where('always'))
    return this.add({ kind: 'always', label: label ?? `always(${describePredicate(np)})`, p: np })
  }

  /** No span in the trace may satisfy `p`. */
  never(p: SpanPredicate, label?: string): this {
    const np = normalizePredicate(p, this.where('never'))
    return this.add({ kind: 'never', label: label ?? `never(${describePredicate(np)})`, p: np })
  }

  /** At least one span in the trace must satisfy `p`. */
  eventually(p: SpanPredicate, label?: string): this {
    const np = normalizePredicate(p, this.where('eventually'))
    return this.add({
      kind: 'eventually',
      label: label ?? `eventually(${describePredicate(np)})`,
      p: np,
    })
  }

  /** Both `a` and `b` must occur, with `a` first under `options.order`
   *  (default `start-order`). For "every `b` needs an earlier `a`, and a run
   *  without `b` passes", use {@link neverUnless}. */
  precedes(a: SpanPredicate, b: SpanPredicate, label?: string, options: OrderOptions = {}): this {
    const na = normalizePredicate(a, this.where('precedes (a)'))
    const nb = normalizePredicate(b, this.where('precedes (b)'))
    const order = assertOrder(options.order, this.where('precedes'))
    return this.add({
      kind: 'precedes',
      label: label ?? `precedes(${describePredicate(na)} -> ${describePredicate(nb)})`,
      a: na,
      b: nb,
      ...(order === undefined ? {} : { order }),
    })
  }

  /** Every `p`-match needs an earlier `prior`-match; a run without `p` passes. */
  neverUnless(
    p: SpanPredicate,
    prior: SpanPredicate,
    label?: string,
    options: OrderOptions = {},
  ): this {
    const np = normalizePredicate(p, this.where('neverUnless (p)'))
    const nprior = normalizePredicate(prior, this.where('neverUnless (prior)'))
    const order = assertOrder(options.order, this.where('neverUnless'))
    return this.add({
      kind: 'neverUnless',
      label: label ?? `neverUnless(${describePredicate(np)} unless ${describePredicate(nprior)})`,
      p: np,
      prior: nprior,
      ...(order === undefined ? {} : { order }),
    })
  }

  /** At most `max` spans may satisfy `p`. */
  atMost(p: SpanPredicate, max: number, label?: string): this {
    const np = normalizePredicate(p, this.where('atMost'))
    assertCount(max, this.where('atMost'))
    return this.add({
      kind: 'atMost',
      label: label ?? `atMost(${describePredicate(np)}, ${max})`,
      p: np,
      max,
    })
  }

  /** Spans satisfying `p` may use at most `max` input+output tokens in total. */
  tokensAtMost(p: SpanPredicate, max: number, label?: string): this {
    const np = normalizePredicate(p, this.where('tokensAtMost'))
    assertCount(max, this.where('tokensAtMost'))
    return this.add({
      kind: 'tokensAtMost',
      label: label ?? `tokensAtMost(${describePredicate(np)}, ${max})`,
      p: np,
      max,
    })
  }

  /** Terminal status and duration of the run. */
  run(checks: RunChecks, label = 'run'): this {
    const rule: ContractRule = { kind: 'run', label, ...checks }
    assertRule(rule, this.where('run'))
    return this.add(rule)
  }

  /** A JSON Pointer check on the arguments of calls matching `p`. */
  argument(p: SpanPredicate, options: ArgumentRuleOptions, label?: string): this {
    const np = normalizePredicate(p, this.where('argument'))
    const rule: ContractRule = {
      kind: 'argument',
      label:
        label ??
        `argument(${describePredicate(np)}, ${options.pointer || '(whole value)'} ${describeCheck(options.check)})`,
      p: np,
      pointer: options.pointer,
      check: options.check,
      ...(options.occurrence === undefined ? {} : { occurrence: options.occurrence }),
    }
    assertRule(rule, this.where('argument'))
    return this.add(rule)
  }

  /** Evaluate only the subtree rooted at the one span matching `root`. */
  scope(root: SpanPredicate): this {
    this.scopeRoot = normalizePredicate(root, this.where('scope'))
    return this
  }

  /** A named alternate path; at least one alternative must pass completely. */
  alternative(id: string, define: (branch: TraceContractBuilder) => TraceContractBuilder): this {
    const branch = define(new TraceContractBuilder(`${this.name}/${id}`))
    if (branch.scopeRoot !== undefined || branch.alternativeList.length > 0) {
      throw new ValidationError(
        `${this.where('alternative')}: alternatives cannot nest scope or alternatives`,
      )
    }
    this.alternativeList.push({ id, rules: [...branch.rules] })
    return this
  }

  build(): TraceContract {
    const contract: TraceContract = {
      name: this.name,
      ...(this.scopeRoot === undefined ? {} : { scope: { root: this.scopeRoot } }),
      rules: [...this.rules],
      ...(this.alternativeList.length === 0 ? {} : { alternatives: [...this.alternativeList] }),
    }
    assertContract(contract, `traceContract("${this.name}").build()`)
    return contract
  }

  private where(op: string): string {
    return `traceContract("${this.name}").${op}`
  }

  private add(rule: ContractRule): this {
    // Labels key per-rule scores — auto-suffix duplicates so two identical
    // operator+predicate rules never collapse into one score entry.
    let label = rule.label
    let n = 2
    while (this.rules.some((r) => r.label === label)) {
      label = `${rule.label} #${n}`
      n += 1
    }
    this.rules.push({ ...rule, label })
    return this
  }
}

export function traceContract(name: string): TraceContractBuilder {
  if (typeof name !== 'string' || name.length === 0) {
    throw new ValidationError('traceContract: name must be a non-empty string')
  }
  return new TraceContractBuilder(name)
}

// ── Validation ────────────────────────────────────────────────────────

function assertOrder(order: unknown, where: string): OrderMode | undefined {
  if (order === undefined) return undefined
  if (!(ORDER_MODES as readonly unknown[]).includes(order)) {
    throw new ValidationError(`${where}: order must be one of ${ORDER_MODES.join(', ')}`)
  }
  return order as OrderMode
}

function assertCount(max: unknown, where: string): void {
  if (typeof max !== 'number' || !Number.isInteger(max) || max < 0) {
    throw new ValidationError(`${where}: max must be a non-negative integer`)
  }
}

function assertJsonPointer(pointer: unknown, where: string): void {
  if (typeof pointer !== 'string' || (pointer !== '' && !pointer.startsWith('/'))) {
    throw new ValidationError(`${where}: pointer must be an RFC 6901 JSON Pointer ('' or '/a/b')`)
  }
  if (/~(?![01])/.test(pointer)) {
    throw new ValidationError(`${where}: pointer has an invalid escape; use ~0 for ~ and ~1 for /`)
  }
}

function assertArgumentCheck(check: unknown, where: string): void {
  const c = check as ArgumentCheck
  if (c === null || typeof c !== 'object') {
    throw new ValidationError(`${where}: check must be an object`)
  }
  switch (c.op) {
    case 'exists':
      return
    case 'equals':
      if (!('value' in c)) throw new ValidationError(`${where}: equals needs a value`)
      return
    case 'oneOf':
      if (!Array.isArray(c.values) || c.values.length === 0) {
        throw new ValidationError(`${where}: oneOf needs a non-empty values array`)
      }
      return
    case 'type':
      if (!(ARGUMENT_TYPES as readonly string[]).includes(c.type)) {
        throw new ValidationError(`${where}: type must be one of ${ARGUMENT_TYPES.join(', ')}`)
      }
      return
    default:
      throw new ValidationError(`${where}: check.op must be exists, equals, oneOf, or type`)
  }
}

function assertRule(rule: ContractRule, where: string): void {
  switch (rule.kind) {
    case 'always':
    case 'never':
    case 'eventually':
      assertPredicate(rule.p, `${where} (p)`)
      return
    case 'precedes':
      assertPredicate(rule.a, `${where} (a)`)
      assertPredicate(rule.b, `${where} (b)`)
      assertOrder(rule.order, where)
      return
    case 'neverUnless':
      assertPredicate(rule.p, `${where} (p)`)
      assertPredicate(rule.prior, `${where} (prior)`)
      assertOrder(rule.order, where)
      return
    case 'atMost':
    case 'tokensAtMost':
      assertPredicate(rule.p, `${where} (p)`)
      assertCount(rule.max, where)
      return
    case 'run': {
      if (
        rule.requireCompleted === undefined &&
        rule.allowedStatuses === undefined &&
        rule.maxDurationMs === undefined
      ) {
        throw new ValidationError(`${where}: run rule checks nothing`)
      }
      if (rule.requireCompleted !== undefined && typeof rule.requireCompleted !== 'boolean') {
        throw new ValidationError(`${where}: requireCompleted must be a boolean`)
      }
      if (rule.allowedStatuses !== undefined) {
        if (!Array.isArray(rule.allowedStatuses) || rule.allowedStatuses.length === 0) {
          throw new ValidationError(`${where}: allowedStatuses must be a non-empty array`)
        }
        for (const status of rule.allowedStatuses) {
          if (!RUN_STATUSES.includes(status)) {
            throw new ValidationError(
              `${where}: unknown run status "${String(status)}" — expected one of ${RUN_STATUSES.join(', ')}`,
            )
          }
        }
      }
      if (
        rule.maxDurationMs !== undefined &&
        (typeof rule.maxDurationMs !== 'number' ||
          !Number.isFinite(rule.maxDurationMs) ||
          rule.maxDurationMs <= 0)
      ) {
        throw new ValidationError(`${where}: maxDurationMs must be a positive number`)
      }
      return
    }
    case 'argument':
      assertPredicate(rule.p, `${where} (p)`)
      assertJsonPointer(rule.pointer, where)
      assertArgumentCheck(rule.check, where)
      if (
        rule.occurrence !== undefined &&
        !(ARGUMENT_OCCURRENCES as readonly string[]).includes(rule.occurrence)
      ) {
        throw new ValidationError(
          `${where}: occurrence must be one of ${ARGUMENT_OCCURRENCES.join(', ')}`,
        )
      }
      return
    default:
      throw new ValidationError(
        `${where}: unknown rule kind "${String((rule as { kind?: unknown }).kind)}"`,
      )
  }
}

function assertRules(rules: unknown, where: string): void {
  if (!Array.isArray(rules) || rules.length === 0) {
    throw new ValidationError(`${where}: no rules — an empty contract would vacuously pass`)
  }
  const seen = new Set<string>()
  for (const rule of rules as ContractRule[]) {
    const ruleWhere = `${where} rule "${rule?.label ?? '<unlabeled>'}"`
    if (typeof rule?.label !== 'string' || rule.label.length === 0) {
      throw new ValidationError(`${ruleWhere}: label must be a non-empty string`)
    }
    if (seen.has(rule.label)) {
      throw new ValidationError(`${ruleWhere}: duplicate label would collapse per-rule scores`)
    }
    seen.add(rule.label)
    assertRule(rule, ruleWhere)
  }
}

/** Throws `ValidationError` when `contract` is not a well-formed contract. */
export function assertTraceContract(contract: TraceContract): void {
  assertContract(contract, 'trace contract')
}

function assertContract(contract: TraceContract, where: string): void {
  if (typeof contract?.name !== 'string' || contract.name.length === 0) {
    throw new ValidationError(`${where}: contract.name must be a non-empty string`)
  }
  const at = `${where} "${contract.name}"`
  assertRules(contract.rules, at)
  if (contract.scope !== undefined) assertPredicate(contract.scope?.root, `${at} scope.root`)
  if (contract.alternatives !== undefined) {
    if (!Array.isArray(contract.alternatives) || contract.alternatives.length === 0) {
      throw new ValidationError(`${at}: alternatives must be a non-empty array`)
    }
    const ids = new Set<string>()
    for (const alternative of contract.alternatives) {
      if (typeof alternative?.id !== 'string' || alternative.id.length === 0) {
        throw new ValidationError(`${at}: every alternative needs a non-empty id`)
      }
      if (ids.has(alternative.id)) {
        throw new ValidationError(`${at}: duplicate alternative id "${alternative.id}"`)
      }
      ids.add(alternative.id)
      assertRules(alternative.rules, `${at} alternative "${alternative.id}"`)
    }
  }
}

// ── Evaluation ────────────────────────────────────────────────────────

interface RuleContext {
  spans: readonly ContractSpan[]
  run: { run: ContractRun } | { unknown: string }
}

interface RuleOutcome {
  status: ContractStatus
  violations: ContractViolation[]
  error?: string
}

function spanRef(span: ContractSpan, index: number): string {
  return span.spanId ?? `#${index}`
}

function indexed(
  spans: readonly ContractSpan[],
  p: SpanPredicate,
): Array<{ span: ContractSpan; ref: string }> {
  const out: Array<{ span: ContractSpan; ref: string }> = []
  spans.forEach((span, i) => {
    if (predicateMatches(span, p)) out.push({ span, ref: spanRef(span, i) })
  })
  return out
}

type Witness = { ok: true } | { ok: false; detail: string }

/**
 * Is guarded span `b` preceded by the guard spans under `order`? A span never
 * witnesses itself. Missing timestamps fail: the checker cannot prove an
 * order it cannot see.
 */
function witnessed(
  b: { span: ContractSpan; ref: string },
  guards: ReadonlyArray<{ span: ContractSpan; ref: string }>,
  order: OrderMode,
): Witness {
  const bStart = finite(b.span.startedAt)
  if (bStart === undefined) {
    return { ok: false, detail: `span ${b.ref} has no startedAt, so its order cannot be proven` }
  }
  const candidates = guards.filter((a) => a.span !== b.span)
  if (candidates.length === 0) return { ok: false, detail: `span ${b.ref} has no earlier match` }
  const boundary = order === 'start-order' ? 'startedAt' : 'endedAt'
  const untimed = candidates.find((a) => finite(a.span[boundary]) === undefined)
  if (order === 'all-occurrences') {
    if (untimed) {
      return {
        ok: false,
        detail: `span ${untimed.ref} has no endedAt, so its order cannot be proven`,
      }
    }
    const late = candidates.find((a) => a.span.endedAt! > bStart)
    return late
      ? { ok: false, detail: `span ${late.ref} ends after span ${b.ref} starts` }
      : { ok: true }
  }
  const earlier = candidates.some((a) => {
    const t = finite(a.span[boundary])
    return t !== undefined && (order === 'start-order' ? t < bStart : t <= bStart)
  })
  if (earlier) return { ok: true }
  if (untimed) {
    return {
      ok: false,
      detail: `span ${untimed.ref} has no ${boundary}, so its order cannot be proven`,
    }
  }
  return {
    ok: false,
    detail:
      order === 'start-order'
        ? `span ${b.ref} has no match that started before it`
        : `span ${b.ref} has no match that finished before it started`,
  }
}

function orderViolations(
  label: string,
  guards: ReadonlyArray<{ span: ContractSpan; ref: string }>,
  guarded: ReadonlyArray<{ span: ContractSpan; ref: string }>,
  order: OrderMode,
  describe: string,
): ContractViolation[] {
  const out: ContractViolation[] = []
  for (const b of guarded) {
    const w = witnessed(b, guards, order)
    if (!w.ok) out.push({ rule: label, spanId: b.span.spanId, detail: `${describe}: ${w.detail}` })
  }
  return out
}

/** RFC 6901 resolution. `found: false` when any reference token is absent. */
function resolveJsonPointer(value: unknown, pointer: string): { found: boolean; value?: unknown } {
  if (pointer === '') return { found: true, value }
  let current: unknown = value
  for (const raw of pointer.slice(1).split('/')) {
    const token = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (Array.isArray(current)) {
      if (!/^(?:0|[1-9]\d*)$/.test(token) || Number(token) >= current.length)
        return { found: false }
      current = current[Number(token)]
    } else if (current !== null && typeof current === 'object' && Object.hasOwn(current, token)) {
      current = (current as Record<string, unknown>)[token]
    } else {
      return { found: false }
    }
  }
  return { found: true, value: current }
}

function jsonType(value: unknown): ArgumentType | 'undefined' {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'array'
  const t = typeof value
  return t === 'string' || t === 'number' || t === 'boolean' || t === 'object' ? t : 'undefined'
}

function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true
  const ta = jsonType(a)
  if (ta !== jsonType(b)) return false
  if (ta === 'array') {
    const x = a as unknown[]
    const y = b as unknown[]
    return x.length === y.length && x.every((v, i) => jsonEqual(v, y[i]))
  }
  if (ta === 'object') {
    const x = a as Record<string, unknown>
    const y = b as Record<string, unknown>
    const keys = Object.keys(x)
    return (
      keys.length === Object.keys(y).length &&
      keys.every((k) => Object.hasOwn(y, k) && jsonEqual(x[k], y[k]))
    )
  }
  return false
}

/** Why `value` fails `check`, or `undefined` when it passes. Never echoes the
 *  actual argument value: arguments can carry customer data. */
function argumentFailure(
  evidence: ArgumentEvidence,
  pointer: string,
  check: ArgumentCheck,
): string | undefined {
  if (!evidence.known) return evidence.reason
  const resolved = resolveJsonPointer(evidence.value, pointer)
  if (!resolved.found) return `argument ${pointer || '(whole value)'} is absent`
  switch (check.op) {
    case 'exists':
      return undefined
    case 'equals':
      return jsonEqual(resolved.value, check.value)
        ? undefined
        : `argument ${pointer || '(whole value)'} (a ${jsonType(resolved.value)}) does not equal the expected value`
    case 'oneOf':
      return check.values.some((v) => jsonEqual(resolved.value, v))
        ? undefined
        : `argument ${pointer || '(whole value)'} (a ${jsonType(resolved.value)}) is not one of the expected values`
    case 'type':
      return jsonType(resolved.value) === check.type
        ? undefined
        : `argument ${pointer || '(whole value)'} is a ${jsonType(resolved.value)}, not a ${check.type}`
  }
}

function checkArgument(
  rule: Extract<ContractRule, { kind: 'argument' }>,
  spans: readonly ContractSpan[],
): ContractViolation[] {
  const matches = indexed(spans, rule.p)
  if (matches.length === 0) {
    return [
      {
        rule: rule.label,
        detail: `no span matches ${describePredicate(rule.p)}, so there is no argument evidence to check`,
      },
    ]
  }
  const occurrence = rule.occurrence ?? 'all'
  let selected = matches
  if ((occurrence === 'first' || occurrence === 'last') && matches.length > 1) {
    const untimed = matches.find((m) => finite(m.span.startedAt) === undefined)
    if (untimed) {
      return [
        {
          rule: rule.label,
          spanId: untimed.span.spanId,
          detail: `span ${untimed.ref} has no startedAt, so the ${occurrence} call cannot be chosen`,
        },
      ]
    }
    const sorted = [...matches].sort((x, y) => x.span.startedAt! - y.span.startedAt!)
    selected = [occurrence === 'first' ? sorted[0]! : sorted[sorted.length - 1]!]
  }
  const failures = selected.map((m) => ({
    m,
    why: argumentFailure(spanArguments(m.span), rule.pointer, rule.check),
  }))
  const failed = failures.filter((f) => f.why !== undefined)
  if (occurrence === 'any' ? failed.length < failures.length : failed.length === 0) return []
  return failed.map((f) => ({
    rule: rule.label,
    spanId: f.m.span.spanId,
    detail: `span ${f.m.ref}: ${f.why}`,
  }))
}

function checkRun(
  rule: Extract<ContractRule, { kind: 'run' }>,
  context: RuleContext['run'],
): ContractViolation[] {
  if ('unknown' in context) {
    return [{ rule: rule.label, detail: `run record unavailable: ${context.unknown}` }]
  }
  const run = context.run
  const out: ContractViolation[] = []
  if (
    rule.requireCompleted &&
    (run.status === undefined || run.status === 'running' || finite(run.endedAt) === undefined)
  ) {
    out.push({
      rule: rule.label,
      detail: `run did not reach a terminal status (status ${run.status ?? 'unknown'})`,
    })
  }
  if (
    rule.allowedStatuses &&
    !(rule.allowedStatuses as readonly string[]).includes(run.status ?? '')
  ) {
    out.push({
      rule: rule.label,
      detail: `run status ${run.status ?? 'unknown'} is not one of ${rule.allowedStatuses.join(', ')}`,
    })
  }
  if (rule.maxDurationMs !== undefined) {
    const start = finite(run.startedAt)
    const end = finite(run.endedAt)
    if (start === undefined || end === undefined) {
      out.push({
        rule: rule.label,
        detail: 'run duration is unknown: start or end time is missing',
      })
    } else if (end - start > rule.maxDurationMs) {
      out.push({
        rule: rule.label,
        detail: `run took ${end - start} ms, over ${rule.maxDurationMs} ms`,
      })
    }
  }
  return out
}

function checkRule(rule: ContractRule, ctx: RuleContext): ContractViolation[] {
  const { spans } = ctx
  switch (rule.kind) {
    case 'always':
      return spans.flatMap((span, i) =>
        predicateMatches(span, rule.p)
          ? []
          : [
              {
                rule: rule.label,
                spanId: span.spanId,
                detail: `span ${spanRef(span, i)} ("${span.name ?? ''}") fails always(${describePredicate(rule.p)})`,
              },
            ],
      )
    case 'never':
      return indexed(spans, rule.p).map(({ span, ref }) => ({
        rule: rule.label,
        spanId: span.spanId,
        detail: `span ${ref} ("${span.name ?? ''}") matches never(${describePredicate(rule.p)})`,
      }))
    case 'eventually':
      return spans.some((span) => predicateMatches(span, rule.p))
        ? []
        : [
            {
              rule: rule.label,
              detail: `no span matches eventually(${describePredicate(rule.p)}) over ${spans.length} span(s)`,
            },
          ]
    case 'precedes': {
      const as = indexed(spans, rule.a)
      const bs = indexed(spans, rule.b)
      const out: ContractViolation[] = []
      if (as.length === 0) {
        out.push({
          rule: rule.label,
          detail: `required predecessor ${describePredicate(rule.a)} never occurred`,
        })
      }
      if (bs.length === 0) {
        out.push({
          rule: rule.label,
          detail: `required successor ${describePredicate(rule.b)} never occurred`,
        })
      }
      if (out.length > 0) return out
      return orderViolations(
        rule.label,
        as,
        bs,
        rule.order ?? 'start-order',
        `${describePredicate(rule.b)} is not preceded by ${describePredicate(rule.a)}`,
      )
    }
    case 'neverUnless':
      return orderViolations(
        rule.label,
        indexed(spans, rule.prior),
        indexed(spans, rule.p),
        rule.order ?? 'start-order',
        `${describePredicate(rule.p)} without an earlier ${describePredicate(rule.prior)}`,
      )
    case 'atMost': {
      const matches = indexed(spans, rule.p)
      return matches.length <= rule.max
        ? []
        : [
            {
              rule: rule.label,
              spanId: matches[rule.max]?.span.spanId,
              detail: `${matches.length} span(s) match ${describePredicate(rule.p)}, over the limit of ${rule.max}`,
            },
          ]
    }
    case 'tokensAtMost': {
      const matches = indexed(spans, rule.p)
      const unknown = matches.find((m) => spanTotalTokens(m.span) === undefined)
      if (unknown) {
        return [
          {
            rule: rule.label,
            spanId: unknown.span.spanId,
            detail: `span ${unknown.ref} has no recorded input and output token counts, so the total is unknown`,
          },
        ]
      }
      const total = matches.reduce((sum, m) => sum + spanTotalTokens(m.span)!, 0)
      return total <= rule.max
        ? []
        : [
            {
              rule: rule.label,
              detail: `${total} tokens across ${matches.length} span(s) matching ${describePredicate(rule.p)}, over the limit of ${rule.max}`,
            },
          ]
    }
    case 'run':
      return checkRun(rule, ctx.run)
    case 'argument':
      return checkArgument(rule, spans)
  }
}

function executeRule(rule: ContractRule, ctx: RuleContext): RuleOutcome {
  try {
    const violations = checkRule(rule, ctx)
    return { status: violations.length === 0 ? 'pass' : 'fail', violations }
  } catch (error) {
    return {
      status: 'error',
      violations: [],
      error: error instanceof Error ? error.message : String(error),
    }
  }
}

/** A run derived from one span: failed on error status, completed once it ended. */
function runOfSpan(span: ContractSpan): ContractRun {
  return {
    status: isSpanError(span)
      ? 'failed'
      : finite(span.endedAt) !== undefined
        ? 'completed'
        : 'running',
    ...(finite(span.startedAt) === undefined ? {} : { startedAt: span.startedAt }),
    ...(finite(span.endedAt) === undefined ? {} : { endedAt: span.endedAt }),
  }
}

function rootsOf(spans: readonly ContractSpan[]): ContractSpan[] {
  const ids = new Set(
    spans.map((s) => s.spanId).filter((id): id is string => typeof id === 'string'),
  )
  return spans.filter((s) => !s.parentSpanId || !ids.has(s.parentSpanId))
}

function subtree(spans: readonly ContractSpan[], root: ContractSpan): ContractSpan[] {
  if (typeof root.spanId !== 'string') return [root]
  const children = new Map<string, ContractSpan[]>()
  for (const span of spans) {
    if (typeof span.parentSpanId === 'string') {
      const list = children.get(span.parentSpanId) ?? []
      list.push(span)
      children.set(span.parentSpanId, list)
    }
  }
  const members = new Set<ContractSpan>([root])
  const queue = [root]
  while (queue.length > 0) {
    const current = queue.shift()!
    for (const child of (typeof current.spanId === 'string' && children.get(current.spanId)) ||
      []) {
      if (!members.has(child)) {
        members.add(child)
        queue.push(child)
      }
    }
  }
  return spans.filter((s) => members.has(s))
}

function statusOf(outcomes: readonly RuleOutcome[]): ContractStatus {
  if (outcomes.some((o) => o.status === 'error')) return 'error'
  return outcomes.every((o) => o.status === 'pass') ? 'pass' : 'fail'
}

/**
 * Evaluate one contract over a span sequence. Pure and synchronous — works on
 * `Span[]` from a TraceStore, `ExportableSpan[]` from the otel-bridge
 * flattening, or any array satisfying `ContractSpan`. Throws
 * `ValidationError` for a malformed contract; a rule that cannot be evaluated
 * is reported as `error` in the verdict instead.
 */
export function evaluateTraceContract(
  contract: TraceContract,
  spans: readonly ContractSpan[],
  options: EvaluateTraceContractOptions = {},
): ContractVerdict {
  assertContract(contract, 'evaluateTraceContract')
  if (!Array.isArray(spans)) {
    throw new ValidationError(`evaluateTraceContract: spans must be an array, got ${typeof spans}`)
  }
  let subject: readonly ContractSpan[] = spans
  let run: RuleContext['run']
  let scopeError: string | undefined
  if (contract.scope) {
    const roots = spans.filter((s) => predicateMatches(s, contract.scope!.root))
    if (roots.length === 1) {
      subject = subtree(spans, roots[0]!)
      run = { run: runOfSpan(roots[0]!) }
    } else {
      scopeError = `scope root ${describePredicate(contract.scope.root)} matched ${roots.length} spans; exactly one is required`
      run = { unknown: scopeError }
    }
  } else if (options.run) {
    run = { run: options.run }
  } else {
    const roots = rootsOf(spans)
    run =
      roots.length === 1
        ? { run: runOfSpan(roots[0]!) }
        : { unknown: `the trace has ${roots.length} root spans and no run record was passed` }
  }
  const ctx: RuleContext = { spans: subject, run }
  const execute = (rule: ContractRule): RuleOutcome =>
    scopeError === undefined
      ? executeRule(rule, ctx)
      : { status: 'error', violations: [], error: scopeError }

  const base = contract.rules.map(execute)
  const branches = (contract.alternatives ?? []).map((alternative) => ({
    alternative,
    outcomes: alternative.rules.map(execute),
  }))
  const passedBranch = branches.find((b) => statusOf(b.outcomes) === 'pass')

  const baseStatus = statusOf(base)
  let status: ContractStatus = baseStatus
  if (baseStatus === 'pass' && branches.length > 0 && !passedBranch) {
    status = branches.some((b) => statusOf(b.outcomes) === 'error') ? 'error' : 'fail'
  }

  const ruleExecutions: ContractRuleExecution[] = [
    ...contract.rules.map((rule, i) => execution(rule.label, undefined, base[i]!)),
    ...branches.flatMap((b) =>
      b.alternative.rules.map((rule, i) => execution(rule.label, b.alternative.id, b.outcomes[i]!)),
    ),
  ]
  const violations = base.flatMap((o) => o.violations)
  if (branches.length > 0 && !passedBranch) {
    for (const b of branches) {
      for (const o of b.outcomes) {
        violations.push(
          ...o.violations.map((v) => ({ ...v, rule: `${b.alternative.id}/${v.rule}` })),
        )
      }
    }
  }
  const errors = ruleExecutions
    .filter((e) => e.status === 'error')
    .map((e) => `${e.alternative ? `${e.alternative}/` : ''}${e.rule}: ${e.error}`)

  const scores: Record<string, number> = {}
  contract.rules.forEach((rule, i) => {
    const s = base[i]!.status
    if (s !== 'error') scores[rule.label] = s === 'pass' ? 1 : 0
  })
  if (branches.length > 0 && (passedBranch || status !== 'error'))
    scores.anyOf = passedBranch ? 1 : 0
  const total = contract.rules.length + (branches.length > 0 ? 1 : 0)
  const passCount = Object.values(scores).filter((s) => s === 1).length

  const assumptions: string[] = []
  for (const rule of [...contract.rules, ...branches.flatMap((b) => b.alternative.rules)]) {
    if (rulePredicates(rule).some(usesCustom)) {
      assumptions.push(`rule '${rule.label}' rests on a custom predicate function`)
    }
  }
  return {
    contract: contract.name,
    status,
    valid: status === 'pass',
    score: passCount / total,
    scores,
    violations,
    ruleExecutions,
    errors,
    notes:
      `${passCount}/${total} rules passed` +
      (errors.length > 0 ? `; ${errors.length} could not be evaluated` : ''),
    certification: {
      strategy: 'invariant',
      checker: { name: 'agent-eval:trace-contracts', version: packageVersion() },
      assumptions,
      evidenceDigest: certificationEvidenceDigest({
        contract: contract.name,
        status,
        scores,
        violations,
        ruleExecutions,
      }),
    },
  }
}

function execution(
  rule: string,
  alternative: string | undefined,
  outcome: RuleOutcome,
): ContractRuleExecution {
  return {
    rule,
    ...(alternative === undefined ? {} : { alternative }),
    status: outcome.status,
    violations: outcome.violations.length,
    ...(outcome.error === undefined ? {} : { error: outcome.error }),
  }
}

function rulePredicates(rule: ContractRule): SpanPredicate[] {
  switch (rule.kind) {
    case 'precedes':
      return [rule.a, rule.b]
    case 'neverUnless':
      return [rule.p, rule.prior]
    case 'run':
      return []
    default:
      return [rule.p]
  }
}

function usesCustom(p: SpanPredicate): boolean {
  return typeof p.custom === 'function' || (p.not !== undefined && usesCustom(p.not))
}

/**
 * Evaluate many contracts over one span sequence. Throws on an empty
 * contract list — `allValid: true` over zero contracts is a silent pass.
 */
export function checkTraceContracts(
  spans: readonly ContractSpan[],
  contracts: readonly TraceContract[],
  options: EvaluateTraceContractOptions = {},
): ContractCheckResult {
  if (contracts.length === 0) {
    throw new ValidationError(
      'checkTraceContracts: empty contract list would vacuously pass — supply at least one contract',
    )
  }
  const verdicts = contracts.map((c) => evaluateTraceContract(c, spans, options))
  const status: ContractStatus = verdicts.some((v) => v.status === 'error')
    ? 'error'
    : verdicts.every((v) => v.status === 'pass')
      ? 'pass'
      : 'fail'
  return { verdicts, status, allValid: status === 'pass' }
}

// ── Campaign judge adapter ────────────────────────────────────────────

export interface ContractJudgeOptions<TArtifact, TScenario extends Scenario = Scenario> {
  /**
   * Project the span sequence out of a cell's artifact. `JudgeConfig.score`
   * receives only `{ artifact, scenario, signal }` (src/campaign/types.ts) —
   * spans are NOT reachable generically — so the consumer supplies this
   * explicit extraction (e.g. dispatch writes spans into the artifact, or
   * closes over a per-cell TraceStore read).
   */
  spans: (input: { artifact: TArtifact; scenario: TScenario }) => readonly ContractSpan[]
  /** Judge name in campaign reports. Default 'trace-contracts'. */
  name?: string
}

/**
 * Adapt trace contracts to a campaign `JudgeConfig`. One judge dimension per
 * contract (key = contract name, value = its rule-pass fraction); composite
 * is the mean across contracts. Deterministic — no LLM call. A contract that
 * could not be evaluated throws instead of scoring, so an unknown never
 * reaches a campaign as a number.
 */
export function contractJudge<TArtifact, TScenario extends Scenario = Scenario>(
  contracts: readonly TraceContract[],
  opts: ContractJudgeOptions<TArtifact, TScenario>,
): JudgeConfig<TArtifact, TScenario> {
  if (contracts.length === 0) {
    throw new ValidationError('contractJudge: at least one contract required')
  }
  for (const c of contracts) assertContract(c, 'contractJudge')
  const names = new Set<string>()
  for (const c of contracts) {
    if (names.has(c.name)) {
      throw new ValidationError(
        `contractJudge: duplicate contract name "${c.name}" would collapse judge dimensions`,
      )
    }
    names.add(c.name)
  }
  if (typeof opts?.spans !== 'function') {
    throw new ValidationError('contractJudge: opts.spans extraction function is required')
  }
  const dimensions: JudgeDimension[] = contracts.map((c) => ({
    key: c.name,
    description: c.rules.map((r) => r.label).join('; '),
  }))
  return {
    name: opts.name ?? 'trace-contracts',
    dimensions,
    score({ artifact, scenario }) {
      const spans = opts.spans({ artifact, scenario })
      if (!Array.isArray(spans)) {
        throw new ValidationError(
          `contractJudge: spans() must return a span array, got ${typeof spans}`,
        )
      }
      const { verdicts } = checkTraceContracts(spans, contracts)
      const errored = verdicts.filter((v) => v.status === 'error')
      if (errored.length > 0) {
        throw new ValidationError(
          `contractJudge: ${errored.map((v) => `contract "${v.contract}" could not be evaluated (${v.errors.join('; ')})`).join('; ')}`,
        )
      }
      const dims: Record<string, number> = {}
      const violations: ContractViolation[] = []
      for (const v of verdicts) {
        dims[v.contract] = v.score
        violations.push(...v.violations)
      }
      const composite = verdicts.reduce((acc, v) => acc + v.score, 0) / verdicts.length
      return {
        dimensions: dims,
        composite,
        notes:
          violations.length === 0
            ? 'all trace contracts satisfied'
            : violations
                .slice(0, 8)
                .map((x) => `${x.rule}: ${x.detail}`)
                .join('\n'),
      }
    },
  }
}
