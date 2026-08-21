import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import type { RepairSession } from '../../src/trace-repair/ports'
import {
  injectedTestOracle,
  TestOracleError,
  TestSuiteTamperedError,
  testSuiteDigest,
} from '../../src/trace-repair/test-oracle'
import {
  FakeBox,
  HELD_OUT_SUITE,
  PLANTED_SUITE,
  SUITE_COMMAND,
  SUITE_FILES,
  SUITE_PATH,
} from './fixtures'

function sessionOver(box: FakeBox): RepairSession {
  return {
    ref: box.ref,
    async exec(command: string) {
      return box.exec(command)
    },
    async close() {},
  }
}

const CONTEXT = { rowId: 'row-1', arm: 'intervention' as const, rolloutIndex: 0 }

describe('the held-out suite is injected from outside the box', () => {
  it('overwrites a suite the trajectory planted, so the planted pass does not count', async () => {
    const box = new FakeBox('box', { actions: {} })
    box.write(SUITE_PATH, PLANTED_SUITE)
    box.write('/tests/reward.txt', 'reward=1')

    // The plant works: run the suite as it stands and it passes.
    expect(box.runSuite().exitCode).toBe(0)

    const oracle = injectedTestOracle({
      files: SUITE_FILES,
      command: SUITE_COMMAND,
      purge: ['/tests'],
    })
    const outcome = await oracle.grade(sessionOver(box), CONTEXT)

    expect(outcome.passed).toBe(false)
    expect(box.files.get(SUITE_PATH)).toBe(HELD_OUT_SUITE)
    expect(box.files.has('/tests/reward.txt')).toBe(false)
    expect(outcome.suiteDigest).toBe(testSuiteDigest(SUITE_FILES))
  })

  it('passes only when the state the held-out suite checks is really there', async () => {
    const box = new FakeBox('box', { actions: {} })
    box.write(SUITE_PATH, PLANTED_SUITE)
    box.write('/app/fixed', '')
    const oracle = injectedTestOracle({
      files: SUITE_FILES,
      command: SUITE_COMMAND,
      purge: ['/tests'],
    })
    const outcome = await oracle.grade(sessionOver(box), CONTEXT)
    expect(outcome.passed).toBe(true)
    expect(box.files.get(SUITE_PATH)).toBe(HELD_OUT_SUITE)
  })

  it('refuses to grade when the bytes it reads back are not the bytes it uploaded', async () => {
    const box = new FakeBox('box', { actions: {}, dropWritesUnder: ['/tests'] })
    box.files.set(SUITE_PATH, PLANTED_SUITE)
    const oracle = injectedTestOracle({
      files: SUITE_FILES,
      command: SUITE_COMMAND,
      // Purge is dropped too, which is exactly the box this test models.
    })
    await expect(oracle.grade(sessionOver(box), CONTEXT)).rejects.toBeInstanceOf(
      TestSuiteTamperedError,
    )
  })

  it('raises an oracle failure rather than a failing suite when the upload cannot land', async () => {
    const box = new FakeBox('box', { actions: {} })
    const session: RepairSession = {
      ref: box.ref,
      async exec(command: string) {
        if (command.startsWith('printf %s')) {
          return { exitCode: 1, stdout: '', stderr: 'read-only file system', timedOut: false }
        }
        return box.exec(command)
      },
      async close() {},
    }
    const oracle = injectedTestOracle({ files: SUITE_FILES, command: SUITE_COMMAND })
    await expect(oracle.grade(session, CONTEXT)).rejects.toBeInstanceOf(TestOracleError)
  })

  it('never reports a pass for a suite command that timed out', async () => {
    const box = new FakeBox('box', { actions: {} })
    box.write('/app/fixed', '')
    const session: RepairSession = {
      ref: box.ref,
      async exec(command: string) {
        if (command === SUITE_COMMAND) {
          return { exitCode: 0, stdout: '', stderr: '', timedOut: true }
        }
        return box.exec(command)
      },
      async close() {},
    }
    const oracle = injectedTestOracle({ files: SUITE_FILES, command: SUITE_COMMAND })
    const outcome = await oracle.grade(session, CONTEXT)
    expect(outcome.timedOut).toBe(true)
    expect(outcome.passed).toBe(false)
  })
})

describe('suite digest', () => {
  it('is order-independent and content-sensitive', () => {
    const a = [
      { path: '/tests/b.py', contents: 'b' },
      { path: '/tests/a.py', contents: 'a' },
    ]
    const b = [
      { path: '/tests/a.py', contents: 'a' },
      { path: '/tests/b.py', contents: 'b' },
    ]
    expect(testSuiteDigest(a)).toBe(testSuiteDigest(b))
    /**
     * Paths that a collation orders differently from code units. The digest's
     * contract is "two suites with the same digest are the same suite", so it
     * must not move with the host's ICU data: `Accuracy` before `Clarity`
     * before `brevity`, never `Accuracy, brevity, Clarity`.
     */
    const mixedCase = [
      { path: '/tests/brevity.py', contents: '1' },
      { path: '/tests/Accuracy.py', contents: '2' },
      { path: '/tests/Clarity.py', contents: '3' },
    ]
    const codeUnitOrder = [
      { path: '/tests/Accuracy.py', contents: '2' },
      { path: '/tests/Clarity.py', contents: '3' },
      { path: '/tests/brevity.py', contents: '1' },
    ]
    const collationOrder = [
      { path: '/tests/Accuracy.py', contents: '2' },
      { path: '/tests/brevity.py', contents: '1' },
      { path: '/tests/Clarity.py', contents: '3' },
    ]
    expect(testSuiteDigest(mixedCase)).toBe(testSuiteDigest(codeUnitOrder))
    expect(testSuiteDigest(codeUnitOrder)).not.toBe(digestInGivenOrder(collationOrder))
    expect(testSuiteDigest(a)).not.toBe(
      testSuiteDigest([
        { path: '/tests/a.py', contents: 'a' },
        { path: '/tests/b.py', contents: 'b ' },
      ]),
    )
  })

  it('refuses a relative suite path, a duplicate path, and a root purge', () => {
    expect(() =>
      injectedTestOracle({ files: [{ path: 'tests/a.py', contents: '' }], command: 'x' }),
    ).toThrow(/absolute/)
    expect(() =>
      injectedTestOracle({
        files: [
          { path: '/tests/a.py', contents: '' },
          { path: '/tests/a.py', contents: '' },
        ],
        command: 'x',
      }),
    ).toThrow(/listed twice/)
    expect(() => injectedTestOracle({ files: SUITE_FILES, command: 'x', purge: ['/'] })).toThrow(
      /below the root/,
    )
  })
})

/** The digest a suite would get if its files were folded in the given order —
 *  what `testSuiteDigest` produced while its sort read the host collation. */
function digestInGivenOrder(files: readonly { path: string; contents: string }[]): string {
  const hash = createHash('sha256')
  for (const file of files) {
    hash.update(file.path)
    hash.update('\0')
    hash.update(Buffer.from(file.contents, 'utf8'))
    hash.update('\0')
  }
  return hash.digest('hex')
}
