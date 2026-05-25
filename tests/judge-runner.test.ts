import { describe, expect, it } from 'vitest'
import { compilerJudge, JudgeRunner, runJudgeFleet, testJudge } from '../src/judge-runner'
import type { HarnessConfig, SandboxDriver, SandboxResult } from '../src/sandbox-harness'

class FakeDriver implements SandboxDriver {
  id = 'fake'
  async exec(
    phase: SandboxResult['phase'],
    _command: string,
    _config: HarnessConfig,
  ): Promise<SandboxResult> {
    return {
      phase,
      exitCode: 0,
      stdout: phase === 'test' ? 'Tests  4 passed' : '',
      stderr: '',
      wallMs: 5,
      ...(phase === 'test' ? { testsTotal: 4, testsPassed: 4 } : {}),
    }
  }
}

describe('judge runner', () => {
  it('runs named judges through the sandbox harness', async () => {
    const runner = new JudgeRunner(new FakeDriver())
    const result = await runner.run(testJudge('tests', { testCommand: 'pnpm test' }))
    expect(result.kind).toBe('test')
    expect(result.passed).toBe(true)
    expect(result.score).toBe(1)
  })

  it('runs a judge fleet in parallel by default', async () => {
    const results = await runJudgeFleet(
      [
        compilerJudge('compile', { runCommand: 'pnpm build' }),
        testJudge('tests', { testCommand: 'pnpm test' }),
      ],
      { driver: new FakeDriver() },
    )
    expect(results).toHaveLength(2)
    expect(results.every((result) => result.passed)).toBe(true)
  })
})
