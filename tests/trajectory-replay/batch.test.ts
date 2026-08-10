import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { runReplayBatch, seededSample } from '../../src/trajectory-replay/batch'
import { enumerateReplayableCases, parseCorpusFlag } from '../../src/trajectory-replay/corpus'
import {
  buildFixPrompt,
  type ChatCompletionCaller,
  extractFixCommand,
  generateFixCommand,
} from '../../src/trajectory-replay/fix'
import { derivedImageTag, type ImagePreparer } from '../../src/trajectory-replay/image-preparer'
import {
  fixtureStep,
  fixtureStepUnrecordedReturncode,
  scriptedBackend,
  writeFixtureCorpus,
} from './fixtures'

let root: string
afterEach(() => {
  if (root) rmSync(root, { recursive: true, force: true })
})

function makeRoot(): string {
  root = mkdtempSync(join(tmpdir(), 'trajectory-replay-batch-test-'))
  return root
}

const failingSteps = () => [
  fixtureStep(1, 'ls', 0, 'files'),
  fixtureStep(2, 'sed -i broken file.c', 0),
  fixtureStep(3, 'make target', 2, 'file.c:9:2: error: broken build\nstopped'),
  fixtureStep(4, 'echo done', 0),
]

describe('parseCorpusFlag', () => {
  it('splits name=labels::prepared', () => {
    expect(parseCorpusFlag('dev=/a/labels.json::/b/prepared')).toEqual({
      name: 'dev',
      labelsPath: '/a/labels.json',
      preparedDir: '/b/prepared',
    })
  })

  it('rejects malformed values', () => {
    expect(() => parseCorpusFlag('no-separator')).toThrow(/--corpus/)
    expect(() => parseCorpusFlag('name=/only/one/path')).toThrow(/--corpus/)
  })
})

