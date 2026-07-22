import {
  InMemoryTraceStore,
  SandboxHarness,
  SubprocessSandboxDriver,
  TraceEmitter,
} from '../../src/index'

/**
 * Same-sandbox pattern:
 * - one driver owns one workdir
 * - the harness runs setup/build/test there
 * - later checks can inspect files/logs/screenshots produced by those phases
 *
 * Replace `workdir` with a generated app, browser automation checkout, or
 * remote computer-use workspace.
 */
export async function runSameSandboxExample(workdir: string) {
  const store = new InMemoryTraceStore()
  const driver = new SubprocessSandboxDriver({ cwd: workdir })
  const harness = new SandboxHarness(driver)
  const emitter = new TraceEmitter(store)
  await emitter.startRun({
    scenarioId: 'same-sandbox-example',
    layer: 'app-build',
  })

  const result = await harness.run(
    {
      setupCommand: 'pnpm install --frozen-lockfile',
      runCommand: 'pnpm build',
      testCommand: 'pnpm test',
      timeoutMs: 180_000,
    },
    emitter,
  )

  const summary = [
    `passed=${result.passed}`,
    `score=${result.score}`,
    `build=${result.run?.exitCode ?? 'not-run'}`,
    `test=${result.test?.exitCode ?? 'not-run'}`,
    result.test?.stdout?.slice(-2000) ?? '',
  ].join('\n')

  const judged = {
    score: result.passed && summary.includes('test=0') ? 1 : 0,
    rationale: result.passed
      ? 'Shared sandbox produced passing build/test evidence.'
      : 'Shared sandbox did not produce passing build/test evidence.',
  }
  await emitter.recordJudge({
    judgeId: 'same-sandbox-evidence',
    name: 'same-sandbox-evidence',
    targetSpanId: emitter.runId,
    dimension: 'evidence',
    score: judged.score,
    rationale: judged.rationale,
    evidence: summary,
  })
  await emitter.endRun({
    pass: result.passed,
    score: result.score,
    notes: judged.rationale,
  })

  return { result, judged, traces: await store.listRuns() }
}
