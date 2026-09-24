/** Fixed-horizon, assignment-level decision for an unpaired served canary. */

import { ValidationError } from '../errors'
import { hashCanonical, LEDGER_HASH_PATTERN } from '../ledger-core/canonical'
import { studentTCdf, studentTQuantile } from '../math/student-t'

export type CanaryArm = 'control' | 'candidate'

/** One assigned unit, including unsuccessful and unobserved executions. */
export interface CanaryAssignmentReceipt {
  assignmentId: string
  assignmentSourceId: string
  clusterId: string
  arm: CanaryArm
}

export interface CanaryObservation extends CanaryAssignmentReceipt {
  /** Independently checked binary outcome. Null means measurement is unavailable. */
  checkedOutcome: 0 | 1 | null
  outcomeSourceId: string | null
  /** Billed cost, including measured zero. Null means billing is unavailable. */
  billedCostUsd: number | null
  billingSourceId: string | null
  /** Trace identity may be null for an assigned unit that never executed. */
  traceSourceId: string | null
  /** Required when no trace exists; identifies the independent no-execution record. */
  noExecutionSourceId: string | null
  /** Observed identities; null only when there was no execution or no checked outcome. */
  servedProfileDigest: string | null
  servedCodeRevisionDigest: string | null
  outcomeCheckerDigest: string | null
  turns: number | null
}

/** Seal this prospective protocol before the first eligible live assignment. */
export interface RandomizedCanaryRule {
  experimentId: string
  populationId: string
  eligibilityRuleDigest: string
  randomizationSourceId: string
  assignmentLedgerAuthorityId: string
  controlProfileDigest: string
  candidateProfileDigest: string
  servedCodeRevisionDigest: string
  outcomeCheckerDigest: string
  /** One externally reserved slot in a fixed family of confirmatory canaries. */
  confirmatoryFamilyId: string
  confirmatoryFamilySize: number
  confirmatoryIndex: number
  familyReservationSourceId: string
  assignmentUnit: 'customer' | 'session'
  /** Customer clustering also permits sessions of one customer in both arms. */
  clusterUnit: 'customer' | 'session'
  stoppingRule: 'fixed-time'
  /** No assignment after this UTC time enters the frozen cohort. */
  analysisCutoff: string
  /** Wait this long after cutoff for checked outcomes and billing to mature. */
  outcomeMaturityMs: number
  /** Candidate minus control success probability must exceed this margin. */
  minimumLift: number
  /** At least 40 total independent clusters and 20 represented in each arm. */
  minimumClusters: number
}

/** Post-cutoff evidence from the independently verified append-only assignment ledger. */
export interface CanaryCohortReceipt {
  protocolDigest: string
  assignmentRosterDigest: string
  assignmentCount: number
  assignmentLedgerSourceId: string
  assignmentLedgerTipDigest: string
  outcomeLedgerSourceId: string
  billingLedgerSourceId: string
  observationSnapshotDigest: string
  /** Exact preregistered cutoff + outcomeMaturityMs, not a selectable later look. */
  observationFrozenAt: string
  authorityId: string
  attestationSourceId: string
  closedAt: string
  attestedAt: string
}

/** Host verifies the independent witnesses and append-only ledger before inference. */
export type CanaryCohortVerifier = (
  receipt: CanaryCohortReceipt,
  protocol: SealedRandomizedCanaryRule,
) =>
  | {
      verified: true
      authorityId: string
      protocolWitnessedBeforeTraffic: boolean
      familySlotReservedBeforeTraffic: boolean
      eligibilityAndDispositionVerified: boolean
      randomizationVerified: boolean
      rosterCompleteAtCutoff: boolean
      outcomeAndBillingSnapshotFrozen: boolean
      sourceJoinsVerified: boolean
      armIsolationVerified: boolean
    }
  | { verified: false; reason: string }

export interface SealedRandomizedCanaryRule {
  rule: RandomizedCanaryRule
  digest: string
  algo: 'sha256-rfc8785'
}

export type CanaryRefusal =
  | 'missing-evidence'
  | 'missing-trace'
  | 'execution-drift'
  | 'insufficient-clusters'
  | 'dominant-cluster'
  | 'zero-variance'
  | null

