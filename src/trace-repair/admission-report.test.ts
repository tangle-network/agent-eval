import { describe, expect, it } from 'vitest'
import { type AdmissionControlRequest, type AdmissionReport, runAdmission } from './admission'
import { AdmissionDenominatorError, type AdmissionRow } from './admission-records'
import { admissionArtifact, renderAdmissionReport } from './admission-report'
import { definePinnedContinuationPolicy } from './continuation-policy'
import type { ContinuationRollout } from './continuation-records'

const POLICY = definePinnedContinuationPolicy({ model: 'pinned/model', seed: 20260808 })

function row(
  rowId: string,
  finalReturncode: number | null,
  taskName = 'gcode-to-text',
): AdmissionRow {
  return { rowId, taskName, recordedModel: 'recorded/model', recordedCommands: 5, finalReturncode }
}

function rollout(request: AdmissionControlRequest): ContinuationRollout {
  return {
    rolloutId: `${request.row.rowId}:${request.arm}:${request.rolloutIndex}`,
    arm: request.arm,
    rowId: request.row.rowId,
    index: request.rolloutIndex,
    seed: 1000 + request.rolloutIndex,
    policyDigest: 'digest-under-test',
    environmentId: 'fake-environments',
    containerRef: 'fake-container',
    environment: { networkMode: 'none' },
    steps: [],
    exitStatus: 'step-budget-exhausted',
    submission: null,
    usage: { calls: 0, callsWithUsage: 0, captured: false, input: 0, output: 0 },
    costProvenance: { kind: 'observed', usd: 0.02 },
    wallMs: 1,
    startedAt: '2026-08-08T00:00:00.000Z',
    endedAt: '2026-08-08T00:00:01.000Z',
  }
}

async function sampleReport(): Promise<AdmissionReport> {
  return runAdmission({
    rows: [
      row('clean:1', 0),
      row('clean:2', 0),
      row('err:1', 1, 'regex-log'),
      row('kill:1', -15),
      { ...row('empty:1', 0), recordedCommands: 0 },
    ],
    policy: POLICY,
    replayer: {
      id: 'docker-replayer',
      async replay(target) {
        return target.rowId === 'clean:2'
          ? {
              succeeded: true,
              value: {
                prefixExecuted: target.recordedCommands,
                prefixDivergences: [{ step: 2, expectedReturncode: 0, actualExit: 1 }],
              },
            }
          : {
              succeeded: true,
              value: { prefixExecuted: target.recordedCommands, prefixDivergences: [] },
            }
      },
    },
    oracle: {
      id: 'tb2-tests',
      async grade() {
        return { succeeded: true, value: { passed: false, reward: 0 } }
      },
    },
    controls: {
      id: 'docker-continuation',
      async run(request) {
        return {
          succeeded: true,
          value: { tests: { passed: false, reward: 0 }, rollout: rollout(request) },
        }
      },
    },
    clock: () => Date.parse('2026-08-08T12:00:00.000Z'),
  })
}

describe('admissionArtifact', () => {
  it('publishes the chain, the admitted ids per stratum, and every input row', async () => {
    const artifact = admissionArtifact(await sampleReport())

    expect(artifact).toMatchObject({ version: 1, kind: 'tb-repair-admission' })
    expect(artifact.admitted).toEqual({
      'clean-exit': ['clean:1'],
      'command-error': ['err:1'],
      'signal-kill': [],
    })
    expect(artifact.rows).toHaveLength(5)
    expect(artifact.chain.overall).toMatchObject({ input: 5, admitted: 2 })
    expect(artifact.chain.reasonTotals).toMatchObject({
      'no-recorded-commands': 1,
      'stratum-not-admitted': 1,
      'prefix-divergence-above-threshold': 1,
    })
    expect(artifact.controlCost.kind).toBe('observed')
    expect(artifact.controlCost.usd).toBeCloseTo(0.24, 10)
  })

  it('survives a JSON round trip unchanged', async () => {
    const artifact = admissionArtifact(await sampleReport())
    expect(JSON.parse(JSON.stringify(artifact))).toEqual(artifact)
  })

  it('refuses to publish a chain that does not reconcile', async () => {
    const report = await sampleReport()
    const tampered = {
      ...report,
      chain: { ...report.chain, overall: { ...report.chain.overall, admitted: 4 } },
    } as AdmissionReport
    expect(() => admissionArtifact(tampered)).toThrow(AdmissionDenominatorError)
  })
})

describe('renderAdmissionReport', () => {
  it('renders the funnel, the strata, and the provenance of each boundary', async () => {
    const markdown = renderAdmissionReport(admissionArtifact(await sampleReport()))

    expect(markdown).toContain('2 of 5 rows admitted')
    expect(markdown).toContain('| `docker-replayer` |')
    expect(markdown).toContain('| `tb2-tests` |')
    expect(markdown).toContain('| `docker-continuation` |')
    expect(markdown).toContain('## Denominator chain')
    expect(markdown).toContain('## Denominator chain — clean-exit')
    expect(markdown).toContain('## Denominator chain — signal-kill')
    expect(markdown).toContain('| 3 | `stratum-not-admitted` | 4 | 1 | 3 |')
    expect(markdown).toContain('| 7 | `prefix-divergence-above-threshold` | 3 | 1 | 2 |')
    expect(markdown).toContain('Input 5 = admitted 2 + excluded 3.')
    expect(markdown).toContain('| signal-kill | 0 | no |')
    expect(markdown).toContain('| clean-exit | 1 | yes |')
  })

  it('lists every exclusion reason, including the ones that excluded nothing', async () => {
    const markdown = renderAdmissionReport(admissionArtifact(await sampleReport()))
    expect(markdown).toContain('| `no-op-control-rescued` | 0 |')
    expect(markdown).toContain('| `end-state-oracle-error` | 0 |')
  })

  it('appends rows only when a limit asks for them', async () => {
    const artifact = admissionArtifact(await sampleReport())
    expect(renderAdmissionReport(artifact)).not.toContain('## Rows')
    const withRows = renderAdmissionReport(artifact, { rowLimit: 2 })
    expect(withRows).toContain('## Rows')
    expect(withRows).toContain('3 further rows in the artifact.')
  })
})
