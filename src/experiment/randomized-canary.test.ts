import { describe, expect, it } from 'vitest'
import { mulberry32 } from '../statistics'
import {
  type CanaryCohortReceipt,
  type CanaryObservation,
  decideRandomizedCanary,
  type RandomizedCanaryRule,
  randomizedCanaryObservationDigest,
  randomizedCanaryRosterDigest,
  type SealedRandomizedCanaryRule,
  sealRandomizedCanaryRule,
} from './index'

function fixture(effect = 0, seed = 7, customerCount = 60): CanaryObservation[] {
  const rng = mulberry32(seed)
  const rows: CanaryObservation[] = []
  for (let customer = 0; customer < customerCount; customer++) {
    const propensity = rng() < 0.5 ? 0.25 : 0.65
    const order = [0, 1, 2, 3]
    for (let i = 3; i > 0; i--) {
      const j = Math.floor(rng() * (i + 1))
      ;[order[i], order[j]] = [order[j]!, order[i]!]
    }
    const controlSessions = new Set(order.slice(0, 2))
    for (let session = 0; session < 4; session++) {
      const assignmentId = `customer-${customer}-session-${session}`
      const arm = controlSessions.has(session) ? 'control' : 'candidate'
      rows.push({
        assignmentId,
        assignmentSourceId: `assignment:${assignmentId}`,
        clusterId: `customer-${customer}`,
        arm,
        checkedOutcome: rng() < propensity + (arm === 'candidate' ? effect : 0) ? 1 : 0,
        outcomeSourceId: `checked:${assignmentId}`,
        billedCostUsd: 0.01,
        billingSourceId: `bill:${assignmentId}`,
        traceSourceId: `trace:${assignmentId}`,
        noExecutionSourceId: null,
        servedProfileDigest: arm === 'control' ? 'profile:control' : 'profile:candidate',
        servedCodeRevisionDigest: 'served:revision-1',
        outcomeCheckerDigest: 'checker:revision-1',
        turns: 3,
      })
    }
  }
  return rows
}

function rule(): RandomizedCanaryRule {
  return {
    experimentId: 'served-canary-1',
    populationId: 'eligible-live-agent-requests',
    eligibilityRuleDigest: 'eligibility:revision-1',
    randomizationSourceId: 'randomizer:served-canary-1',
    assignmentLedgerAuthorityId: 'platform-ledger',
    controlProfileDigest: 'profile:control',
    candidateProfileDigest: 'profile:candidate',
    servedCodeRevisionDigest: 'served:revision-1',
    outcomeCheckerDigest: 'checker:revision-1',
    confirmatoryFamilyId: 'weekly-agent-improvement',
    confirmatoryFamilySize: 1,
    confirmatoryIndex: 1,
    familyReservationSourceId: 'family-ledger:slot-1',
    assignmentUnit: 'session',
    clusterUnit: 'customer',
    stoppingRule: 'fixed-time',
    analysisCutoff: '2026-09-25T06:00:00Z',
    outcomeMaturityMs: 120_000,
    minimumLift: 0,
    minimumClusters: 40,
  }
}

function receipt(
  sealed: SealedRandomizedCanaryRule,
  rows: CanaryObservation[],
): CanaryCohortReceipt {
  return {
    protocolDigest: sealed.digest,
    assignmentRosterDigest: randomizedCanaryRosterDigest(rows),
    assignmentCount: rows.length,
    assignmentLedgerSourceId: 'assignment-ledger:at-cutoff',
    assignmentLedgerTipDigest: `sha256:${'a'.repeat(64)}`,
    outcomeLedgerSourceId: 'outcome-ledger:at-freeze',
    billingLedgerSourceId: 'billing-ledger:at-freeze',
    observationSnapshotDigest: randomizedCanaryObservationDigest(rows),
    observationFrozenAt: '2026-09-25T06:02:00Z',
    authorityId: 'platform-ledger',
    attestationSourceId: 'platform-attestation:cohort-1',
    closedAt: '2026-09-25T06:01:00Z',
    attestedAt: '2026-09-25T06:03:00Z',
  }
}

const verified = (cohort: CanaryCohortReceipt) => ({
  verified: true as const,
  authorityId: cohort.authorityId,
  protocolWitnessedBeforeTraffic: true as const,
  familySlotReservedBeforeTraffic: true as const,
  eligibilityAndDispositionVerified: true as const,
  randomizationVerified: true as const,
  rosterCompleteAtCutoff: true as const,
  outcomeAndBillingSnapshotFrozen: true as const,
  sourceJoinsVerified: true as const,
  armIsolationVerified: true as const,
})

