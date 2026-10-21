import type { EvidenceRecord, JsonValue } from './evidence'

// ── Predicate ────────────────────────────────────────────────────────

/**
 * Closed-key comparison over a declared record schema. The only leaf node.
 * `field` is a dot-separated path into an evidence record.
 */
export type Predicate =
  | {
      kind: 'compare'
      field: string
      op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte'
      value: JsonValue
    }
  | { kind: 'in'; field: string; values: JsonValue[] }
  | { kind: 'all'; of: Predicate[] }
  | { kind: 'any'; of: Predicate[] }
  | { kind: 'not'; of: Predicate }

/** Read a dot-separated field path. Missing segments yield `undefined`. */
export function readField(record: EvidenceRecord, path: string): unknown {
  let current: unknown = record
  for (const key of path.split('.')) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[key]
  }
  return current
}

/** Evaluate a predicate against one evidence record. */
export function evaluatePredicate(predicate: Predicate, record: EvidenceRecord): boolean {
  switch (predicate.kind) {
    case 'compare':
      return compareValues(readField(record, predicate.field), predicate.op, predicate.value)
    case 'in':
      return predicate.values.includes(readField(record, predicate.field) as JsonValue)
    case 'all':
      return predicate.of.every((p) => evaluatePredicate(p, record))
    case 'any':
      return predicate.of.some((p) => evaluatePredicate(p, record))
    case 'not':
      return !evaluatePredicate(predicate.of, record)
  }
}

/** Numbers compare numerically; everything else compares as strings. */
export function compareValues(
  value: unknown,
  op: 'eq' | 'ne' | 'lt' | 'lte' | 'gt' | 'gte',
  target: JsonValue,
): boolean {
  if (op === 'eq') return value === target
  if (op === 'ne') return value !== target
  const numeric = typeof value === 'number' && typeof target === 'number'
  const left = numeric ? (value as number) : String(value)
  const right = numeric ? (target as number) : String(target)
  switch (op) {
    case 'lt':
      return left < right
    case 'lte':
      return left <= right
    case 'gt':
      return left > right
    case 'gte':
      return left >= right
  }
}
