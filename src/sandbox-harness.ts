import { setTimeout as delay } from 'node:timers/promises'
import { runBoundedProcess } from './bounded-process'

import type { TraceEmitter } from './trace/emitter'
import type { SandboxSpan } from './trace/schema'

export interface HarnessConfig {
  /** Setup command (e.g. "pnpm install"). Non-zero exit fails the run. */
  setupCommand?: string
  /** Run command (e.g. "pnpm build"). */
  runCommand?: string
  /** Test command (e.g. "pnpm test --run"). Drives the test count + pass count. */
  testCommand?: string
  /** Absolute cwd for the subprocess driver. Ignored by docker driver. */
  cwd?: string
  /** Max wall-clock per phase in ms. Default 10 minutes. */
  timeoutMs?: number
  /** Captured stdout + stderr cap, default 16 MiB; excess is dropped. */
  maxOutputBytes?: number
  /** Image for the docker driver. */
  image?: string
  /** Extra env vars (validated; shell-escaped). */
  env?: Record<string, string>
  /** Parser for the test output — maps stdout/stderr/exit code → pass count. */
  testParser?: TestOutputParser
}

export interface TestOutputParser {
  id: string
  parse(
    stdout: string,
    stderr: string,
    exitCode: number,
  ): { testsTotal: number; testsPassed: number } | undefined
}

export interface SandboxResult {
  phase: 'setup' | 'run' | 'test'
  exitCode: number
  stdout: string
  stderr: string
  wallMs: number
  testsTotal?: number
  testsPassed?: number
  /** A timed-out phase always fails, even with exitCode 0. Absent/false means natural exit. */
  killedByTimeout?: boolean
  /** Captured output exceeded maxOutputBytes. */
  outputTruncated?: boolean
}

export interface SandboxDriver {
  id: string
  exec(
    phase: SandboxResult['phase'],
    command: string,
    config: HarnessConfig,
  ): Promise<SandboxResult>
}

interface SubprocessSandboxDriverOptions {
  cwd?: string
  env?: Record<string, string>
}

export class SubprocessSandboxDriver implements SandboxDriver {
  id = 'subprocess'
  constructor(private options: SubprocessSandboxDriverOptions = {}) {}

  async exec(
    phase: SandboxResult['phase'],
    command: string,
    config: HarnessConfig,
  ): Promise<SandboxResult> {
    const effectiveCwd = config.cwd ?? this.options.cwd
    const effectiveEnv = { ...process.env, ...(this.options.env ?? {}), ...(config.env ?? {}) }
    const result = await runBoundedProcess({
      command,
      shell: true,
      cwd: effectiveCwd,
      env: effectiveEnv,
      envMode: 'replace',
      timeoutMs: config.timeoutMs ?? 10 * 60_000,
      maxOutputBytes: config.maxOutputBytes ?? 16 * 1024 * 1024,
    })
    // A timed-out phase never reaches the parser: the output of a killed
    // process is a fragment, and a fragment that happens to parse would
    // report a pass for a run that never finished.
    const parsed =
      !result.killedByTimeout && phase === 'test' && config.testParser
        ? config.testParser.parse(result.stdout, result.stderr, result.exitCode)
        : undefined
    return {
      phase,
      exitCode: result.exitCode,
      stdout: result.stdout,
      stderr: result.runnerError ? result.stderr + result.runnerError : result.stderr,
      wallMs: result.wallMs,
      testsTotal: parsed?.testsTotal,
      testsPassed: parsed?.testsPassed,
      killedByTimeout: result.killedByTimeout || undefined,
      outputTruncated: result.outputTruncated || undefined,
    }
  }
}

// ── Harness orchestration ────────────────────────────────────────────

export interface SandboxHarnessResult {
  passed: boolean
  setup?: SandboxResult
  run?: SandboxResult
  test?: SandboxResult
  totalWallMs: number
  /** Final score — 0 when no tests; otherwise testsPassed/testsTotal. */
  score: number
}

export class SandboxHarness {
  constructor(private driver: SandboxDriver = new SubprocessSandboxDriver()) {}

  async run(config: HarnessConfig, emitter: TraceEmitter): Promise<SandboxHarnessResult> {
    const handle = await emitter.sandbox({
      name: `sandbox(${this.driver.id})`,
      image: config.image,
      command: [config.setupCommand, config.runCommand, config.testCommand]
        .filter(Boolean)
        .join(' && '),
    })
    const result: SandboxHarnessResult = { passed: false, totalWallMs: 0, score: 0 }
    try {
      for (const phase of ['setup', 'run', 'test'] as const) {
        const command = config[`${phase}Command`]
        if (!command) continue
        const measured = await this.driver.exec(phase, command, config)
        result[phase] = measured
        result.totalWallMs += measured.wallMs
        const passed = !measured.killedByTimeout && measured.exitCode === 0
        if (phase !== 'test' && !passed) {
          await handle.fail(
            measured.killedByTimeout
              ? `${phase} timed out after ${measured.wallMs}ms`
              : `${phase} failed (exit ${measured.exitCode})`,
            {
              exitCode: measured.exitCode,
              wallMs: result.totalWallMs,
            } as Partial<SandboxSpan>,
          )
          return result
        }
      }
      const test = result.test
      result.passed = !test || (!test.killedByTimeout && test.exitCode === 0)
      result.score =
        test?.testsTotal !== undefined && test.testsTotal > 0
          ? (test.testsPassed ?? 0) / test.testsTotal
          : result.passed
            ? 1
            : 0
      await handle.end({
        ...(test
          ? {
              exitCode: test.exitCode,
              testsTotal: test.testsTotal,
              testsPassed: test.testsPassed,
              status: result.passed ? 'ok' : 'error',
            }
          : {}),
        wallMs: result.totalWallMs,
      } as Partial<SandboxSpan>)
    } catch (err) {
      await handle.fail(err instanceof Error ? err : String(err))
      throw err
    }
    return result
  }
}

