import { ValidationError } from '../errors'
import { describeCheck, describePredicate } from './explain'
import { normalizePredicate } from './predicates'
import type {
  ArgumentCheck,
  ArgumentOccurrence,
  ContractAlternative,
  ContractRule,
  OrderMode,
  RetryWrite,
  RunChecks,
  SpanPredicate,
  TraceContract,
} from './types'
import { assertContract, assertCount, assertOrder, assertRule } from './validate'

// ── Builder ───────────────────────────────────────────────────────────

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

  /** The trace records the tools offered to the model, every call is one of
   *  them, and, with `declared`, every offered tool is declared. */
  toolsOffered(declared?: string[], label = 'toolsOffered'): this {
    const rule: ContractRule = {
      kind: 'toolsOffered',
      label,
      ...(declared === undefined ? {} : { declared: [...declared] }),
    }
    assertRule(rule, this.where('toolsOffered'))
    return this.add(rule)
  }

  /** No call repeats a side effect that is not proven safe to repeat. */
  retrySafe(options: { reads?: string[]; writes?: RetryWrite[] }, label = 'retrySafe'): this {
    const rule: ContractRule = {
      kind: 'retrySafe',
      label,
      ...(options.reads === undefined ? {} : { reads: [...options.reads] }),
      ...(options.writes === undefined ? {} : { writes: options.writes.map((w) => ({ ...w })) }),
    }
    assertRule(rule, this.where('retrySafe'))
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
