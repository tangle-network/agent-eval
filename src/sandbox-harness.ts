/**
 * SandboxHarness — executes a scenario in an isolated environment and
 * emits a rich SandboxSpan into the trace.
 *
 * Two built-in drivers:
 *   - `SubprocessSandboxDriver` — spawn in a local cwd with env vars.
 *     Fast, no dependencies, fine for unit tests and most CI gates.
 *   - `DockerSandboxDriver` — lifted from tangle-router's sandbox path;
 *     shells out to `docker run`. Stronger isolation, slower startup.
 *
 * Consumers implement `SandboxDriver` for custom backends (Firecracker,
 * Cloudflare sandbox product, etc.). The harness doesn't care which.
 */

import { ConfigError } from './errors'
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
  /**
   * Cap on captured stdout+stderr bytes per phase. A runaway process can
   * otherwise grow the in-memory buffer without bound. Once hit, further
   * output is dropped and `outputTruncated` is set. Default 16 MiB.
   */
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
  /**
   * True when the process was killed because it exceeded `timeoutMs`. A
   * SIGKILLed child can still close with exit code 0; callers MUST treat
   * a timed-out phase as a hard failure regardless of `exitCode`, never
   * as a pass. `undefined`/`false` means the process completed on its own.
   */
  killedByTimeout?: boolean
  /**
   * True when captured stdout/stderr hit `maxOutputBytes` and further
   * output was dropped. The result is still returned (the process was
   * not killed for this), but downstream parsers see truncated text.
   */
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

// ── Parsers ──────────────────────────────────────────────────────────

/** Vitest default summary line: "Tests  X passed | Y failed". */
export const vitestTestParser: TestOutputParser = {
  id: 'vitest',
  parse(stdout) {
    const m = stdout.match(/Tests\s+(\d+)\s+(passed|failed)(?:\s*\|\s*(\d+)\s+(passed|failed))?/i)
    if (!m) return undefined
    let passed = 0
    let failed = 0
    const a = parseInt(m[1]!, 10)
    const aLabel = m[2]!.toLowerCase()
    if (aLabel === 'passed') passed += a
    else failed += a
    if (m[3] && m[4]) {
      const b = parseInt(m[3], 10)
      if (m[4].toLowerCase() === 'passed') passed += b
      else failed += b
    }
    return { testsTotal: passed + failed, testsPassed: passed }
  },
}

/** Pytest default: "collected N items" + " X passed, Y failed". */
export const pytestTestParser: TestOutputParser = {
  id: 'pytest',
  parse(stdout) {
    const total = stdout.match(/collected\s+(\d+)\s+items?/i)
    const passed = stdout.match(/(\d+)\s+passed/)
    if (!total || !passed) return undefined
    return { testsTotal: parseInt(total[1]!, 10), testsPassed: parseInt(passed[1]!, 10) }
  },
}

/** Jest: "Tests: X passed, Y total" (and optional failed). */
export const jestTestParser: TestOutputParser = {
  id: 'jest',
  parse(stdout) {
    const m = stdout.match(/Tests:\s+(?:(\d+)\s+failed[^,]*,\s*)?(\d+)\s+passed,\s+(\d+)\s+total/i)
    if (!m) return undefined
    return { testsTotal: parseInt(m[3]!, 10), testsPassed: parseInt(m[2]!, 10) }
  },
}

/** Composite parser — tries a list of parsers in order. */
export function composeParsers(...parsers: TestOutputParser[]): TestOutputParser {
  return {
    id: parsers.map((p) => p.id).join('|'),
    parse(stdout, stderr, exitCode) {
      for (const p of parsers) {
        const res = p.parse(stdout, stderr, exitCode)
        if (res) return res
      }
      return undefined
    },
  }
}

// ── Drivers ──────────────────────────────────────────────────────────

export interface SubprocessSandboxDriverOptions {
  /**
   * Default cwd for all `exec` calls. Used when the per-call `HarnessConfig`
   * does not set its own `cwd`. Lets callers bind the driver to a working
   * directory once instead of spreading cwd into every harness config —
   * useful when the harness config is constructed far from the call site
   * (e.g. starter-foundry's promoter passes a static HarnessConfig per
   * family taxonomy but needs a per-run composed-scaffold cwd).
   */
  cwd?: string
  /**
   * Default env merged into every `exec` call's env (per-call `HarnessConfig.env`
   * still wins on key collision). Same ergonomic rationale as `cwd` above.
   */
  env?: Record<string, string>
}