function analyze(rows: CanaryObservation[], registration = rule()) {
  // The protocol is sealed before the simulated assignments and outcome receipt are joined.
  const sealed = sealRandomizedCanaryRule(registration)
  return decideRandomizedCanary(sealed, receipt(sealed, rows), rows, verified)
}

describe('randomized served canary', () => {
  it('keeps mixed-arm customer sessions in one cluster and reports the fixed 95% headline', () => {
    const decision = analyze(fixture(0.2))
    expect(decision.assignments).toBe(240)
    expect(decision.controlAssignments).toBe(120)
    expect(decision.candidateAssignments).toBe(120)
    expect(decision.clusters).toBe(60)
    expect(decision.controlClusters).toBe(60)
    expect(decision.candidateClusters).toBe(60)
    expect(decision.coverage.control).toEqual({
      checkedOutcomes: 120,
      billedAssignments: 120,
      turnReceipts: 120,
      traceReceipts: 120,
    })
    expect(decision.confidence).toBe(0.95)
    expect(decision.refusal).toBeNull()
    expect(decision.nominal95Interval).not.toBeNull()
    expect(decision.controlBilledCostUsd).toBeCloseTo(1.2)
    expect(decision.candidateTurns).toBe(360)
  })

  it('retains assigned units and refuses unavailable outcome, billing, or turn evidence', () => {
    const rows = fixture()
    const controlIndex = rows.findIndex((row) => row.arm === 'control')
    const missingOutcome = rows.map((row, i) =>
      i === 0
        ? ({
            ...row,
            checkedOutcome: null,
            outcomeSourceId: null,
            outcomeCheckerDigest: null,
          } as const)
        : row,
    )
    const outcomeDecision = analyze(missingOutcome)
    expect(outcomeDecision.refusal).toBe('missing-evidence')
    expect(outcomeDecision.missingOutcomes).toBe(1)
    expect(outcomeDecision.delta).toBeNull()
    expect(outcomeDecision.successCriterionMet).toBe(false)
    const missingBill = rows.map((row, i) =>
      i === controlIndex ? ({ ...row, billedCostUsd: null, billingSourceId: null } as const) : row,
    )
    const billDecision = analyze(missingBill)
    expect(billDecision.refusal).toBe('missing-evidence')
    expect(billDecision.missingBilling).toBe(1)
    expect(billDecision.controlBilledCostUsd).toBeNull()
    expect(billDecision.candidateBilledCostUsd).toBeCloseTo(1.2)
    expect(billDecision.coverage.control.billedAssignments).toBe(119)
    const missingTurn = rows.map((row, i) => (i === 0 ? ({ ...row, turns: null } as const) : row))
    expect(analyze(missingTurn).missingTurns).toBe(1)
  })

  it('rejects incomplete, changed, unwitnessed, and mutable cohort evidence', () => {
    const rows = fixture()
    const sealed = sealRandomizedCanaryRule(rule())
    const frozen = receipt(sealed, rows)
    expect(() => decideRandomizedCanary(sealed, frozen, rows.slice(1), verified)).toThrow(
      /assignment count/,
    )
    expect(() =>
      decideRandomizedCanary(
        sealed,
        frozen,
        rows.map((row, i) =>
          i === 0
            ? { ...row, arm: row.arm === 'control' ? ('candidate' as const) : ('control' as const) }
            : row,
        ),
        verified,
      ),
    ).toThrow(/roster digest/)
    expect(() =>
      decideRandomizedCanary(
        sealed,
        frozen,
        rows.map((row, i) =>
          i === 0
            ? { ...row, checkedOutcome: row.checkedOutcome === 0 ? (1 as const) : (0 as const) }
            : row,
        ),
        verified,
      ),
    ).toThrow(/snapshot digest/)
    expect(() => randomizedCanaryRosterDigest([rows[0]!, rows[0]!])).toThrow(/duplicate assignment/)
    expect(() =>
      randomizedCanaryRosterDigest([
        rows[0]!,
        { ...rows[1]!, assignmentSourceId: rows[0]!.assignmentSourceId },
      ]),
    ).toThrow(/duplicate assignment source/)
    expect(() =>
      decideRandomizedCanary(sealed, frozen, rows, () => ({ verified: false, reason: 'unsigned' })),
    ).toThrow(/unverified/)
    for (const flag of [
      'eligibilityAndDispositionVerified',
      'randomizationVerified',
      'sourceJoinsVerified',
      'armIsolationVerified',
    ] as const) {
      expect(() =>
        decideRandomizedCanary(sealed, frozen, rows, (cohort) => ({
          ...verified(cohort),
          [flag]: false,
        })),
      ).toThrow(/unverified/)
    }
    expect(() =>
      decideRandomizedCanary(
        sealed,
        { ...frozen, observationFrozenAt: '2026-09-25T06:03:00Z' },
        rows,
        verified,
      ),
    ).toThrow(/frozen observation time/)
    expect(() =>
      decideRandomizedCanary(
        sealed,
        { ...frozen, attestedAt: '2026-09-25T06:00:00Z' },
        rows,
        verified,
      ),
    ).toThrow(/frozen observation time/)
    expect(() =>
      decideRandomizedCanary(
        { ...sealed, rule: { ...sealed.rule, minimumLift: 0.1 } },
        frozen,
        rows,
        verified,
      ),
    ).toThrow(/registration digest/)
    expect(() =>
      decideRandomizedCanary(
        sealed,
        frozen,
        rows.map((row, i) => (i === 0 ? { ...row, outcomeSourceId: null } : row)),
        verified,
      ),
    ).toThrow(/snapshot digest/)
  })

  it('requires raw traces for executions and independently sourced no-execution failures', () => {
    const rows = fixture()
    const missingTrace = rows.map((row, i) =>
      i === 0 ? ({ ...row, traceSourceId: null } as const) : row,
    )
    const decision = analyze(missingTrace)
    expect(decision.refusal).toBe('missing-trace')
    expect(decision.missingTraces).toBe(1)
    expect(
      decision.coverage.control.traceReceipts + decision.coverage.candidate.traceReceipts,
    ).toBe(239)
    const noExecution = rows.map((row, i) =>
      i === 0
        ? {
            ...row,
            traceSourceId: null,
            noExecutionSourceId: 'platform:no-execution:0',
            checkedOutcome: 0 as const,
            billedCostUsd: 0,
            turns: 0,
            servedProfileDigest: null,
            servedCodeRevisionDigest: null,
          }
        : row,
    )
    expect(analyze(noExecution).missingTraces).toBe(0)
    const drift = rows.map((row, i) =>
      i === 0 ? { ...row, servedCodeRevisionDigest: 'served:wrong' } : row,
    )
    expect(analyze(drift).refusal).toBe('execution-drift')
  })

  it('refuses too few independent clusters, repeated customer assignments, and zero variance', () => {
    expect(analyze(fixture(0.2, 3, 30)).refusal).toBe('insufficient-clusters')
    const allSuccess = fixture().map((row) => ({ ...row, checkedOutcome: 1 as const }))
    expect(analyze(allSuccess).refusal).toBe('zero-variance')
    const customers = fixture()
      .filter((row) => row.assignmentId.endsWith('session-0'))
      .map((row, index) => ({
        ...row,
        arm: index % 2 === 0 ? ('control' as const) : ('candidate' as const),
        servedProfileDigest: index % 2 === 0 ? 'profile:control' : 'profile:candidate',
      }))
    const customerRule = { ...rule(), assignmentUnit: 'customer' as const }
    const customerDecision = analyze(customers, customerRule)
    expect(customerDecision.clusters).toBe(60)
    expect(customerDecision.controlClusters).toBe(30)
    expect(customerDecision.candidateClusters).toBe(30)
    expect(() => analyze(fixture(), customerRule)).toThrow(/multiple assignments/)
  })

  it('keeps the nominal headline and family correction as separate gates', () => {
    const rows = fixture(0.2)
    const decision = analyze(rows, { ...rule(), confirmatoryFamilySize: 10 })
    expect(decision.confidence).toBe(0.95)
    expect(decision.familyAdjustedConfidence).toBeCloseTo(0.995)
    expect(decision.familyAdjustedInterval!.low).toBeLessThan(decision.nominal95Interval!.low)
    expect(decision.successCriterionMet).toBe(decision.headline95Pass && decision.familywisePass)
  })

  it('calibrates fixed-horizon clustered false promotion and positive-law power', () => {
    const trials = 500
    let nullPasses = 0
    let positivePasses = 0
    for (let trial = 0; trial < trials; trial++) {
      if (analyze(fixture(0, trial + 1000)).headline95Pass) nullPasses++
      if (analyze(fixture(0.2, trial + 1000)).headline95Pass) positivePasses++
    }
    if (process.env.CANARY_CALIBRATION === '1') {
      console.info(JSON.stringify({ trials, nullPasses, positivePasses }))
    }
    expect(nullPasses / trials).toBeLessThanOrEqual(0.08)
    expect(positivePasses / trials).toBeGreaterThanOrEqual(0.75)
  }, 20_000)
})
