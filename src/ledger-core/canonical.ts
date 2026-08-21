/**
 * Canonical bytes and digests for durable journal rows.
 *
 * Serialization is RFC 8785 through `@tangle-network/agent-interface` — the
 * stack's single identity scheme — so a value carries the same digest in every
 * package that produces or verifies one.
 *
 * Values canonical JSON cannot represent faithfully are refused, never coerced.
 * `NaN`, `Infinity`, `undefined`, class instances, cycles, and unpaired
 * surrogates each have a lossy encoding that maps distinct records onto one
 * digest, and in a hash chain the digest IS the record's identity: a coercion
 * there is a collision, not a convenience.
 */

import {
  canonicalCandidateBytes,
  canonicalCandidateJson,
  sha256Bytes,
} from '@tangle-network/agent-interface'
import { ValidationError } from '../errors'

export type LedgerHash = `sha256:${string}`

/** Shape of every ledger digest: `sha256:` followed by 64 lowercase hex chars. */
export const LEDGER_HASH_PATTERN = /^sha256:[a-f0-9]{64}$/

/** A value has no faithful canonical-JSON form, so it cannot be stored or hashed. */
export class LedgerCanonicalizationError extends ValidationError {}

/** Canonical JSON encoding (RFC 8785): object keys sorted by UTF-16 code unit,
 * recursively. This is the byte form that is hashed and stored, so equal values
 * always encode identically. */
export function canonicalString(value: unknown): string {
  try {
    return canonicalCandidateJson(value)
  } catch (error) {
    throw canonicalizationError(value, error)
  }
}

export function hashCanonical(value: unknown): LedgerHash {
  try {
    return sha256Bytes(canonicalCandidateBytes(value))
  } catch (error) {
    throw canonicalizationError(value, error)
  }
}

/**
 * The JSON document form of `value` — the value as a JSON file carries it.
 *
 * A JSON document has no `undefined`, so an undefined-valued key is absent
 * from the document and absent from its digest. Use this, and say so, when a
 * record is digested BEFORE being written and re-digested AFTER being read
 * back: without it the two digests disagree for a record carrying an
 * undefined-valued key, and the reader cannot verify the writer.
 *
 * Only that one rule is applied. Every other non-canonical value — `NaN`, a
 * class instance, an `undefined` array item, a cycle — reaches
 * {@link canonicalString} unchanged and is refused there, so this form never
 * turns an ambiguous value into a valid-looking digest the way
 * `JSON.stringify` turns `NaN` into `null`.
 */
export function jsonDocument(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map(jsonDocument)
  const prototype = Object.getPrototypeOf(value)
  if (prototype !== Object.prototype && prototype !== null) return value
  const out: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (entry !== undefined) out[key] = jsonDocument(entry)
  }
  return out
}

/** Name the offending value and path so a refusal is actionable. The RFC 8785
 * encoder above is the sole authority on acceptance; this walk only explains a
 * rejection it already made. */
function canonicalizationError(value: unknown, cause: unknown): LedgerCanonicalizationError {
  const defect = firstNonCanonicalDefect(value, '$', new Set())
  const reason = defect !== '' ? defect : cause instanceof Error ? cause.message : String(cause)
  return new LedgerCanonicalizationError(`value has no canonical JSON form: ${reason}`, {
    cause,
  })
}

function firstNonCanonicalDefect(value: unknown, path: string, ancestors: Set<object>): string {
  if (value === null) return ''
  if (value === undefined) return `${path} is undefined`
  const type = typeof value
  if (type === 'number') {
    return Number.isFinite(value) ? '' : `${path} is ${String(value)}`
  }
  if (type === 'string') {
    return isWellFormedUtf16(value as string) ? '' : `${path} contains an unpaired surrogate`
  }
  if (type === 'boolean') return ''
  if (type !== 'object') return `${path} is a ${type}`
  const object = value as object
  if (ancestors.has(object)) return `${path} closes a reference cycle`
  const prototype = Object.getPrototypeOf(object)
  if (!Array.isArray(object) && prototype !== Object.prototype && prototype !== null) {
    return `${path} is a ${object.constructor?.name ?? 'non-plain'} instance, not plain JSON data`
  }
  const nested = new Set(ancestors).add(object)
  if (Array.isArray(object)) {
    for (let index = 0; index < object.length; index += 1) {
      const defect = firstNonCanonicalDefect(object[index], `${path}[${index}]`, nested)
      if (defect !== '') return defect
    }
    return ''
  }
  for (const [key, entry] of Object.entries(object)) {
    if (!isWellFormedUtf16(key)) return `${path}.${key} has a key with an unpaired surrogate`
    const defect = firstNonCanonicalDefect(entry, `${path}.${key}`, nested)
    if (defect !== '') return defect
  }
  return ''
}

function isWellFormedUtf16(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index)
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!(next >= 0xdc00 && next <= 0xdfff)) return false
      index += 1
    } else if (code >= 0xdc00 && code <= 0xdfff) {
      return false
    }
  }
  return true
}

/**
 * Compare two strings by UTF-16 code unit — the order RFC 8785 uses for object
 * keys, and the order any array must be sorted into before it is canonicalized.
 *
 * `String.prototype.localeCompare` reads the host's collation, so it is a
 * property of the machine rather than of the value. RFC 8785 canonicalizes an
 * array BY POSITION, so a `localeCompare` sort in front of `canonicalString` or
 * `hashCanonical` lets the collation decide the digest bytes: the ids
 * `Accuracy, brevity, Clarity` order as `Accuracy,brevity,Clarity` under an
 * en-US collation and as `Accuracy,Clarity,brevity` by code unit, and the two
 * produce different digests for the same data.
 *
 * Use this for any ordering whose result reaches a digest, a stable
 * serialization, or a stored identity. A comparator for a report a human reads
 * is free to keep `localeCompare`.
 */
export function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1
  return left > right ? 1 : 0
}