/** Portable integration report; products may retain extra timing and assertion fields. */
export interface HarnessAssertion {
  name: string
  status: 'pass' | 'fail' | 'skip'
  expected?: string
  actual?: string
  message?: string
  soft?: boolean
}
export interface HarnessTiming {
  name: string
  durationMs: number
  success: boolean
  error?: string
}
export interface HarnessReport {
  pass: boolean
  assertions: HarnessAssertion[]
  timings: HarnessTiming[]
  error?: string
  metadata?: Record<string, unknown>
}
export interface HarnessScope {
  signal: AbortSignal
  check(...assertions: HarnessAssertion[]): void
  measure(name: string, run: () => Promise<unknown>): Promise<HarnessTiming>
  /** Register retirement immediately after allocation; cleanup ignores workload cancellation. */
  defer(retire: () => Promise<unknown>): void
  poll<T>(
    read: () => Promise<T>,
    ready: (value: T) => boolean,
    budget: { timeoutMs: number; intervalMs: number },
  ): Promise<T | undefined>
}
export interface HarnessScenario<T> {
  setup(scope: HarnessScope): Promise<T>
  steps: ReadonlyArray<{
    name: string
    when?: (state: T) => boolean
    run(state: T, scope: HarnessScope): Promise<unknown>
    expect?: (state: T, timing: HarnessTiming) => HarnessAssertion[]
  }>
  expectations?: (state: T) => HarnessAssertion[]
  metadata?: (state: T) => Record<string, unknown>
  /** Includes setup and steps. Transports must honor scope.signal. */
  budgetMs: number
}

/** Campaigns own whole-scenario retries; polling only repeats the declared read. */
export async function runSandboxScenario<T>(
  spec: HarnessScenario<T>,
  options: {
    signal?: AbortSignal
    measure?: HarnessScope['measure']
  } = {},
): Promise<HarnessReport> {
  if (!(spec.budgetMs > 0 && Number.isFinite(spec.budgetMs)))
    throw new Error('Scenario budgetMs must be positive and finite')
  const signal = AbortSignal.any([
    AbortSignal.timeout(spec.budgetMs),
    ...(options.signal ? [options.signal] : []),
  ])
  const report: HarnessReport = { pass: false, assertions: [], timings: [] }
  const retirements: Array<() => Promise<unknown>> = []
  const scope: HarnessScope = {
    signal,
    check: (...assertions) => {
      report.assertions.push(...assertions)
    },
    defer: (retire) => {
      retirements.push(retire)
    },
    async measure(name, run) {
      const start = performance.now()
      let measured: HarnessTiming = { name, durationMs: 0, success: true }
      try {
        if (options.measure) measured = await options.measure(name, run)
        else {
          const result = (await run()) as { success?: boolean; error?: string } | undefined
          if (result?.success === false)
            throw new Error(result.error ?? 'measured operation returned success=false')
          measured.durationMs = Math.round(performance.now() - start)
        }
      } catch (error) {
        measured = {
          name,
          durationMs: Math.round(performance.now() - start),
          success: false,
          error: error instanceof Error ? error.message : String(error),
        }
      }
      report.timings.push(measured)
      return measured
    },
    async poll(read, ready, budget) {
      if (!(budget.timeoutMs > 0 && budget.intervalMs > 0))
        throw new Error('Polling timeout and interval must be positive')
      const deadline = performance.now() + budget.timeoutMs
      while (performance.now() < deadline) {
        signal.throwIfAborted()
        const value = await read()
        if (ready(value)) return value
        await delay(
          Math.min(budget.intervalMs, Math.max(0, deadline - performance.now())),
          undefined,
          { signal },
        )
      }
      return undefined
    },
  }
  try {
    signal.throwIfAborted()
    const state = await spec.setup(scope)
    for (const step of spec.steps) {
      signal.throwIfAborted()
      if (step.when && !step.when(state)) continue
      const timing = await scope.measure(step.name, () => step.run(state, scope))
      scope.check(...(step.expect?.(state, timing) ?? []))
    }
    signal.throwIfAborted()
    scope.check(...(spec.expectations?.(state) ?? []))
    report.metadata = spec.metadata?.(state)
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error)
  } finally {
    for (const retire of retirements.reverse()) {
      const measured = await scope.measure('cleanup', retire)
      if (!measured.success)
        scope.check({ name: 'cleanup', status: 'fail', message: measured.error })
    }
  }
  report.pass =
    !report.error &&
    report.timings.every((t) => t.success) &&
    report.assertions.every((a) => a.soft || a.status === 'pass')
  return report
}