export class SubprocessSandboxDriver implements SandboxDriver {
  id = 'subprocess'
  private defaultCwd?: string
  private defaultEnv?: Record<string, string>

  constructor(options: SubprocessSandboxDriverOptions = {}) {
    this.defaultCwd = options.cwd
    this.defaultEnv = options.env
  }

  async exec(
    phase: SandboxResult['phase'],
    command: string,
    config: HarnessConfig,
  ): Promise<SandboxResult> {
    const { spawn } = await import('node:child_process')
    const start = Date.now()
    // Per-call config wins; fall back to constructor defaults. Honoring
    // the constructor `cwd` keeps the subprocess from inheriting Node's
    // cwd when only the constructor arg is supplied.
    const effectiveCwd = config.cwd ?? this.defaultCwd
    const effectiveEnv = { ...process.env, ...(this.defaultEnv ?? {}), ...(config.env ?? {}) }
    const maxOutputBytes = config.maxOutputBytes ?? 16 * 1024 * 1024
    return await new Promise<SandboxResult>((resolve) => {
      const child = spawn(command, {
        shell: true,
        cwd: effectiveCwd,
        env: effectiveEnv,
        // Own process group so a timeout can SIGKILL the whole tree, not
        // just the shell — otherwise a runaway grandchild keeps the pipes
        // open and `close` never fires (the timeout silently does nothing).
        detached: process.platform !== 'win32',
      })
      let stdout = ''
      let stderr = ''
      let outputBytes = 0
      let outputTruncated = false
      let killedByTimeout = false
      let settled = false

      const onStdout = (d: unknown) => {
        const chunk = capture(String(d))
        if (chunk) stdout += chunk
      }
      const onStderr = (d: unknown) => {
        const chunk = capture(String(d))
        if (chunk) stderr += chunk
      }
      // Bound the in-memory buffer so a runaway process can't OOM the
      // harness. Once the cap is hit we keep draining the streams (to let
      // the child reach `close`) but discard the bytes.
      function capture(s: string): string {
        if (outputBytes >= maxOutputBytes) {
          outputTruncated = true
          return ''
        }
        const room = maxOutputBytes - outputBytes
        if (s.length > room) {
          outputBytes = maxOutputBytes
          outputTruncated = true
          return s.slice(0, room)
        }
        outputBytes += s.length
        return s
      }

      child.stdout?.on('data', onStdout)
      child.stderr?.on('data', onStderr)

      const cleanup = () => {
        clearTimeout(timeout)
        if (forceResolve) clearTimeout(forceResolve)
        child.stdout?.off('data', onStdout)
        child.stderr?.off('data', onStderr)
        child.removeAllListeners('close')
        child.removeAllListeners('error')
      }

      // Resolve exactly once. `code`/`signal` come from `close`; on the
      // timeout path we force a non-zero exit so a SIGKILLed child that
      // reports exit 0 can never read as a clean pass downstream.
      const finish = (outcome: { code: number | null; runnerError?: string }) => {
        if (settled) return
        settled = true
        cleanup()
        const wallMs = Date.now() - start
        const exitCode = killedByTimeout
          ? outcome.code && outcome.code !== 0
            ? outcome.code
            : 124
          : (outcome.code ?? 1)
        const parsed =
          !killedByTimeout && phase === 'test' && config.testParser
            ? config.testParser.parse(stdout, stderr, exitCode)
            : undefined
        resolve({
          phase,
          exitCode,
          stdout,
          stderr: outcome.runnerError ? stderr + outcome.runnerError : stderr,
          wallMs,
          testsTotal: parsed?.testsTotal,
          testsPassed: parsed?.testsPassed,
          killedByTimeout: killedByTimeout || undefined,
          outputTruncated: outputTruncated || undefined,
        })
      }

      // Kill the whole process group on win32-less platforms (we spawned
      // detached). On a clean close this is a no-op.
      const killTree = () => {
        try {
          if (process.platform !== 'win32' && typeof child.pid === 'number') {
            process.kill(-child.pid, 'SIGKILL')
          } else {
            child.kill('SIGKILL')
          }
        } catch (err) {
          console.warn('[sandbox-harness] SIGKILL on timeout failed:', err)
        }
      }

      let forceResolve: ReturnType<typeof setTimeout> | undefined
      const timeout = setTimeout(
        () => {
          killedByTimeout = true
          killTree()
          // Give `close` a brief window to fire (flushing any final output)
          // after the group dies; if an orphaned grandchild keeps the pipes
          // open, force-resolve so the harness can't hang on a runaway.
          forceResolve = setTimeout(() => finish({ code: null }), 2000)
        },
        config.timeoutMs ?? 10 * 60_000,
      )

      child.on('close', (code) => {
        if (forceResolve) clearTimeout(forceResolve)
        finish({ code })
      })
      child.on('error', (err) => {
        if (forceResolve) clearTimeout(forceResolve)
        finish({ code: 127, runnerError: String(err) })
      })
    })
  }
}

