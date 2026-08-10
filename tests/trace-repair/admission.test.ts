import { describe, expect, it } from 'vitest'
import { admitRow, TB_REPAIR_ADMISSION_CRITERIA } from '../../src/trace-repair/admission-contract'
import { blindTrajectory, BLINDED_FIELDS } from '../../src/trace-repair/blinding'
import { admissionEvidence, admitted, POLICY_DIGEST, step } from './fixtures'

const STEPS = [
  step(1, 'ls /app', { returncode: 0, output: 'main.py' }),
  step(2, 'python /app/main.py', { returncode: 1, output: 'Traceback\nValueError' }),
  step(3, 'echo done', { returncode: 0, output: 'done' }),
]

describe('the four pre-registered checks', () => {
  it('admits a row that passes all four and derives what the estimator needs', () => {
    const outcome = admitRow(admissionEvidence({ steps: STEPS }))
    expect(outcome.admitted).toBe(true)
    if (!outcome.admitted) throw new Error('unreachable')
    expect(outcome.row.controlRate).toBe(0)
    expect(outcome.row.controlRollouts).toBe(3)
    expect(outcome.row.policyDigest).toBe(POLICY_DIGEST)
    expect(outcome.row.prefixDivergenceRatio).toBe(0)
  })

  it('refuses a row whose prefix does not replay faithfully enough', () => {
    const outcome = admitRow(
      admissionEvidence({ steps: STEPS, prefixFidelity: { stepsReplayed: 10, divergences: 2 } }),
    )
    expect(outcome).toMatchObject({ admitted: false, rejection: 'prefix-divergence-too-high' })
  })

  it('admits exactly at the divergence ceiling and refuses just above it', () => {
    expect(
      admitRow(
        admissionEvidence({ steps: STEPS, prefixFidelity: { stepsReplayed: 10, divergences: 1 } }),
      ).admitted,
    ).toBe(true)
    expect(
      admitRow(
        admissionEvidence({ steps: STEPS, prefixFidelity: { stepsReplayed: 20, divergences: 3 } }),
      ).admitted,
    ).toBe(false)
  })

  it('refuses a row whose held-out suite already passes on the recorded end state', () => {
    expect(admitRow(admissionEvidence({ steps: STEPS, endStatePassed: true }))).toMatchObject({
      admitted: false,
      rejection: 'end-state-already-passes',
    })
  })

  it('refuses a row the no-fix control can already repair', () => {
    expect(
      admitRow(
        admissionEvidence({
          steps: STEPS,
          noFixControl: { rollouts: 3, passes: 1, policyDigest: POLICY_DIGEST },
        }),
      ),
    ).toMatchObject({ admitted: false, rejection: 'no-fix-control-passed' })
  })

  it('refuses a row the no-op control can already repair', () => {
    expect(
      admitRow(
        admissionEvidence({
          steps: STEPS,
          noOpControl: { rollouts: 3, passes: 3, policyDigest: POLICY_DIGEST },
        }),
      ),
    ).toMatchObject({ admitted: false, rejection: 'no-op-control-passed' })
  })

  it('refuses a control arm that ran fewer rollouts than the criteria pre-register', () => {
    expect(
      admitRow(
        admissionEvidence({
          steps: STEPS,
          noFixControl: { rollouts: 2, passes: 0, policyDigest: POLICY_DIGEST },
        }),
      ),
    ).toMatchObject({ admitted: false, rejection: 'control-rollouts-short' })
  })

  it('refuses controls that ran different policies', () => {
    expect(
      admitRow(
        admissionEvidence({
          steps: STEPS,
          noOpControl: { rollouts: 3, passes: 0, policyDigest: 'other' },
        }),
      ),
    ).toMatchObject({ admitted: false, rejection: 'control-policy-mismatch' })
  })

  it('refuses an empty trajectory', () => {
    expect(admitRow(admissionEvidence({ steps: [] }))).toMatchObject({
      admitted: false,
      rejection: 'empty-trajectory',
    })
  })

  it('reads no finding, no k and no label — the evidence has no field for one', () => {
    const evidence = admissionEvidence({ steps: STEPS })
    expect(Object.keys(evidence).sort()).toEqual([
      'controlPolicy',
      'cwd',
      'endStatePassed',
      'image',
      'noFixControl',
      'noOpControl',
      'oracleDeterminism',
      'prefixFidelity',
      'rowId',
      'steps',
      'suiteDigest',
      'taskName',
      'taskStatement',
    ])
  })

  it('refuses criteria that cannot be applied', () => {
    expect(() =>
      admitRow(admissionEvidence({ steps: STEPS }), {
        maxPrefixDivergenceRatio: 1.5,
        controlRollouts: 3,
      }),
    ).toThrow(/maxPrefixDivergenceRatio/)
    expect(() =>
      admitRow(admissionEvidence({ steps: STEPS }), {
        ...TB_REPAIR_ADMISSION_CRITERIA,
        controlRollouts: 0,
      }),
    ).toThrow(/controlRollouts/)
  })
})

describe('what the analyst is shown', () => {
  it('carries the task and the steps and none of the admission evidence', () => {
    const prefix = blindTrajectory(admitted({ steps: STEPS }))
    expect(Object.keys(prefix).sort()).toEqual([
      'maxK',
      'recordedSteps',
      'rowId',
      'steps',
      'taskStatement',
    ])
    for (const field of BLINDED_FIELDS) {
      expect(prefix as Record<string, unknown>).not.toHaveProperty(field)
    }
    expect(prefix.steps).toHaveLength(3)
    expect(prefix.maxK).toBe(3)
  })

  it('truncates on request and reports the k range that truncation allows', () => {
    const prefix = blindTrajectory(admitted({ steps: STEPS }), { throughStep: 2 })
    expect(prefix.steps.map((s) => s.step_id)).toEqual([1, 2])
    expect(prefix.maxK).toBe(2)
    expect(prefix.recordedSteps).toBe(3)
  })

  it('refuses a truncation point outside the recording', () => {
    expect(() => blindTrajectory(admitted({ steps: STEPS }), { throughStep: 9 })).toThrow(
      /throughStep/,
    )
  })
})
