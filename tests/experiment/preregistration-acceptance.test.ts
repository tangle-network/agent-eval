/**
 * Acceptance: the week's three hand-written preregistrations, expressed with
 * the experiment module, sealed, and their recorded decisions reproduced by
 * executing the sealed rules against the recorded evidence.
 *
 * Every expected value below is a recorded artifact of the original runs —
 * see tests/experiment/recorded-fixtures.ts for provenance.
 */

import { describe, expect, it } from 'vitest'
import {
  amendExperiment,
  classifyReissue,
  openSealedExperiment,
  sealExperiment,
  verifySealedExperiment,
} from '../../src/experiment/index'
import {
  freelunchLedgerAmendment6,
  freelunchLedgerAsExecuted,
  freelunchMeasuredPassCosts,
  freelunchSpec,
  killtestSpec,
  milestone2Spec,
} from './preregistrations'
import {
  admitRecords,
  freelunchOutcomes,
  m1Outcomes,
  m1PolicyDigest,
  oracleProbe,
  recordedChain,
  recordedM2Interval,
  recordedPowerCurve,
  recordedUniformN,
  rowSubsetM2,
  rowSubsetM3,
} from './recorded-fixtures'

const killtestSealed = sealExperiment(killtestSpec, { sealedAt: '2026-08-10T00:00:00Z' })
const killtestRegistered = killtestSealed.then(openSealedExperiment)

const freelunchSealed = sealExperiment(freelunchSpec(freelunchLedgerAsExecuted), {
  sealedAt: '2026-08-10T08:00:00Z',
})
const freelunchRegistered = freelunchSealed.then(openSealedExperiment)

const milestone2Sealed = sealExperiment(milestone2Spec, { sealedAt: '2026-08-08T00:00:00Z' })
const milestone2Registered = milestone2Sealed.then(openSealedExperiment)

describe('fixture 1: killtest-20260810 — four gates fail, the halt refuses the spend', () => {
  it('seals deterministically and verifies', async () => {
    const sealed = await killtestSealed
    const again = await sealExperiment(killtestSpec, { sealedAt: '2026-08-10T09:00:00Z' })
    expect(again.digest).toBe(sealed.digest)
    expect(await verifySealedExperiment(sealed)).toBe(true)
  })

  it('gate 7.1 oracle-determinism FAILS on the recorded 45 pytest tails (rep-4 flip)', async () => {
    const registered = await killtestRegistered
    const gate = registered.gate('oracle-determinism', {
      kind: 'oracle-determinism',
      repsByState: oracleProbe,
    })
    expect(gate.passed).toBe(false)
    const evidence = gate.evidence as Record<string, { passes: number; flipRate: number }>
    expect(evidence.solved!.passes).toBe(15)
    expect(evidence.partial!.passes).toBe(1)
    expect(evidence.unsolved!.passes).toBe(0)
    expect(evidence.partial!.flipRate).toBeCloseTo(1 / 15, 10)
  })

  it('gate 7.2 population-reproducibility FAILS: exactly 2 changed rows, both largest-eigenval', async () => {
    const registered = await killtestRegistered
    const gate = registered.gate('population-reproducibility', {
      kind: 'population-reproducibility',
      left: m1Outcomes,
      right: admitRecords,
    })
    expect(gate.passed).toBe(false)
    const changed = gate.evidence as string[]
    expect(changed).toHaveLength(2)
    for (const row of changed) expect(row.startsWith('largest-eigenval')).toBe(true)
  })

  it('gate 7.3 provenance-assertion FAILS: the motivating control makes zero model calls', async () => {
    const registered = await killtestRegistered
    // zero-step-continuation@v1 is the zero-step policy: model call budget 0.
    const gate = registered.gate('provenance-assertion', {
      kind: 'provenance-assertion',
      provenance: { policy: { digest: m1PolicyDigest, modelCallBudget: 0 } },
    })
    expect(m1PolicyDigest).toBe('zero-step-continuation@v1')
    expect(gate.passed).toBe(false)
  })

  it('gate 7.4 power-floor FAILS on the registered curve: max power 0.692 < 0.80', async () => {
    const registered = await killtestRegistered
    const gate = registered.gate('power-floor', {
      kind: 'power-floor',
      curve: recordedPowerCurve,
    })
    expect(gate.passed).toBe(false)
    const evidence = gate.evidence as { maxPower: number }
    expect(evidence.maxPower).toBeCloseTo(0.692, 10)
  })

  it('the halt rule fires over the four gates: refuse-spend, contrast never run, $0.00', async () => {
    const registered = await killtestRegistered
    const gates = [
      registered.gate('oracle-determinism', {
        kind: 'oracle-determinism',
        repsByState: oracleProbe,
      }),
      registered.gate('population-reproducibility', {
        kind: 'population-reproducibility',
        left: m1Outcomes,
        right: admitRecords,
      }),
      registered.gate('provenance-assertion', {
        kind: 'provenance-assertion',
        provenance: { policy: { digest: m1PolicyDigest, modelCallBudget: 0 } },
      }),
      registered.gate('power-floor', { kind: 'power-floor', curve: recordedPowerCurve }),
    ]
    const halt = registered.halt(gates)
    expect(halt.fired).toBe(true)
    expect(halt.action).toBe('refuse-spend')
    expect(halt.failedGates).toHaveLength(4)
  })

  it('a positive interval without the registered control cannot reach thesis-survives', async () => {
    const registered = await killtestRegistered
    const withoutControl = registered.decide({
      intervals: { 'task-clustered-95': { lower: 0.05, upper: 0.4 } },
      quantities: { 'free-lunch-fraction': 0.2 },
      obligationsMet: { 'b-best-intermediate-grade': false },
    })
    expect(withoutControl.verdict).toBe('blocked-pending-registered-control')
    const withControl = registered.decide({
      intervals: { 'task-clustered-95': { lower: 0.05, upper: 0.4 } },
      quantities: { 'free-lunch-fraction': 0.2 },
      obligationsMet: { 'b-best-intermediate-grade': true },
    })
    expect(withControl.verdict).toBe('thesis-survives-at-this-n')
  })
})

