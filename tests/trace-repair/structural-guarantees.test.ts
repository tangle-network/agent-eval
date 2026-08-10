/**
 * The guarantees this module makes structurally rather than by convention.
 *
 * Each `@ts-expect-error` below fails `pnpm typecheck` if the guarantee is
 * ever weakened: the annotation is an error when the line it marks compiles.
 * That is what makes these checks, not comments.
 */

import { describe, expect, it } from 'vitest'
import {
  type AdmittedRow,
  TB_REPAIR_ADMISSION_CRITERIA,
} from '../../src/trace-repair/admission-contract'
import { blindTrajectory } from '../../src/trace-repair/blinding'
import type { RepairCredit } from '../../src/trace-repair/funnel'
import { admitted, POLICY_DIGEST, step, SUITE_DIGEST } from './fixtures'

const UNADMITTED = {
  rowId: 'forged',
  image: 'registry.example/task@sha256:pinned',
  cwd: '/app',
  taskStatement: 'make the suite pass',
  steps: [step(1, 'ls /app', { returncode: 0, output: 'main.py' })],
  criteria: TB_REPAIR_ADMISSION_CRITERIA,
  prefixDivergenceRatio: 0,
  suiteDigest: SUITE_DIGEST,
  policyDigest: POLICY_DIGEST,
  controlRate: 0,
  controlRollouts: 3,
}

describe('the reproduction gate has nothing to pay into', () => {
  it('has no reproduction term in the credit vector to assign', () => {
    // @ts-expect-error the credit vector has no reproduction term
    const term: keyof RepairCredit = 'reproduced'
    expect(term).toBe('reproduced')
  })

  it('has no localisation term either', () => {
    // @ts-expect-error the credit vector has no localisation term
    const term: keyof RepairCredit = 'localised'
    expect(term).toBe('localised')
  })
})

describe('a row reaches the analyst and the grader only through admission', () => {
  it('will not accept a row that admitRow did not brand', () => {
    // @ts-expect-error a row assembled by hand is not an AdmittedRow
    const forged: AdmittedRow = UNADMITTED
    expect(forged.rowId).toBe('forged')
  })

  it('will not blind a row that admitRow did not brand', () => {
    // @ts-expect-error blindTrajectory takes an AdmittedRow only
    expect(() => blindTrajectory(UNADMITTED)).toBeTruthy()
  })

  it('blinds a branded row', () => {
    const prefix = blindTrajectory(
      admitted({ steps: [step(1, 'ls /app', { returncode: 0, output: 'main.py' })] }),
    )
    expect(prefix.steps).toHaveLength(1)
  })
})
