import { describe, expect, it } from 'vitest'
import { InMemoryTraceStore, TraceEmitter } from '../src/trace'
import {
  composeParsers,
  jestTestParser,
  pytestTestParser,
  SandboxHarness,
  SubprocessSandboxDriver,
  vitestTestParser,
  type HarnessConfig,
  type SandboxDriver,
  type SandboxResult,
} from '../src/sandbox-harness'
import { runTestGradedScenario } from '../src/test-graded-scenario'

class FakeDriver implements SandboxDriver {
  id = 'fake'
  results: Record<string, SandboxResult> = {}
  async exec(phase: SandboxResult['phase'], _cmd: string, _cfg: HarnessConfig): Promise<SandboxResult> {
    return this.results[phase] ?? { phase, exitCode: 0, stdout: '', stderr: '', wallMs: 1 }
  }
}

describe('vitestTestParser', () => {
  it('parses "Tests 5 passed | 1 failed"', () => {
    const r = vitestTestParser.parse('  Tests  5 passed | 1 failed\n  Start at 09:00', '', 1)
    expect(r).toEqual({ testsTotal: 6, testsPassed: 5 })
  })
})

describe('pytestTestParser', () => {
  it('parses collected + passed counts', () => {
    const out = 'collected 10 items\n========= 8 passed, 2 failed in 1.2s ========='
    expect(pytestTestParser.parse(out, '', 1)).toEqual({ testsTotal: 10, testsPassed: 8 })
  })
})

describe('jestTestParser', () => {
  it('parses "Tests: 3 failed, 7 passed, 10 total"', () => {
    expect(jestTestParser.parse('Tests:       3 failed, 7 passed, 10 total', '', 1))
      .toEqual({ testsTotal: 10, testsPassed: 7 })
  })
})

describe('composeParsers — regression: silent misparse lets test-failing runs pass', () => {
  it('tries parsers in order', () => {
    const p = composeParsers(vitestTestParser, pytestTestParser)
    expect(p.parse('collected 5 items\n5 passed', '', 0))
      .toEqual({ testsTotal: 5, testsPassed: 5 })
  })
})

describe('SandboxHarness with FakeDriver', () => {
  it('emits sandbox span + returns test pass ratio', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const driver = new FakeDriver()
    driver.results = {
      setup: { phase: 'setup', exitCode: 0, stdout: '', stderr: '', wallMs: 10 },
      test: { phase: 'test', exitCode: 0, stdout: '', stderr: '', wallMs: 50, testsTotal: 10, testsPassed: 8 },
    }
    const harness = new SandboxHarness(driver)
    const result = await harness.run({ setupCommand: 'noop', testCommand: 'noop' }, e)
    expect(result.score).toBeCloseTo(0.8)
    expect(result.passed).toBe(true)
    const spans = await store.spans({ runId: e.runId, kind: 'sandbox' })
    expect(spans).toHaveLength(1)
    expect(spans[0].name).toBe('sandbox(fake)')
  })

  it('fails the span when setup exits non-zero — regression: downstream was running on an unsetup sandbox', async () => {
    const store = new InMemoryTraceStore()
    const e = new TraceEmitter(store)
    await e.startRun({ scenarioId: 's' })
    const driver = new FakeDriver()
    driver.results = { setup: { phase: 'setup', exitCode: 2, stdout: '', stderr: 'err', wallMs: 5 } }
    const harness = new SandboxHarness(driver)
    const result = await harness.run({ setupCommand: 'noop', testCommand: 'noop' }, e)
    expect(result.passed).toBe(false)
    const spans = await store.spans({ runId: e.runId, kind: 'sandbox' })
    expect(spans[0].status).toBe('error')
  })
})

describe('runTestGradedScenario', () => {
  it('records a Run with proper score and failure class', async () => {
    const store = new InMemoryTraceStore()
    const driver = new FakeDriver()
    driver.results = {
      test: { phase: 'test', exitCode: 0, stdout: '', stderr: '', wallMs: 5, testsTotal: 4, testsPassed: 4 },
    }
    const result = await runTestGradedScenario(
      { id: 'scn-1', harness: { testCommand: 'pnpm test' }, passThreshold: 1 },
      store,
      { driver, variantId: 'v1' },
    )
    expect(result.pass).toBe(true)
    expect(result.score).toBe(1)
    const run = await store.getRun(result.runId)
    expect(run?.status).toBe('completed')
    expect(run?.variantId).toBe('v1')
    expect(run?.outcome?.failureClass).toBe('success')
  })

  it('below-threshold flags failure class format_drift', async () => {
    const store = new InMemoryTraceStore()
    const driver = new FakeDriver()
    driver.results = {
      test: { phase: 'test', exitCode: 1, stdout: '', stderr: '', wallMs: 5, testsTotal: 4, testsPassed: 2 },
    }
    const result = await runTestGradedScenario(
      { id: 'scn-2', harness: { testCommand: 'pnpm test' } },
      store,
      { driver },
    )
    expect(result.pass).toBe(false)
    expect(result.score).toBeCloseTo(0.5)
    const run = await store.getRun(result.runId)
    expect(run?.outcome?.failureClass).toBe('format_drift')
  })
})

describe('SubprocessSandboxDriver', () => {
  it('actually runs shell echo — regression: without real exec, harness is toy', async () => {
    const driver = new SubprocessSandboxDriver()
    const result = await driver.exec('run', 'echo hello', {})
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
  })

  it('constructor defaults.cwd is honored when HarnessConfig.cwd is unset (0.7.1 footgun fix)', async () => {
    // Pre-0.7.1: constructor took no args — `new Driver({cwd})` compiled,
    // silent-dropped the arg, spawn inherited node's cwd. Two shipped bugs
    // traced to this. 0.7.1 honors defaults as fallbacks.
    const { mkdtempSync, realpathSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'driver-default-cwd-')))
    try {
      const driver = new SubprocessSandboxDriver({ cwd: dir })
      const result = await driver.exec('run', 'pwd', {})
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('per-call HarnessConfig.cwd wins over constructor default', async () => {
    const { mkdtempSync, realpathSync, rmSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const defaultDir = realpathSync(mkdtempSync(join(tmpdir(), 'driver-default-cwd-')))
    const callDir = realpathSync(mkdtempSync(join(tmpdir(), 'driver-call-cwd-')))
    try {
      const driver = new SubprocessSandboxDriver({ cwd: defaultDir })
      const result = await driver.exec('run', 'pwd', { cwd: callDir })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe(callDir)
    } finally {
      rmSync(defaultDir, { recursive: true, force: true })
      rmSync(callDir, { recursive: true, force: true })
    }
  })

  it('constructor defaults.env is merged; per-call env wins on conflict', async () => {
    const driver = new SubprocessSandboxDriver({ env: { FROM_DEFAULT: 'd', SHARED: 'default' } })
    // `env | grep` form survives missing vars; `printenv A B C` exits on
    // the first miss and swallows the rest, making the assertion flaky.
    const result = await driver.exec('run', 'env | grep -E "^(FROM_|SHARED=)" | sort', {
      env: { FROM_CALL: 'c', SHARED: 'call' },
    })
    expect(result.exitCode).toBe(0)
    const vars = Object.fromEntries(
      result.stdout.trim().split('\n').map((l) => {
        const eq = l.indexOf('=')
        return [l.slice(0, eq), l.slice(eq + 1)]
      }),
    )
    expect(vars.FROM_DEFAULT).toBe('d')
    expect(vars.FROM_CALL).toBe('c')
    expect(vars.SHARED).toBe('call') // per-call wins over driver default
  })
})