describe('fixture 2: freelunch-20260810 — identity, funnel, budget, report-only', () => {
  it('identity gate: deepseek-v3.2 vs served v4-flash aborts; glm-5.2 proceeds', async () => {
    const registered = await freelunchRegistered
    const substituted = registered.gate('identity', {
      kind: 'identity',
      pinned: 'deepseek/deepseek-v3.2',
      served: 'deepseek-v4-flash',
    })
    expect(substituted.passed).toBe(false)
    const honest = registered.gate('identity', {
      kind: 'identity',
      pinned: 'glm-5.2',
      served: 'glm-5.2',
    })
    expect(honest.passed).toBe(true)
  })

  it('oracle gate excludes exactly the flipping task (largest-eigenval, 6/16 minority)', async () => {
    const registered = await freelunchRegistered
    // Replicate arrays reconstructed at the recorded pass counts: the three
    // certified tasks are 16/16 stable; largest-eigenval splits 10/16 (flip
    // rate 0.375, the recorded value).
    const stable = Array.from({ length: 16 }, () => true)
    const flipping = [
      ...Array.from({ length: 10 }, () => true),
      ...Array.from({ length: 6 }, () => false),
    ]
    const gate = registered.gate('oracle-determinism', {
      kind: 'oracle-determinism',
      repsByState: {
        'password-recovery': stable,
        'sanitize-git-repo': stable,
        'count-dataset-tokens': stable,
        'largest-eigenval': flipping,
      },
    })
    expect(gate.passed).toBe(false)
    const evidence = gate.evidence as Record<string, { flipRate: number }>
    const excluded = Object.entries(evidence)
      .filter(([, state]) => state.flipRate > 0)
      .map(([task]) => task)
    expect(excluded).toEqual(['largest-eigenval'])
    expect(evidence['largest-eigenval']!.flipRate).toBeCloseTo(0.375, 10)
  })

  it('the admission funnel executed on the 48 records reproduces 48>43>35>35>32, secondary 3', async () => {
    const registered = await freelunchRegistered
    const admission = registered.admit(admitRecords)
    const remaining = admission.funnel.stages.map((stage) => stage.remaining)
    expect(remaining).toEqual([
      recordedChain.evaluated,
      recordedChain.deterministicOracle,
      recordedChain.cleanExit,
      recordedChain.failedEndState,
      recordedChain.prefixFidelityOk,
    ])
    expect(admission.funnel.surviving).toBe(recordedChain.prefixFidelityOk)
    expect(admission.funnel.partitions).toHaveLength(1)
    expect(admission.funnel.partitions[0]!.count).toBe(recordedChain.prefixDivergent)
    expect(admission.survivors).toHaveLength(recordedChain.prefixFidelityOk)
  })

  it('the uniform-pass schedule reproduces the recorded uniform n=2 (pass 2 go, pass 3 stop)', async () => {
    const registered = await freelunchRegistered
    const schedule = registered.runUniformPassBudget(freelunchMeasuredPassCosts)
    expect(schedule.uniformN).toBe(recordedUniformN)
    expect(schedule.decisions[0]!.go).toBe(true)
    expect(schedule.decisions[1]!.go).toBe(false)
  })

  it('amendment-6 ledger under the same sealed rule refuses pass 2 — the drift the seal catches', async () => {
    const sealed = await freelunchSealed
    const amended = await amendExperiment(sealed, {
      spec: freelunchSpec(freelunchLedgerAmendment6),
      reason: 'amendment 6: count the aborted substitution and the zombie run against the ceiling',
      blind: ['no pass-2 outcome had been read when the ledger was amended'],
      at: '2026-08-10T10:14:00Z',
    })
    expect(amended.digest).not.toBe(sealed.digest)
    expect(amended.initialDigest).toBe(sealed.digest)
    expect(amended.amendments).toHaveLength(1)
    const registeredAmended = await openSealedExperiment(amended)
    const schedule = registeredAmended.runUniformPassBudget(freelunchMeasuredPassCosts)
    expect(schedule.uniformN).toBe(1)
    expect(schedule.decisions[0]!.go).toBe(false)
  })

  it('report-only estimands recomputed from the 64 outcomes: rollout 3/64, row 2/32', async () => {
    const registered = await freelunchRegistered
    const decision = registered.decide({ intervals: {}, quantities: {}, obligationsMet: {} })
    expect(decision.verdict).toBe('report-only')
    const rollout = registered.estimate('rollout-rescue-rate', freelunchOutcomes)
    expect(rollout.numerator).toBe(3)
    expect(rollout.denominator).toBe(64)
    const row = registered.estimate('row-rescue-rate', freelunchOutcomes)
    expect(row.numerator).toBe(2)
    expect(row.denominator).toBe(32)
  })

  it('the registered Clopper-Pearson interval executes on the rescue count', async () => {
    const registered = await freelunchRegistered
    const interval = registered.interval('clopper-pearson-95', {
      kind: 'binomial',
      successes: 3,
      trials: 64,
    })
    // Exact binomial 95% interval for 3/64 (reference: scipy.stats.beta.ppf,
    // 0.0097731 / 0.1309357).
    expect(interval.lower).toBeCloseTo(0.0097731, 6)
    expect(interval.upper).toBeCloseTo(0.1309357, 6)
  })
})

