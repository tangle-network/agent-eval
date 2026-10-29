import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { describe, expect, it } from 'vitest'
import { runSandboxScenario } from '../src/campaign'
import { SandboxHarness, SubprocessSandboxDriver } from '../src/sandbox-harness'
import { TraceEmitter } from '../src/trace/emitter'
import { InMemoryTraceStore } from '../src/trace/store'

describe('sandbox scenario lifecycle over real files and subprocesses', () => {
  it('runs setup, measured steps, conditions and expectations, then retires resources', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-harness-'))
    const marker = join(directory, 'marker')
    try {
      const report = await runSandboxScenario({
        budgetMs: 5_000,
        async setup(scope) {
          await writeFile(marker, 'setup')
          scope.defer(() => rm(marker))
          return { marker }
        },
        steps: [
          {
            name: 'subprocess',
            async run(state) {
              const result = await new SubprocessSandboxDriver().exec(
                'run',
                'printf ready > marker',
                { cwd: directory },
              )
              if (result.exitCode !== 0) throw new Error(result.stderr)
              expect(await readFile(state.marker, 'utf8')).toBe('ready')
            },
            expect: (_state, timing) => [
              { name: 'command', status: timing.success ? 'pass' : 'fail' },
            ],
          },
          {
            name: 'conditional',
            when: () => false,
            async run() {
              throw new Error('condition did not exclude step')
            },
          },
        ],
        expectations: () => [{ name: 'complete', status: 'pass' }],
        metadata: () => ({ transport: 'subprocess' }),
      })
      expect(report).toMatchObject({ pass: true, metadata: { transport: 'subprocess' } })
      expect(report.timings.map((timing) => timing.name)).toEqual(['subprocess', 'cleanup'])
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('retains operation failure and all cleanup attempts after cancellation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-harness-failure-'))
    const marker = join(directory, 'marker')
    const owner = new AbortController()
    try {
      const report = await runSandboxScenario(
        {
          budgetMs: 5_000,
          async setup(scope) {
            await writeFile(marker, 'owned')
            scope.defer(() => rm(marker))
            scope.defer(() => rm(join(directory, 'absent')))
            return undefined
          },
          steps: [
            {
              name: 'cancel',
              async run() {
                owner.abort(new Error('owner cancelled'))
                await delay(1, undefined, { signal: owner.signal })
              },
            },
          ],
        },
        { signal: owner.signal },
      )
      expect(report.pass).toBe(false)
      expect(report.error).toContain('owner cancelled')
      expect(report.timings.map((timing) => timing.success)).toEqual([false, false, true])
      await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('polls actual file state and distinguishes an exhausted read', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'eval-harness-poll-'))
    try {
      const report = await runSandboxScenario({
        budgetMs: 5_000,
        async setup(scope) {
          const missing = await scope.poll(
            () => readFile(join(directory, 'absent')).catch(() => ''),
            Boolean,
            { timeoutMs: 20, intervalMs: 5 },
          )
          expect(missing).toBeUndefined()
          await writeFile(join(directory, 'ready'), 'ready')
          const present = await scope.poll(
            () => readFile(join(directory, 'ready'), 'utf8'),
            (text) => text === 'ready',
            { timeoutMs: 100, intervalMs: 5 },
          )
          scope.check({ name: 'ready', status: present === 'ready' ? 'pass' : 'fail' })
        },
        steps: [],
      })
      expect(report.pass).toBe(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('keeps legacy trace and phase verdicts with the real command driver', async () => {
    const store = new InMemoryTraceStore()
    const emitter = new TraceEmitter(store)
    await emitter.startRun({ scenarioId: 'harness-phases' })
    const harness = new SandboxHarness()
    const failed = await harness.run({ setupCommand: 'exit 7', runCommand: 'exit 0' }, emitter)
    expect(failed).toMatchObject({ passed: false, score: 0, setup: { exitCode: 7 } })
    expect(failed.run).toBeUndefined()
    const timed = await harness.run({ testCommand: 'sleep 5', timeoutMs: 20 }, emitter)
    expect(timed).toMatchObject({ passed: false, score: 0, test: { killedByTimeout: true } })
    const passed = await harness.run(
      { setupCommand: 'true', runCommand: 'true', testCommand: 'true' },
      emitter,
    )
    expect(passed).toMatchObject({ passed: true, score: 1 })
    await emitter.endRun({ pass: true })
  })
})

it('retires an allocated resource when its real readiness read fails', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eval-harness-resource-'))
  const marker = join(directory, 'resource')
  try {
    const report = await runSandboxScenario({
      budgetMs: 5_000,
      setup: (scope) =>
        scope.resource({
          name: 'allocate',
          async create() {
            await writeFile(marker, 'allocated')
            return marker
          },
          ready: () => readFile(join(directory, 'missing-readiness')),
          retire: (path) => rm(path),
        }),
      expectations: ({ resource }) => [
        { name: 'allocation-retained', status: resource === marker ? 'pass' : 'fail' },
      ],
    })
    expect(report.pass).toBe(false)
    expect(report.timings.map((timing) => [timing.name, timing.success])).toEqual([
      ['allocate', false],
      ['cleanup', true],
    ])
    await expect(readFile(marker)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

it('keeps failed diagnostic measurements separate from required expectations', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'eval-harness-diagnostic-'))
  try {
    const report = await runSandboxScenario({
      budgetMs: 5_000,
      setup: async () => undefined,
      steps: [
        { name: 'diagnostic', advisory: true, run: () => readFile(join(directory, 'absent')) },
      ],
      expectations: () => [{ name: 'required', status: 'pass' }],
    })
    expect(report.pass).toBe(true)
    expect(report.timings).toMatchObject([{ name: 'diagnostic', success: false }])
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})
