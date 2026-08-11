import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { InMemoryTraceStore } from '../../src/trace/store'
import { buildTrajectory } from '../../src/trajectory'
import { wrapActionForExec } from '../../src/trajectory-replay/exec'
import {
  deriveFailureSignature,
  parseObservationOutput,
  parseRecordedReturncode,
  type RecordedTrajectoryStep,
} from '../../src/trajectory-replay/steps'
import {
  classifyPrefixStep,
  ingestRecordedTrajectory,
  PREFIX_DIVERGENCE_TOLERANCE_PCT,
  replayVerify,
  summarizePrefixReplay,
} from '../../src/trajectory-replay/verify'
import {
  fixtureStep,
  fixtureStepUnrecordedReturncode,
  scriptedBackend,
  wrappedPayload,
} from './fixtures'

const step = fixtureStep

describe('observation parsing', () => {
  it('extracts the recorded returncode', () => {
    expect(parseRecordedReturncode('\n<returncode>2</returncode>\n<output>\nx\n</output>')).toBe(2)
    expect(parseRecordedReturncode('\n<returncode>-1</returncode>\n<output>\n</output>')).toBe(-1)
  })

  it('parses the negative returncodes a signal kill records', () => {
    expect(parseRecordedReturncode('<returncode>-15</returncode>')).toBe(-15)
    expect(parseRecordedReturncode('<returncode>-9</returncode>')).toBe(-9)
  })

  it('returns null when the observation has no returncode tag', () => {
    expect(parseRecordedReturncode(null)).toBeNull()
    expect(parseRecordedReturncode('plain text')).toBeNull()
  })

  it('extracts output between tags and falls back to the raw string', () => {
    expect(parseObservationOutput('<output>\nhello\n</output>')).toBe('hello')
    expect(parseObservationOutput('raw')).toBe('raw')
    expect(parseObservationOutput(null)).toBe('')
  })

  it('derives the first error line as the failure signature', () => {
    const obs = `<output>\ncc -c x.c\nx.c:5:1: warning: unused\nx.c:9:2: error: 'y' undeclared\nnote: reported once\n</output>`
    expect(deriveFailureSignature(obs)).toBe("x.c:9:2: error: 'y' undeclared")
  })

  it('returns null signature when no error line exists', () => {
    expect(deriveFailureSignature('<output>\nall fine\n</output>')).toBeNull()
  })
})

describe('wrapActionForExec', () => {
  it('pins mini-SWE semantics: cd to the workdir, pipe the action into sh', () => {
    const wrapped = wrapActionForExec(`echo "a && b" | grep a`, '/home')
    expect(wrapped.startsWith(`cd '/home' && printf %s `)).toBe(true)
    expect(wrapped.endsWith(' | base64 -d | sh')).toBe(true)
    expect(wrappedPayload(wrapped)).toBe(`echo "a && b" | grep a`)
  })

  it('quotes workdirs with single quotes safely', () => {
    expect(wrapActionForExec('pwd', "/tmp/it's")).toContain(`cd '/tmp/it'\\''s' &&`)
  })
})

describe('prefix step classification', () => {
  it('confirms a step only when the recorded returncode equals the replayed exit', () => {
    expect(classifyPrefixStep(1, 0, 0)).toBeNull()
    expect(classifyPrefixStep(1, 127, 127)).toBeNull()
    expect(classifyPrefixStep(1, -15, -15)).toBeNull()
  })

  it('classifies a differing exit as a returncode mismatch', () => {
    expect(classifyPrefixStep(4, 0, 127)).toEqual({
      step: 4,
      kind: 'returncode-mismatch',
      expectedReturncode: 0,
      actualExit: 127,
    })
  })

  it('classifies an unrecorded returncode as unknown-expectation, never agreement', () => {
    expect(classifyPrefixStep(7, null, 127)).toEqual({
      step: 7,
      kind: 'unknown-expectation',
      expectedReturncode: null,
      actualExit: 127,
    })
    // Exit 0 is no better: nothing was checked against, so nothing is confirmed.
    expect(classifyPrefixStep(7, null, 0)).toMatchObject({ kind: 'unknown-expectation' })
  })
})

