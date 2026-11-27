import { describe, expect, it } from 'vitest'
import {
  decideRandomizedCanary,
  joinProspectiveCanaryReceipts,
  type ProspectiveCanaryJoinInput,
  randomizedCanaryObservationDigest,
  randomizedCanaryRosterDigest,
  sealRandomizedCanaryRule,
} from './index'

function synthetic(): ProspectiveCanaryJoinInput {
  const sealed = sealRandomizedCanaryRule({
    experimentId: 'synthetic-served-canary',
    populationId: 'synthetic-eligible-requests',
    eligibilityRuleDigest: 'eligibility:synthetic',
    randomizationSourceId: 'randomizer:synthetic',
    assignmentLedgerAuthorityId: 'platform-ledger',
    controlProfileDigest: 'profile:control',
    candidateProfileDigest: 'profile:candidate',
    servedCodeRevisionDigest: 'served:revision-1',
    outcomeCheckerDigest: 'checker:revision-1',
    confirmatoryFamilyId: 'synthetic-family',
    confirmatoryFamilySize: 1,
    confirmatoryIndex: 1,
    familyReservationSourceId: 'family:synthetic-slot',
    assignmentUnit: 'session',
    clusterUnit: 'session',
    stoppingRule: 'fixed-time',
    analysisCutoff: '2026-09-25T06:00:00.000Z',
    outcomeMaturityMs: 120_000,
    minimumLift: 0,
    minimumClusters: 40,
  })
  const assignments = Array.from({ length: 40 }, (_, i) => ({
    assignmentId: `assignment-${i}`,
    assignmentSourceId: `platform-assignment:${i}`,
    sourceUnitId: `fresh-session-${i}`,
    clusterId: `session-${i}`,
    arm: i % 2 === 0 ? ('control' as const) : ('candidate' as const),
    assignedAt: '2026-09-25T05:00:00.000Z',
  }))
  return {
    enabled: true,
    sealed,
    protocolWitnessedAt: '2026-09-24T23:00:00.000Z',
    historicalSourceUnitIds: ['old-session-0'],
    assignments,
    outcomes: assignments.map((row, i) => ({
      assignmentId: row.assignmentId,
      outcomeSourceId: `checked-outcome:${i}`,
      checkedOutcome: i % 4 === 0 || i % 4 === 1 ? (1 as const) : (0 as const),
      outcomeCheckerDigest: 'checker:revision-1',
      checkedAt: '2026-09-25T05:01:00.000Z',
    })),
    executions: assignments.map((row, i) => ({
      assignmentId: row.assignmentId,
      traceSourceId: `served-trace:${i}`,
      noExecutionSourceId: null,
      servedProfileDigest: row.arm === 'control' ? 'profile:control' : 'profile:candidate',
      servedCodeRevisionDigest: 'served:revision-1',
      turns: 2,
      providerCallIds: [`provider-call:${i}`],
      recordedAt: '2026-09-25T05:01:00.000Z',
    })),
    billing: assignments.map((row, i) => ({
      assignmentId: row.assignmentId,
      billingSourceId: `settled-bill:${i}`,
      settlement: 'settled' as const,
      billedCostUsd: i === 0 ? 0 : 0.003,
      providerCallIds: [`provider-call:${i}`],
      recordedAt: '2026-09-25T05:02:00.000Z',
    })),
  }
}