describe('fixture 3: tbench-20260808 milestone 2 — sealed subsets and the verdict table', () => {
  const admitted = admitRecords.filter((record) => record.admitted)

  it('the round-robin rule over the admitted records reproduces the recorded 20 rows in pick order', async () => {
    const registered = await milestone2Registered
    const derived = registered.select('m2-subset', admitted, { idField: 'rowId' })
    expect(derived).toEqual(rowSubsetM2)
  })

  it('the m3 subset is the certified-task filter of the SEALED m2 subset (16 rows, in order)', async () => {
    const registered = await milestone2Registered
    const derived = registered.select('m3-subset', admitted, { idField: 'rowId' })
    expect(derived).toEqual(rowSubsetM3)
  })

  it('the decision table on the recorded interval (-0.100, +0.567) reproduces the verdict', async () => {
    const registered = await milestone2Registered
    const outcome = registered.decide({
      intervals: { 'task-clustered-95': recordedM2Interval },
      quantities: {},
      obligationsMet: {},
    })
    expect(outcome.verdict).toBe('not-certified-at-this-n')
    expect(outcome.report).toContain('wins-losses-ties')
  })

  it('a carrier fault is reissued within budget; a model outcome stands', async () => {
    await milestone2Sealed
    const policy = milestone2Spec.reissue!
    expect(classifyReissue(policy, 'deadline', 0)).toBe('reissue')
    expect(classifyReissue(policy, 'empty-content', 3)).toBe('exhausted')
    expect(classifyReissue(policy, 'model-refused', 0)).toBe('stands')
  })
})
