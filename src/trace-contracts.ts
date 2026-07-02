/**
 * Trace contracts — finite-trace temporal assertions over span sequences.
 *
 * Five LTLf operators over one ordered span sequence — `always(p)`,
 * `never(p)`, `eventually(p)`, `precedes(a, b)`, `neverUnless(p, prior)` —
 * deterministic and judge-free. No nesting: each rule is one operator over
 * flat `SpanPredicate`s; compose richer checks with multiple rules.
 *
 * A built `TraceContract` is a serializable plain object (RegExp matchers
 * are normalized to `SerializedRegex`), so ONE contract definition is
 * dual-use:
 *
 *   - recorded eval traces — `evaluateTraceContract(contract, await
 *     store.spans({ runId }))`, or via the behavior DSL:
 *     `expectAgent(store, runId).toSatisfyContract(contract)`.
 *   - the production OTLP stream — `ExportableSpan`s flattened by
 *     `trace/otel-bridge` satisfy `ContractSpan` structurally. A production
 *     monitor implements `OtelExporter`, buffers `exportSpan` payloads per
 *     trace, and runs `checkTraceContracts(buffer, contracts)` on flush:
 *
 *       const buffer: ContractSpan[] = []
 *       const monitor: OtelExporter = {
 *         exportSpan: (s) => { buffer.push(s) },
 *         flush: async () => {
 *           const { allValid, verdicts } = checkTraceContracts(buffer, contracts)
 *           if (!allValid) alert(verdicts)
 *         },
 *         shutdown: async () => {},
 *       }
 *       const store = createOtelTracingStore(inner, monitor, runId)
 *
 * `custom` predicate functions are the one non-serializable escape hatch:
 * the builder stamps `requiresCustom: true` (which DOES survive JSON) so a
 * deserialized contract that lost its function fails loud at evaluation
 * instead of silently weakening.
 *
 * Naming: the root barrel exports ci-gate's threshold-contract
 * `evaluateContract`, so the evaluators here are `evaluateTraceContract` /
 * `checkTraceContracts`.
 */

import type { JudgeConfig, JudgeDimension, Scenario } from './campaign/types'
import { ValidationError } from './errors'
import type { DefaultVerdict } from './verdict'

// ── Span surface ──────────────────────────────────────────────────────

/**
 * Minimal structural span the checker reads. Both the eval-side `Span`
 * (trace/schema) and the OTLP-flattened `ExportableSpan` (trace/otel-export)
 * satisfy it; any other producer only needs these fields.
 */
export interface ContractSpan {
  spanId?: string
  name?: string
  kind?: string
  startedAt?: number
  status?: string
  error?: string
  /** Typed field on eval-side ToolSpans; OTLP flattenings drop it (see
   *  `tool` matching order in {@link matchSpan}). */
  toolName?: string
  attributes?: Record<string, unknown>
}

/** JSON-safe RegExp form — what the builder normalizes RegExp matchers to. */
export interface SerializedRegex {
  $regex: string
  flags: string
}

export type TextMatcher = string | RegExp | SerializedRegex

/**
 * Proposition over one span. All specified fields must match (AND).
 * At least one field is required — an empty predicate would match every
 * span and is rejected.
 *
 * `tool` resolution order covers both span shapes: `span.toolName` (typed
 * ToolSpan) → `attributes['tool.name']` / `attributes['toolName']`
 * (OTLP-flat attribute conventions) → `span.name` when `kind === 'tool'`
 * (otel-bridge's `ExportableSpan`, which drops `toolName`).
 *
 * `attr` values match by strict equality, or regex-test when the value is a
 * RegExp/SerializedRegex and the attribute is a string. Structured attribute
 * values need `custom`.
 */
export interface SpanPredicate {
  name?: TextMatcher
  tool?: TextMatcher
  attr?: Record<string, unknown>
  custom?: (span: ContractSpan) => boolean
  /** Stamped by the builder when `custom` is present. Survives JSON while
   *  the function does not, so evaluation of a deserialized contract throws
   *  instead of silently dropping the check. */
  requiresCustom?: true
}

