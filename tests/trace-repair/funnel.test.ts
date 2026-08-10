import { describe, expect, it } from 'vitest'
import { CREDIT_TERMS, repairCredit } from '../../src/trace-repair/funnel'
import { gradeRepairRow, type GradeRepairOptions } from '../../src/trace-repair/grade'
import { injectedTestOracle } from '../../src/trace-repair/test-oracle'
import {
  type ActionSpec,
  admitted,
  CWD,
  expectZeroCredit,
  FakeSessionFactory,
  fakeContinuation,
  type FakeWorldOptions,
  HELD_OUT_SUITE,
  SUITE_COMMAND,
  SUITE_FILES,
  SUITE_PATH,
  step,
} from './fixtures'
import { repairFinding } from '../../src/trace-repair/analyst-response'

/**
 * A four-step recording that ends on a clean exit — the dominant shape in the
 * corpus. The agent edits the wrong file, the suite it never ran would have
 * failed, and it submits believing it is done.
 */
const STEPS = [
  step(1, 'ls /app', { returncode: 0, output: 'main.py\nbroken.py' }),
  step(2, 'python /app/main.py', { returncode: 1, output: 'Traceback\nValueError: bad input' }),
  step(3, 'sed -i s/x/y/ /app/wrong.py', { returncode: 0, output: '' }),
  step(4, 'echo done', { returncode: 0, output: 'done' }),
]

const RECORDED_ACTIONS: Record<string, ActionSpec> = {
  'ls /app': { stdout: 'main.py\nbroken.py' },
  'python /app/main.py': { exit: 1, stdout: 'Traceback', stderr: 'ValueError: bad input' },
  'sed -i s/x/y/ /app/wrong.py': {},
  'echo done': { stdout: 'done' },
}

function world(extra: Record<string, ActionSpec> = {}, options: Partial<FakeWorldOptions> = {}) {
  return {
    image: { '/app/main.py': 'broken', ...(options.image ?? {}) },
    actions: { ...RECORDED_ACTIONS, ...extra },
    dropWritesUnder: options.dropWritesUnder,
  } satisfies FakeWorldOptions
}

function harness(worldOptions: FakeWorldOptions, over: Partial<GradeRepairOptions> = {}) {
  const sessions = new FakeSessionFactory(worldOptions)
  const continuation = over.continuation ?? fakeContinuation()
  const oracle = injectedTestOracle({
    files: SUITE_FILES,
    command: SUITE_COMMAND,
    purge: ['/tests'],
  })
  return {
    sessions,
    continuation,
    oracle,
    options: (extra: Partial<GradeRepairOptions>): GradeRepairOptions => ({
      row: admitted({ steps: STEPS }),
      response: { kind: 'no-decisive-failure' },
      sessions,
      oracle,
      continuation,
      repairRollouts: 3,
      ...over,
      ...extra,
    }),
  }
}

describe('t0 — parsed and inside the action budget', () => {
  it('rejects a k outside the recording without opening a container', async () => {
    const h = harness(world())
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 99,
          failureClaim: 'wrong file edited',
          intervention: { kind: 'shell', action: 'touch /app/fixed' },
        }),
      }),
    )
    expect(result.grade.outcome).toBe('rejected')
    expect(result.grade).toMatchObject({ rejection: { reason: 'k-out-of-range' } })
    expect(h.sessions.opened).toHaveLength(0)
    expectZeroCredit(result.credit)
    expect(result.delta).toBe(0)
  })

  it('rejects an intervention over the byte budget before any replay', async () => {
    const h = harness(world())
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 3,
          failureClaim: 'wrong file edited',
          intervention: { kind: 'shell', action: `echo ${'x'.repeat(5000)}` },
        }),
      }),
    )
    expect(result.grade).toMatchObject({
      outcome: 'rejected',
      rejection: { source: 'budget', reason: 'over-byte-cap' },
    })
    expect(h.sessions.opened).toHaveLength(0)
  })
})

