import type { HarnessConfig, SandboxDriver, SandboxHarnessResult } from './sandbox-harness'
import { SandboxHarness } from './sandbox-harness'
import { TraceEmitter } from './trace/emitter'
import type { FailureClass, Run } from './trace/schema'
import type { TraceStore } from './trace/store'

export interface TestGradedScenario {
  id: string
  description?: string
  harness: HarnessConfig
  /** Optional pass threshold in 0..1 (default 1.0 = all tests must pass). */
  passThreshold?: number
  /** Provenance for dataset tracking. */
  datasetVersion?: string
  /** Free-form tags (difficulty, category, etc.). */
  tags?: Record<string, string>
}

interface TestGradedRunOptions {
  variantId?: string
  driver?: SandboxDriver
  /** Metadata recorded on the Run (codeSha, promptSha, modelFingerprint, seed). */
  provenance?: Pick<Run, 'codeSha' | 'promptSha' | 'modelFingerprint' | 'seed' | 'envFingerprint'>
}

export interface TestGradedRunResult {
  runId: string
  scenario: TestGradedScenario
  harness: SandboxHarnessResult
  pass: boolean
  score: number
  failureClass?: FailureClass
}

export async function runTestGradedScenario(
  scenario: TestGradedScenario,
  store: TraceStore,
  options: TestGradedRunOptions = {},
): Promise<TestGradedRunResult> {
  const emitter = new TraceEmitter(store)
  await emitter.startRun({
    scenarioId: scenario.id,
    variantId: options.variantId,
    datasetVersion: scenario.datasetVersion,
    tags: scenario.tags,
    ...options.provenance,
  })
  const result = await new SandboxHarness(options.driver).run(scenario.harness, emitter)
  const pass = result.passed && result.score >= (scenario.passThreshold ?? 1)
  const failure = (['setup', 'run', 'test'] as const).find(
    (phase) => result[phase] && result[phase]!.exitCode !== 0,
  )
  const failureClass: FailureClass = pass
    ? 'success'
    : failure === 'test'
      ? 'format_drift'
      : failure
        ? 'sandbox_failure'
        : 'unknown'
  await emitter.endRun({
    pass,
    score: result.score,
    failureClass,
    notes: pass ? undefined : reasonForFailure(result),
  })
  return {
    runId: emitter.runId,
    scenario,
    harness: result,
    pass,
    score: result.score,
    failureClass,
  }
}

function reasonForFailure(result: SandboxHarnessResult): string {
  for (const phase of ['setup', 'run'] as const) {
    const measured = result[phase]
    if (measured && measured.exitCode !== 0) return `${phase} failed: exit ${measured.exitCode}`
  }
  if (result.test) {
    if (result.test.testsTotal !== undefined) {
      return `tests: ${result.test.testsPassed ?? 0}/${result.test.testsTotal}`
    }
    return `test exit ${result.test.exitCode}`
  }
  return 'no test command'
}