// ── Contract shape ────────────────────────────────────────────────────

export type ContractRuleKind = 'always' | 'never' | 'eventually' | 'precedes' | 'neverUnless'

export interface ContractRule {
  kind: ContractRuleKind
  /** Unique within the contract — keys the per-rule score. */
  label: string
  /** Subject predicate for always / never / eventually / neverUnless. */
  p?: SpanPredicate
  /** precedes: the required precondition. */
  a?: SpanPredicate
  /** precedes: the guarded match — every b-match needs an earlier a-match. */
  b?: SpanPredicate
  /** neverUnless: the authorizing earlier match. */
  prior?: SpanPredicate
}

/** Serializable plain object — `traceContract(name)....build()` output. */
export interface TraceContract {
  name: string
  rules: ContractRule[]
}

export interface ContractViolation {
  rule: string
  spanId?: string
  detail: string
}

export interface ContractVerdict extends DefaultVerdict {
  /** Contract name — keys this verdict in multi-contract reports. */
  contract: string
  valid: boolean
  /** Fraction of rules passing, in [0, 1]. */
  score: number
  /** Per-rule 0|1 keyed by rule label. */
  scores: Record<string, number>
  violations: ContractViolation[]
}

export interface ContractCheckResult {
  verdicts: ContractVerdict[]
  allValid: boolean
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

function matchText(actual: string | undefined, matcher: TextMatcher): boolean {
  if (typeof actual !== 'string') return false
  if (typeof matcher === 'string') return actual === matcher
  if (matcher instanceof RegExp) return matcher.test(actual)
  return new RegExp(matcher.$regex, matcher.flags).test(actual)
}

function resolveToolName(span: ContractSpan): string | undefined {
  if (typeof span.toolName === 'string') return span.toolName
  const fromAttr = span.attributes?.['tool.name'] ?? span.attributes?.toolName
  if (typeof fromAttr === 'string') return fromAttr
  if (span.kind === 'tool' && typeof span.name === 'string') return span.name
  return undefined
}

function assertPredicate(value: unknown, where: string): asserts value is SpanPredicate {
  if (value === null || typeof value !== 'object') {
    throw new ValidationError(`${where}: predicate must be an object, got ${typeof value}`)
  }
  const p = value as SpanPredicate
  for (const field of ['name', 'tool'] as const) {
    const m = p[field]
    if (
      m !== undefined &&
      typeof m !== 'string' &&
      !(m instanceof RegExp) &&
      !isSerializedRegex(m)
    ) {
      throw new ValidationError(`${where}: "${field}" must be string | RegExp | SerializedRegex`)
    }
  }
  if (
    p.attr !== undefined &&
    (p.attr === null || typeof p.attr !== 'object' || Array.isArray(p.attr))
  ) {
    throw new ValidationError(`${where}: "attr" must be a plain object`)
  }
  if (p.requiresCustom && typeof p.custom !== 'function') {
    throw new ValidationError(
      `${where}: rule was built with a custom predicate function, which does not survive JSON ` +
        'serialization — re-attach `custom` after deserializing or drop the rule',
    )
  }
  const hasAttr = p.attr !== undefined && Object.keys(p.attr).length > 0
  if (p.name === undefined && p.tool === undefined && !hasAttr && typeof p.custom !== 'function') {
    throw new ValidationError(
      `${where}: empty predicate would match every span — specify name, tool, attr, or custom`,
    )
  }
}

/** Test one span against one predicate. All specified fields must match. */
export function matchSpan(span: ContractSpan, predicate: SpanPredicate): boolean {
  assertPredicate(predicate, 'matchSpan')
  if (predicate.name !== undefined && !matchText(span.name, predicate.name)) return false
  if (predicate.tool !== undefined && !matchText(resolveToolName(span), predicate.tool))
    return false
  if (predicate.attr !== undefined) {
    for (const [key, expected] of Object.entries(predicate.attr)) {
      const actual = span.attributes?.[key]
      if (expected instanceof RegExp || isSerializedRegex(expected)) {
        if (!matchText(typeof actual === 'string' ? actual : undefined, expected as TextMatcher)) {
          return false
        }
      } else if (actual !== expected) {
        return false
      }
    }
  }
  if (predicate.custom !== undefined && !predicate.custom(span)) return false
  return true
}

// ── Builder ───────────────────────────────────────────────────────────

function describeMatcher(m: TextMatcher): string {
  if (typeof m === 'string') return m
  if (m instanceof RegExp) return `/${m.source}/${m.flags}`
  return `/${m.$regex}/${m.flags}`
}

function describePredicate(p: SpanPredicate): string {
  const parts: string[] = []
  if (p.name !== undefined) parts.push(`name=${describeMatcher(p.name)}`)
  if (p.tool !== undefined) parts.push(`tool=${describeMatcher(p.tool)}`)
  if (p.attr !== undefined) {
    for (const [k, v] of Object.entries(p.attr)) {
      parts.push(
        `attr.${k}=${v instanceof RegExp || isSerializedRegex(v) ? describeMatcher(v as TextMatcher) : JSON.stringify(v)}`,
      )
    }
  }
  if (typeof p.custom === 'function') parts.push(`custom=${p.custom.name || 'fn'}`)
  return parts.join(',')
}

function normalizeMatcher(m: TextMatcher): string | SerializedRegex {
  return m instanceof RegExp ? { $regex: m.source, flags: m.flags } : m
}

function normalizePredicate(p: SpanPredicate, where: string): SpanPredicate {
  assertPredicate(p, where)
  const out: SpanPredicate = {}
  if (p.name !== undefined) out.name = normalizeMatcher(p.name)
  if (p.tool !== undefined) out.tool = normalizeMatcher(p.tool)
  if (p.attr !== undefined) {
    out.attr = Object.fromEntries(
      Object.entries(p.attr).map(([k, v]) => [k, v instanceof RegExp ? normalizeMatcher(v) : v]),
    )
  }
  if (typeof p.custom === 'function') {
    out.custom = p.custom
    out.requiresCustom = true
  }
  return out
}

export class TraceContractBuilder {
  private readonly rules: ContractRule[] = []

