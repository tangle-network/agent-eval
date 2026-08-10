import { describe, expect, it } from 'vitest'
import { CaptureIntegrityError, ValidationError } from '../errors'
import {
  type AdmissionControlObservation,
  type AdmissionControlRequest,
  type AdmissionControlRunner,
  type AdmissionEndStateOracle,
  type AdmissionOutcome,
  type AdmissionPrefixReplay,
  type AdmissionPrefixReplayer,
  type AdmissionReport,
  admittedCount,
  admittedRowIds,
  assertDenominatorIntact,
  noOpInjectionStep,
  resolveAdmissionConfig,
  runAdmission,
} from './admission'
import {
  AdmissionDenominatorError,
  AdmissionIndependenceError,
  type AdmissionRow,
  type AdmissionRowVerdict,
  assertAnalystIndependent,
  assertChainReconciles,
  buildDenominatorChain,
  stratumOf,
} from './admission-records'
import { definePinnedContinuationPolicy } from './continuation-policy'
import type { ContinuationRollout } from './continuation-records'

const POLICY = definePinnedContinuationPolicy({ model: 'pinned/model', seed: 20260808 })
const POLICY_DIGEST = 'digest-under-test'

function row(overrides: Partial<AdmissionRow> = {}): AdmissionRow {
  return {
    rowId: 'gcode-to-text:1',
    taskName: 'gcode-to-text',
    recordedModel: 'recorded/model',
    recordedCommands: 6,
    finalReturncode: 0,
    ...overrides,
  }
}

function rollout(
  request: AdmissionControlRequest,
  costUsd: number | null = 0.01,
): ContinuationRollout {
  return {
    rolloutId: `${request.row.rowId}:${request.arm}:${request.rolloutIndex}`,
    arm: request.arm,
    rowId: request.row.rowId,
    index: request.rolloutIndex,
    // The real seed derivation ignores the arm, so paired rollouts match here too.
    seed: 1000 + request.rolloutIndex,
    policyDigest: POLICY_DIGEST,
    environmentId: 'fake-environments',
    containerRef: 'fake-container',
    environment: { networkMode: 'none' },
    steps: [],
    exitStatus: 'step-budget-exhausted',
    submission: null,
    usage: { calls: 0, callsWithUsage: 0, captured: false, input: 0, output: 0 },
    costProvenance:
      costUsd === null ? { kind: 'uncaptured', usd: null } : { kind: 'observed', usd: costUsd },
    wallMs: 1,
    startedAt: '2026-08-08T00:00:00.000Z',
    endedAt: '2026-08-08T00:00:01.000Z',
  }
}

interface FakeOptions {
  replay?: (row: AdmissionRow) => AdmissionOutcome<AdmissionPrefixReplay>
  endState?: (row: AdmissionRow) => AdmissionOutcome<{ passed: boolean; reward: number | null }>
  control?: (request: AdmissionControlRequest) => AdmissionOutcome<AdmissionControlObservation>
}

interface Fakes {
  replayer: AdmissionPrefixReplayer
  oracle: AdmissionEndStateOracle
  controls: AdmissionControlRunner
  controlCalls: AdmissionControlRequest[]
  replayCalls: string[]
}

function fakes(options: FakeOptions = {}): Fakes {
  const controlCalls: AdmissionControlRequest[] = []
  const replayCalls: string[] = []
  return {
    controlCalls,
    replayCalls,
    replayer: {
      id: 'fake-replayer',
      async replay(target) {
        replayCalls.push(target.rowId)
        return options.replay
          ? options.replay(target)
          : {
              succeeded: true,
              value: { prefixExecuted: target.recordedCommands, prefixDivergences: [] },
            }
      },
    },
    oracle: {
      id: 'fake-oracle',
      async grade(target) {
        return options.endState
          ? options.endState(target)
          : { succeeded: true, value: { passed: false, reward: 0 } }
      },
    },
    controls: {
      id: 'fake-controls',
      async run(request) {
        controlCalls.push(request)
        return options.control
          ? options.control(request)
          : {
              succeeded: true,
              value: { tests: { passed: false, reward: 0 }, rollout: rollout(request) },
            }
      },
    },
  }
}