export interface RandomizedCanaryDecision {
  registrationDigest: string
  cohortReceiptSourceId: string
  assignmentRosterDigest: string
  estimand: 'assignment-weighted-itt-risk-difference'
  method: 'cluster-robust-t'
  /** The fixed headline remains a nominal 95% interval. */
  confidence: 0.95
  /** Additional Bonferroni level: 1 - 0.05 / registered family size. */
  familyAdjustedConfidence: number
  assignments: number
  controlAssignments: number
  candidateAssignments: number
  clusters: number
  controlClusters: number
  candidateClusters: number
  coverage: Record<
    CanaryArm,
    {
      checkedOutcomes: number
      billedAssignments: number
      turnReceipts: number
      traceReceipts: number
    }
  >
  missingOutcomes: number
  missingBilling: number
  missingTurns: number
  missingTraces: number
  executionDrift: number
  controlSuccessRate: number | null
  candidateSuccessRate: number | null
  delta: number | null
  nominal95Interval: { low: number; high: number } | null
  headline95Pass: boolean
  familyAdjustedInterval: { low: number; high: number } | null
  familywisePass: boolean
  /** Two-sided zero-null p-value before the registered family correction. */
  unadjustedPValue: number | null
  controlBilledCostUsd: number | null
  candidateBilledCostUsd: number | null
  controlTurns: number | null
  candidateTurns: number | null
  refusal: CanaryRefusal
  /** Primary lift criterion only; product cost and latency gates remain external. */
  successCriterionMet: boolean
}

function nonEmpty(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0 || value.trim() !== value) {
    throw new ValidationError(`randomized canary: ${label} must be a nonempty trimmed string`)
  }
}

function validateAssignment(row: CanaryAssignmentReceipt, index: number): void {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    throw new ValidationError(`randomized canary: assignment ${index} must be an object`)
  }
  nonEmpty(row.assignmentId, `assignment ${index} id`)
  nonEmpty(row.assignmentSourceId, `assignment ${index} source id`)
  nonEmpty(row.clusterId, `assignment ${index} cluster id`)
  if (row.arm !== 'control' && row.arm !== 'candidate') {
    throw new ValidationError(
      `randomized canary: assignment ${index} arm must be control or candidate`,
    )
  }
}

/** Digest only assignment facts, so outcome and cost cannot change the roster. */
export function randomizedCanaryRosterDigest(rows: readonly CanaryAssignmentReceipt[]): string {
  const seen = new Set<string>()
  const seenSources = new Set<string>()
  const roster = rows.map((row, index) => {
    validateAssignment(row, index)
    if (seen.has(row.assignmentId)) {
      throw new ValidationError(`randomized canary: duplicate assignment id '${row.assignmentId}'`)
    }
    seen.add(row.assignmentId)
    if (seenSources.has(row.assignmentSourceId)) {
      throw new ValidationError(
        `randomized canary: duplicate assignment source id '${row.assignmentSourceId}'`,
      )
    }
    seenSources.add(row.assignmentSourceId)
    return {
      assignmentId: row.assignmentId,
      assignmentSourceId: row.assignmentSourceId,
      clusterId: row.clusterId,
      arm: row.arm,
    }
  })
  roster.sort((a, b) =>
    a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0,
  )
  return hashCanonical(roster)
}

/** Commit to the one complete checked-outcome, trace, turn, and billing snapshot. */
export function randomizedCanaryObservationDigest(rows: readonly CanaryObservation[]): string {
  // The roster validation also prevents duplicate assignment IDs.
  randomizedCanaryRosterDigest(rows)
  const snapshot = rows.map((row) => ({
    assignmentId: row.assignmentId,
    checkedOutcome: row.checkedOutcome,
    outcomeSourceId: row.outcomeSourceId,
    billedCostUsd: row.billedCostUsd,
    billingSourceId: row.billingSourceId,
    traceSourceId: row.traceSourceId,
    noExecutionSourceId: row.noExecutionSourceId,
    servedProfileDigest: row.servedProfileDigest,
    servedCodeRevisionDigest: row.servedCodeRevisionDigest,
    outcomeCheckerDigest: row.outcomeCheckerDigest,
    turns: row.turns,
  }))
  snapshot.sort((a, b) =>
    a.assignmentId < b.assignmentId ? -1 : a.assignmentId > b.assignmentId ? 1 : 0,
  )
  return hashCanonical(snapshot)
}

