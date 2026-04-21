/**
 * TestGradedScenario — a scenario whose score comes from a test suite.
 *
 * This is the SWE-bench pattern generalized. The scenario ships:
 *   - fixture data (setup instructions)
 *   - a test command the harness runs
 *   - optional assertion overrides
 *
 * The runner emits a run, delegates to SandboxHarness, records the
 * outcome, and returns a structured verdict. Consumers bind their own
 * agent execution to this contract.
 */

import type { HarnessConfig, SandboxDriver, SandboxHarnessResult } from './sandbox-harness'
import { SandboxHarness } from './sandbox-harness'
import type { TraceStore } from './trace/store'
import { TraceEmitter } from './trace/emitter'
import type { FailureClass, Run } from './trace/schema'

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

export interface TestGradedRunOptions {
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
  const harness = new SandboxHarness(options.driver)
  const result = await harness.run(scenario.harness, emitter)
  const threshold = scenario.passThreshold ?? 1.0
  const pass = result.passed && result.score >= threshold
  const setupFailed = result.setup !== undefined && result.setup.exitCode !== 0
  const runFailed = result.run !== undefined && result.run.exitCode !== 0
  const testFailed = result.test !== undefined && result.test.exitCode !== 0
  const failureClass: FailureClass | undefined = pass
    ? 'success'
    : setupFailed || runFailed
      ? 'sandbox_failure'
      : testFailed
        ? 'format_drift'
        : 'unknown'
  await emitter.endRun({
    pass,
    score: result.score,
    failureClass,
    notes: pass ? undefined : reasonForFailure(result),
  })
  return { runId: emitter.runId, scenario, harness: result, pass, score: result.score, failureClass }
}

function reasonForFailure(result: SandboxHarnessResult): string {
  if (result.setup && result.setup.exitCode !== 0) return `setup failed: exit ${result.setup.exitCode}`
  if (result.run && result.run.exitCode !== 0) return `run failed: exit ${result.run.exitCode}`
  if (result.test) {
    if (result.test.testsTotal !== undefined) {
      return `tests: ${result.test.testsPassed ?? 0}/${result.test.testsTotal}`
    }
    return `test exit ${result.test.exitCode}`
  }
  return 'no test command'
}