async function admit(
  rows: readonly AdmissionRow[],
  options: FakeOptions = {},
  config: Parameters<typeof runAdmission>[0]['config'] = {},
): Promise<{ report: AdmissionReport; fakes: Fakes }> {
  const built = fakes(options)
  const report = await runAdmission({
    rows,
    policy: POLICY,
    replayer: built.replayer,
    oracle: built.oracle,
    controls: built.controls,
    config,
    clock: () => Date.parse('2026-08-08T12:00:00.000Z'),
  })
  return { report, fakes: built }
}

function verdictOf(report: AdmissionReport, rowId: string): AdmissionRowVerdict {
  const found = report.rows.find((entry) => entry.rowId === rowId)
  if (!found) throw new Error(`no verdict for ${rowId}`)
  return found
}

describe('stratumOf', () => {
  it('splits the three recorded populations and refuses to invent one', () => {
    expect(stratumOf(0)).toBe('clean-exit')
    expect(stratumOf(1)).toBe('command-error')
    expect(stratumOf(127)).toBe('command-error')
    expect(stratumOf(-15)).toBe('signal-kill')
    expect(stratumOf(-9)).toBe('signal-kill')
    expect(stratumOf(null)).toBeNull()
    expect(stratumOf(1.5)).toBeNull()
  })
})