export class DockerSandboxDriver implements SandboxDriver {
  id = 'docker'

  async exec(
    phase: SandboxResult['phase'],
    command: string,
    config: HarnessConfig,
  ): Promise<SandboxResult> {
    if (!config.image) throw new ConfigError('DockerSandboxDriver requires config.image')
    const sub = new SubprocessSandboxDriver()
    const envArgs = Object.entries(config.env ?? {})
      .map(([k, v]) => `-e ${shellQuote(k)}=${shellQuote(v)}`)
      .join(' ')
    const wrapped = `docker run --rm ${envArgs} ${shellQuote(config.image)} sh -c ${shellQuote(command)}`
    return sub.exec(phase, wrapped, { ...config, env: undefined })
  }
}

function shellQuote(v: string): string {
  if (/^[A-Za-z0-9_\-/.@:=]+$/.test(v)) return v
  return `'${v.replace(/'/g, `'\\''`)}'`
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
  private driver: SandboxDriver
  constructor(driver: SandboxDriver = new SubprocessSandboxDriver()) {
    this.driver = driver
  }

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
      if (config.setupCommand) {
        result.setup = await this.driver.exec('setup', config.setupCommand, config)
        result.totalWallMs += result.setup.wallMs
        if (result.setup.killedByTimeout || result.setup.exitCode !== 0) {
          const reason = result.setup.killedByTimeout
            ? `setup timed out after ${result.setup.wallMs}ms`
            : `setup failed (exit ${result.setup.exitCode})`
          await handle.fail(reason, {
            exitCode: result.setup.exitCode,
            wallMs: result.totalWallMs,
          } as Partial<SandboxSpan>)
          return result
        }
      }
      if (config.runCommand) {
        result.run = await this.driver.exec('run', config.runCommand, config)
        result.totalWallMs += result.run.wallMs
        if (result.run.killedByTimeout || result.run.exitCode !== 0) {
          const reason = result.run.killedByTimeout
            ? `run timed out after ${result.run.wallMs}ms`
            : `run failed (exit ${result.run.exitCode})`
          await handle.fail(reason, {
            exitCode: result.run.exitCode,
            wallMs: result.totalWallMs,
          } as Partial<SandboxSpan>)
          return result
        }
      }
      if (config.testCommand) {
        result.test = await this.driver.exec('test', config.testCommand, config)
        result.totalWallMs += result.test.wallMs
        // A timed-out test phase is a hard fail regardless of the exit code
        // a SIGKILLed child happens to report — never let it score as a pass.
        const passed = !result.test.killedByTimeout && result.test.exitCode === 0
        result.passed = passed
        if (result.test.testsTotal !== undefined && result.test.testsTotal > 0) {
          result.score = (result.test.testsPassed ?? 0) / result.test.testsTotal
        } else {
          result.score = passed ? 1 : 0
        }
        await handle.end({
          exitCode: result.test.exitCode,
          testsTotal: result.test.testsTotal,
          testsPassed: result.test.testsPassed,
          wallMs: result.totalWallMs,
          status: passed ? 'ok' : 'error',
        } as Partial<SandboxSpan>)
      } else {
        result.passed = true
        result.score = 1
        await handle.end({ wallMs: result.totalWallMs } as Partial<SandboxSpan>)
      }
    } catch (err) {
      await handle.fail(err instanceof Error ? err : String(err))
      throw err
    }
    return result
  }
}
