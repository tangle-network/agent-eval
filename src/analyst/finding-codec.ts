/**
 * The raw-finding wire contract — one decoder for both sides of the process
 * boundary.
 *
 * A finding array crosses a process boundary twice: an optimizer bridge writes
 * it in Python, TypeScript reads it back. Two decoders written independently
 * accept different shapes, so Python could report a completed investigation
 * whose rows TypeScript then dropped — the paid work disappearing between two
 * "successes". This module is the TypeScript half; `finding_contract.json`
 * carries the same rules to the Python half, generated from the schema here.
 *
 * Decoding never invents an empty result. A value that is not an array of rows
 * fails with the exact type it was, and a malformed row is reported with its
 * index and path while its valid siblings survive.
 */

import { type RawAnalystFinding, RawAnalystFindingSchema } from './finding-signature'
import { parseFindingSubject } from './finding-subject'
import { coerceJson } from './parse-tolerant'

/**
 * Version of the wire contract both languages implement. Bump when the
 * accepted row shape changes; the Python package pins the same value, and the
 * emitted contract carries it so a mismatched pair is visible.
 */
export const FINDING_WIRE_CONTRACT_VERSION = 1

/** Why one row was refused. Stable across languages: Python reports the same codes. */
export type FindingRejectionCode = 'not-an-object' | 'schema' | 'invalid-subject' | 'row-limit'

/** A refused row, named precisely enough to repair or report. */
export interface RejectedFindingRow {
  /** Position in the submitted array. */
  readonly index: number
  /** Dotted path to the offending field, `''` for the row itself. */
  readonly path: string
  readonly code: FindingRejectionCode
  readonly message: string
}

export interface DecodedFindingArray {
  readonly accepted: RawAnalystFinding[]
  readonly rejected: RejectedFindingRow[]
  /**
   * Set when the value was not a finding array at all — the array itself is
   * the failure, so `accepted` and `rejected` are both empty and a caller must
   * not read the result as "no findings".
   */
  readonly topLevelError?: string
}

/**
 * Rows past this count are refused rather than validated. A model that emits
 * thousands of rows has lost the plot, and the diagnostics for them would
 * dwarf the answer they came with.
 */
export const MAX_FINDING_ROWS = 500

/**
 * Decode a submitted findings value into accepted rows plus per-row
 * diagnostics.
 *
 * Accepts an array of rows, or a string carrying one (a JSON array, possibly
 * fenced). Anything else — an object, a number, null, undefined — sets
 * `topLevelError` naming the type received: a caller that asked for findings
 * and got a number has a defect to report, not an empty result to record.
 */
export function decodeRawFindingArray(value: unknown): DecodedFindingArray {
  const rows = findingRows(value)
  if (typeof rows === 'string') return { accepted: [], rejected: [], topLevelError: rows }

  const accepted: RawAnalystFinding[] = []
  const rejected: RejectedFindingRow[] = []
  for (const [index, row] of rows.entries()) {
    if (index >= MAX_FINDING_ROWS) {
      rejected.push({
        index,
        path: '',
        code: 'row-limit',
        message: `findings array exceeds ${MAX_FINDING_ROWS} rows`,
      })
      continue
    }
    const decoded = decodeRow(row, index)
    if ('finding' in decoded) accepted.push(decoded.finding)
    else rejected.push(decoded.rejection)
  }
  return { accepted, rejected }
}

function decodeRow(
  row: unknown,
  index: number,
): { finding: RawAnalystFinding } | { rejection: RejectedFindingRow } {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return {
      rejection: {
        index,
        path: '',
        code: 'not-an-object',
        message: `finding row must be an object, received ${describe(row)}`,
      },
    }
  }
  const parsed = RawAnalystFindingSchema.safeParse(row)
  if (!parsed.success) {
    const issue = parsed.error.issues[0]
    const path = (issue?.path ?? []).join('.')
    // The schema refines `subject` against the grammar; name that refusal
    // separately so a repair turn can be told which rule the row broke.
    const code: FindingRejectionCode =
      path === 'subject' && parseFindingSubject((row as { subject?: string }).subject) === null
        ? 'invalid-subject'
        : 'schema'
    return {
      rejection: { index, path, code, message: issue?.message ?? 'row does not match the schema' },
    }
  }
  return { finding: parsed.data }
}

/**
 * Narrow a submitted value to candidate rows, or return the message naming why
 * it is not a findings array at all.
 */
function findingRows(value: unknown): unknown[] | string {
  if (Array.isArray(value)) return value
  if (typeof value === 'string') {
    const parsed = coerceJson(value)
    if (parsed === undefined) {
      return 'findings must be a JSON array; the string received is not JSON'
    }
    if (Array.isArray(parsed)) return parsed
    const unwrapped = findingsProperty(parsed)
    if (unwrapped !== undefined) return unwrapped
    return `findings must be a JSON array, received ${describe(parsed)}`
  }
  const unwrapped = findingsProperty(value)
  if (unwrapped !== undefined) return unwrapped
  return `findings must be an array, received ${describe(value)}`
}

/** `{ findings: [...] }` is the one wrapper models emit often enough to unwrap. */
function findingsProperty(value: unknown): unknown[] | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const inner = (value as Record<string, unknown>).findings
  return Array.isArray(inner) ? inner : undefined
}

function describe(value: unknown): string {
  if (value === null) return 'null'
  if (Array.isArray(value)) return 'an array'
  return `a ${typeof value}`
}

/** One line per refused row, for a repair prompt or an error message. */
export function describeRejectedRows(rejected: readonly RejectedFindingRow[]): string {
  return rejected
    .map((row) => `row ${row.index}${row.path ? ` field '${row.path}'` : ''}: ${row.message}`)
    .join('\n')
}