describe('runAdmission — the four conditions', () => {
  it('admits a row that replays, fails its tests, and survives both controls', async () => {
    const { report, fakes: built } = await admit([row()])
    const verdict = verdictOf(report, 'gcode-to-text:1')

    expect(verdict.admitted).toBe(true)
    expect(verdict.excludedBy).toBeNull()
    expect(verdict.stratum).toBe('clean-exit')
    expect(admittedRowIds(report, 'clean-exit')).toEqual(['gcode-to-text:1'])
    expect(admittedCount(report)).toBe(1)
    expect(built.controlCalls).toHaveLength(6)
    expect(verdict.rollouts).toHaveLength(6)
    expect(report.controlCost.kind).toBe('observed')
    expect(report.controlCost.usd).toBeCloseTo(0.06, 10)
  })

  it('excludes a row whose prefix diverges beyond the threshold', async () => {
    const { report, fakes: built } = await admit([row({ recordedCommands: 10 })], {
      replay: () => ({
        succeeded: true,
        value: {
          prefixExecuted: 10,
          prefixDivergences: [
            { step: 3, expectedReturncode: 0, actualExit: 1 },
            { step: 7, expectedReturncode: 0, actualExit: 2 },
          ],
        },
      }),
    })

    const verdict = verdictOf(report, 'gcode-to-text:1')
    expect(verdict.excludedBy).toBe('prefix-divergence-above-threshold')
    expect(verdict.checks).toContainEqual({
      check: 'prefix-replay',
      prefixExecuted: 10,
      divergences: 2,
      divergenceRatio: 0.2,
    })
    expect(built.controlCalls).toHaveLength(0)
  })

  it('admits a row sitting exactly on the divergence threshold', async () => {
    const { report } = await admit([row({ recordedCommands: 10 })], {
      replay: () => ({
        succeeded: true,
        value: {
          prefixExecuted: 10,
          prefixDivergences: [{ step: 3, expectedReturncode: 0, actualExit: 1 }],
        },
      }),
    })
    expect(verdictOf(report, 'gcode-to-text:1').admitted).toBe(true)
  })

  it('excludes a row whose held-out tests already pass on the recorded end state', async () => {
    const { report, fakes: built } = await admit([row()], {
      endState: () => ({ succeeded: true, value: { passed: true, reward: 1 } }),
    })

    const verdict = verdictOf(report, 'gcode-to-text:1')
    expect(verdict.excludedBy).toBe('end-state-tests-pass')
    expect(verdict.checks).toContainEqual({ check: 'end-state-tests', passed: true, reward: 1 })
    expect(built.controlCalls).toHaveLength(0)
  })

  it('excludes a row the continuation policy rescues with no intervention', async () => {
    const { report, fakes: built } = await admit([row()], {
      control: (request) => ({
        succeeded: true,
        value: {
          tests: { passed: request.arm === 'no-fix-control', reward: null },
          rollout: rollout(request),
        },
      }),
    })

    const verdict = verdictOf(report, 'gcode-to-text:1')
    expect(verdict.excludedBy).toBe('no-fix-control-rescued')
    // The first passing rollout decides the arm; the other two are never paid for.
    expect(built.controlCalls).toHaveLength(1)
    expect(verdict.checks).toContainEqual({
      check: 'control',
      arm: 'no-fix-control',
      rolloutsRun: 1,
      passes: 1,
      injections: [],
    })
  })

  it('excludes a row an inert action plus continuation rescues', async () => {
    const { report, fakes: built } = await admit([row()], {
      control: (request) => ({
        succeeded: true,
        value: {
          tests: {
            passed: request.arm === 'no-op-control' && request.rolloutIndex === 2,
            reward: null,
          },
          rollout: rollout(request),
        },
      }),
    })

    const verdict = verdictOf(report, 'gcode-to-text:1')
    expect(verdict.excludedBy).toBe('no-op-control-rescued')
    expect(built.controlCalls).toHaveLength(6)
    const noOp = verdict.checks.find(
      (check) => check.check === 'control' && check.arm === 'no-op-control',
    )
    expect(noOp).toMatchObject({ rolloutsRun: 3, passes: 1 })
  })

  it('runs the no-fix arm before the no-op arm and injects only into the no-op arm', async () => {
    const { fakes: built } = await admit([row()])
    expect(built.controlCalls.map((call) => `${call.arm}:${call.rolloutIndex}`)).toEqual([
      'no-fix-control:0',
      'no-fix-control:1',
      'no-fix-control:2',
      'no-op-control:0',
      'no-op-control:1',
      'no-op-control:2',
    ])
    for (const call of built.controlCalls) {
      if (call.arm === 'no-fix-control') expect(call.injection).toBeNull()
      else {
        expect(call.injection).toEqual({
          step: noOpInjectionStep(POLICY.seed, call.row.rowId, call.rolloutIndex, 6),
          action: 'true',
        })
      }
    }
  })
})

