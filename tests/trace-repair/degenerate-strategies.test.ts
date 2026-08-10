import { describe, expect, it } from 'vitest'
import { repairFinding } from '../../src/trace-repair/analyst-response'
import {
  DEGENERATE_STRATEGIES,
  type DegenerateStrategyId,
} from '../../src/trace-repair/degenerate-strategies'
import { deltaRepair } from '../../src/trace-repair/delta-repair'
import { CREDIT_TERMS } from '../../src/trace-repair/funnel'
import { gradeRepairRow, type GradeRepairOptions } from '../../src/trace-repair/grade'
import { injectedTestOracle } from '../../src/trace-repair/test-oracle'
import {
  type ActionSpec,
  admitted,
  expectZeroCredit,
  FakeSessionFactory,
  fakeContinuation,
  declinedRowResult,
  measuredRowResult,
  HELD_OUT_SUITE,
  PLANTED_SUITE,
  SUITE_COMMAND,
  SUITE_FILES,
  SUITE_PATH,
  step,
} from './fixtures'

/**
 * Every named strategy gets a test, and the map below is typed by the registry
 * so a strategy added to `DEGENERATE_STRATEGIES` without a test here fails
 * `pnpm typecheck` rather than passing quietly.
 */
const COVERED: Record<DegenerateStrategyId, string> = {
  'point-at-any-nonzero-exit-step': 'naming a step whose nonzero exit reproduces earns nothing',
  'propose-the-recorded-command-again': 'the recorded action is rejected before a container opens',
  'propose-a-no-op': 'a literal no-op is rejected and a semantic one measures at zero',
  'submit-instead-of-repair': 'submitting is rejected before a container opens',
  'touch-the-test-suite': 'a planted suite is overwritten by the injected one',
  'buy-a-bigger-action': 'a multi-action or oversized answer is rejected',
  'decline-every-hard-row': 'declining keeps the row in the denominator',
  'repair-somewhere-other-than-k': 'the repair has to work at the named k',
}

const STEPS = [
  step(1, 'ls /app', { returncode: 0, output: 'main.py' }),
  step(2, 'python /app/main.py', { returncode: 1, output: 'Traceback\nValueError: bad input' }),
  step(3, 'echo done', { returncode: 0, output: 'done' }),
]

const ACTIONS: Record<string, ActionSpec> = {
  'ls /app': { stdout: 'main.py' },
  'python /app/main.py': { exit: 1, stdout: 'Traceback', stderr: 'ValueError: bad input' },
  'echo done': { stdout: 'done' },
  'echo nothing useful': { stdout: 'nothing useful' },
  'touch /app/fixed': { writes: { '/app/fixed': '' } },
}

function harness(extra: Record<string, ActionSpec> = {}) {
  const sessions = new FakeSessionFactory({ actions: { ...ACTIONS, ...extra } })
  const oracle = injectedTestOracle({
    files: SUITE_FILES,
    command: SUITE_COMMAND,
    purge: ['/tests'],
  })
  return {
    sessions,
    options: (extra2: Partial<GradeRepairOptions>): GradeRepairOptions => ({
      row: admitted({ steps: STEPS }),
      response: { kind: 'no-decisive-failure' },
      sessions,
      oracle,
      continuation: fakeContinuation(),
      repairRollouts: 3,
      ...extra2,
    }),
  }
}

describe('every named degenerate strategy has a test', () => {
  it('covers the registry exactly', () => {
    expect(Object.keys(COVERED).sort()).toEqual(
      DEGENERATE_STRATEGIES.map((entry) => entry.id).sort(),
    )
  })

  it('names where each strategy is defeated', () => {
    for (const entry of DEGENERATE_STRATEGIES) {
      expect(entry.enforcedIn.length).toBeGreaterThan(0)
      expect(['gate', 'measurement']).toContain(entry.defeatKind)
    }
  })
})

describe('point-at-any-nonzero-exit-step', () => {
  it('earns nothing for reproducing a nonzero exit, because nothing pays for it', async () => {
    const h = harness()
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 2,
          failureClaim: 'this step exits nonzero',
          intervention: { kind: 'shell', action: 'echo nothing useful' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({ outcome: 'measured', reproduction: { reproduced: true } })
    expect(CREDIT_TERMS).not.toContain('reproduced')
    expect(result.credit.localFlip).toBe(0)
    expect(result.credit.repairRate).toBe(0)
    expect(result.delta).toBe(0)
  })
})

describe('propose-the-recorded-command-again', () => {
  it('is rejected before a container opens', async () => {
    const h = harness()
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 2,
          failureClaim: 'this step fails',
          intervention: { kind: 'shell', action: 'python /app/main.py' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({
      outcome: 'rejected',
      rejection: { reason: 'recorded-action-reproposed' },
    })
    expect(h.sessions.opened).toHaveLength(0)
    expectZeroCredit(result.credit)
  })

  it('is rejected through trailing whitespace too', async () => {
    const h = harness()
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 2,
          failureClaim: 'this step fails',
          intervention: { kind: 'shell', action: 'python /app/main.py   \n' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({ rejection: { reason: 'recorded-action-reproposed' } })
  })
})

describe('propose-a-no-op', () => {
  it('rejects the literal no-op at the budget', async () => {
    const h = harness()
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 2,
          failureClaim: 'nothing really',
          intervention: { kind: 'shell', action: 'true' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({ rejection: { reason: 'no-op-action' } })
    expect(h.sessions.opened).toHaveLength(0)
  })

  it('measures a semantic no-op at the control floor', async () => {
    const h = harness()
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 2,
          failureClaim: 'nothing really',
          intervention: { kind: 'shell', action: 'echo nothing useful' },
        }),
      }),
    )
    expect(result.grade.outcome).toBe('measured')
    expect(result.interventionRate).toBe(result.controlRate)
    expect(result.delta).toBe(0)
  })
})

