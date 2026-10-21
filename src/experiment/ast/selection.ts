import { ValidationError } from '../../errors'
import type { EvidenceRecord } from './evidence'
import { evaluatePredicate, type Predicate, readField } from './predicate'

// ── Admission ────────────────────────────────────────────────────────

/**
 * One monotone funnel stage. `waives` names substrate admission conditions
 * deliberately NOT applied, so a waiver is registered, never implicit.
 */
export interface AdmissionStage {
  id: string
  keep: Predicate
  waives?: string[]
}

/** A partition is a set reported separately and never pooled. */
export interface AdmissionPartition {
  id: string
  /** Stage whose dropped rows this partition draws from. */
  from: string
  keep: Predicate
  pooling: 'never'
}

/** Declarative row-admission funnel. Stages only remove rows. */
export interface AdmissionRule {
  population: string
  stages: AdmissionStage[]
  partitions?: AdmissionPartition[]
}

// ── Selection ────────────────────────────────────────────────────────

/**
 * Deterministic subset selection. `reads` is the closed field set the rule
 * may touch — outcome-contaminated selection is unrepresentable because an
 * outcome field is simply not in the list.
 */
export type SelectionRule =
  | {
      kind: 'round-robin'
      groupBy: string
      groupOrder: 'lex-asc'
      withinOrder: { field: string; dir: 'asc' | 'desc' }
      take: number
      reads: string[]
    }
  | {
      kind: 'filter-of'
      /** Name of the sealed subset or selection this rule filters. */
      base: string
      keep: Predicate
      order: { field: string; dir: 'asc' | 'desc' }
    }

/**
 * Execute a selection rule.
 *
 * Round-robin walks groups in lexicographic order and takes ids in
 * within-group order until `take` ids are chosen. Filter-of keeps the ids of
 * `bases[rule.base]` whose record satisfies the predicate, in the registered
 * order. Ids absent from `records` are evaluated on their id alone (fields
 * derived from the id via `idFields`), so a sealed base outlives its source
 * records.
 */
export function runSelectionRule(
  rule: SelectionRule,
  records: readonly EvidenceRecord[],
  options: {
    /** Field carrying a row's identity. */
    idField: string
    /** Sealed or previously-computed subsets, by name. */
    bases?: Record<string, readonly string[]>
    /** Derive predicate-readable fields from a bare id when its record is absent. */
    idFields?: (id: string) => EvidenceRecord
  },
): string[] {
  if (rule.kind === 'round-robin') {
    const allowed = new Set(rule.reads)
    for (const field of [rule.groupBy, rule.withinOrder.field]) {
      if (!allowed.has(field)) {
        throw new ValidationError(
          `runSelectionRule: round-robin reads '${field}' but its closed read set is [${rule.reads.join(', ')}]`,
        )
      }
    }
    const byGroup = new Map<string, string[]>()
    for (const record of records) {
      const group = String(readField(record, rule.groupBy))
      const id = String(readField(record, rule.withinOrder.field))
      const bucket = byGroup.get(group)
      if (bucket) bucket.push(id)
      else byGroup.set(group, [id])
    }
    for (const ids of byGroup.values()) {
      ids.sort()
      if (rule.withinOrder.dir === 'desc') ids.reverse()
    }
    const groups = [...byGroup.keys()].sort()
    const chosen: string[] = []
    let cursor = 0
    while (chosen.length < rule.take && groups.some((g) => byGroup.get(g)!.length > 0)) {
      const group = groups[cursor % groups.length]!
      const ids = byGroup.get(group)!
      if (ids.length > 0) chosen.push(ids.shift()!)
      cursor += 1
    }
    return chosen
  }

  const base = options.bases?.[rule.base]
  if (!base) {
    throw new ValidationError(`runSelectionRule: filter-of base '${rule.base}' was not provided`)
  }
  const index = new Map(records.map((r) => [String(readField(r, options.idField)), r]))
  const kept = base.filter((id) => {
    const record = index.get(id) ?? options.idFields?.(id)
    if (!record) {
      throw new ValidationError(
        `runSelectionRule: base id '${id}' has no record and no idFields derivation`,
      )
    }
    return evaluatePredicate(rule.keep, record)
  })
  const sorted = [...kept].sort()
  if (rule.order.dir === 'desc') sorted.reverse()
  return sorted
}