describe('runAdmission — boundary failures never read as verdicts', () => {
  it('excludes on a replay error and keeps the message', async () => {
    const { report, fakes: built } = await admit([row()], {
      replay: () => ({ succeeded: false, error: 'image pull failed: 429' }),
    })

    const verdict = verdictOf(report, 'gcode-to-text:1')
    expect(verdict.excludedBy).toBe('prefix-replay-error')
    expect(verdict.errorDetail).toBe('image pull failed: 429')
    expect(verdict.checks.some((check) => check.check === 'prefix-replay')).toBe(false)
    expect(built.controlCalls).toHaveLength(0)
  })

  it('excludes when the replay executed no recorded step', async () => {
    const { report } = await admit([row()], {
      replay: () => ({ succeeded: true, value: { prefixExecuted: 0, prefixDivergences: [] } }),
    })
    expect(verdictOf(report, 'gcode-to-text:1').excludedBy).toBe('prefix-replay-empty')
  })

  it('excludes a replay that stopped short of the recorded end state', async () => {
    const { report, fakes: built } = await admit([row({ recordedCommands: 40 })], {
      // A truncated replay would otherwise report 0/3 divergence and look perfect.
      replay: () => ({ succeeded: true, value: { prefixExecuted: 3, prefixDivergences: [] } }),
    })

    const verdict = verdictOf(report, 'gcode-to-text:1')
    expect(verdict.excludedBy).toBe('prefix-replay-truncated')
    expect(verdict.checks.some((check) => check.check === 'prefix-replay')).toBe(false)
    expect(built.controlCalls).toHaveLength(0)
  })

  it('excludes on an oracle error rather than assuming the tests failed', async () => {
    const { report } = await admit([row()], {
      endState: () => ({ succeeded: false, error: 'grader container exited 137' }),
    })
    const verdict = verdictOf(report, 'gcode-to-text:1')
    expect(verdict.excludedBy).toBe('end-state-oracle-error')
    expect(verdict.errorDetail).toBe('grader container exited 137')
  })

  it('excludes on a no-fix rollout error rather than counting it as a failure', async () => {
    const { report, fakes: built } = await admit([row()], {
      control: (request) =>
        request.rolloutIndex === 1
          ? { succeeded: false, error: 'docker: no such container' }
          : {
              succeeded: true,
              value: { tests: { passed: false, reward: 0 }, rollout: rollout(request) },
            },
    })

    const verdict = verdictOf(report, 'gcode-to-text:1')
    expect(verdict.excludedBy).toBe('no-fix-control-error')
    expect(verdict.errorDetail).toBe('docker: no such container')
    expect(verdict.rollouts).toHaveLength(1)
    expect(built.controlCalls).toHaveLength(2)
  })

  it('excludes on a no-op rollout error after the no-fix arm passed its check', async () => {
    const { report } = await admit([row()], {
      control: (request) =>
        request.arm === 'no-op-control' && request.rolloutIndex === 0
          ? { succeeded: false, error: 'inert action could not be applied' }
          : {
              succeeded: true,
              value: { tests: { passed: false, reward: 0 }, rollout: rollout(request) },
            },
    })

    const verdict = verdictOf(report, 'gcode-to-text:1')
    expect(verdict.excludedBy).toBe('no-op-control-error')
    expect(verdict.rollouts).toHaveLength(3)
  })

  it('rejects a control runner that answers with the wrong arm, row, or index', async () => {
    const wrongArm = admit([row()], {
      control: (request) => ({
        succeeded: true,
        value: {
          tests: { passed: false, reward: 0 },
          rollout: { ...rollout(request), arm: 'intervention' },
        },
      }),
    })
    await expect(wrongArm).rejects.toThrow(AdmissionDenominatorError)

    const wrongRow = admit([row()], {
      control: (request) => ({
        succeeded: true,
        value: {
          tests: { passed: false, reward: 0 },
          rollout: { ...rollout(request), rowId: 'another-row' },
        },
      }),
    })
    await expect(wrongRow).rejects.toThrow(/rollout for row another-row/)

    const wrongIndex = admit([row()], {
      control: (request) => ({
        succeeded: true,
        value: { tests: { passed: false, reward: 0 }, rollout: { ...rollout(request), index: 9 } },
      }),
    })
    await expect(wrongIndex).rejects.toThrow(/rollout index 9/)
  })

  it('rejects arms that ran under different policies', async () => {
    const mixed = admit([row()], {
      control: (request) => ({
        succeeded: true,
        value: {
          tests: { passed: false, reward: 0 },
          rollout: {
            ...rollout(request),
            policyDigest: request.arm === 'no-op-control' ? 'other-digest' : POLICY_DIGEST,
          },
        },
      }),
    })
    await expect(mixed).rejects.toThrow(CaptureIntegrityError)
  })

  it('reports the control cost as uncaptured when a rollout carried an unpriced call', async () => {
    const { report } = await admit([row()], {
      control: (request) => ({
        succeeded: true,
        value: {
          tests: { passed: false, reward: 0 },
          rollout: rollout(request, request.rolloutIndex === 2 ? null : 0.01),
        },
      }),
    })
    expect(report.controlCost).toEqual({ kind: 'uncaptured', usd: null })
  })
})

