import { ValidationError } from '../../errors'
import type { EvidenceRecord } from './evidence'
import { evaluatePredicate, type Predicate, readField } from './predicate'

// ── Estimands ────────────────────────────────────────────────────────

/** A named set of row identities, built from arm rows and an event predicate. */
export type SetExpr =
  | { kind: 'rows-where'; arm: string; event: Predicate }
  | { kind: 'intersect'; of: SetExpr[] }

/**
 * What the experiment measures. Every estimand names the fields it reads, so
 * the sealed tree records the full data dependency of the number.
 */
export type Estimand =
  | { kind: 'rate'; event: Predicate; over: 'rollouts' }
  | { kind: 'rate-at-least-once'; event: Predicate; groupBy: string }
  | {
      kind: 'paired-mean-diff'
      armField: string
      treatment: string
      control: string
      pairBy: string
      /**
       * Field path to the per-row outcome. A boolean reads as 1 or 0, so a
       * binary pass/fail outcome gives the risk difference directly.
       */
      value: string
      /** A pair one arm did not answer contributes a difference of exactly zero. */
      missing: 'zero-diff'
    }
  | {
      kind: 'set-ratio'
      armField: string
      idField: string
      numerator: SetExpr
      denominator: SetExpr
    }

export interface EstimandResult {
  value: number
  numerator: number
  denominator: number
}

function evaluateSetExpr(
  expr: SetExpr,
  rows: readonly EvidenceRecord[],
  armField: string,
  idField: string,
): Set<string> {
  if (expr.kind === 'rows-where') {
    const ids = new Set<string>()
    for (const row of rows) {
      if (String(readField(row, armField)) !== expr.arm) continue
      if (evaluatePredicate(expr.event, row)) ids.add(String(readField(row, idField)))
    }
    return ids
  }
  if (expr.of.length === 0) throw new ValidationError('computeEstimand: empty intersect')
  const sets = expr.of.map((e) => evaluateSetExpr(e, rows, armField, idField))
  const [first, ...rest] = sets
  const out = new Set<string>()
  for (const id of first!) {
    if (rest.every((s) => s.has(id))) out.add(id)
  }
  return out
}

/**
 * Read one registered outcome field as a number.
 *
 * A binary outcome reaches evidence as `true` or `false`. Its mean is the pass
 * rate and the mean of its paired differences is the risk difference, so
 * `true` reads as 1 and `false` as 0 — the same quantity a caller would
 * otherwise encode by hand, and the same reading in every interpreter here.
 * Every other type, and a non-finite number, is a measurement defect: it
 * rejects instead of poisoning the mean with `NaN` or a coerced zero.
 */
export function readNumericOutcome(
  raw: unknown,
  context: string,
  field: string,
  where: string,
): number {
  if (typeof raw === 'boolean') return raw ? 1 : 0
  if (typeof raw === 'number' && Number.isFinite(raw)) return raw
  throw new ValidationError(
    `${context}: value field '${field}' is not a finite number or a boolean on ${where}`,
  )
}

/** Compute an estimand over evidence rows. Pure; reads only registered fields. */
export function computeEstimand(
  estimand: Estimand,
  rows: readonly EvidenceRecord[],
): EstimandResult {
  switch (estimand.kind) {
    case 'rate': {
      const numerator = rows.filter((r) => evaluatePredicate(estimand.event, r)).length
      if (rows.length === 0) throw new ValidationError('computeEstimand: rate over zero rows')
      return { value: numerator / rows.length, numerator, denominator: rows.length }
    }
    case 'rate-at-least-once': {
      const byGroup = new Map<string, boolean>()
      for (const row of rows) {
        const group = String(readField(row, estimand.groupBy))
        const hit = evaluatePredicate(estimand.event, row)
        byGroup.set(group, (byGroup.get(group) ?? false) || hit)
      }
      if (byGroup.size === 0) {
        throw new ValidationError('computeEstimand: rate-at-least-once over zero groups')
      }
      const numerator = [...byGroup.values()].filter(Boolean).length
      return { value: numerator / byGroup.size, numerator, denominator: byGroup.size }
    }
    case 'paired-mean-diff': {
      const byPair = new Map<string, { treatment?: number; control?: number }>()
      for (const row of rows) {
        const arm = String(readField(row, estimand.armField))
        if (arm !== estimand.treatment && arm !== estimand.control) continue
        const pair = String(readField(row, estimand.pairBy))
        const value = readNumericOutcome(
          readField(row, estimand.value),
          'computeEstimand paired-mean-diff',
          estimand.value,
          `pair '${pair}'`,
        )
        const slot = byPair.get(pair) ?? {}
        if (arm === estimand.treatment) slot.treatment = value
        else slot.control = value
        byPair.set(pair, slot)
      }
      if (byPair.size === 0) {
        throw new ValidationError('computeEstimand: paired-mean-diff over zero pairs')
      }
      let sum = 0
      for (const slot of byPair.values()) {
        // missing: 'zero-diff' — an unanswered side contributes zero, never a drop
        sum += (slot.treatment ?? 0) - (slot.control ?? 0)
      }
      return { value: sum / byPair.size, numerator: sum, denominator: byPair.size }
    }
    case 'set-ratio': {
      const numeratorSet = evaluateSetExpr(
        estimand.numerator,
        rows,
        estimand.armField,
        estimand.idField,
      )
      const denominatorSet = evaluateSetExpr(
        estimand.denominator,
        rows,
        estimand.armField,
        estimand.idField,
      )
      if (denominatorSet.size === 0) {
        throw new ValidationError('computeEstimand: set-ratio denominator set is empty')
      }
      return {
        value: numeratorSet.size / denominatorSet.size,
        numerator: numeratorSet.size,
        denominator: denominatorSet.size,
      }
    }
  }
}