describe('summarizePrefixReplay', () => {
  it('counts both kinds toward the rate and reports each separately', () => {
    const summary = summarizePrefixReplay(
      10,
      [
        classifyPrefixStep(1, 0, 1)!,
        classifyPrefixStep(2, null, 127)!,
        classifyPrefixStep(3, null, 127)!,
      ],
      42,
    )
    expect(summary).toMatchObject({
      prefixExecuted: 10,
      prefixConfirmed: 7,
      prefixReturncodeMismatches: 1,
      prefixUnknownExpectations: 2,
      prefixDivergencePct: 30,
      prefixWithinTolerance: false,
      wallMs: 42,
    })
  })

  it('holds a replay at the tolerance boundary inside it', () => {
    const oneInTen = summarizePrefixReplay(10, [classifyPrefixStep(1, null, 127)!], 0)
    expect(oneInTen.prefixDivergencePct).toBe(PREFIX_DIVERGENCE_TOLERANCE_PCT)
    expect(oneInTen.prefixWithinTolerance).toBe(true)
    const twoInTen = summarizePrefixReplay(
      10,
      [classifyPrefixStep(1, null, 127)!, classifyPrefixStep(2, null, 127)!],
      0,
    )
    expect(twoInTen.prefixWithinTolerance).toBe(false)
  })

  it('reports an empty prefix as zero divergence, not as a divide by zero', () => {
    const empty = summarizePrefixReplay(0, [], 0)
    expect(empty.prefixDivergencePct).toBe(0)
    expect(empty.prefixConfirmed).toBe(0)
    expect(empty.prefixWithinTolerance).toBe(true)
  })

  it('fails loud when more steps diverged than executed', () => {
    expect(() =>
      summarizePrefixReplay(1, [classifyPrefixStep(1, 0, 1)!, classifyPrefixStep(2, 0, 1)!], 0),
    ).toThrow(/2 divergences over 1 executed prefix steps/)
  })
})

describe('ingestRecordedTrajectory', () => {
  it('emits one ordered tool span per step with command and returncode', async () => {
    const store = new InMemoryTraceStore()
    const steps = [step(1, 'ls', 0), step(2, 'make', 2, 'boom'), step(3, 'echo done', null)]
    const { runId, stepCount } = await ingestRecordedTrajectory(store, steps, 'case-x')
    expect(stepCount).toBe(3)
    const trajectory = await buildTrajectory(store, runId)
    expect(trajectory.toolCalls).toBe(3)
    expect(trajectory.steps.map((s) => s.span.name)).toEqual(['step:1', 'step:2', 'step:3'])
    const second = trajectory.steps[1]!.span as {
      args: { command: string }
      result: { returncode: number | null }
    }
    expect(second.args.command).toBe('make')
    expect(second.result.returncode).toBe(2)
  })

  it('fails loud on a step without an action', async () => {
    const store = new InMemoryTraceStore()
    await expect(ingestRecordedTrajectory(store, [step(1, '', 0)], 'case-x')).rejects.toThrow(
      /step 1 has no action/,
    )
  })
})

