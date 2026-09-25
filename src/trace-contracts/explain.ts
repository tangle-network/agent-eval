import { isOneOfMatcher, isRegexValue } from './predicates'
import type {
  ArgumentCheck,
  ContractRule,
  SpanPredicate,
  TextMatcher,
  TraceContract,
} from './types'
import { assertContract } from './validate'

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

export function describeCheck(check: ArgumentCheck): string {
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
      if (rule.requireCompleted) parts.push('the run completed and recorded its end')
      if (rule.allowedStatuses)
        parts.push(`its status is one of ${rule.allowedStatuses.join(', ')}`)
      if (rule.maxDurationMs !== undefined) parts.push(`it took at most ${rule.maxDurationMs} ms`)
      return parts.join('; ')
    }
    case 'argument':
      return `${rule.occurrence ?? 'all'} call(s) matching ${describePredicate(rule.p)} have argument ${rule.pointer || '(whole value)'} that ${describeCheck(rule.check)}`
    case 'toolsOffered':
      return `the trace records the tools offered to the model, every tool call is one of them${rule.declared ? `, and every offered tool is one of ${rule.declared.join(', ')}` : ''}`
    case 'retrySafe': {
      const parts = ['no tool is called twice with the same arguments']
      if (rule.reads) parts.push(`except the reads ${rule.reads.join(', ')}`)
      for (const w of rule.writes ?? []) {
        parts.push(
          w.idempotencyKey === undefined
            ? `write ${w.tool} may never repeat`
            : `write ${w.tool} may repeat only with one idempotency key at ${w.idempotencyKey}`,
        )
      }
      return parts.join('; ')
    }
  }
}

/** Plain-language statement of everything a contract checks, one rule per line. */
export function explainTraceContract(contract: TraceContract): string {
  assertContract(contract, 'explainTraceContract')
  const lines = [
    `Contract "${contract.name}"${contract.description ? ` — ${contract.description}` : ''}`,
  ]
  if (contract.scope) {
    lines.push(
      `Scope: only the span matching ${describePredicate(contract.scope.root)} and its descendants; exactly one span must match.`,
    )
  }
  lines.push('Every rule must pass:')
  for (const rule of contract.rules) lines.push(`  - ${rule.label}: ${describeRule(rule)}`)
  if (contract.alternatives) {
    lines.push('And at least one alternative must pass completely:')
    for (const alternative of contract.alternatives) {
      lines.push(`  ${alternative.id}:`)
      for (const rule of alternative.rules) lines.push(`    - ${rule.label}: ${describeRule(rule)}`)
    }
  }
  return lines.join('\n')
}
