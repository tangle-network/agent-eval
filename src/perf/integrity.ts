/**
 * Record-integrity contracts for perf metric records.
 *
 * A record that claims `pass === true` must actually carry the journey's
 * required measurements — a "passing" provision run with a null
 * `total_ms` is a lying record, not a pass. Failed records are exempt:
 * a run that errored mid-flight legitimately has nulls.
 */

import type { JourneySpec } from './journey'

export interface IntegrityViolation {
  recordIndex: number
  journeyId: string
  field: string
  reason: 'null-required-field' | 'below-minimum'
  detail: string
}

export interface IntegrityResult {
  succeeded: boolean
  violations: IntegrityViolation[]
}

function isMissing(value: unknown): boolean {
  return value === null || value === undefined
}

/**
 * Validates flat metric records (Record<string, unknown> with a boolean
 * `pass` field) against their journey contract. Only records with
 * pass === true are checked — a failed record may legitimately have nulls.
 * resolveJourney maps a record to its JourneySpec (or null to skip).
 */
export function checkRecordIntegrity(
  records: ReadonlyArray<Record<string, unknown>>,
  resolveJourney: (record: Record<string, unknown>) => JourneySpec | null,
): IntegrityResult {
  const violations: IntegrityViolation[] = []
  for (const [recordIndex, record] of records.entries()) {
    if (record.pass !== true) continue
    const journey = resolveJourney(record)
    if (journey === null) continue
    for (const field of journey.requiredFields) {
      if (isMissing(record[field])) {
        violations.push({
          recordIndex,
          journeyId: journey.id,
          field,
          reason: 'null-required-field',
          detail: `required field '${field}' is ${record[field] === null ? 'null' : 'undefined'} on a passing '${journey.id}' record`,
        })
      }
    }
    for (const field of journey.phaseFields ?? []) {
      if (isMissing(record[field])) {
        violations.push({
          recordIndex,
          journeyId: journey.id,
          field,
          reason: 'null-required-field',
          detail: `phase field '${field}' is ${record[field] === null ? 'null' : 'undefined'} on a passing '${journey.id}' record`,
        })
      }
    }
    for (const { field, min } of journey.minimums ?? []) {
      const value = record[field]
      if (isMissing(value)) continue // null-ness is the required/phase fields' contract
      if (typeof value !== 'number' || Number.isNaN(value)) {
        violations.push({
          recordIndex,
          journeyId: journey.id,
          field,
          reason: 'below-minimum',
          detail: `field '${field}' has non-numeric value ${JSON.stringify(value)} on a passing '${journey.id}' record (minimum ${min})`,
        })
        continue
      }
      if (value < min) {
        violations.push({
          recordIndex,
          journeyId: journey.id,
          field,
          reason: 'below-minimum',
          detail: `field '${field}' is ${value}, below minimum ${min} on a passing '${journey.id}' record`,
        })
      }
    }
  }
  return { succeeded: violations.length === 0, violations }
}

/** Throws an Error listing every violation when the result fails. */
export function assertRecordIntegrity(
  records: ReadonlyArray<Record<string, unknown>>,
  resolveJourney: (record: Record<string, unknown>) => JourneySpec | null,
): void {
  const result = checkRecordIntegrity(records, resolveJourney)
  if (result.succeeded) return
  const lines = result.violations.map(
    (v) => `  [record ${v.recordIndex}] ${v.journeyId}.${v.field} (${v.reason}): ${v.detail}`,
  )
  throw new Error(
    `Record integrity check failed with ${result.violations.length} violation(s):\n${lines.join('\n')}`,
  )
}
