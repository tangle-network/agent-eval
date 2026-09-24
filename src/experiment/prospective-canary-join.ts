import { ValidationError } from '../errors'
import type {
  CanaryAssignmentReceipt,
  CanaryObservation,
  SealedRandomizedCanaryRule,
} from './randomized-canary'

/** Host-ledger assignment written when an eligible request is routed. */
export interface ProspectiveCanaryAssignment extends CanaryAssignmentReceipt {
  sourceUnitId: string
  assignedAt: string
}

/** Independent checker result, including a null when the outcome is unavailable. */
export interface ProspectiveCanaryOutcome {
  assignmentId: string
  outcomeSourceId: string
  checkedOutcome: 0 | 1 | null
  outcomeCheckerDigest: string
  checkedAt: string
}

/** Served trace, or an independent receipt that the assigned unit never executed. */
export interface ProspectiveCanaryExecution {
  assignmentId: string
  traceSourceId: string | null
  noExecutionSourceId: string | null
  servedProfileDigest: string | null
  servedCodeRevisionDigest: string | null
  turns: number | null
  providerCallIds: readonly string[]
  recordedAt: string
}

/** Billing authority's settled snapshot for every provider call in one assignment. */
export interface ProspectiveCanaryBilling {
  assignmentId: string
  billingSourceId: string
  settlement: 'settled' | 'unknown'
  billedCostUsd: number | null
  providerCallIds: readonly string[]
  recordedAt: string
}

export interface ProspectiveCanaryJoinInput {
  /** An opt-in host flag. Calling this function never routes product traffic. */
  enabled?: boolean
  sealed: SealedRandomizedCanaryRule
  /** The host must independently verify this witness predates every assignment. */
  protocolWitnessedAt: string
  /** The complete prior-source roster must be attested by the host verifier. */
  historicalSourceUnitIds: readonly string[]
  assignments: readonly ProspectiveCanaryAssignment[]
  outcomes: readonly ProspectiveCanaryOutcome[]
  executions: readonly ProspectiveCanaryExecution[]
  billing: readonly ProspectiveCanaryBilling[]
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ValidationError(`prospective canary: ${label} must be a nonempty trimmed string`)
  }
}

function utc(value: unknown, label: string): number {
  nonEmpty(value, label)
  const parsed = Date.parse(value)
  const canonical = Number.isFinite(parsed) ? new Date(parsed).toISOString() : ''
  if (
    !value.endsWith('Z') ||
    !Number.isFinite(parsed) ||
    (value !== canonical && value !== canonical.replace('.000Z', 'Z'))
  ) {
    throw new ValidationError(`prospective canary: ${label} must be a canonical UTC timestamp`)
  }
  return parsed
}

function indexRows<T extends { assignmentId: string }>(
  rows: readonly T[],
  label: string,
  assignments: ReadonlySet<string>,
): Map<string, T> {
  const indexed = new Map<string, T>()
  for (const row of rows) {
    nonEmpty(row.assignmentId, `${label} assignmentId`)
    if (!assignments.has(row.assignmentId)) {
      throw new ValidationError(`prospective canary: orphan ${label} for '${row.assignmentId}'`)
    }
    if (indexed.has(row.assignmentId)) {
      throw new ValidationError(`prospective canary: duplicate ${label} for '${row.assignmentId}'`)
    }
    indexed.set(row.assignmentId, row)
  }
  return indexed
}

function uniqueIds(ids: readonly string[], label: string): string[] {
  if (!Array.isArray(ids)) {
    throw new ValidationError(`prospective canary: ${label} must be an array`)
  }
  const seen = new Set<string>()
  for (const id of ids) {
    nonEmpty(id, label)
    if (seen.has(id)) throw new ValidationError(`prospective canary: duplicate ${label} '${id}'`)
    seen.add(id)
  }
  return [...seen].sort()
}

/**
 * Join independently sourced served receipts without inventing missing costs.
 * The host still verifies ledger completeness, source authority, isolation,
 * randomization and the pre-traffic witness in `decideRandomizedCanary`.
 */