  constructor(private readonly name: string) {}

  /** Every span in the trace must satisfy `p`. */
  always(p: SpanPredicate, label?: string): this {
    const np = normalizePredicate(p, `traceContract("${this.name}").always`)
    return this.add({ kind: 'always', label: label ?? `always(${describePredicate(np)})`, p: np })
  }

  /** No span in the trace may satisfy `p`. */
  never(p: SpanPredicate, label?: string): this {
    const np = normalizePredicate(p, `traceContract("${this.name}").never`)
    return this.add({ kind: 'never', label: label ?? `never(${describePredicate(np)})`, p: np })
  }

  /** At least one span in the trace must satisfy `p`. */
  eventually(p: SpanPredicate, label?: string): this {
    const np = normalizePredicate(p, `traceContract("${this.name}").eventually`)
    return this.add({
      kind: 'eventually',
      label: label ?? `eventually(${describePredicate(np)})`,
      p: np,
    })
  }

  /** Every `b`-match must have a strictly earlier `a`-match. */
  precedes(a: SpanPredicate, b: SpanPredicate, label?: string): this {
    const na = normalizePredicate(a, `traceContract("${this.name}").precedes (a)`)
    const nb = normalizePredicate(b, `traceContract("${this.name}").precedes (b)`)
    return this.add({
      kind: 'precedes',
      label: label ?? `precedes(${describePredicate(na)} -> ${describePredicate(nb)})`,
      a: na,
      b: nb,
    })
  }

  /** Every `p`-match is a violation unless a strictly earlier `prior`-match exists. */
  neverUnless(p: SpanPredicate, prior: SpanPredicate, label?: string): this {
    const np = normalizePredicate(p, `traceContract("${this.name}").neverUnless (p)`)
    const nprior = normalizePredicate(prior, `traceContract("${this.name}").neverUnless (prior)`)
    return this.add({
      kind: 'neverUnless',
      label: label ?? `neverUnless(${describePredicate(np)} unless ${describePredicate(nprior)})`,
      p: np,
      prior: nprior,
    })
  }

