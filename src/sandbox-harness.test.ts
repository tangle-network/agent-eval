import { describe, expect, it } from 'vitest'
import { type HarnessConfig, SubprocessSandboxDriver } from './sandbox-harness'

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
