import { describe, expect, it } from 'vitest'
import { CaptureIntegrityError } from '../errors'
import {
  type AdmissionControlObservation,
  type AdmissionControlRequest,
  type AdmissionControlRunner,
  type AdmissionEndStateOracle,
  type AdmissionOutcome,
  type AdmissionPrefixReplay,
  type AdmissionPrefixReplayer,
  type AdmissionReport,
  assertDenominatorIntact,
  runAdmission,
} from './admission'
import {
  AdmissionDenominatorError,
  type AdmissionRow,
  type AdmissionRowVerdict,
  assertChainReconciles,
  buildDenominatorChain,
  stratumOf,
} from './admission-records'
import { definePinnedContinuationPolicy } from './continuation-policy'
import type { ContinuationRollout } from './continuation-records'

import {
  type OracleDeterminismVerdict,
  oracleDeterminism,
  taskOracleRegistry,
} from './oracle-determinism'

const POLICY = definePinnedContinuationPolicy({ model: 'pinned/model', seed: 20260808 })
const POLICY_DIGEST = 'digest-under-test'

function certification(taskName: string, flips = 0): OracleDeterminismVerdict {
  return oracleDeterminism({
    taskName,
    image: 'registry.example/task@sha256:pinned',
    suiteDigest: 'suite-digest',
    measuredAt: '2026-08-10T00:00:00.000Z',
    groups: [
      {
        state: 'solved',
        load: 'idle',
        // No per-assertion summary, so the rule counts the whole-suite reward.
        replicates: Array.from({ length: 4 }, (_, index) => ({
          index,
          reward: index < flips ? '0' : '1',
          passed: index >= flips,
          wallMs: 10,
          assertions: null,
        })),
      },
    ],
  })
}

const TASK_ORACLES = taskOracleRegistry([certification('gcode-to-text')])

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
  taskOracles = TASK_ORACLES,
): Promise<{ report: AdmissionReport; fakes: Fakes }> {
  const built = fakes(options)
  const report = await runAdmission({
    rows,
    policy: POLICY,
    replayer: built.replayer,
    oracle: built.oracle,
    controls: built.controls,
    taskOracles,
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
        controlPolicyDigest: POLICY_DIGEST,
        controlScreening: 'enforced',
        oracleFlipRate: 0,
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