describe('runAdmission — stratification before sampling', () => {
  const population: AdmissionRow[] = [
    row({ rowId: 'clean:1', finalReturncode: 0 }),
    row({ rowId: 'clean:2', finalReturncode: 0 }),
    row({ rowId: 'err:1', finalReturncode: 1 }),
    row({ rowId: 'err:2', finalReturncode: 127 }),
    row({ rowId: 'kill:1', finalReturncode: -15 }),
    row({ rowId: 'kill:2', finalReturncode: -9 }),
  ]

  it('carries the stratum on every row and admits the default two populations', async () => {
    const { report } = await admit(population)

    expect(report.rows.map((entry) => `${entry.rowId}=${entry.stratum}`)).toEqual([
      'clean:1=clean-exit',
      'clean:2=clean-exit',
      'err:1=command-error',
      'err:2=command-error',
      'kill:1=signal-kill',
      'kill:2=signal-kill',
    ])
    expect(admittedRowIds(report, 'clean-exit')).toEqual(['clean:1', 'clean:2'])
    expect(admittedRowIds(report, 'command-error')).toEqual(['err:1', 'err:2'])
    expect(admittedRowIds(report, 'signal-kill')).toEqual([])
    expect(verdictOf(report, 'kill:1').excludedBy).toBe('stratum-not-admitted')
  })

  it('spends nothing on a stratum the campaign does not admit', async () => {
    const { fakes: built } = await admit(population)
    expect(built.replayCalls).toEqual(['clean:1', 'clean:2', 'err:1', 'err:2'])
  })

  it('admits the signal-kill population when a campaign asks for it', async () => {
    const { report } = await admit(population, {}, { admitStrata: ['signal-kill'] })
    expect(admittedRowIds(report, 'signal-kill')).toEqual(['kill:1', 'kill:2'])
    expect(admittedRowIds(report, 'clean-exit')).toEqual([])
    expect(verdictOf(report, 'clean:1').excludedBy).toBe('stratum-not-admitted')
  })

  it('excludes rows that carry no command or no parseable return code, before any stratum', async () => {
    const { report, fakes: built } = await admit([
      row({ rowId: 'empty:1', recordedCommands: 0 }),
      row({ rowId: 'unparsed:1', finalReturncode: null }),
    ])

    expect(verdictOf(report, 'empty:1').excludedBy).toBe('no-recorded-commands')
    expect(verdictOf(report, 'empty:1').stratum).toBeNull()
    expect(verdictOf(report, 'unparsed:1').excludedBy).toBe('unparseable-final-returncode')
    expect(verdictOf(report, 'unparsed:1').stratum).toBeNull()
    expect(built.replayCalls).toEqual([])
    expect(report.chain.unstratified).toBe(2)
  })

  it('keeps input order when rows run concurrently', async () => {
    const { report } = await admit(population, {}, { concurrency: 4 })
    expect(report.rows.map((entry) => entry.rowId)).toEqual([
      'clean:1',
      'clean:2',
      'err:1',
      'err:2',
      'kill:1',
      'kill:2',
    ])
  })
})