function validateRule(rule: RandomizedCanaryRule): void {
  for (const field of [
    'experimentId',
    'populationId',
    'eligibilityRuleDigest',
    'randomizationSourceId',
    'assignmentLedgerAuthorityId',
    'controlProfileDigest',
    'candidateProfileDigest',
    'servedCodeRevisionDigest',
    'outcomeCheckerDigest',
    'confirmatoryFamilyId',
    'familyReservationSourceId',
    'analysisCutoff',
  ] as const)
    nonEmpty(rule[field], field)
  if (
    !Number.isSafeInteger(rule.confirmatoryFamilySize) ||
    rule.confirmatoryFamilySize < 1 ||
    rule.confirmatoryFamilySize > 1000
  ) {
    throw new ValidationError('randomized canary: confirmatoryFamilySize must be in [1, 1000]')
  }
  if (
    !Number.isSafeInteger(rule.confirmatoryIndex) ||
    rule.confirmatoryIndex < 1 ||
    rule.confirmatoryIndex > rule.confirmatoryFamilySize
  ) {
    throw new ValidationError(
      'randomized canary: confirmatoryIndex must name a reserved family slot',
    )
  }
  if (rule.assignmentUnit !== 'customer' && rule.assignmentUnit !== 'session') {
    throw new ValidationError('randomized canary: assignmentUnit must be customer or session')
  }
  if (rule.clusterUnit !== 'customer' && rule.clusterUnit !== 'session') {
    throw new ValidationError('randomized canary: clusterUnit must be customer or session')
  }
  if (rule.assignmentUnit === 'customer' && rule.clusterUnit !== 'customer') {
    throw new ValidationError('randomized canary: customer assignments must cluster by customer')
  }
  if (rule.stoppingRule !== 'fixed-time') {
    throw new ValidationError('randomized canary: only fixed-time stopping is supported')
  }
  if (!Number.isFinite(Date.parse(rule.analysisCutoff)) || !rule.analysisCutoff.endsWith('Z')) {
    throw new ValidationError('randomized canary: analysisCutoff must be a UTC timestamp')
  }
  if (!Number.isSafeInteger(rule.outcomeMaturityMs) || rule.outcomeMaturityMs < 0) {
    throw new ValidationError('randomized canary: outcomeMaturityMs must be a nonnegative integer')
  }
  if (!Number.isFinite(rule.minimumLift) || rule.minimumLift < 0 || rule.minimumLift >= 1) {
    throw new ValidationError('randomized canary: minimumLift must be in [0, 1)')
  }
  if (!Number.isSafeInteger(rule.minimumClusters) || rule.minimumClusters < 40) {
    throw new ValidationError('randomized canary: minimumClusters must be at least 40')
  }
}

/** Seal the fixed decision controls; retaining this digest alone cannot prove preregistration time. */
export function sealRandomizedCanaryRule(rule: RandomizedCanaryRule): SealedRandomizedCanaryRule {
  validateRule(rule)
  const captured = structuredClone(rule)
  return { rule: captured, digest: hashCanonical(captured), algo: 'sha256-rfc8785' }
}

