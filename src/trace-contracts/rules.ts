import { describePredicate } from './explain'
import { predicateMatches } from './predicates'
import { type ArgumentEvidence, finite, spanArguments, spanTotalTokens } from './spans'
import type {
  ArgumentCheck,
  ArgumentType,
  ContractRule,
  ContractRun,
  ContractSpan,
  ContractStatus,
  ContractViolation,
  OrderMode,
  SpanPredicate,
} from './types'

// ── Evaluation ────────────────────────────────────────────────────────

export interface RuleContext {
  spans: readonly ContractSpan[]
  run: { run: ContractRun } | { unknown: string }
}

export interface RuleOutcome {
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

export function executeRule(rule: ContractRule, ctx: RuleContext): RuleOutcome {
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