  build(): TraceContract {
    if (this.rules.length === 0) {
      throw new ValidationError(
        `traceContract("${this.name}").build(): no rules — an empty contract would vacuously pass`,
      )
    }
    return { name: this.name, rules: [...this.rules] }
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

// ── Evaluation ────────────────────────────────────────────────────────

function assertContract(contract: TraceContract): void {
  if (typeof contract?.name !== 'string' || contract.name.length === 0) {
    throw new ValidationError('evaluateTraceContract: contract.name must be a non-empty string')
  }
  if (!Array.isArray(contract.rules) || contract.rules.length === 0) {
    throw new ValidationError(
      `evaluateTraceContract: contract "${contract.name}" has no rules — an empty contract would vacuously pass`,
    )
  }
  const seen = new Set<string>()
  for (const rule of contract.rules) {
    const where = `contract "${contract.name}" rule "${rule?.label ?? '<unlabeled>'}"`
    if (typeof rule?.label !== 'string' || rule.label.length === 0) {
      throw new ValidationError(`${where}: label must be a non-empty string`)
    }
    if (seen.has(rule.label)) {
      throw new ValidationError(`${where}: duplicate label would collapse per-rule scores`)
    }
    seen.add(rule.label)
    switch (rule.kind) {
      case 'always':
      case 'never':
      case 'eventually':
        assertPredicate(rule.p, `${where} (p)`)
        break
      case 'precedes':
        assertPredicate(rule.a, `${where} (a)`)
        assertPredicate(rule.b, `${where} (b)`)
        break
      case 'neverUnless':
        assertPredicate(rule.p, `${where} (p)`)
        assertPredicate(rule.prior, `${where} (prior)`)
        break
      default:
        throw new ValidationError(
          `${where}: unknown rule kind "${String((rule as ContractRule).kind)}"`,
        )
    }
  }
}

/**
 * Order spans for temporal evaluation: by `startedAt` when EVERY span carries
 * one (stable — ties keep array order), by array order when NONE does. Mixed
 * timestamps throw: neither time order nor array order is a trustworthy total
 * order over a partially-stamped sequence, and guessing would corrupt
 * `precedes` / `neverUnless` verdicts.
 */
function orderSpans(spans: readonly ContractSpan[]): ContractSpan[] {
  const timed = spans.filter(
    (s) => typeof s.startedAt === 'number' && Number.isFinite(s.startedAt),
  ).length
  if (timed === spans.length) {
    return spans
      .map((span, i) => ({ span, i }))
      .sort((x, y) => x.span.startedAt! - y.span.startedAt! || x.i - y.i)
      .map((x) => x.span)
  }
  if (timed === 0) return [...spans]
  throw new ValidationError(
    `evaluateTraceContract: ${timed}/${spans.length} spans carry a finite startedAt — ` +
      'mixed timestamps make ordering ambiguous; stamp every span or none',
  )
}

function spanRef(span: ContractSpan, index: number): string {
  return span.spanId ?? `#${index}`
}

// precedes(a, b) and neverUnless(p, prior) share one semantics: every
// guarded-match must have a STRICTLY earlier guard-match. The guard flag
// updates after the guarded check, so a span matching both cannot witness
// itself.
function checkGuarded(args: {
  label: string
  ordered: readonly ContractSpan[]
  guard: SpanPredicate
  guarded: SpanPredicate
  detail: (ref: string) => string
}): ContractViolation[] {
  const out: ContractViolation[] = []
  let guardSeen = false
  for (let i = 0; i < args.ordered.length; i++) {
    const span = args.ordered[i]!
    if (!guardSeen && matchSpan(span, args.guarded)) {
      out.push({ rule: args.label, spanId: span.spanId, detail: args.detail(spanRef(span, i)) })
    }
    if (matchSpan(span, args.guard)) guardSeen = true
  }
  return out
}

function checkRule(rule: ContractRule, ordered: readonly ContractSpan[]): ContractViolation[] {
  switch (rule.kind) {
    case 'always': {
      const out: ContractViolation[] = []
      for (let i = 0; i < ordered.length; i++) {
        const span = ordered[i]!
        if (!matchSpan(span, rule.p!)) {
          out.push({
            rule: rule.label,
            spanId: span.spanId,
            detail: `span ${spanRef(span, i)} ("${span.name ?? ''}") fails always(${describePredicate(rule.p!)})`,
          })
        }
      }
      return out
    }
    case 'never': {
      const out: ContractViolation[] = []
      for (let i = 0; i < ordered.length; i++) {
        const span = ordered[i]!
        if (matchSpan(span, rule.p!)) {
          out.push({
            rule: rule.label,
            spanId: span.spanId,
            detail: `span ${spanRef(span, i)} ("${span.name ?? ''}") matches never(${describePredicate(rule.p!)})`,
          })
        }
      }
      return out
    }
    case 'eventually': {
      const hit = ordered.some((span) => matchSpan(span, rule.p!))
      return hit
        ? []
        : [
            {
              rule: rule.label,
              detail: `no span matches eventually(${describePredicate(rule.p!)}) over ${ordered.length} span(s)`,
            },
          ]
    }
    case 'precedes':
      return checkGuarded({
        label: rule.label,
        ordered,
        guard: rule.a!,
        guarded: rule.b!,
        detail: (ref) =>
          `span ${ref} matches ${describePredicate(rule.b!)} with no earlier ${describePredicate(rule.a!)} match`,
      })
    case 'neverUnless':
      return checkGuarded({
        label: rule.label,
        ordered,
        guard: rule.prior!,
        guarded: rule.p!,
        detail: (ref) =>
          `span ${ref} matches ${describePredicate(rule.p!)} with no earlier ${describePredicate(rule.prior!)} match`,
      })
  }
}

/**
 * Evaluate one contract over a span sequence. Pure and synchronous — works
 * on `Span[]` from a TraceStore, `ExportableSpan[]` from the otel-bridge
 * flattening, or any array satisfying `ContractSpan`.
 */
export function evaluateTraceContract(
  contract: TraceContract,
  spans: readonly ContractSpan[],
): ContractVerdict {
  assertContract(contract)
  const ordered = orderSpans(spans)
  const scores: Record<string, number> = {}
  const violations: ContractViolation[] = []
  for (const rule of contract.rules) {
    const ruleViolations = checkRule(rule, ordered)
    scores[rule.label] = ruleViolations.length === 0 ? 1 : 0
    violations.push(...ruleViolations)
  }
  const ruleCount = contract.rules.length
  const passCount = Object.values(scores).filter((s) => s === 1).length
  return {
    contract: contract.name,
    valid: passCount === ruleCount,
    score: passCount / ruleCount,
    scores,
    violations,
    notes: `${passCount}/${ruleCount} rules passed`,
  }
}

/**
 * Evaluate many contracts over one span sequence. Throws on an empty
 * contract list — `allValid: true` over zero contracts is a silent pass.
 */
export function checkTraceContracts(
  spans: readonly ContractSpan[],
  contracts: readonly TraceContract[],
): ContractCheckResult {
  if (contracts.length === 0) {
    throw new ValidationError(
      'checkTraceContracts: empty contract list would vacuously pass — supply at least one contract',
    )
  }
  const verdicts = contracts.map((c) => evaluateTraceContract(c, spans))
  return { verdicts, allValid: verdicts.every((v) => v.valid) }
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
 * is the mean across contracts. Deterministic — no LLM call.
 */
export function contractJudge<TArtifact, TScenario extends Scenario = Scenario>(
  contracts: readonly TraceContract[],
  opts: ContractJudgeOptions<TArtifact, TScenario>,
): JudgeConfig<TArtifact, TScenario> {
  if (contracts.length === 0) {
    throw new ValidationError('contractJudge: at least one contract required')
  }
  for (const c of contracts) assertContract(c)
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
