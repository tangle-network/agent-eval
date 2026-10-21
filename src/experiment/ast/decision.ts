import { ValidationError } from '../../errors'
import { compareValues } from './predicate'

/** A decision rule's branches did not cover the evidence. */
class DecisionTableNotTotalError extends ValidationError {}

// ── Conditions and decisions ─────────────────────────────────────────

/** Decision guards read only named derived quantities — never raw rows. */
export type Condition =
  | { kind: 'interval-excludes-zero'; interval: string; sign: 'positive' | 'negative' }
  | { kind: 'interval-includes-zero'; interval: string }
  | { kind: 'quantity-threshold'; quantity: string; op: 'gte' | 'lte' | 'gt' | 'lt'; value: number }
  | { kind: 'obligation-met'; obligation: string }
  | { kind: 'all'; of: Condition[] }
  | { kind: 'any'; of: Condition[] }
  | { kind: 'not'; of: Condition }

/** The named quantities a decision rule may read. Nothing else reaches it. */
export interface DerivedQuantities {
  intervals: Record<string, { lower: number; upper: number }>
  quantities: Record<string, number>
  obligationsMet: Record<string, boolean>
}

export function evaluateCondition(condition: Condition, evidence: DerivedQuantities): boolean {
  switch (condition.kind) {
    case 'interval-excludes-zero': {
      const interval = evidence.intervals[condition.interval]
      if (!interval) {
        throw new ValidationError(
          `evaluateCondition: interval '${condition.interval}' is not in the evidence`,
        )
      }
      const excludes = interval.lower > 0 || interval.upper < 0
      return excludes && (condition.sign === 'positive' ? interval.lower > 0 : interval.upper < 0)
    }
    case 'interval-includes-zero': {
      const interval = evidence.intervals[condition.interval]
      if (!interval) {
        throw new ValidationError(
          `evaluateCondition: interval '${condition.interval}' is not in the evidence`,
        )
      }
      return interval.lower <= 0 && interval.upper >= 0
    }
    case 'quantity-threshold': {
      const value = evidence.quantities[condition.quantity]
      if (value === undefined) {
        throw new ValidationError(
          `evaluateCondition: quantity '${condition.quantity}' is not in the evidence`,
        )
      }
      return compareValues(value, condition.op, condition.value)
    }
    case 'obligation-met':
      return evidence.obligationsMet[condition.obligation] === true
    case 'all':
      return condition.of.every((c) => evaluateCondition(c, evidence))
    case 'any':
      return condition.of.some((c) => evaluateCondition(c, evidence))
    case 'not':
      return !evaluateCondition(condition.of, evidence)
  }
}

export interface DecisionBranch {
  when: Condition
  verdict: string
  report: string[]
}

/**
 * Ordered decision table: the first branch whose condition holds fires, and a
 * table no branch matches throws — a non-total registration is a defect, not
 * an implicit verdict. `report-only` registers the ABSENCE of a verdict
 * branch: the estimate and the per-row table are the finding, and the
 * registered meaning prose rides as non-executable interpretation data.
 */
export type DecisionRule =
  | { kind: 'table'; branches: DecisionBranch[] }
  | {
      kind: 'report-only'
      estimands: string[]
      intervals: string[]
      perRow: string[]
      interpretation?: { onQualitative: string; consequence: string }[]
    }

export interface DecisionOutcome {
  verdict: string
  report: string[]
}

export function executeDecisionRule(
  rule: DecisionRule,
  evidence: DerivedQuantities,
): DecisionOutcome {
  if (rule.kind === 'report-only') {
    return { verdict: 'report-only', report: [...rule.estimands, ...rule.intervals] }
  }
  for (const branch of rule.branches) {
    if (evaluateCondition(branch.when, evidence)) {
      return { verdict: branch.verdict, report: branch.report }
    }
  }
  throw new DecisionTableNotTotalError(
    'executeDecisionRule: decision table is not total — no branch matched the evidence',
  )
}
