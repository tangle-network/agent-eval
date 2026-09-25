import { SPAN_KINDS, type SpanKind } from '@tangle-network/agent-trace-contract'
import { ValidationError } from '../errors'
import { contractSpanKind, contractSpanToolName, spanModel } from './spans'
import type {
  ContractSpan,
  OneOfMatcher,
  SerializedRegex,
  SpanPredicate,
  TextMatcher,
} from './types'

// ── Predicate matching ────────────────────────────────────────────────

function isSerializedRegex(v: unknown): v is SerializedRegex {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as SerializedRegex).$regex === 'string' &&
    typeof (v as SerializedRegex).flags === 'string'
  )
}

export function isOneOfMatcher(v: unknown): v is OneOfMatcher {
  return typeof v === 'object' && v !== null && Array.isArray((v as OneOfMatcher).oneOf)
}

export function isRegexValue(v: unknown): v is RegExp | SerializedRegex {
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

export function assertPredicate(value: unknown, where: string): asserts value is SpanPredicate {
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

export function predicateMatches(span: ContractSpan, p: SpanPredicate): boolean {
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

function normalizeMatcher(m: TextMatcher): Exclude<TextMatcher, RegExp> {
  if (m instanceof RegExp) return { $regex: m.source, flags: m.flags }
  if (isOneOfMatcher(m)) return { oneOf: [...m.oneOf] }
  return m
}

export function normalizePredicate(p: SpanPredicate, where: string): SpanPredicate {
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
