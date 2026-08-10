import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { ChatCompletionCaller } from '../../src/trajectory-replay/fix'
import {
  parseIncorrectStepsSubject,
  replayVerifyFinding,
  resolveFindingInvocation,
} from '../../src/trajectory-replay/wire'
import { fixtureStep, scriptedBackend, writeFixtureCorpus } from './fixtures'

let root: string
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'replay-wire-test-'))
  return root
}

const steps = () => [
  fixtureStep(1, 'ls', 0, 'files'),
  fixtureStep(2, 'sed -i broken file.c', 0),
  fixtureStep(3, 'make target', 2, 'file.c:9:2: error: broken build\nstopped'),
  fixtureStep(4, 'echo done', 0),
]

describe('parseIncorrectStepsSubject', () => {
  it('parses the four analyst subject fields', () => {
    expect(parseIncorrectStepsSubject('incorrect-steps-7-9-unescaped-consequence-11')).toEqual({
      firstStep: 7,
      lastStep: 9,
      escapeStatus: 'unescaped',
      consequenceStep: 11,
    })
    expect(parseIncorrectStepsSubject('incorrect-steps-2-2-escaped-consequence-3')).toMatchObject({
      escapeStatus: 'escaped',
    })
  })

  it('returns null for anything else', () => {
    expect(parseIncorrectStepsSubject('incorrect-steps-2-consequence-3')).toBeNull()
    expect(parseIncorrectStepsSubject('some-other-finding')).toBeNull()
    expect(parseIncorrectStepsSubject('incorrect-steps-2-2-maybe-consequence-3')).toBeNull()
  })
})

describe('resolveFindingInvocation', () => {
  it('maps a finding to the trajectory resources with --at from the subject', () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'wire', [
      {
        trajId: 'traj-ok',
        steps: steps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:1', runConfigCwd: '/repo', timeoutSeconds: 9 },
      },
    ])
    const invocation = resolveFindingInvocation(
      { trajId: 'traj-ok', subject: 'incorrect-steps-3-3-unescaped-consequence-4' },
      [corpus],
    )
    expect(invocation.at).toBe(3)
    expect(invocation.resources).toMatchObject({
      image: 'example/img:1',
      cwd: '/repo',
      recordedStepTimeoutMs: 9000,
    })
  })

  it('fails loud on malformed subjects, unknown trajectories, and out-of-range steps', () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'wire', [
      {
        trajId: 'traj-ok',
        steps: steps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:1', runConfigCwd: '/repo' },
      },
      { trajId: 'traj-not-swe', steps: steps(), goldIncorrectSteps: [3] },
    ])
    expect(() =>
      resolveFindingInvocation({ trajId: 'traj-ok', subject: 'nonsense' }, [corpus]),
    ).toThrow(/not incorrect-steps/)
    expect(() =>
      resolveFindingInvocation(
        { trajId: 'traj-missing', subject: 'incorrect-steps-1-1-unescaped-consequence-2' },
        [corpus],
      ),
    ).toThrow(/not replayable in any corpus/)
    expect(() =>
      resolveFindingInvocation(
        { trajId: 'traj-not-swe', subject: 'incorrect-steps-1-1-unescaped-consequence-2' },
        [corpus],
      ),
    ).toThrow(/no-swe-raw-trajectory/)
    expect(() =>
      resolveFindingInvocation(
        { trajId: 'traj-ok', subject: 'incorrect-steps-99-99-unescaped-consequence-100' },
        [corpus],
      ),
    ).toThrow(/outside/)
  })
})

describe('replayVerifyFinding', () => {
  it('runs the full finding → generated fix → two-arm proof on a fake backend', async () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'wire', [
      {
        trajId: 'traj-ok',
        steps: steps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:1', runConfigCwd: '/repo' },
        taskMd: 'Fix the build.',
      },
    ])
    const backend = scriptedBackend((action) => {
      if (action === 'make target') {
        return { exitCode: 2, stdout: 'stopped', stderr: 'file.c:9:2: error: broken build' }
      }
      if (action === 'fix file.c && make target') {
        return { exitCode: 0, stdout: 'built ok', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const caller: ChatCompletionCaller = {
      complete: async (_system, user) => {
        expect(user).toContain('make target')
        expect(user).toContain('Fix the build.')
        return {
          succeeded: true,
          value: { content: '```sh\nfix file.c && make target\n```', usage: null },
        }
      },
    }
    const result = await replayVerifyFinding(
      { trajId: 'traj-ok', subject: 'incorrect-steps-3-3-unescaped-consequence-4' },
      {
        corpora: [corpus],
        out: join(dir, 'out'),
        fixCaller: caller,
        backendFactory: () => backend,
      },
    )
    expect(result.fixCommand).toBe('fix file.c && make target')
    expect(result.verdict.armA.failureSignatureMatch).toBe(true)
    expect(result.verdict.armB?.failureVanished).toBe(true)
    expect(backend.executed).toEqual([
      ['ls', 'sed -i broken file.c', 'make target'],
      ['ls', 'sed -i broken file.c', 'fix file.c && make target'],
    ])
  })

  it('propagates fix-generation failure instead of running an armless arm B', async () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'wire', [
      {
        trajId: 'traj-ok',
        steps: steps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:1', runConfigCwd: '/repo' },
      },
    ])
    await expect(
      replayVerifyFinding(
        { trajId: 'traj-ok', subject: 'incorrect-steps-3-3-unescaped-consequence-4' },
        {
          corpora: [corpus],
          out: join(dir, 'out'),
          fixCaller: { complete: async () => ({ succeeded: false, error: 'HTTP 500' }) },
          backendFactory: () => scriptedBackend(() => ({ exitCode: 0, stdout: '', stderr: '' })),
        },
      ),
    ).rejects.toThrow(/fix generation failed — HTTP 500/)
  })

  it('rejects fixCaller and fixCommand together', async () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'wire', [])
    await expect(
      replayVerifyFinding(
        { trajId: 'x', subject: 'incorrect-steps-1-1-unescaped-consequence-2' },
        {
          corpora: [corpus],
          out: join(dir, 'out'),
          fixCaller: { complete: async () => ({ succeeded: false, error: 'x' }) },
          fixCommand: 'echo hi',
          backendFactory: () => scriptedBackend(() => ({ exitCode: 0, stdout: '', stderr: '' })),
        },
      ),
    ).rejects.toThrow(/not both/)
  })
})