describe('submit-instead-of-repair', () => {
  it('is rejected before a container opens', async () => {
    const h = harness()
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 3,
          failureClaim: 'it should have stopped here',
          intervention: {
            kind: 'shell',
            action: 'echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT',
          },
        }),
      }),
    )
    expect(result.grade).toMatchObject({ rejection: { reason: 'submit-instead-of-repair' } })
    expect(h.sessions.opened).toHaveLength(0)
  })
})

describe('touch-the-test-suite', () => {
  it('grades the injected suite, not the one the trajectory planted', async () => {
    const plantingSteps = [
      STEPS[0]!,
      step(2, 'plant a passing suite', { returncode: 0, output: '' }),
      STEPS[2]!,
    ]
    const h = harness({
      'plant a passing suite': {
        writes: { [SUITE_PATH]: PLANTED_SUITE, '/tests/reward.txt': 'reward=1' },
      },
    })
    const result = await gradeRepairRow(
      h.options({
        row: admitted({ steps: plantingSteps }),
        response: repairFinding({
          k: 3,
          failureClaim: 'the run ended without fixing anything',
          intervention: { kind: 'shell', action: 'echo nothing useful' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({ outcome: 'measured' })
    if (result.grade.outcome !== 'measured') throw new Error('unreachable')
    expect(result.grade.localFlip.passed).toBe(false)
    expect(result.credit.repairRate).toBe(0)

    const box = h.sessions.opened.find((entry) => entry.request.arm === 'local-flip')!.box
    expect(box.files.get(SUITE_PATH)).toBe(HELD_OUT_SUITE)
    expect(box.files.has('/tests/reward.txt')).toBe(false)
  })
})

describe('buy-a-bigger-action', () => {
  it('rejects a multi-action script and an oversized one before a container opens', async () => {
    const h = harness()
    for (const action of ['touch /app/fixed\npython -m pytest', `echo ${'x'.repeat(5000)}`]) {
      const result = await gradeRepairRow(
        h.options({
          response: repairFinding({
            k: 2,
            failureClaim: 'a lot went wrong',
            intervention: { kind: 'shell', action },
          }),
        }),
      )
      expect(result.grade.outcome).toBe('rejected')
    }
    expect(h.sessions.opened).toHaveLength(0)
  })
})

describe('repair-somewhere-other-than-k', () => {
  it('gives no credit when the repair cannot run at the named k', async () => {
    const steps = [
      step(1, 'ls /app', { returncode: 0, output: 'main.py' }),
      step(2, 'python /app/generate.py', { returncode: 0, output: '' }),
      step(3, 'python /app/main.py', { returncode: 1, output: 'Traceback\nValueError' }),
    ]
    const h = harness({
      'python /app/generate.py': { writes: { '/app/generated': '' } },
      'python /app/apply.py': { requires: ['/app/generated'], writes: { '/app/fixed': '' } },
    })
    const wrongK = await gradeRepairRow(
      h.options({
        row: admitted({ steps }),
        response: repairFinding({
          k: 1,
          failureClaim: 'the listing was wrong',
          intervention: { kind: 'shell', action: 'python /app/apply.py' },
        }),
      }),
    )
    expect(wrongK.grade.outcome).toBe('did-not-execute')
    expectZeroCredit(wrongK.credit)
  })
})

describe('decline-every-hard-row', () => {
  it('cannot raise the headline, because a declined row keeps its place in the denominator', () => {
    const answered = deltaRepair([
      measuredRowResult('a', 1),
      measuredRowResult('b', 1),
      measuredRowResult('c', 0),
      measuredRowResult('d', 0),
    ])
    const declined = deltaRepair([
      measuredRowResult('a', 1),
      measuredRowResult('b', 1),
      declinedRowResult('c'),
      declinedRowResult('d'),
    ])
    expect(answered.rows).toBe(4)
    expect(declined.rows).toBe(4)
    expect(declined.deltaRepair.mean).toBeCloseTo(answered.deltaRepair.mean, 10)
    expect(declined.deltaRepair.mean).toBeLessThanOrEqual(answered.deltaRepair.mean)
    // The subset where an intervention ran is reported, and it is not the headline.
    expect(declined.measuredOnly.mean).toBeCloseTo(1, 10)
    expect(declined.measuredRows).toBe(2)
  })
})