describe('replayVerify', () => {
  let outDir: string
  afterEach(() => {
    if (outDir) rmSync(outDir, { recursive: true, force: true })
  })

  function writeSteps(steps: RecordedTrajectoryStep[]): string {
    outDir = mkdtempSync(join(tmpdir(), 'trajectory-replay-test-'))
    const path = join(outDir, 'steps.json')
    writeFileSync(path, JSON.stringify(steps))
    return path
  }

  const failingSteps = [
    step(1, 'ls', 0, 'files'),
    step(2, 'sed -i broken file.c', 0),
    step(3, 'make target', 2, 'file.c:9:2: error: broken build\nstopped'),
    step(4, 'echo unreachable-for-replay', 0),
  ]

  it('arm A reproduces the failure and arm B shows it vanish, each in a fresh session', async () => {
    const stepsPath = writeSteps(failingSteps)
    const backend = scriptedBackend((action) => {
      if (action === 'make target') {
        return { exitCode: 2, stdout: 'stopped', stderr: 'file.c:9:2: error: broken build' }
      }
      if (action === 'fix file.c && make target') {
        return { exitCode: 0, stdout: 'built ok', stderr: '' }
      }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const verdict = await replayVerify({
      stepsPath,
      image: 'example/image:tag',
      at: 3,
      fixCommand: 'fix file.c && make target',
      cwd: '/home',
      out: join(outDir, 'out'),
      backend,
    })
    expect(verdict.k).toBe(3)
    expect(verdict.recordedReturncode).toBe(2)
    expect(verdict.signature).toBe('file.c:9:2: error: broken build')
    expect(verdict.prefixExecuted).toBe(2)
    expect(verdict.prefixDivergences).toEqual([])
    expect(verdict.armA.exitCode).toBe(2)
    expect(verdict.armA.failureSignatureMatch).toBe(true)
    expect(verdict.armB?.exitCode).toBe(0)
    expect(verdict.armB?.failureVanished).toBe(true)
    // The verdict lands in the shared spine, certified as a replication
    // from the pinned image with nothing left unverified.
    expect(verdict.valid).toBe(true)
    expect(verdict.score).toBe(1)
    expect(verdict.scores).toEqual({
      prefixFidelity: 1,
      armAReproduced: 1,
      armBFailureVanished: 1,
    })
    expect(verdict.certification?.strategy).toBe('replication')
    expect(verdict.certification?.checker.name).toBe('agent-eval:trajectory-replay')
    expect(verdict.certification?.checker.pins).toEqual({ image: 'example/image:tag' })
    expect(verdict.certification?.assumptions).toEqual([])
    expect(verdict.certification?.evidenceDigest).toMatch(/^[0-9a-f]{64}$/)
    // Each arm replayed the prefix in its own session: [prefix..., stepK].
    expect(backend.executed).toEqual([
      ['ls', 'sed -i broken file.c', 'make target'],
      ['ls', 'sed -i broken file.c', 'fix file.c && make target'],
    ])
    const onDisk = JSON.parse(readFileSync(join(outDir, 'out', 'replay-verdict.json'), 'utf8'))
    expect(onDisk.armA.failureSignatureMatch).toBe(true)
    const report = readFileSync(join(outDir, 'out', 'report.md'), 'utf8')
    expect(report).toContain('failureVanished: **true**')
  })

  it('records prefix divergences honestly and keeps replaying', async () => {
    const stepsPath = writeSteps(failingSteps)
    const backend = scriptedBackend((action) => {
      if (action === 'ls') return { exitCode: 1, stdout: '', stderr: 'diverged' }
      if (action === 'make target') return { exitCode: 0, stdout: 'unexpectedly fine', stderr: '' }
      return { exitCode: 0, stdout: '', stderr: '' }
    })
    const verdict = await replayVerify({
      stepsPath,
      image: 'example/image:tag',
      at: 3,
      cwd: '/home',
      out: join(outDir, 'out'),
      backend,
    })
    expect(verdict.prefixDivergences).toEqual([
      { step: 1, kind: 'returncode-mismatch', expectedReturncode: 0, actualExit: 1 },
    ])
    expect(verdict.prefixConfirmed).toBe(1)
    expect(verdict.prefixReturncodeMismatches).toBe(1)
    expect(verdict.prefixUnknownExpectations).toBe(0)
    expect(verdict.prefixDivergencePct).toBe(50)
    expect(verdict.prefixWithinTolerance).toBe(false)
    // Recorded rc=2 but replay exited 0 → the failure did NOT reproduce.
    expect(verdict.armA.failureSignatureMatch).toBe(false)
    expect(verdict.armB).toBeNull()
    expect(verdict.valid).toBe(false)
    expect(verdict.score).toBe(0)
  })

  it('counts a prefix the recording cannot adjudicate as divergent, not as agreement', async () => {
    // Every prefix step replays as exit 127 (command not found) while its
    // recording carries no returncode. Arm A still reproduces the recorded
    // failure at k, so nothing but the prefix classification separates this
    // from a faithful replay.
    const stepsPath = writeSteps([
      fixtureStepUnrecordedReturncode(1, 'ls', 'files'),
      fixtureStepUnrecordedReturncode(2, 'sed -i broken file.c'),
      fixtureStepUnrecordedReturncode(3, 'cat file.c'),
      step(4, 'make target', 2, 'file.c:9:2: error: broken build\nstopped'),
    ])
    const backend = scriptedBackend((action) =>
      action === 'make target'
        ? { exitCode: 2, stdout: 'stopped', stderr: 'file.c:9:2: error: broken build' }
        : { exitCode: 127, stdout: '', stderr: 'sh: 1: not found' },
    )
    const verdict = await replayVerify({
      stepsPath,
      image: 'example/image:tag',
      at: 4,
      cwd: '/home',
      out: join(outDir, 'out'),
      backend,
    })
    expect(verdict.prefixExecuted).toBe(3)
    expect(verdict.prefixDivergences).toEqual([
      { step: 1, kind: 'unknown-expectation', expectedReturncode: null, actualExit: 127 },
      { step: 2, kind: 'unknown-expectation', expectedReturncode: null, actualExit: 127 },
      { step: 3, kind: 'unknown-expectation', expectedReturncode: null, actualExit: 127 },
    ])
    expect(verdict.prefixConfirmed).toBe(0)
    expect(verdict.prefixUnknownExpectations).toBe(3)
    expect(verdict.prefixReturncodeMismatches).toBe(0)
    expect(verdict.prefixDivergencePct).toBe(100)
    expect(verdict.prefixWithinTolerance).toBe(false)
    // Arm A reproduced; the verdict is still unusable because its prefix state is not the recorded one.
    expect(verdict.armA.failureSignatureMatch).toBe(true)
    expect(verdict.valid).toBe(false)
    // The certificate names the steps the recording could not adjudicate.
    expect(verdict.certification?.assumptions).toEqual([
      '3 prefix step(s) carry no recorded returncode — agreement with the recording is unestablished there',
    ])
    const report = readFileSync(join(outDir, 'out', 'report.md'), 'utf8')
    expect(report).toContain('3 with no recorded returncode to check')
    expect(report).toContain('| 1 | unknown-expectation | none recorded | 127 |')
    expect(report).toContain(
      `Within the ${PREFIX_DIVERGENCE_TOLERANCE_PCT}% admission tolerance: **false**`,
    )
  })

  it('rejects an out-of-range or misaligned step index', async () => {
    const stepsPath = writeSteps(failingSteps)
    await expect(
      replayVerify({
        stepsPath,
        image: 'i',
        at: 99,
        cwd: '/home',
        out: join(outDir, 'out'),
        backend: scriptedBackend(() => ({ exitCode: 0, stdout: '', stderr: '' })),
      }),
    ).rejects.toThrow(/out of range/)
    const misaligned = writeSteps([step(1, 'ls', 0), step(7, 'make', 2)])
    await expect(
      replayVerify({
        stepsPath: misaligned,
        image: 'i',
        at: 2,
        cwd: '/home',
        out: join(outDir, 'out'),
        backend: scriptedBackend(() => ({ exitCode: 0, stdout: '', stderr: '' })),
      }),
    ).rejects.toThrow(/contiguous step_ids/)
  })

  it('honors prefixLimit and reports the truncated count', async () => {
    const stepsPath = writeSteps(failingSteps)
    const backend = scriptedBackend((action) =>
      action === 'make target'
        ? { exitCode: 2, stdout: '', stderr: 'file.c:9:2: error: broken build' }
        : { exitCode: 0, stdout: '', stderr: '' },
    )
    const verdict = await replayVerify({
      stepsPath,
      image: 'i',
      at: 3,
      cwd: '/home',
      out: join(outDir, 'out'),
      prefixLimit: 1,
      backend,
    })
    expect(verdict.prefixExecuted).toBe(1)
    expect(backend.executed[0]).toEqual(['ls', 'make target'])
  })
})