describe('denominator chain', () => {
  it('reconciles overall and per stratum across every exclusion path', async () => {
    const { report } = await admit(
      [
        row({ rowId: 'admit:1', finalReturncode: 0 }),
        row({ rowId: 'admit:2', finalReturncode: 2 }),
        row({ rowId: 'diverge:1', finalReturncode: 0 }),
        row({ rowId: 'passes:1', finalReturncode: 0 }),
        row({ rowId: 'rescued:1', finalReturncode: 3 }),
        row({ rowId: 'kill:1', finalReturncode: -15 }),
        row({ rowId: 'empty:1', recordedCommands: 0 }),
      ],
      {
        replay: (target) =>
          target.rowId === 'diverge:1'
            ? {
                succeeded: true,
                value: {
                  prefixExecuted: target.recordedCommands,
                  prefixDivergences: [{ step: 1, expectedReturncode: 0, actualExit: 1 }],
                },
              }
            : {
                succeeded: true,
                value: { prefixExecuted: target.recordedCommands, prefixDivergences: [] },
              },
        endState: (target) => ({
          succeeded: true,
          value: { passed: target.rowId === 'passes:1', reward: null },
        }),
        control: (request) => ({
          succeeded: true,
          value: {
            tests: { passed: request.row.rowId === 'rescued:1', reward: null },
            rollout: rollout(request),
          },
        }),
      },
    )

    const chain = report.chain
    expect(chain.overall.input).toBe(7)
    expect(chain.overall.admitted).toBe(2)
    expect(chain.reasonTotals).toMatchObject({
      'no-recorded-commands': 1,
      'stratum-not-admitted': 1,
      'prefix-divergence-above-threshold': 1,
      'end-state-tests-pass': 1,
      'no-fix-control-rescued': 1,
    })
    expect(() => assertChainReconciles(chain)).not.toThrow()

    const clean = chain.byStratum.find((entry) => entry.scope === 'clean-exit')
    expect(clean).toMatchObject({ input: 3, admitted: 1 })
    const stages = chain.overall.stages
    expect(stages[0]).toEqual({
      reason: 'no-recorded-commands',
      entering: 7,
      excluded: 1,
      remaining: 6,
    })
    expect(stages[stages.length - 1]?.remaining).toBe(2)
  })

  it('omits the pre-stratum stages from a stratum chain', async () => {
    const { report } = await admit([
      row({ rowId: 'admit:1' }),
      row({ rowId: 'empty:1', recordedCommands: 0 }),
    ])
    const clean = report.chain.byStratum.find((entry) => entry.scope === 'clean-exit')
    expect(clean?.stages.map((stage) => stage.reason)).not.toContain('no-recorded-commands')
    expect(clean?.input).toBe(1)
  })

  it('rejects a chain whose stages do not add up', () => {
    const verdicts: AdmissionRowVerdict[] = [
      {
        rowId: 'a',
        taskName: 't',
        recordedModel: 'm',
        recordedCommands: 1,
        finalReturncode: 0,
        stratum: 'clean-exit',
        admitted: true,
        excludedBy: null,
        errorDetail: null,
        checks: [],
        rollouts: [],
      },
    ]
    const artifact = buildDenominatorChain(verdicts, ['clean-exit'])
    const broken = { ...artifact, overall: { ...artifact.overall, admitted: 0 } }
    expect(() => assertChainReconciles(broken)).toThrow(AdmissionDenominatorError)
  })
})

describe('analyst independence', () => {
  it('rejects a row carrying an analyst field', () => {
    const leaked = { ...row(), failureClaim: 'step 4 deleted the fixture' } as AdmissionRow
    expect(() => assertAnalystIndependent([leaked])).toThrow(AdmissionIndependenceError)
    expect(() => assertAnalystIndependent([leaked])).toThrow(/failureClaim/)
  })

  it('rejects any unknown field, not only the ones named today', () => {
    const leaked = { ...row(), proposedStepK: 4 } as AdmissionRow
    expect(() => assertAnalystIndependent([leaked])).toThrow(/proposedStepK/)
  })

  it('refuses duplicate row ids', async () => {
    await expect(admit([row({ rowId: 'dup' }), row({ rowId: 'dup' })])).rejects.toThrow(
      ValidationError,
    )
  })
})