/** Apply one registered analysis to the entire frozen assignment roster. */
export function decideRandomizedCanary(
  sealed: SealedRandomizedCanaryRule,
  cohort: CanaryCohortReceipt,
  rows: readonly CanaryObservation[],
  verifyCohort: CanaryCohortVerifier,
): RandomizedCanaryDecision {
  if (sealed.algo !== 'sha256-rfc8785') {
    throw new ValidationError('randomized canary: unsupported registration digest scheme')
  }
  validateRule(sealed.rule)
  if (hashCanonical(sealed.rule) !== sealed.digest) {
    throw new ValidationError('randomized canary: registration digest mismatch')
  }
  if (cohort === null || typeof cohort !== 'object' || Array.isArray(cohort)) {
    throw new ValidationError('randomized canary: independent cohort receipt is required')
  }
  for (const field of [
    'assignmentLedgerSourceId',
    'outcomeLedgerSourceId',
    'billingLedgerSourceId',
    'authorityId',
    'attestationSourceId',
    'closedAt',
    'observationFrozenAt',
    'attestedAt',
  ] as const) {
    nonEmpty(cohort[field], `cohort ${field}`)
  }
  if (cohort.protocolDigest !== sealed.digest) {
    throw new ValidationError('randomized canary: cohort protocol digest mismatch')
  }
  if (cohort.authorityId !== sealed.rule.assignmentLedgerAuthorityId) {
    throw new ValidationError('randomized canary: cohort authority differs from registered ledger')
  }
  for (const field of [
    'assignmentRosterDigest',
    'assignmentLedgerTipDigest',
    'observationSnapshotDigest',
  ] as const) {
    if (!LEDGER_HASH_PATTERN.test(cohort[field])) {
      throw new ValidationError(`randomized canary: cohort ${field} must be a sha256 digest`)
    }
  }
  if (
    !Number.isSafeInteger(cohort.assignmentCount) ||
    cohort.assignmentCount < 1 ||
    rows.length !== cohort.assignmentCount
  ) {
    throw new ValidationError(
      'randomized canary: assignment count differs from complete ledger receipt',
    )
  }
  if (randomizedCanaryRosterDigest(rows) !== cohort.assignmentRosterDigest) {
    throw new ValidationError('randomized canary: assignment roster digest mismatch')
  }
  if (randomizedCanaryObservationDigest(rows) !== cohort.observationSnapshotDigest) {
    throw new ValidationError('randomized canary: frozen observation snapshot digest mismatch')
  }
  const cutoff = Date.parse(sealed.rule.analysisCutoff)
  const closedAt = Date.parse(cohort.closedAt)
  const frozenAt = Date.parse(cohort.observationFrozenAt)
  const attestedAt = Date.parse(cohort.attestedAt)
  const expectedFreezeAt = cutoff + sealed.rule.outcomeMaturityMs
  if (
    !Number.isFinite(closedAt) ||
    closedAt < cutoff ||
    !cohort.closedAt.endsWith('Z') ||
    !Number.isFinite(frozenAt) ||
    frozenAt !== expectedFreezeAt ||
    closedAt > frozenAt ||
    !cohort.observationFrozenAt.endsWith('Z') ||
    !Number.isFinite(attestedAt) ||
    attestedAt < frozenAt ||
    !cohort.attestedAt.endsWith('Z')
  ) {
    throw new ValidationError(
      'randomized canary: ledger closure or frozen observation time differs from registered cutoffs',
    )
  }
  if (typeof verifyCohort !== 'function') {
    throw new ValidationError('randomized canary: independent cohort verifier is required')
  }
  const verification = verifyCohort(cohort, sealed)
  if (
    verification?.verified !== true ||
    verification.authorityId !== cohort.authorityId ||
    verification.protocolWitnessedBeforeTraffic !== true ||
    verification.familySlotReservedBeforeTraffic !== true ||
    verification.eligibilityAndDispositionVerified !== true ||
    verification.randomizationVerified !== true ||
    verification.rosterCompleteAtCutoff !== true ||
    verification.outcomeAndBillingSnapshotFrozen !== true ||
    verification.sourceJoinsVerified !== true ||
    verification.armIsolationVerified !== true
  ) {
    throw new ValidationError(
      `randomized canary: cohort attestation or completeness unverified${verification?.verified === false ? `: ${verification.reason}` : ''}`,
    )
  }

  const clusters = new Map<string, CanaryObservation[]>()
  const arms = { control: [] as CanaryObservation[], candidate: [] as CanaryObservation[] }
  let missingOutcomes = 0
  let missingBilling = 0
  let missingTurns = 0
  let missingTraces = 0
  let executionDrift = 0
  for (const [index, row] of rows.entries()) {
    if (row.checkedOutcome !== 0 && row.checkedOutcome !== 1 && row.checkedOutcome !== null) {
      throw new ValidationError(
        `randomized canary: assignment ${index} outcome must be 0, 1, or null`,
      )
    }
    if (row.checkedOutcome === null) missingOutcomes++
    if (row.outcomeSourceId === null) {
      if (row.checkedOutcome !== null)
        throw new ValidationError(
          `randomized canary: assignment ${index} has an outcome without its source`,
        )
    } else nonEmpty(row.outcomeSourceId, `assignment ${index} outcome source id`)
    if (row.billedCostUsd === null) missingBilling++
    else if (!Number.isFinite(row.billedCostUsd) || row.billedCostUsd < 0) {
      throw new ValidationError(
        `randomized canary: assignment ${index} billed cost must be nonnegative`,
      )
    }
    if (row.billingSourceId === null) {
      if (row.billedCostUsd !== null)
        throw new ValidationError(
          `randomized canary: assignment ${index} has billed cost without its source`,
        )
    } else nonEmpty(row.billingSourceId, `assignment ${index} billing source id`)
    if (row.turns === null) missingTurns++
    else if (!Number.isSafeInteger(row.turns) || row.turns < 0) {
      throw new ValidationError(
        `randomized canary: assignment ${index} turns must be a nonnegative integer`,
      )
    }
    if (row.traceSourceId !== null)
      nonEmpty(row.traceSourceId, `assignment ${index} trace source id`)
    if (row.noExecutionSourceId !== null)
      nonEmpty(row.noExecutionSourceId, `assignment ${index} no-execution source id`)
    if (row.traceSourceId !== null && row.noExecutionSourceId !== null) {
      throw new ValidationError(
        `randomized canary: assignment ${index} has conflicting trace and no-execution receipts`,
      )
    }
    const noExecution =
      row.noExecutionSourceId !== null &&
      row.turns === 0 &&
      row.billedCostUsd === 0 &&
      row.checkedOutcome === 0
    if (row.traceSourceId === null && !noExecution) missingTraces++
    for (const field of [
      'servedProfileDigest',
      'servedCodeRevisionDigest',
      'outcomeCheckerDigest',
    ] as const) {
      if (row[field] !== null) nonEmpty(row[field], `assignment ${index} ${field}`)
    }
    const expectedProfile =
      row.arm === 'control' ? sealed.rule.controlProfileDigest : sealed.rule.candidateProfileDigest
    if (
      (row.traceSourceId !== null &&
        (row.servedProfileDigest !== expectedProfile ||
          row.servedCodeRevisionDigest !== sealed.rule.servedCodeRevisionDigest)) ||
      (row.checkedOutcome !== null &&
        row.outcomeCheckerDigest !== sealed.rule.outcomeCheckerDigest) ||
      (noExecution && (row.servedProfileDigest !== null || row.servedCodeRevisionDigest !== null))
    ) {
      executionDrift++
    }
    arms[row.arm].push(row)
    const bucket = clusters.get(row.clusterId) ?? []
    bucket.push(row)
    clusters.set(row.clusterId, bucket)
  }
  const controlClusters = [...clusters.values()].filter((bucket) =>
    bucket.some((r) => r.arm === 'control'),
  ).length
  const candidateClusters = [...clusters.values()].filter((bucket) =>
    bucket.some((r) => r.arm === 'candidate'),
  ).length
  if (sealed.rule.assignmentUnit === sealed.rule.clusterUnit) {
    for (const [clusterId, bucket] of clusters) {
      if (bucket.length !== 1) {
        throw new ValidationError(
          `randomized canary: ${sealed.rule.assignmentUnit} cluster '${clusterId}' has multiple assignments`,
        )
      }
    }
  }
  const coverage = (arm: CanaryArm) => ({
    checkedOutcomes: arms[arm].filter((row) => row.checkedOutcome !== null).length,
    billedAssignments: arms[arm].filter((row) => row.billedCostUsd !== null).length,
    turnReceipts: arms[arm].filter((row) => row.turns !== null).length,
    traceReceipts: arms[arm].filter((row) => row.traceSourceId !== null).length,
  })
  const armCoverage = { control: coverage('control'), candidate: coverage('candidate') }
  const sum = (arm: CanaryArm, field: 'checkedOutcome' | 'billedCostUsd' | 'turns'): number =>
    arms[arm].reduce((total, row) => total + (row[field] ?? 0), 0)
  const n0 = arms.control.length
  const n1 = arms.candidate.length
  const outcomesComplete = missingOutcomes === 0 && n0 > 0 && n1 > 0
  const p0 = outcomesComplete ? sum('control', 'checkedOutcome') / n0 : null
  const p1 = outcomesComplete ? sum('candidate', 'checkedOutcome') / n1 : null
  const delta = p0 === null || p1 === null ? null : p1 - p0
  const result: RandomizedCanaryDecision = {
    registrationDigest: sealed.digest,
    cohortReceiptSourceId: cohort.attestationSourceId,
    assignmentRosterDigest: cohort.assignmentRosterDigest,
    estimand: 'assignment-weighted-itt-risk-difference',
    method: 'cluster-robust-t',
    confidence: 0.95,
    familyAdjustedConfidence: 1 - 0.05 / sealed.rule.confirmatoryFamilySize,
    assignments: rows.length,
    controlAssignments: n0,
    candidateAssignments: n1,
    clusters: clusters.size,
    controlClusters,
    candidateClusters,
    coverage: armCoverage,
    missingOutcomes,
    missingBilling,
    missingTurns,
    missingTraces,
    executionDrift,
    controlSuccessRate: p0,
    candidateSuccessRate: p1,
    delta,
    nominal95Interval: null,
    headline95Pass: false,
    familyAdjustedInterval: null,
    familywisePass: false,
    unadjustedPValue: null,
    controlBilledCostUsd:
      armCoverage.control.billedAssignments === n0 ? sum('control', 'billedCostUsd') : null,
    candidateBilledCostUsd:
      armCoverage.candidate.billedAssignments === n1 ? sum('candidate', 'billedCostUsd') : null,
    controlTurns: armCoverage.control.turnReceipts === n0 ? sum('control', 'turns') : null,
    candidateTurns: armCoverage.candidate.turnReceipts === n1 ? sum('candidate', 'turns') : null,
    refusal: null,
    successCriterionMet: false,
  }
  if (missingOutcomes > 0 || missingBilling > 0 || missingTurns > 0 || n0 === 0 || n1 === 0) {
    result.refusal = 'missing-evidence'
    return result
  }
  if (missingTraces > 0) {
    result.refusal = 'missing-trace'
    return result
  }
  if (executionDrift > 0) {
    result.refusal = 'execution-drift'
    return result
  }
  if (
    clusters.size < sealed.rule.minimumClusters ||
    controlClusters < 20 ||
    candidateClusters < 20
  ) {
    result.refusal = 'insufficient-clusters'
    return result
  }
  // A single customer may own many assigned sessions. One dominant customer
  // defeats the many-independent-clusters approximation even when G is large.
  for (const bucket of clusters.values()) {
    if (
      bucket.filter((r) => r.arm === 'control').length / n0 > 0.1 ||
      bucket.filter((r) => r.arm === 'candidate').length / n1 > 0.1
    ) {
      result.refusal = 'dominant-cluster'
      return result
    }
  }
  // OLS risk difference with customer/session cluster sandwich scores. A
  // cluster may contain both arms; its covariance contribution stays intact.
  const scores = [...clusters.values()].map((bucket) =>
    bucket.reduce(
      (score, row) =>
        score +
        (row.arm === 'candidate'
          ? (row.checkedOutcome! - p1!) / n1
          : -(row.checkedOutcome! - p0!) / n0),
      0,
    ),
  )
  const G = clusters.size
  const variance =
    (((G / (G - 1)) * (rows.length - 1)) / (rows.length - 2)) *
    scores.reduce((total, score) => total + score * score, 0)
  if (!Number.isFinite(variance) || variance <= 0) {
    result.refusal = 'zero-variance'
    return result
  }
  const se = Math.sqrt(variance)
  const t = delta! / se
  const critical95 = studentTQuantile(0.975, G - 1)
  const familyCritical = studentTQuantile(1 - (1 - result.familyAdjustedConfidence) / 2, G - 1)
  result.nominal95Interval = { low: delta! - critical95 * se, high: delta! + critical95 * se }
  result.familyAdjustedInterval = {
    low: delta! - familyCritical * se,
    high: delta! + familyCritical * se,
  }
  result.unadjustedPValue = Math.min(1, 2 * (1 - studentTCdf(Math.abs(t), G - 1)))
  result.headline95Pass = result.nominal95Interval.low > 0
  result.familywisePass = result.familyAdjustedInterval.low > sealed.rule.minimumLift
  result.successCriterionMet = result.headline95Pass && result.familywisePass
  return result
}
