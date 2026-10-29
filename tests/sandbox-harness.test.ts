import { describe, expect, it } from 'vitest'
import { SubprocessSandboxDriver } from '../src/sandbox-harness'

describe('SubprocessSandboxDriver', () => {
  it('actually runs shell echo — regression: without real exec, harness is toy', async () => {
    const driver = new SubprocessSandboxDriver()
    const result = await driver.exec('run', 'echo hello', {})
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain('hello')
  })

  it('constructor cwd is used when HarnessConfig.cwd is not set', async () => {
    // Regression guard: previously the constructor accepted `{ cwd }` via duck
    // typing but silently dropped it — exec only read config.cwd. Consumers
    // who passed cwd to the constructor got subprocesses that inherited
    // Node's cwd. Now the constructor arg is a real default.
    const { mkdtempSync, rmSync, realpathSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-cwd-ctor-')))
    try {
      const driver = new SubprocessSandboxDriver({ cwd: dir })
      const result = await driver.exec('run', 'pwd', {})
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe(dir)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('per-call HarnessConfig.cwd overrides constructor cwd', async () => {
    const { mkdtempSync, rmSync, realpathSync } = await import('node:fs')
    const { tmpdir } = await import('node:os')
    const { join } = await import('node:path')
    const ctorDir = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-cwd-ctor-')))
    const callDir = realpathSync(mkdtempSync(join(tmpdir(), 'sdk-cwd-call-')))
    try {
      const driver = new SubprocessSandboxDriver({ cwd: ctorDir })
      const result = await driver.exec('run', 'pwd', { cwd: callDir })
      expect(result.exitCode).toBe(0)
      expect(result.stdout.trim()).toBe(callDir)
    } finally {
      rmSync(ctorDir, { recursive: true, force: true })
      rmSync(callDir, { recursive: true, force: true })
    }
  })

  it('constructor env merges with per-call env (per-call wins on collision)', async () => {
    const driver = new SubprocessSandboxDriver({
      env: { AGENT_EVAL_DEFAULT: 'from-ctor', AGENT_EVAL_SHARED: 'ctor' },
    })
    // `env | grep` survives missing vars; `printenv A B C` is BSD-on-macOS
    // vs GNU-on-Linux inconsistent (BSD prints only the first hit, exits 0
    // and hides subsequent vars), so the naive form passes on CI and fails
    // on Darwin.
    const result = await driver.exec('run', 'env | grep -E "^AGENT_EVAL_" | sort', {
      env: { AGENT_EVAL_SHARED: 'call', AGENT_EVAL_PER_CALL: 'from-call' },
    })
    expect(result.exitCode).toBe(0)
    const vars = Object.fromEntries(
      result.stdout
        .trim()
        .split('\n')
        .map((l) => {
          const eq = l.indexOf('=')
          return [l.slice(0, eq), l.slice(eq + 1)]
        }),
    )
    expect(vars.AGENT_EVAL_DEFAULT).toBe('from-ctor')
    expect(vars.AGENT_EVAL_SHARED).toBe('call') // per-call wins on collision
    expect(vars.AGENT_EVAL_PER_CALL).toBe('from-call')
  })
})