describe('enumerateReplayableCases', () => {
  it('classifies every exclusion reason and resolves cwd by priority', () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'mix', [
      {
        trajId: 'traj-ok',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:1', runConfigCwd: '/repo', timeoutSeconds: 5 },
        taskMd: 'Fix the build.',
      },
      {
        trajId: 'traj-pwd-cwd',
        steps: [fixtureStep(1, 'pwd', 0, '/derived'), ...failingSteps().slice(1)],
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:2' },
      },
      {
        trajId: 'traj-docker-cwd',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:3', dockerCwd: '/testbed' },
      },
      {
        trajId: 'traj-nogold',
        steps: failingSteps(),
        raw: { baseImage: 'example/img:4', runConfigCwd: '/r' },
      },
      { trajId: 'traj-noraw', steps: failingSteps(), goldIncorrectSteps: [3] },
      {
        trajId: 'traj-noimage',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: { runConfigCwd: '/r' },
      },
      {
        trajId: 'traj-nocwd',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:5' },
      },
      {
        trajId: 'traj-k-out-of-range',
        steps: failingSteps(),
        goldIncorrectSteps: [99],
        raw: { baseImage: 'example/img:6', runConfigCwd: '/r' },
      },
    ])
    const { replayable, excluded, labelEntryCount } = enumerateReplayableCases([corpus])
    expect(labelEntryCount).toBe(8)
    expect(replayable.map((c) => c.trajId).sort()).toEqual([
      'traj-docker-cwd',
      'traj-ok',
      'traj-pwd-cwd',
    ])
    const ok = replayable.find((c) => c.trajId === 'traj-ok')!
    expect(ok).toMatchObject({
      cwd: '/repo',
      cwdSource: 'run-config',
      k: 3,
      recordedReturncodeAtK: 2,
      recordedStepTimeoutMs: 5000,
      image: 'example/img:1',
      taskStatement: 'Fix the build.',
    })
    expect(replayable.find((c) => c.trajId === 'traj-pwd-cwd')).toMatchObject({
      cwd: '/derived',
      cwdSource: 'pwd-observation',
    })
    expect(replayable.find((c) => c.trajId === 'traj-docker-cwd')).toMatchObject({
      cwd: '/testbed',
      cwdSource: 'docker-config',
    })
    const reasons = Object.fromEntries(excluded.map((e) => [e.trajId, e.reason]))
    expect(reasons).toEqual({
      'traj-nogold': 'no-gold-incorrect-step',
      'traj-noraw': 'no-swe-raw-trajectory',
      'traj-noimage': 'no-docker-image',
      'traj-nocwd': 'cwd-underivable',
      'traj-k-out-of-range': 'gold-step-outside-steps',
    })
  })

  it('falls back to the raw user message when task.md is absent', () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'msg', [
      {
        trajId: 'traj-msg',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: {
          baseImage: 'example/img:1',
          runConfigCwd: '/r',
          taskMessage: 'Fix zstd build please.',
        },
      },
    ])
    const { replayable } = enumerateReplayableCases([corpus])
    expect(replayable[0]!.taskStatement).toBe('Fix zstd build please.')
  })

  it('skips submit-command golds when choosing k and excludes submit-only cases', () => {
    const submitAction =
      'echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && git add -A && git diff --cached'
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'submit', [
      {
        // Gold 2 is the submit command, gold 3 a real failed action: k must be 3.
        trajId: 'traj-skip-to-real',
        steps: [
          fixtureStep(1, 'ls', 0),
          fixtureStep(2, submitAction, null),
          fixtureStep(3, 'make target', 2, 'error: broken'),
          fixtureStep(4, 'echo done', 0),
        ],
        goldIncorrectSteps: [2, 3],
        raw: { baseImage: 'example/img:1', runConfigCwd: '/r' },
      },
      {
        trajId: 'traj-submit-only',
        steps: [fixtureStep(1, 'ls', 0), fixtureStep(2, submitAction, null)],
        goldIncorrectSteps: [2],
        raw: { baseImage: 'example/img:2', runConfigCwd: '/r' },
      },
      {
        trajId: 'traj-no-submit-gold',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/img:3', runConfigCwd: '/r' },
      },
    ])
    const { replayable, excluded } = enumerateReplayableCases([corpus])
    expect(replayable.map((c) => c.trajId).sort()).toEqual([
      'traj-no-submit-gold',
      'traj-skip-to-real',
    ])
    expect(replayable.find((c) => c.trajId === 'traj-skip-to-real')).toMatchObject({
      k: 3,
      submitGoldsSkipped: 1,
      recordedReturncodeAtK: 2,
      goldIncorrectSteps: [2, 3],
    })
    expect(replayable.find((c) => c.trajId === 'traj-no-submit-gold')).toMatchObject({
      k: 3,
      submitGoldsSkipped: 0,
    })
    expect(excluded).toEqual([
      {
        corpus: 'submit',
        trajId: 'traj-submit-only',
        reason: 'gold-only-submit-step',
        detail: '1 gold step(s), all submit commands',
      },
    ])
  })
})

describe('fix generation', () => {
  it('extracts the last fenced command and rejects empty content', () => {
    expect(extractFixCommand('prose\n```sh\nmake -j2\n```\nmore')).toBe('make -j2')
    expect(extractFixCommand('```sh\nwrong\n```\ntext\n```bash\nsed -i x f && make\n```')).toBe(
      'sed -i x f && make',
    )
    expect(extractFixCommand('bare command')).toBe('bare command')
    expect(extractFixCommand('   ')).toBeNull()
    expect(extractFixCommand('```sh\n\n```')).toBeNull()
  })

  it('builds a prompt with the failing step, ±3 context, and the task', () => {
    const steps = [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
      fixtureStep(i, `cmd-${i}`, i === 5 ? 2 : 0, i === 5 ? 'x.c:1: error: boom' : ''),
    )
    const { system, user } = buildFixPrompt({ taskStatement: 'Do the thing.', steps, k: 5 })
    expect(system).toContain('ONE corrected shell command')
    expect(user).toContain('Do the thing.')
    expect(user).toContain('step 5 (INCORRECT — correct this one)')
    expect(user).toContain('cmd-2')
    expect(user).toContain('cmd-8')
    expect(user).not.toContain('cmd-1\n')
    expect(user).toContain('x.c:1: error: boom')
  })

  it('returns a typed failure when the caller fails or emits no command', async () => {
    const steps = failingSteps()
    const failing: ChatCompletionCaller = {
      complete: async () => ({ succeeded: false, error: 'HTTP 500' }),
    }
    expect(await generateFixCommand(failing, { taskStatement: null, steps, k: 3 })).toEqual({
      succeeded: false,
      error: 'HTTP 500',
    })
    const empty: ChatCompletionCaller = {
      complete: async () => ({ succeeded: true, value: { content: '   ', usage: null } }),
    }
    const outcome = await generateFixCommand(empty, { taskStatement: null, steps, k: 3 })
    expect(outcome.succeeded).toBe(false)
  })
})

