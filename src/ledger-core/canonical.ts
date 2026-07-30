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