describe('t1 — reproduction is a gate that pays nothing', () => {
  it('closes the gate when the recorded state at k does not come back', async () => {
    // The recording says step 2 exits 1; this environment exits 0 there.
    const h = harness(world({ 'python /app/main.py': { exit: 0, stdout: 'fine' } }))
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 2,
          failureClaim: 'the program crashes',
          intervention: { kind: 'shell', action: 'touch /app/fixed' },
        }),
      }),
    )
    expect(result.grade.outcome).toBe('not-reproduced')
    expect(h.sessions.armsOpened()).toEqual(['reproduce'])
    expectZeroCredit(result.credit)
  })

  it('passes the gate vacuously when the step recorded no observation, opening nothing', async () => {
    const steps = [...STEPS.slice(0, 3), step(4, 'submit', null)]
    const h = harness(world({ submit: {}, 'touch /app/fixed': { writes: { '/app/fixed': '' } } }))
    const result = await gradeRepairRow(
      h.options({
        row: admitted({ steps }),
        response: repairFinding({
          k: 4,
          failureClaim: 'submitted without running the suite',
          intervention: { kind: 'shell', action: 'touch /app/fixed' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({
      outcome: 'measured',
      reproduction: { basis: 'no-recorded-observation', reproduced: true },
    })
    expect(h.sessions.armsOpened()).not.toContain('reproduce')
  })

  it('gives a reproduced step with a useless intervention no more than a rejected answer', async () => {
    const h = harness(world({ 'echo nothing useful': { stdout: 'nothing useful' } }))
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 2,
          failureClaim: 'the program crashes here',
          intervention: { kind: 'shell', action: 'echo nothing useful' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({ outcome: 'measured', reproduction: { reproduced: true } })
    expect(result.credit.localFlip).toBe(0)
    expect(result.credit.repairRate).toBe(0)
    expect(result.delta).toBe(0)
  })

  it('has no reproduction term in the credit vector at all', () => {
    expect(CREDIT_TERMS).toEqual(['executes', 'localFlip', 'repairRate'])
    expect(
      CREDIT_TERMS.some((term) => /reproduc|localis|localiz|k\b/i.test(term)),
    ).toBe(false)
    expect(repairCredit({ outcome: 'declined' })).toEqual({
      executes: 0,
      localFlip: 0,
      repairRate: 0,
    })
  })
})

describe('t2 — the intervention executes', () => {
  it('stops at did-not-execute when the action exits nonzero', async () => {
    const h = harness(world({ 'python /app/fix.py': { exit: 2, stderr: 'no such file' } }))
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 3,
          failureClaim: 'the wrong file was edited',
          intervention: { kind: 'shell', action: 'python /app/fix.py' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({ outcome: 'did-not-execute', execution: { exitCode: 2 } })
    expect(h.sessions.armsOpened()).toEqual(['reproduce', 'local-flip'])
    expectZeroCredit(result.credit)
  })
})

describe('t3 — local flip', () => {
  it('flips immediately when the intervention repairs the task on its own', async () => {
    const h = harness(
      world({ 'touch /app/fixed': { writes: { '/app/fixed': '' } } }),
    )
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 3,
          failureClaim: 'the wrong file was edited',
          intervention: { kind: 'shell', action: 'touch /app/fixed' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({ outcome: 'measured', localFlip: { passed: true } })
    expect(result.credit).toEqual({ executes: 1, localFlip: 1, repairRate: 1 })
    expect(result.delta).toBe(1)
  })
})

describe('t4 — repair flip after the pinned continuation', () => {
  it('measures a repair the continuation had to finish, with no local flip', async () => {
    const continuation = fakeContinuation({
      actionsByRollout: { 0: ['touch /app/fixed'], 1: ['touch /app/fixed'], 2: ['echo gave up'] },
    })
    const h = harness(
      world({
        'chmod +w /app/main.py': { writes: { '/app/unblocked': '' } },
        'touch /app/fixed': { writes: { '/app/fixed': '' } },
        'echo gave up': { stdout: 'gave up' },
      }),
      { continuation },
    )
    const result = await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 3,
          failureClaim: 'the file was read-only, so the edit never landed',
          intervention: { kind: 'shell', action: 'chmod +w /app/main.py' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({ outcome: 'measured', localFlip: { passed: false } })
    expect(result.credit.localFlip).toBe(0)
    expect(result.credit.repairRate).toBeCloseTo(2 / 3, 10)
    expect(result.delta).toBeCloseTo(2 / 3, 10)
    expect(continuation.calls.map((call) => call.rolloutIndex)).toEqual([0, 1, 2])
    expect(continuation.calls[0]?.k).toBe(3)
    expect(continuation.calls[0]?.injected?.action).toBe('chmod +w /app/main.py')
  })

  it('rejects the row when a rollout ran a different policy than the controls', async () => {
    const continuation = fakeContinuation({ policyDigest: 'a-different-policy' })
    const h = harness(world({ 'touch /app/fixed': { writes: { '/app/fixed': '' } } }), {
      continuation,
    })
    await expect(
      gradeRepairRow(
        h.options({
          response: repairFinding({
            k: 3,
            failureClaim: 'the wrong file was edited',
            intervention: { kind: 'shell', action: 'touch /app/fixed' },
          }),
        }),
      ),
    ).rejects.toThrow(/would not be the intervention/)
  })

  it('counts a rollout whose intervention failed as a non-pass instead of dropping it', async () => {
    let attempts = 0
    const sessions = new FakeSessionFactory(
      world({ 'touch /app/fixed': { writes: { '/app/fixed': '' } } }),
    )
    const flaky = {
      async open(request: Parameters<typeof sessions.open>[0]) {
        const session = await sessions.open(request)
        if (request.arm !== 'intervention') return session
        attempts += 1
        const failThisOne = attempts === 2
        return {
          ...session,
          async exec(command: string, timeoutMs: number) {
            const result = await session.exec(command, timeoutMs)
            if (failThisOne && command.includes('base64 -d | sh') && result.exitCode === 0) {
              return { ...result, exitCode: 9 }
            }
            return result
          },
        }
      },
    }
    const h = harness(world())
    const result = await gradeRepairRow(
      h.options({
        sessions: flaky,
        response: repairFinding({
          k: 3,
          failureClaim: 'the wrong file was edited',
          intervention: { kind: 'shell', action: 'touch /app/fixed' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({ outcome: 'measured' })
    if (result.grade.outcome !== 'measured') throw new Error('unreachable')
    expect(result.grade.repair.rollouts).toBe(3)
    expect(result.grade.repair.interventionFailures).toBeGreaterThan(0)
    expect(result.grade.repair.rolloutEvidence).toHaveLength(3)
  })
})

describe('no-decisive-failure', () => {
  it('is a real answer with its own cell, costing and earning nothing', async () => {
    const h = harness(world())
    const result = await gradeRepairRow(h.options({ response: { kind: 'no-decisive-failure' } }))
    expect(result.grade).toEqual({ outcome: 'declined' })
    expect(h.sessions.opened).toHaveLength(0)
    expectZeroCredit(result.credit)
    expect(result.interventionRate).toBe(result.controlRate)
    expect(result.delta).toBe(0)
  })
})

describe('the repair must work at the k the analyst named', () => {
  const withDependency = world({
    'python /app/patch.py': {
      requires: ['/app/generated'],
      writes: { '/app/fixed': '' },
    },
    'python /app/generate.py': { writes: { '/app/generated': '' } },
  })
  const steps = [
    step(1, 'ls /app', { returncode: 0, output: 'main.py' }),
    step(2, 'python /app/generate.py', { returncode: 0, output: '' }),
    step(3, 'python /app/main.py', { returncode: 1, output: 'Traceback\nValueError: bad input' }),
  ]

  it('scores zero at a k whose state the repair cannot run on', async () => {
    const h = harness(withDependency)
    const result = await gradeRepairRow(
      h.options({
        row: admitted({ steps }),
        response: repairFinding({
          k: 1,
          failureClaim: 'the listing was wrong',
          intervention: { kind: 'shell', action: 'python /app/patch.py' },
        }),
      }),
    )
    expect(result.grade.outcome).toBe('did-not-execute')
    expectZeroCredit(result.credit)
  })

  it('scores the identical intervention at the k where it works', async () => {
    const h = harness(withDependency)
    const result = await gradeRepairRow(
      h.options({
        row: admitted({ steps }),
        response: repairFinding({
          k: 3,
          failureClaim: 'the program crashes because the patch was never applied',
          intervention: { kind: 'shell', action: 'python /app/patch.py' },
        }),
      }),
    )
    expect(result.grade).toMatchObject({ outcome: 'measured', localFlip: { passed: true } })
    expect(result.credit.localFlip).toBe(1)
  })
})

describe('arm integrity', () => {
  it('refuses a result graded against a suite the row was not admitted against', async () => {
    const h = harness(world({ 'touch /app/fixed': { writes: { '/app/fixed': '' } } }))
    const otherOracle = injectedTestOracle({
      files: [{ path: SUITE_PATH, contents: `${HELD_OUT_SUITE} `, mode: '0755' }],
      command: SUITE_COMMAND,
      purge: ['/tests'],
    })
    await expect(
      gradeRepairRow(
        h.options({
          oracle: otherOracle,
          response: repairFinding({
            k: 3,
            failureClaim: 'the wrong file was edited',
            intervention: { kind: 'shell', action: 'touch /app/fixed' },
          }),
        }),
      ),
    ).rejects.toThrow(/did not answer the same question/)
  })

  it('replays exactly the recorded steps before k, in the recorded working directory', async () => {
    const h = harness(world({ 'touch /app/fixed': { writes: { '/app/fixed': '' } } }))
    await gradeRepairRow(
      h.options({
        response: repairFinding({
          k: 3,
          failureClaim: 'the wrong file was edited',
          intervention: { kind: 'shell', action: 'touch /app/fixed' },
        }),
      }),
    )
    const localFlipBox = h.sessions.opened.find((entry) => entry.request.arm === 'local-flip')?.box
    const replayed = (localFlipBox?.commands ?? [])
      .filter((command) => command.includes('base64 -d | sh'))
      .map((command) =>
        Buffer.from(/printf %s ([A-Za-z0-9+/=]+) /.exec(command)![1]!, 'base64').toString('utf8'),
      )
    expect(replayed).toEqual(['ls /app', 'python /app/main.py', 'touch /app/fixed'])
    expect(localFlipBox?.commands.every((c) => !c.includes('base64 -d | sh') || c.startsWith(`cd '${CWD}'`))).toBe(true)
  })
})