export function joinProspectiveCanaryReceipts(
  input: ProspectiveCanaryJoinInput,
): CanaryObservation[] {
  if (input.enabled !== true) {
    throw new ValidationError('prospective canary: pilot is disabled')
  }
  const witnessedAt = utc(input.protocolWitnessedAt, 'protocolWitnessedAt')
  const cutoff = utc(input.sealed.rule.analysisCutoff, 'analysisCutoff')
  if (witnessedAt >= cutoff) {
    throw new ValidationError('prospective canary: protocol witness must precede cutoff')
  }
  if (!Array.isArray(input.assignments) || input.assignments.length === 0) {
    throw new ValidationError('prospective canary: assignment ledger is empty')
  }
  const historical = new Set(uniqueIds(input.historicalSourceUnitIds, 'historical source unit'))
  const assignmentIds = new Set<string>()
  const assignmentSources = new Set<string>()
  const sourceUnits = new Set<string>()
  for (const row of input.assignments) {
    nonEmpty(row.assignmentId, 'assignmentId')
    nonEmpty(row.assignmentSourceId, 'assignmentSourceId')
    nonEmpty(row.clusterId, 'clusterId')
    nonEmpty(row.sourceUnitId, 'sourceUnitId')
    if (row.arm !== 'control' && row.arm !== 'candidate') {
      throw new ValidationError('prospective canary: assignment arm is invalid')
    }
    if (assignmentIds.has(row.assignmentId) || assignmentSources.has(row.assignmentSourceId)) {
      throw new ValidationError('prospective canary: duplicate assignment identity')
    }
    if (sourceUnits.has(row.sourceUnitId) || historical.has(row.sourceUnitId)) {
      throw new ValidationError(`prospective canary: source unit '${row.sourceUnitId}' is reused`)
    }
    const assignedAt = utc(row.assignedAt, `assignment '${row.assignmentId}' assignedAt`)
    if (assignedAt <= witnessedAt || assignedAt > cutoff) {
      throw new ValidationError('prospective canary: assignment falls outside witnessed window')
    }
    assignmentIds.add(row.assignmentId)
    assignmentSources.add(row.assignmentSourceId)
    sourceUnits.add(row.sourceUnitId)
  }
  const outcomes = indexRows(input.outcomes, 'outcome', assignmentIds)
  const executions = indexRows(input.executions, 'execution', assignmentIds)
  const billing = indexRows(input.billing, 'billing', assignmentIds)
  const sourceIds = new Set(assignmentSources)
  const claimSource = (id: string, label: string) => {
    nonEmpty(id, label)
    if (sourceIds.has(id)) {
      throw new ValidationError(`prospective canary: reused independent source '${id}'`)
    }
    sourceIds.add(id)
  }

  return input.assignments.map((assignment) => {
    const outcome = outcomes.get(assignment.assignmentId)
    const execution = executions.get(assignment.assignmentId)
    const bill = billing.get(assignment.assignmentId)
    const assignedAt = Date.parse(assignment.assignedAt)
    if (outcome) {
      claimSource(outcome.outcomeSourceId, 'outcomeSourceId')
      nonEmpty(outcome.outcomeCheckerDigest, 'outcomeCheckerDigest')
      if (utc(outcome.checkedAt, 'checkedAt') < assignedAt) {
        throw new ValidationError('prospective canary: outcome precedes assignment')
      }
      if (![0, 1, null].includes(outcome.checkedOutcome)) {
        throw new ValidationError('prospective canary: checked outcome must be 0, 1 or null')
      }
    }
    if (execution) {
      if ((execution.traceSourceId === null) === (execution.noExecutionSourceId === null)) {
        throw new ValidationError(
          'prospective canary: execution needs one trace or no-execution source',
        )
      }
      claimSource(execution.traceSourceId ?? execution.noExecutionSourceId!, 'execution source')
      if (utc(execution.recordedAt, 'execution recordedAt') < assignedAt) {
        throw new ValidationError('prospective canary: execution precedes assignment')
      }
      if (
        execution.turns !== null &&
        (!Number.isSafeInteger(execution.turns) || execution.turns < 0)
      ) {
        throw new ValidationError('prospective canary: turns must be a nonnegative integer')
      }
      if (
        execution.noExecutionSourceId !== null &&
        (execution.turns !== 0 || execution.providerCallIds.length !== 0)
      ) {
        throw new ValidationError(
          'prospective canary: no-execution receipt contains turns or calls',
        )
      }
    }
    if (bill) {
      claimSource(bill.billingSourceId, 'billingSourceId')
      if (utc(bill.recordedAt, 'billing recordedAt') < assignedAt) {
        throw new ValidationError('prospective canary: billing precedes assignment')
      }
      if (bill.settlement === 'settled') {
        if (
          bill.billedCostUsd === null ||
          !Number.isFinite(bill.billedCostUsd) ||
          bill.billedCostUsd < 0
        ) {
          throw new ValidationError(
            'prospective canary: settled billing needs nonnegative actual cost',
          )
        }
      } else if (bill.settlement !== 'unknown' || bill.billedCostUsd !== null) {
        throw new ValidationError('prospective canary: unknown billing cost must stay null')
      }
      if (
        execution &&
        uniqueIds(bill.providerCallIds, 'billing call').join('\0') !==
          uniqueIds(execution.providerCallIds, 'execution call').join('\0')
      ) {
        throw new ValidationError('prospective canary: provider-call billing join is incomplete')
      }
    }
    return {
      assignmentId: assignment.assignmentId,
      assignmentSourceId: assignment.assignmentSourceId,
      clusterId: assignment.clusterId,
      arm: assignment.arm,
      checkedOutcome: outcome?.checkedOutcome ?? null,
      outcomeSourceId: outcome?.outcomeSourceId ?? null,
      billedCostUsd: bill?.settlement === 'settled' ? bill.billedCostUsd : null,
      billingSourceId: bill?.billingSourceId ?? null,
      traceSourceId: execution?.traceSourceId ?? null,
      noExecutionSourceId: execution?.noExecutionSourceId ?? null,
      servedProfileDigest: execution?.servedProfileDigest ?? null,
      servedCodeRevisionDigest: execution?.servedCodeRevisionDigest ?? null,
      outcomeCheckerDigest: outcome?.outcomeCheckerDigest ?? null,
      turns: execution?.turns ?? null,
    }
  })
}