describe('prospective served canary receipt join', () => {
  it('is off by default and rejects reuse of a frozen source unit', () => {
    const input = synthetic()
    expect(() => joinProspectiveCanaryReceipts({ ...input, enabled: undefined })).toThrow(
      /pilot is disabled/,
    )
    const assignments = input.assignments.map((row, index) =>
      index === 0 ? { ...row, sourceUnitId: 'old-session-0' } : row,
    )
    expect(() => joinProspectiveCanaryReceipts({ ...input, assignments })).toThrow(
      /source unit.*reused/,
    )
  })

  it('joins 40 synthetic served assignments to independent outcome, trace and settled cost sources', () => {
    const input = synthetic()
    const rows = joinProspectiveCanaryReceipts(input)
    expect(rows).toHaveLength(40)
    expect(rows[0]?.billedCostUsd).toBe(0)
    expect(rows[0]?.outcomeSourceId).toBe('checked-outcome:0')
    expect(rows[0]?.traceSourceId).toBe('served-trace:0')
    const decision = decideRandomizedCanary(
      input.sealed,
      {
        protocolDigest: input.sealed.digest,
        assignmentRosterDigest: randomizedCanaryRosterDigest(rows),
        assignmentCount: rows.length,
        assignmentLedgerSourceId: 'platform-ledger:synthetic-roster',
        assignmentLedgerTipDigest: `sha256:${'a'.repeat(64)}`,
        outcomeLedgerSourceId: 'checker-ledger:synthetic',
        billingLedgerSourceId: 'billing-ledger:synthetic',
        observationSnapshotDigest: randomizedCanaryObservationDigest(rows),
        observationFrozenAt: '2026-09-25T06:02:00.000Z',
        authorityId: 'platform-ledger',
        attestationSourceId: 'synthetic-attestation',
        closedAt: '2026-09-25T06:00:00.000Z',
        attestedAt: '2026-09-25T06:02:01.000Z',
      },
      rows,
      () => ({
        verified: true,
        authorityId: 'platform-ledger',
        protocolWitnessedBeforeTraffic: true,
        familySlotReservedBeforeTraffic: true,
        eligibilityAndDispositionVerified: true,
        randomizationVerified: true,
        rosterCompleteAtCutoff: true,
        outcomeAndBillingSnapshotFrozen: true,
        sourceJoinsVerified: true,
        armIsolationVerified: true,
      }),
    )
    expect(decision.assignments).toBe(40)
    expect(decision.coverage.control.billedAssignments).toBe(20)
    expect(decision.coverage.candidate.billedAssignments).toBe(20)
    expect(decision.missingBilling).toBe(0)
    expect(decision.refusal).toBeNull()
    expect(decision.headline95Pass).toBe(false)
  })

  it('preserves unknown failed cost and rejects incomplete provider-call joins', () => {
    const input = synthetic()
    const billing = input.billing.map((row, index) =>
      index === 1 ? { ...row, settlement: 'unknown' as const, billedCostUsd: null } : row,
    )
    const rows = joinProspectiveCanaryReceipts({ ...input, billing })
    expect(rows[1]?.billedCostUsd).toBeNull()
    expect(rows[1]?.billingSourceId).toBe('settled-bill:1')
    const incomplete = billing.map((row, index) =>
      index === 1 ? { ...row, providerCallIds: [] } : row,
    )
    expect(() => joinProspectiveCanaryReceipts({ ...input, billing: incomplete })).toThrow(
      /provider-call billing join is incomplete/,
    )
    expect(() =>
      joinProspectiveCanaryReceipts({
        ...input,
        billing: [...input.billing, { ...input.billing[0]!, assignmentId: 'not-assigned' }],
      }),
    ).toThrow(/orphan billing/)
  })

  // A delegated task runs on a subscription seat in one of the repositories it changes. Tasks
  // are randomized one by one, so one repository holds tasks of both arms; the seat has no
  // dollar figure, which is a known basis, not missing billing.
  it('decides task assignments clustered by repository on subscription seats', () => {
    const base = synthetic()
    const sealed = sealRandomizedCanaryRule({
      ...base.sealed.rule,
      experimentId: 'synthetic-task-canary',
      assignmentUnit: 'task',
      clusterUnit: 'repository',
    })
    const assignments = Array.from({ length: 96 }, (_, i) => ({
      assignmentId: `task-${i}`,
      assignmentSourceId: `assignment-ledger:${i}`,
      sourceUnitId: `brief-${i}`,
      clusterId: `example/repository-${i % 48}`,
      arm: (i % 96 < 48 ? i % 2 : (i + 1) % 2) === 0 ? ('control' as const) : ('candidate' as const),
      assignedAt: '2026-09-25T05:00:00.000Z',
    }))
    const input: ProspectiveCanaryJoinInput = {
      ...base,
      sealed,
      assignments,
      outcomes: assignments.map((row, i) => ({
        assignmentId: row.assignmentId,
        outcomeSourceId: `checked-outcome:${i}`,
        checkedOutcome:
          row.arm === 'candidate' ? (i % 5 === 0 ? 0 : 1) : i % 5 < 2 ? (1 as const) : (0 as const),
        outcomeCheckerDigest: 'checker:revision-1',
        checkedAt: '2026-09-25T05:01:00.000Z',
      })),
      executions: assignments.map((row, i) => ({
        assignmentId: row.assignmentId,
        traceSourceId: `session-transcript:${i}`,
        noExecutionSourceId: null,
        servedProfileDigest: row.arm === 'control' ? 'profile:control' : 'profile:candidate',
        servedCodeRevisionDigest: 'served:revision-1',
        turns: 30,
        providerCallIds: [`turn:${i}`],
        recordedAt: '2026-09-25T05:01:00.000Z',
      })),
      billing: assignments.map((row, i) => ({
        assignmentId: row.assignmentId,
        billingSourceId: `seat-record:${i}`,
        settlement: 'subscription' as const,
        billedCostUsd: null,
        providerCallIds: [`turn:${i}`],
        recordedAt: '2026-09-25T05:02:00.000Z',
      })),
    }
    const rows = joinProspectiveCanaryReceipts(input)
    expect(rows.every((row) => row.billingBasis === 'subscription')).toBe(true)
    const decision = decideRandomizedCanary(
      sealed,
      {
        protocolDigest: sealed.digest,
        assignmentRosterDigest: randomizedCanaryRosterDigest(rows),
        assignmentCount: rows.length,
        assignmentLedgerSourceId: 'assignment-ledger:synthetic',
        assignmentLedgerTipDigest: `sha256:${'b'.repeat(64)}`,
        outcomeLedgerSourceId: 'checker-ledger:synthetic',
        billingLedgerSourceId: 'seat-ledger:synthetic',
        observationSnapshotDigest: randomizedCanaryObservationDigest(rows),
        observationFrozenAt: '2026-09-25T06:02:00.000Z',
        authorityId: 'platform-ledger',
        attestationSourceId: 'synthetic-attestation',
        closedAt: '2026-09-25T06:00:00.000Z',
        attestedAt: '2026-09-25T06:02:01.000Z',
      },
      rows,
      () => ({
        verified: true,
        authorityId: 'platform-ledger',
        protocolWitnessedBeforeTraffic: true,
        familySlotReservedBeforeTraffic: true,
        eligibilityAndDispositionVerified: true,
        randomizationVerified: true,
        rosterCompleteAtCutoff: true,
        outcomeAndBillingSnapshotFrozen: true,
        sourceJoinsVerified: true,
        armIsolationVerified: true,
      }),
    )
    expect(decision.refusal).toBeNull()
    expect(decision.clusters).toBe(48)
    expect(decision.controlClusters).toBe(48)
    expect(decision.candidateClusters).toBe(48)
    expect(decision.missingBilling).toBe(0)
    expect(decision.coverage.candidate.billedAssignments).toBe(48)
    expect(decision.coverage.candidate.subscriptionAssignments).toBe(48)
    expect(decision.controlBilledCostUsd).toBeNull()
    expect(decision.candidateSuccessRate).toBeGreaterThan(decision.controlSuccessRate!)
    expect(decision.headline95Pass).toBe(true)

    expect(() =>
      joinProspectiveCanaryReceipts({
        ...input,
        billing: input.billing.map((row, index) =>
          index === 0 ? { ...row, billedCostUsd: 0.01 } : row,
        ),
      }),
    ).toThrow(/subscription billing has no dollar figure/)
    expect(() =>
      sealRandomizedCanaryRule({ ...sealed.rule, assignmentUnit: 'task', clusterUnit: 'customer' }),
    ).toThrow(/task assignments must cluster by task or repository/)
  })
})
