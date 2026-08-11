import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/errors'
import { admitRow, TB_REPAIR_ADMISSION_CRITERIA } from '../../src/trace-repair/admission-contract'
import {
  assertControlCalibrated,
  controlCanRescue,
  defineControlPolicy,
  UncalibratedControlError,
} from '../../src/trace-repair/control-policy'
import {
  admissionEvidence,
  CONTROL_POLICY,
  INERT_CONTROL_POLICY,
  POLICY_DIGEST,
  step,
} from './fixtures'

const STEPS = [
  step(1, 'ls /app', { returncode: 0, output: 'main.py' }),
  step(2, 'python /app/main.py', { returncode: 1, output: 'Traceback' }),
]

const INERT_CRITERIA = {
  ...TB_REPAIR_ADMISSION_CRITERIA,
  controlScreening: 'declared-inert' as const,
}

describe('what a control has to be able to do', () => {
  it('reads a zero step budget as a control that cannot reach a new state', () => {
    expect(controlCanRescue(0)).toBe(false)
    expect(controlCanRescue(1)).toBe(true)
    expect(INERT_CONTROL_POLICY.canRescue).toBe(false)
    expect(CONTROL_POLICY.canRescue).toBe(true)
  })

  it('hashes the whole declaration, so a step budget cannot move under one label', () => {
    const twenty = defineControlPolicy({
      id: 'same-label',
      stepBudget: 20,
      scaffold: 'mini-swe-agent',
      model: 'pinned/model-id',
      commandTimeoutSeconds: 30,
    })
    const one = defineControlPolicy({ ...twenty, stepBudget: 1 })
    expect(one.digest).not.toBe(twenty.digest)
  })

  it('refuses a declaration whose budget and model disagree', () => {
    expect(() =>
      defineControlPolicy({
        id: 'zero-with-model',
        stepBudget: 0,
        scaffold: 'mini-swe-agent',
        model: 'pinned/model-id',
        commandTimeoutSeconds: 30,
      }),
    ).toThrow(ValidationError)
    expect(() =>
      defineControlPolicy({
        id: 'budget-without-model',
        stepBudget: 3,
        scaffold: 'mini-swe-agent',
        model: null,
        commandTimeoutSeconds: 30,
      }),
    ).toThrow(/names no model/)
  })

  it('refuses to screen under a control that makes no model call', () => {
    expect(() => assertControlCalibrated(INERT_CONTROL_POLICY, 'enforced')).toThrow(
      UncalibratedControlError,
    )
    expect(() => assertControlCalibrated(INERT_CONTROL_POLICY, 'enforced')).toThrow(
      /grades the same bytes the end-state check already graded as failing/,
    )
  })

  it('refuses to call a control inert when it can act', () => {
    expect(() => assertControlCalibrated(CONTROL_POLICY, 'declared-inert')).toThrow(
      /it can rescue a row, but the criteria declare it inert/,
    )
  })
})

describe('admission refuses an uncalibrated configuration instead of passing every row', () => {
  it('throws at the configuration rather than admitting the row', () => {
    expect(() =>
      admitRow(admissionEvidence({ steps: STEPS, controlPolicy: INERT_CONTROL_POLICY })),
    ).toThrow(UncalibratedControlError)
  })

  it('reads a control pass under an inert control as the oracle flip it is', () => {
    const decision = admitRow(
      admissionEvidence({
        steps: STEPS,
        controlPolicy: INERT_CONTROL_POLICY,
        noFixControl: { rollouts: 3, passes: 2, policyDigest: INERT_CONTROL_POLICY.digest },
      }),
      INERT_CRITERIA,
    )
    expect(decision).toMatchObject({
      admitted: false,
      rejection: 'control-passed-on-identical-state',
    })
    if (decision.admitted) throw new Error('unreachable')
    expect(decision.detail).toMatch(/executes no command/)
    expect(decision.detail).not.toMatch(/repairable by continuing alone/)
  })

  it('still reads a control pass as a rescue when the control can act', () => {
    expect(
      admitRow(
        admissionEvidence({
          steps: STEPS,
          noFixControl: { rollouts: 3, passes: 2, policyDigest: POLICY_DIGEST },
        }),
      ),
    ).toMatchObject({ admitted: false, rejection: 'no-fix-control-passed' })
  })

  it('rejects an arm that reported a policy the criteria did not declare', () => {
    expect(
      admitRow(
        admissionEvidence({
          steps: STEPS,
          noFixControl: { rollouts: 3, passes: 0, policyDigest: 'zero-step-continuation@v1' },
        }),
      ),
    ).toMatchObject({ admitted: false, rejection: 'control-policy-mismatch' })
  })
})

describe('every decision names the control that screened the row', () => {
  it('records the policy on an admitted row', () => {
    const decision = admitRow(admissionEvidence({ steps: STEPS }))
    expect(decision.screening).toMatchObject({
      controlPolicyDigest: POLICY_DIGEST,
      controlScreening: 'enforced',
      oracleStable: true,
      oracleFlipRate: 0,
    })
    if (!decision.admitted) throw new Error('unreachable')
    expect(decision.row.controlPolicy.stepBudget).toBe(20)
    expect(decision.row.controlScreening).toBe('enforced')
  })

  it('records the policy on a rejected row too', () => {
    const decision = admitRow(admissionEvidence({ steps: STEPS, endStatePassed: true }))
    expect(decision.admitted).toBe(false)
    expect(decision.screening).toMatchObject({
      controlPolicyDigest: POLICY_DIGEST,
      controlScreening: 'enforced',
    })
  })

  it('records the inert control on a row screened under one', () => {
    const decision = admitRow(
      admissionEvidence({ steps: STEPS, controlPolicy: INERT_CONTROL_POLICY }),
      INERT_CRITERIA,
    )
    expect(decision.screening).toMatchObject({
      controlPolicyDigest: INERT_CONTROL_POLICY.digest,
      controlScreening: 'declared-inert',
    })
  })
})
