import { ValidationError } from '../errors'
import { assertPredicate } from './predicates'
import {
  ARGUMENT_OCCURRENCES,
  ARGUMENT_TYPES,
  type ArgumentCheck,
  type ContractRule,
  ORDER_MODES,
  type OrderMode,
  RUN_STATUSES,
  type TraceContract,
} from './types'

// ── Validation ────────────────────────────────────────────────────────

export function assertOrder(order: unknown, where: string): OrderMode | undefined {
  if (order === undefined) return undefined
  if (!(ORDER_MODES as readonly unknown[]).includes(order)) {
    throw new ValidationError(`${where}: order must be one of ${ORDER_MODES.join(', ')}`)
  }
  return order as OrderMode
}

export function assertCount(max: unknown, where: string): void {
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

export function assertRule(rule: ContractRule, where: string): void {
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

function assertRules(rules: unknown, where: string, allowEmpty = false): void {
  if (!Array.isArray(rules) || (rules.length === 0 && !allowEmpty)) {
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

export function assertContract(contract: TraceContract, where: string): void {
  if (typeof contract?.name !== 'string' || contract.name.length === 0) {
    throw new ValidationError(`${where}: contract.name must be a non-empty string`)
  }
  const at = `${where} "${contract.name}"`
  // Base rules may be empty only when alternatives carry the checks: the
  // contract then passes exactly when one alternative passes.
  assertRules(
    contract.rules,
    at,
    Array.isArray(contract.alternatives) && contract.alternatives.length > 0,
  )
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
