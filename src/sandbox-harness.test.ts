import { describe, expect, it } from 'vitest'
import {
  type HarnessConfig,
  type SandboxDriver,
  SandboxHarness,
  type SandboxResult,
  SubprocessSandboxDriver,
  vitestTestParser,
} from './sandbox-harness'
import type { TraceEmitter } from './trace/emitter'

// Minimal trace emitter stub — the harness only needs `sandbox()` and the
// returned handle's `end`/`fail`. None of the regression behaviour depends
// on the trace payload, so we record nothing.
function stubEmitter(): TraceEmitter {
  const handle = {
    async end() {},
    async fail() {},
  }
  return {
    async sandbox() {
      return handle as never
    },
  } as unknown as TraceEmitter
}

describe('SubprocessSandboxDriver timeout handling', () => {
  it('flags killedByTimeout and forces non-zero exit when a phase overruns', async () => {
    const driver = new SubprocessSandboxDriver()
    // A process that outlives the timeout. The driver must mark the
    // result as timed out — NOT resolve it as a clean close.
    const res = await driver.exec('test', 'sleep 5', {
      timeoutMs: 150,
    } as HarnessConfig)
    expect(res.killedByTimeout).toBe(true)
    expect(res.exitCode).not.toBe(0)
  })

  it('does not flag killedByTimeout for a fast clean exit', async () => {
    const driver = new SubprocessSandboxDriver()
    const res = await driver.exec('test', 'true', { timeoutMs: 5000 } as HarnessConfig)
    expect(res.killedByTimeout).toBeFalsy()
    expect(res.exitCode).toBe(0)
  })

  it('caps captured output for a runaway process (outputTruncated)', async () => {
    const driver = new SubprocessSandboxDriver()
    // Emit far more than the cap; the buffer must stay bounded.
    const res = await driver.exec(
      'run',
      `node -e "const b='x'.repeat(1024); for(let i=0;i<5000;i++) process.stdout.write(b)"`,
      { maxOutputBytes: 4096 } as HarnessConfig,
    )
    expect(res.outputTruncated).toBe(true)
    expect(res.stdout.length).toBeLessThanOrEqual(4096)
  })
})

describe('SandboxHarness treats a timed-out test phase as a hard fail', () => {
  // A driver whose test phase was killed by timeout but whose SIGKILLed
  // child reported exit 0 AND whose stdout would parse as "all passed."
  // This is the exact masquerade: before the fix the harness scored it a
  // pass.
  const masqueradeDriver: SandboxDriver = {
    id: 'masquerade',
    async exec(phase): Promise<SandboxResult> {
      if (phase === 'test') {
        return {
          phase,
          exitCode: 0,
          stdout: 'Tests  3 passed',
          stderr: '',
          wallMs: 1,
          killedByTimeout: true,
        }
      }
      return { phase, exitCode: 0, stdout: '', stderr: '', wallMs: 1 }
    },
  }

  it('a timed-out test phase fails the harness regardless of exit code', async () => {
    const harness = new SandboxHarness(masqueradeDriver)
    const config: HarnessConfig = { testCommand: 'pnpm test', testParser: vitestTestParser }
    const result = await harness.run(config, stubEmitter())
    expect(result.passed).toBe(false)
    expect(result.score).toBe(0)
  })

  it('a clean test phase with a real parse still passes (no false negatives)', async () => {
    const cleanDriver: SandboxDriver = {
      id: 'clean',
      async exec(phase): Promise<SandboxResult> {
        return {
          phase,
          exitCode: 0,
          stdout: 'Tests  4 passed',
          stderr: '',
          wallMs: 1,
        }
      },
    }
    const harness = new SandboxHarness(cleanDriver)
    const config: HarnessConfig = { testCommand: 'pnpm test', testParser: vitestTestParser }
    const result = await harness.run(config, stubEmitter())
    expect(result.passed).toBe(true)
    expect(result.score).toBe(1)
  })

  it('a timed-out setup phase fails fast without running test', async () => {
    let testRan = false
    const setupTimeoutDriver: SandboxDriver = {
      id: 'setup-timeout',
      async exec(phase): Promise<SandboxResult> {
        if (phase === 'test') testRan = true
        if (phase === 'setup') {
          return { phase, exitCode: 0, stdout: '', stderr: '', wallMs: 1, killedByTimeout: true }
        }
        return { phase, exitCode: 0, stdout: '', stderr: '', wallMs: 1 }
      },
    }
    const harness = new SandboxHarness(setupTimeoutDriver)
    const config: HarnessConfig = { setupCommand: 'install', testCommand: 'test' }
    const result = await harness.run(config, stubEmitter())
    expect(result.passed).toBe(false)
    expect(testRan).toBe(false)
  })
})