describe('derivedImageTag / seededSample', () => {
  it('derives a stable content-addressed tag', () => {
    const tag = derivedImageTag('mswebench/x:pr-1', '/home')
    expect(tag).toMatch(/^ctb-replay:[0-9a-f]{12}-uid1000$/)
    expect(derivedImageTag('mswebench/x:pr-1', '/home')).toBe(tag)
    expect(derivedImageTag('mswebench/x:pr-1', '/app')).not.toBe(tag)
  })

  it('samples deterministically for a given seed', () => {
    const items = ['a', 'b', 'c', 'd', 'e']
    const first = [...seededSample(items, 2, 17)]
    expect([...seededSample(items, 2, 17)]).toEqual(first)
    expect(first).toHaveLength(2)
  })
})

const fakePreparer = (failImages: string[] = []): ImagePreparer => ({
  async ensure(image: string) {
    if (failImages.includes(image)) {
      return { succeeded: false, error: `pull ${image}: not found` }
    }
    return {
      succeeded: true,
      value: { derivedImage: `derived-${image}`, pulled: true, built: true },
    }
  },
})

describe('runReplayBatch', () => {
  it('measures replayability and fix-flip with exclusions and pull failures reported', async () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'batch', [
      {
        trajId: 'traj-reproduces',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/ok:1', runConfigCwd: '/repo' },
        taskMd: 'Fix the build.',
      },
      {
        // Gold step is a final submit with no recorded observation: arm A can
        // never reproduce a returncode, so the case counts against the rate.
        trajId: 'traj-submit-gold',
        steps: [...failingSteps().slice(0, 3), fixtureStep(4, 'echo SUBMIT', null)],
        goldIncorrectSteps: [4],
        raw: { baseImage: 'example/ok:2', runConfigCwd: '/repo' },
      },
      {
        trajId: 'traj-pull-fails',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/missing:1', runConfigCwd: '/repo' },
      },
      { trajId: 'traj-not-swe', steps: failingSteps(), goldIncorrectSteps: [3] },
      {
        trajId: 'traj-submit-sentinel',
        steps: [
          fixtureStep(1, 'ls', 0),
          fixtureStep(2, 'echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT && git diff', null),
        ],
        goldIncorrectSteps: [2],
        raw: { baseImage: 'example/ok:3', runConfigCwd: '/repo' },
      },
    ])
    const out = join(dir, 'out')
    const caller: ChatCompletionCaller = {
      complete: async () => ({
        succeeded: true,
        value: {
          content: '```sh\nfix file.c && make target\n```',
          usage: { promptTokens: 100, completionTokens: 20 },
        },
      }),
    }
    const report = await runReplayBatch({
      corpora: [corpus],
      out,
      fix: 'generate',
      fixCaller: caller,
      fixModelLabel: 'fake-model',
      preparer: fakePreparer(['example/missing:1']),
      backendFactory: () =>
        scriptedBackend((action) => {
          if (action === 'make target') {
            return { exitCode: 2, stdout: 'stopped', stderr: 'file.c:9:2: error: broken build' }
          }
          if (action === 'fix file.c && make target') {
            return { exitCode: 0, stdout: 'built ok', stderr: '' }
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        }),
    })

    expect(report.totals).toMatchObject({ labelEntries: 5, replayable: 3, executed: 3 })
    expect(report.totals.excludedByReason).toEqual({
      'no-swe-raw-trajectory': 1,
      'gold-only-submit-step': 1,
    })
    expect(report.totals.submitGoldsByCorpus).toEqual({
      batch: { submitOnlyCases: 1, goldsSkippedWithinReplayable: 0 },
    })
    expect(report.pullFailures).toEqual([
      {
        corpus: 'batch',
        trajId: 'traj-pull-fails',
        image: 'example/missing:1',
        error: 'pull example/missing:1: not found',
      },
    ])
    // Only traj-reproduces replays: submit-gold has no recorded returncode,
    // pull-fails never reached an exec backend.
    expect(report.headline.replayabilityRate).toEqual({
      numerator: 1,
      denominator: 3,
      value: 1 / 3,
    })
    expect(report.headline.signatureStrictRate.numerator).toBe(1)
    expect(report.headline.fixFlipRate).toEqual({ numerator: 1, denominator: 1, value: 1 })
    expect(report.headline.fixFlipRateNonzeroRc).toEqual({ numerator: 1, denominator: 1, value: 1 })
    expect(report.llm).toEqual({
      model: 'fake-model',
      calls: 1,
      failures: 0,
      promptTokens: 100,
      completionTokens: 20,
      callsWithoutUsage: 0,
    })

    const reproduced = report.cases.find((c) => c.trajId === 'traj-reproduces')!
    expect(reproduced).toMatchObject({
      status: 'ok',
      derivedImage: 'derived-example/ok:1',
      armAExit: 2,
      armAReturncodeMatch: true,
      armASignatureMatch: true,
      replayed: true,
      prefixExecuted: 2,
      prefixDivergences: 0,
    })
    expect(reproduced.fix).toMatchObject({
      attempted: true,
      command: 'fix file.c && make target',
      armBExit: 0,
      failureVanished: true,
    })
    const submit = report.cases.find((c) => c.trajId === 'traj-submit-gold')!
    expect(submit).toMatchObject({
      status: 'ok',
      armAReturncodeMatch: false,
      replayed: false,
      fix: null,
    })

    expect(existsSync(join(out, 'batch-report.json'))).toBe(true)
    expect(existsSync(join(out, 'cases.jsonl'))).toBe(true)
    const markdown = readFileSync(join(out, 'batch-report.md'), 'utf8')
    expect(markdown).toContain('Replayability rate: 33.3%')
    expect(markdown).toContain('Fix-flip rate: 100.0%')
    expect(markdown).toContain('pull example/missing:1: not found')
    expect(markdown).toContain('| batch | 1 | 0 |')
    const verdictPath = join(out, 'batch--traj-reproduces', 'replay-verdict.json')
    expect(existsSync(verdictPath)).toBe(true)
    expect(existsSync(join(out, 'batch--traj-reproduces', 'armB-result.json'))).toBe(true)
  })

  it('refuses admission when the prefix replay was never confirmed against the recording', async () => {
    // The row an admission pre-pass must reject: arm A reproduces the recorded
    // returncode at k, but every prefix step replayed as 127 against a
    // recording that carries no returncode to check it against.
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'unverifiable', [
      {
        trajId: 'traj-127-prefix',
        steps: [
          fixtureStepUnrecordedReturncode(1, 'ls', 'files'),
          fixtureStepUnrecordedReturncode(2, 'sed -i broken file.c'),
          fixtureStepUnrecordedReturncode(3, 'cat file.c'),
          fixtureStep(4, 'make target', 2, 'file.c:9:2: error: broken build\nstopped'),
        ],
        goldIncorrectSteps: [4],
        raw: { baseImage: 'example/ok:1', runConfigCwd: '/repo' },
      },
    ])
    const out = join(dir, 'out')
    const report = await runReplayBatch({
      corpora: [corpus],
      out,
      fix: 'none',
      preparer: fakePreparer(),
      backendFactory: () =>
        scriptedBackend((action) =>
          action === 'make target'
            ? { exitCode: 2, stdout: 'stopped', stderr: 'file.c:9:2: error: broken build' }
            : { exitCode: 127, stdout: '', stderr: 'sh: 1: not found' },
        ),
    })
    const row = report.cases.find((c) => c.trajId === 'traj-127-prefix')!
    expect(row).toMatchObject({
      status: 'ok',
      armAExit: 2,
      armAReturncodeMatch: true,
      armASignatureMatch: true,
      prefixExecuted: 3,
      prefixDivergences: 3,
      prefixDivergencePct: 100,
      prefixConfirmed: 0,
      prefixReturncodeMismatches: 0,
      prefixUnknownExpectations: 3,
      replayed: false,
    })
    expect(report.headline.replayabilityRate).toEqual({
      numerator: 0,
      denominator: 1,
      value: 0,
    })
    expect(report.headline.prefixFidelity).toEqual({
      executedSteps: 3,
      divergentSteps: 3,
      returncodeMismatches: 0,
      unknownExpectations: 3,
      divergencePct: 100,
      tolerancePct: 10,
      casesWithinTolerance: 0,
      casesExecuted: 1,
    })
    const markdown = readFileSync(join(out, 'batch-report.md'), 'utf8')
    expect(markdown).toContain('**Prefix divergence: 100%**')
    expect(markdown).toContain('3 with no recorded returncode to check')
    expect(markdown).toContain('0/1 executed cases are within the 10% tolerance')
  })

  it('caps fix generation with a seeded sample and marks the rest sampled-out', async () => {
    const dir = makeRoot()
    const trajectories = [1, 2, 3].map((i) => ({
      trajId: `traj-${i}`,
      steps: failingSteps(),
      goldIncorrectSteps: [3],
      raw: { baseImage: `example/ok:${i}`, runConfigCwd: '/repo' },
    }))
    const corpus = writeFixtureCorpus(dir, 'cap', trajectories)
    let calls = 0
    const caller: ChatCompletionCaller = {
      complete: async () => {
        calls += 1
        return {
          succeeded: true,
          value: { content: '```sh\nfix file.c && make target\n```', usage: null },
        }
      },
    }
    const report = await runReplayBatch({
      corpora: [corpus],
      out: join(dir, 'out'),
      fix: 'generate',
      fixCaller: caller,
      maxFixCases: 2,
      seed: 7,
      preparer: fakePreparer(),
      backendFactory: () =>
        scriptedBackend((action) =>
          action === 'make target'
            ? { exitCode: 2, stdout: '', stderr: 'file.c:9:2: error: broken build' }
            : { exitCode: 0, stdout: '', stderr: '' },
        ),
    })
    expect(calls).toBe(2)
    const sampledOut = report.cases.filter((c) => c.fix?.sampledOut)
    expect(sampledOut).toHaveLength(1)
    expect(report.headline.fixFlipRate!.denominator).toBe(2)
  })

  it('fix=loop retries with feedback, opens a fresh session per attempt, and reports @1 vs final', async () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'loop', [
      {
        trajId: 'traj-flips-at-2',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/ok:1', runConfigCwd: '/repo' },
        taskMd: 'Fix the build.',
      },
      {
        trajId: 'traj-never-flips',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/ok:2', runConfigCwd: '/repo' },
      },
    ])
    const out = join(dir, 'out')
    const prompts: string[] = []
    const caller: ChatCompletionCaller = {
      complete: async (_system, user) => {
        prompts.push(user)
        // The retry prompt carries the failed command; use that to key replies.
        const isRetry = user.includes('## Previous fix attempts')
        return {
          succeeded: true,
          value: {
            content: isRetry
              ? '```sh\nfix file.c && make target\n```'
              : '```sh\nfirst-guess && make target\n```',
            usage: { promptTokens: 100, completionTokens: 20 },
          },
        }
      },
    }
    let opens = 0
    const report = await runReplayBatch({
      corpora: [corpus],
      out,
      fix: 'loop',
      fixAttempts: 3,
      fixCaller: caller,
      fixModelLabel: 'fake-model',
      preparer: fakePreparer(),
      backendFactory: (derivedImage) => {
        const inner = scriptedBackend((action) => {
          if (action === 'make target') {
            return { exitCode: 2, stdout: 'stopped', stderr: 'file.c:9:2: error: broken build' }
          }
          // Only the corrected command on the ok:1 image ever flips.
          if (action === 'fix file.c && make target' && derivedImage === 'derived-example/ok:1') {
            return { exitCode: 0, stdout: 'built ok', stderr: '' }
          }
          if (action.includes('make target')) {
            return { exitCode: 2, stdout: '', stderr: 'file.c:9:2: error: broken build' }
          }
          return { exitCode: 0, stdout: '', stderr: '' }
        })
        return {
          async open() {
            opens += 1
            return inner.open()
          },
        }
      },
    })

    const flips = report.cases.find((c) => c.trajId === 'traj-flips-at-2')!
    expect(flips.fix).toMatchObject({
      attempted: true,
      command: 'fix file.c && make target',
      armBExit: 0,
      failureVanished: true,
      flippedAtAttempt: 2,
      llmError: null,
      armBError: null,
    })
    expect(flips.fix!.attempts).toHaveLength(2)
    expect(flips.fix!.attempts![0]).toMatchObject({
      attempt: 1,
      executed: true,
      exitCode: 2,
      failureVanished: false,
    })
    expect(flips.fix!.usage).toEqual({ promptTokens: 200, completionTokens: 40 })

    const never = report.cases.find((c) => c.trajId === 'traj-never-flips')!
    expect(never.fix).toMatchObject({ failureVanished: false, flippedAtAttempt: null })
    expect(never.fix!.attempts).toHaveLength(3)

    // 2 arm-A sessions + 2 attempts (flip case) + 3 attempts (exhausted case),
    // each in its own fresh session.
    expect(opens).toBe(7)

    expect(report.headline.fixFlipRate).toEqual({ numerator: 1, denominator: 2, value: 0.5 })
    expect(report.headline.fixFlipAttempt1).toEqual({ numerator: 0, denominator: 2, value: 0 })
    expect(report.headline.flipsByAttempt).toEqual({ '2': 1 })
    expect(report.llm).toEqual({
      model: 'fake-model',
      calls: 5,
      failures: 0,
      promptTokens: 500,
      completionTokens: 100,
      callsWithoutUsage: 0,
    })

    // The retry prompt fed back the failed command and its REAL output.
    const retryPrompt = prompts.find((p) => p.includes('## Previous fix attempts'))!
    expect(retryPrompt).toContain('first-guess && make target')
    expect(retryPrompt).toContain('file.c:9:2: error: broken build')

    const caseDir = join(out, 'loop--traj-flips-at-2')
    expect(existsSync(join(caseDir, 'armB-attempt1-result.json'))).toBe(true)
    expect(existsSync(join(caseDir, 'armB-attempt2-result.json'))).toBe(true)
    const final = JSON.parse(readFileSync(join(caseDir, 'armB-result.json'), 'utf8'))
    expect(final).toMatchObject({ attempt: 2, exitCode: 0 })
    const markdown = readFileSync(join(out, 'batch-report.md'), 'utf8')
    expect(markdown).toContain('flip@2')
    expect(markdown).toContain('exhausted(3)')
    expect(markdown).toContain('Fix-flip@1: 0.0%')
  })

  it('records an LLM failure as a row, not an abort', async () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'llmfail', [
      {
        trajId: 'traj-1',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/ok:1', runConfigCwd: '/repo' },
      },
    ])
    const report = await runReplayBatch({
      corpora: [corpus],
      out: join(dir, 'out'),
      fix: 'generate',
      fixCaller: { complete: async () => ({ succeeded: false, error: 'HTTP 429' }) },
      preparer: fakePreparer(),
      backendFactory: () =>
        scriptedBackend((action) =>
          action === 'make target'
            ? { exitCode: 2, stdout: '', stderr: 'file.c:9:2: error: broken build' }
            : { exitCode: 0, stdout: '', stderr: '' },
        ),
    })
    expect(report.cases[0]!.fix).toMatchObject({
      attempted: true,
      llmError: 'HTTP 429',
      command: null,
    })
    expect(report.headline.fixFlipRate).toEqual({ numerator: 0, denominator: 0, value: null })
    expect(report.llm).toMatchObject({ calls: 1, failures: 1 })
  })

  it('fails loud when a fix mode runs without a caller', async () => {
    const dir = makeRoot()
    const corpus = writeFixtureCorpus(dir, 'nocaller', [
      {
        trajId: 'traj-1',
        steps: failingSteps(),
        goldIncorrectSteps: [3],
        raw: { baseImage: 'example/ok:1', runConfigCwd: '/repo' },
      },
    ])
    await expect(
      runReplayBatch({
        corpora: [corpus],
        out: join(dir, 'out'),
        fix: 'generate',
        preparer: fakePreparer(),
        backendFactory: () => scriptedBackend(() => ({ exitCode: 0, stdout: '', stderr: '' })),
      }),
    ).rejects.toThrow(/requires a fixCaller/)
  })
})
