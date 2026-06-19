import { describe, expect, it } from 'vitest'
import { compilerJudge, runJudgeFleet } from './judge-runner'
import type { HarnessConfig, SandboxDriver, SandboxResult } from './sandbox-harness'

/**
 * Driver that records peak concurrent `exec` calls. Each exec yields to the
 * event loop a few times so the pool's bound is observable: with unbounded
 * fan-out every spec's subprocess is in-flight at once.
 */
function makeConcurrencyTrackingDriver(): SandboxDriver & { peak: number; active: number } {
  const state = { id: 'tracking', peak: 0, active: 0 } as SandboxDriver & {
    peak: number
    active: number
  }
  state.exec = async (
    phase: SandboxResult['phase'],
    _command: string,
    _config: HarnessConfig,
  ): Promise<SandboxResult> => {
    state.active++
    if (state.active > state.peak) state.peak = state.active
    // Yield repeatedly so other workers can start while we're "running".
    for (let i = 0; i < 5; i++) await Promise.resolve()
    state.active--
    return { phase, exitCode: 0, stdout: '', stderr: '', wallMs: 1 }
  }
  return state
}

describe('runJudgeFleet bounded concurrency', () => {
  it('caps concurrent subprocesses at the configured concurrency', async () => {
    const driver = makeConcurrencyTrackingDriver()
    const specs = Array.from({ length: 12 }, (_, i) =>
      compilerJudge(`judge-${i}`, { runCommand: 'true' } as HarnessConfig),
    )

    const results = await runJudgeFleet(specs, { driver, concurrency: 3 })

    expect(results).toHaveLength(12)
    // OLD behavior (Promise.all over all specs) would peak at 12. The bounded
    // pool must never exceed the configured concurrency.
    expect(driver.peak).toBeLessThanOrEqual(3)
    expect(driver.peak).toBeGreaterThan(0)
  })

  it('preserves result order matching input spec order', async () => {
    const driver = makeConcurrencyTrackingDriver()
    const specs = Array.from({ length: 8 }, (_, i) =>
      compilerJudge(`spec-${i}`, { runCommand: 'true' } as HarnessConfig),
    )
    const results = await runJudgeFleet(specs, { driver, concurrency: 2 })
    expect(results.map((r) => r.id)).toEqual(specs.map((s) => s.id))
  })

  it('returns [] for an empty spec list without spawning workers', async () => {
    const driver = makeConcurrencyTrackingDriver()
    const results = await runJudgeFleet([], { driver })
    expect(results).toEqual([])
    expect(driver.peak).toBe(0)
  })
})
