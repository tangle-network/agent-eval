// Frozen golden-record fixtures.
//
// A version file is written once and never edited. A behaviour change mints a
// new file and registers it here beside the old one, so the diff between two
// versions is the reviewable record of what moved and the previous contract
// stays runnable.

import type { MultishotGoldenRecordSet } from '../types'
import v1 from './v1.json'

/** Version a check uses when the caller names none. */
export const CURRENT_MULTISHOT_GOLDEN_VERSION = 'v1'

/** A fixture reaches this module as parsed JSON, which types cannot vouch for.
 *  A record set that is not the shape the harness reads would surface as a
 *  confusing mismatch on every scenario, so the shape is checked once at load
 *  and named where it breaks. */
function assertRecordSet(value: unknown, version: string): MultishotGoldenRecordSet {
  const fail = (reason: string): never => {
    throw new Error(`multishot golden ${version}: malformed record set — ${reason}`)
  }
  if (typeof value !== 'object' || value === null) fail('expected an object')
  const set = value as Record<string, unknown>
  for (const key of ['version', 'recordedFrom', 'recordedFromPackageVersion', 'recordedAt']) {
    if (typeof set[key] !== 'string') fail(`${key} must be a string`)
  }
  if (set.version !== version) fail(`declares version ${String(set.version)}`)
  if (!Array.isArray(set.scenarios) || set.scenarios.length === 0) {
    fail('scenarios must be a non-empty array')
  }
  if (!Array.isArray(set.matrixScenarios)) fail('matrixScenarios must be an array')
  for (const [index, entry] of (set.scenarios as unknown[]).entries()) {
    const row = entry as Record<string, unknown>
    if (typeof row?.id !== 'string') fail(`scenarios[${index}].id must be a string`)
    if (!Array.isArray(row.requests)) fail(`scenarios[${index}].requests must be an array`)
    const outcome = row.outcome as Record<string, unknown> | undefined
    if (outcome?.kind !== 'result' && outcome?.kind !== 'error') {
      fail(`scenarios[${index}].outcome.kind must be result or error`)
    }
  }
  for (const [index, entry] of (set.matrixScenarios as unknown[]).entries()) {
    const row = entry as Record<string, unknown>
    if (typeof row?.id !== 'string') fail(`matrixScenarios[${index}].id must be a string`)
    if (typeof row.files !== 'object' || row.files === null) {
      fail(`matrixScenarios[${index}].files must be an object`)
    }
  }
  return set as unknown as MultishotGoldenRecordSet
}

/** The set is handed to every caller, so a caller that mutated it would move
 *  the oracle for the whole process. Freezing makes the documented immutability
 *  a property of the value rather than a convention. */
function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== 'object') return value
  for (const entry of Object.values(value as Record<string, unknown>)) deepFreeze(entry)
  return Object.freeze(value)
}

const VERSIONS: Record<string, MultishotGoldenRecordSet> = {
  v1: deepFreeze(assertRecordSet(v1, 'v1')),
}

export function multishotGoldenVersions(): string[] {
  return Object.keys(VERSIONS)
}

export function goldenRecords(
  version: string = CURRENT_MULTISHOT_GOLDEN_VERSION,
): MultishotGoldenRecordSet {
  const set = VERSIONS[version]
  if (!set) {
    throw new Error(
      `multishot golden: no record set for version "${version}" — known versions are ${multishotGoldenVersions().join(', ')}`,
    )
  }
  return set
}
