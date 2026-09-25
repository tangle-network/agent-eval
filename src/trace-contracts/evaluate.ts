import { ValidationError } from '../errors'
import { packageVersion } from '../package-version'
import { certificationEvidenceDigest } from '../verdict'
import { describePredicate } from './explain'
import { predicateMatches } from './predicates'
import { executeRule, type RuleContext, type RuleOutcome } from './rules'
import { finite, isSpanError } from './spans'
import {
  type ContractCheckResult,
  type ContractRule,
  type ContractRuleExecution,
  type ContractRun,
  type ContractSpan,
  type ContractStatus,
  type ContractVerdict,
  type EvaluateTraceContractOptions,
  RUN_STATUSES,
  type SpanPredicate,
  type TraceContract,
} from './types'
import { assertContract } from './validate'

// ── Evaluation ────────────────────────────────────────────────────────

/**
 * A run derived from one span: the `run.status` attribute a run-anchor span
 * carries (store-to-otlp writes it), else failed on an error status, else
 * unknown. An ended span with an OK status and no declared `run.status` is
 * NOT inferred as completed — a span exporter can end its root span cleanly
 * without ever learning whether the underlying run actually finished (for
 * example, a trace reader that saw no terminal record). `requireCompleted`
 * and `allowedStatuses` must fail closed on that gap rather than pass it.
 */
function runOfSpan(span: ContractSpan): ContractRun {
  const declared = span.attributes?.['run.status']
  return {
    status:
      typeof declared === 'string' && (RUN_STATUSES as readonly string[]).includes(declared)
        ? declared
        : isSpanError(span)
          ? 'failed'
          : undefined,
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
 * `Span[]` from a TraceStore, `contractSpansFromOtlp` output, or any array
 * satisfying `ContractSpan`. Throws
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
    case 'toolsOffered':
    case 'retrySafe':
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