describe('assertDenominatorIntact', () => {
  async function admittedReport(): Promise<AdmissionReport> {
    const { report } = await admit([
      row({ rowId: 'clean:1' }),
      row({ rowId: 'clean:2' }),
      row({ rowId: 'kill:1', finalReturncode: -15 }),
    ])
    return report
  }

  it('accepts a campaign that scored exactly what it sampled', async () => {
    const report = await admittedReport()
    expect(() =>
      assertDenominatorIntact({
        report,
        strata: ['clean-exit'],
        sampled: ['clean:1', 'clean:2'],
        scored: ['clean:2', 'clean:1'],
      }),
    ).not.toThrow()
  })

  it('rejects a sampled row that was never admitted', async () => {
    const report = await admittedReport()
    expect(() =>
      assertDenominatorIntact({
        report,
        strata: ['clean-exit'],
        sampled: ['clean:1', 'kill:1'],
        scored: ['clean:1', 'kill:1'],
      }),
    ).toThrow(/not admitted/)
  })

  it('rejects a scored row that was never sampled', async () => {
    const report = await admittedReport()
    expect(() =>
      assertDenominatorIntact({
        report,
        strata: ['clean-exit'],
        sampled: ['clean:1'],
        scored: ['clean:1', 'clean:2'],
      }),
    ).toThrow(/never sampled/)
  })

  it('rejects a row counted twice in either list', async () => {
    const report = await admittedReport()
    expect(() =>
      assertDenominatorIntact({
        report,
        strata: ['clean-exit'],
        sampled: ['clean:1', 'clean:1'],
        scored: ['clean:1'],
      }),
    ).toThrow(/sampled lists 1 duplicate/)
    expect(() =>
      assertDenominatorIntact({
        report,
        strata: ['clean-exit'],
        sampled: ['clean:1'],
        scored: ['clean:1', 'clean:1'],
      }),
    ).toThrow(/scored lists 1 duplicate/)
  })

  it('rejects an analyst that dropped a sampled row instead of scoring it', async () => {
    const report = await admittedReport()
    expect(() =>
      assertDenominatorIntact({
        report,
        strata: ['clean-exit'],
        sampled: ['clean:1', 'clean:2'],
        scored: ['clean:1'],
      }),
    ).toThrow(/denominator shrank by 1 row/)
  })
})

describe('configuration and draws', () => {
  it('rejects an out-of-range divergence threshold and an empty stratum list', () => {
    expect(() => resolveAdmissionConfig({ maxPrefixDivergence: 1.5 })).toThrow(ValidationError)
    expect(() => resolveAdmissionConfig({ maxPrefixDivergence: -0.1 })).toThrow(ValidationError)
    expect(() => resolveAdmissionConfig({ admitStrata: [] })).toThrow(ValidationError)
    expect(() => resolveAdmissionConfig({ controlRollouts: 0 })).toThrow(ValidationError)
    expect(() => resolveAdmissionConfig({ inertAction: '  ' })).toThrow(ValidationError)
  })

  it('draws the no-op step deterministically inside the recorded commands', () => {
    for (let index = 0; index < 3; index += 1) {
      const step = noOpInjectionStep(POLICY.seed, 'row-a', index, 6)
      expect(step).toBe(noOpInjectionStep(POLICY.seed, 'row-a', index, 6))
      expect(step).toBeGreaterThanOrEqual(1)
      expect(step).toBeLessThanOrEqual(6)
    }
    expect(noOpInjectionStep(POLICY.seed, 'row-a', 0, 6)).not.toBe(
      noOpInjectionStep(POLICY.seed + 1, 'row-a', 0, 6),
    )
  })

  it('records the provenance of every boundary that decided the denominator', async () => {
    const { report } = await admit([row()])
    expect(report.provenance).toMatchObject({
      replayerId: 'fake-replayer',
      oracleId: 'fake-oracle',
      controlRunnerId: 'fake-controls',
      policyId: 'tb-repair-continuation-v1',
      policyModel: 'pinned/model',
      policySeed: 20260808,
    })
    expect(report.digest).toMatch(/^[0-9a-f]{16,}$/)
  })

  it('changes the digest when the admitted set changes', async () => {
    const first = await admit([row({ rowId: 'a' }), row({ rowId: 'b' })])
    const second = await admit([row({ rowId: 'a' }), row({ rowId: 'b' })], {
      endState: (target) => ({
        succeeded: true,
        value: { passed: target.rowId === 'b', reward: null },
      }),
    })
    expect(first.report.digest).not.toBe(second.report.digest)
  })
})
