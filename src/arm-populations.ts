import type { FindingTreatment } from './analyst/finding-composition'
import { findingTreatmentSchema } from './analyst/finding-composition'
import type { PairedArmRow } from './paired-arms'

/** Expected seed identities must be supplied independently of completed observations. */
export interface ArmAssignment {
  pairKey: string
  repKey?: string
  arm: string
  treatment?: FindingTreatment[]
}
export interface ArmPopulationSummary {
  n: number
  passed: number
  failed: number
  missingOutcomes: number
  /** Unknown unless every unit's outcome was observed; missing is never a failed check. */
  passRate: number | null
  metrics: Record<string, { n: number; missing: number; sum: number | null; mean: number | null }>
}
export interface ArmPopulationReading {
  arm: string
  assignments: ArmAssignment[]
  missingObservations: number
  formation: { formed: number; notFormed: number; unknown: number }
  asAssigned: ArmPopulationSummary
  asFormed: ArmPopulationSummary
}

const keyOf = (row: ArmAssignment): string =>
  JSON.stringify([row.arm, row.pairKey, row.repKey ?? null])
function checkIdentity(row: ArmAssignment): void {
  for (const value of [row.arm, row.pairKey, ...(row.repKey === undefined ? [] : [row.repKey])]) {
    if (typeof value !== 'string' || !value.trim())
      throw new TypeError('Arm assignments require nonempty identities')
  }
  if (row.treatment !== undefined) {
    if (!Array.isArray(row.treatment)) throw new TypeError('Arm treatment must be an array')
    for (const value of row.treatment) findingTreatmentSchema.parse(value)
    if (new Set(row.treatment.map((t) => t.id)).size !== row.treatment.length)
      throw new TypeError('Duplicate arm treatment id')
  }
}
function checkObservation(row: PairedArmRow): void {
  checkIdentity(row)
  if (row.pass != null && typeof row.pass !== 'boolean')
    throw new TypeError('Invalid arm pass value')
  if (row.formation !== undefined) {
    if (row.formation === null || typeof row.formation !== 'object')
      throw new TypeError('Invalid formation verdict')
    if (row.formation.formed !== null && typeof row.formation.formed !== 'boolean')
      throw new TypeError('Invalid formation state')
    if (row.formation.reason !== undefined && typeof row.formation.reason !== 'string')
      throw new TypeError('Invalid formation reason')
  }
  for (const value of Object.values(row.metrics ?? {})) {
    if (value !== null && !Number.isFinite(value)) throw new TypeError('Non-finite arm metric')
  }
}

/** One roster join serves comparison and both denominators; no outcomes are inferred from formation. */
export function prepareArmPopulations(
  observations: readonly PairedArmRow[],
  assignments: readonly ArmAssignment[],
  options: { baselineArm: string; treatmentArm: string; metricNames?: string[] },
): { rows: PairedArmRow[]; readings: ArmPopulationReading[] } {
  const arms = [options.baselineArm, options.treatmentArm]
  const roster = new Map<string, ArmAssignment>()
  for (const entry of assignments) {
    if (!arms.includes(entry.arm)) continue
    checkIdentity(entry)
    const key = keyOf(entry)
    if (roster.has(key)) throw new TypeError('Duplicate arm assignment')
    roster.set(key, structuredClone(entry))
  }
  for (const arm of arms)
    if (![...roster.values()].some((r) => r.arm === arm))
      throw new TypeError(`No assignment roster for arm '${arm}'`)
  const actual = new Map<string, PairedArmRow>()
  for (const row of observations) {
    if (!arms.includes(row.arm)) continue
    checkObservation(row)
    const key = keyOf(row)
    if (!roster.has(key)) throw new TypeError('Observed seed is outside the assignment roster')
    if (actual.has(key)) throw new TypeError('Duplicate arm observation')
    actual.set(key, row)
  }
  const ordered = [...roster.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
  // Placeholder rows carry identities only. They never manufacture pass, metrics or formation.
  const rows = ordered.map(([key, entry]) => actual.get(key) ?? entry)
  const metricNames =
    options.metricNames ??
    [...new Set([...actual.values()].flatMap((r) => Object.keys(r.metrics ?? {})))].sort()
  const readings = arms.map((arm) => {
    const declared = ordered.filter(([, r]) => r.arm === arm)
    const asAssigned = declared.map(([key]) => actual.get(key))
    const asFormed = asAssigned.filter(
      (row): row is PairedArmRow => row?.formation?.formed === true,
    )
    return {
      arm,
      assignments: declared.map(([, r]) => r),
      missingObservations: asAssigned.filter((r) => r === undefined).length,
      formation: {
        formed: asFormed.length,
        notFormed: asAssigned.filter((r) => r?.formation?.formed === false).length,
        unknown: asAssigned.filter((r) => r?.formation?.formed == null).length,
      },
      asAssigned: summarize(asAssigned, metricNames),
      asFormed: summarize(asFormed, metricNames),
    }
  })
  return { rows, readings }
}

function summarize(
  rows: readonly (PairedArmRow | undefined)[],
  names: readonly string[],
): ArmPopulationSummary {
  const passed = rows.filter((r) => r?.pass === true).length
  const failed = rows.filter((r) => r?.pass === false).length
  const missingOutcomes = rows.length - passed - failed
  const metrics = Object.fromEntries(
    names.map((name) => {
      const values = rows.map((r) => r?.metrics?.[name]).filter((x): x is number => x != null)
      const sum = values.length ? values.reduce((s, v) => s + v, 0) : null
      return [
        name,
        {
          n: values.length,
          missing: rows.length - values.length,
          sum,
          mean: sum === null ? null : sum / values.length,
        },
      ]
    }),
  )
  return {
    n: rows.length,
    passed,
    failed,
    missingOutcomes,
    passRate: rows.length && !missingOutcomes ? passed / rows.length : null,
    metrics,
  }
}
