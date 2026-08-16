/**
 * @tangle-network/agent-eval/multishot/golden
 *
 * Regression detection for a multishot conversation engine.
 *
 * The records freeze what a reference engine produced on a closed set of
 * deterministic scenarios: every transport request each leg received, and the
 * value the run resolved or threw with. Point your own engine at them and any
 * orchestration drift — a changed turn boundary, a different token budget, a
 * lost tool row, a driver rotation that stops early, a cost that stops being
 * metered, an error that changes class — surfaces as a named field.
 *
 * ```ts
 * import { describe, it } from 'vitest'
 * import {
 *   assertMultishotGoldenScenario,
 *   multishotGoldenScenarios,
 * } from '@tangle-network/agent-eval/multishot/golden'
 * import { runMyEngine } from './my-engine'
 *
 * describe('my engine reproduces the multishot golden records', () => {
 *   for (const scenario of multishotGoldenScenarios()) {
 *     it(scenario.description, async () => {
 *       await assertMultishotGoldenScenario({ engine: runMyEngine, scenario })
 *     })
 *   }
 * })
 * ```
 *
 * Regenerating: `docs/multishot-golden-records.md`.
 */

export { type CompareOptions, compareJson } from './compare'
export type { MultishotGoldenEngine, MultishotMatrixGoldenEngine } from './engine'
export {
  assertMultishotGoldenScenario,
  assertMultishotMatrixGoldenScenario,
  checkMultishotGolden,
  checkMultishotGoldenScenario,
  checkMultishotMatrixGoldenScenario,
  MultishotGoldenMismatchError,
  type MultishotGoldenReport,
  type MultishotGoldenScenarioReport,
} from './harness'
export {
  type MultishotMatrixGoldenCase,
  type MultishotMatrixGoldenScenario,
  multishotMatrixGoldenScenarios,
} from './matrix-scenarios'
export {
  maskVolatileMarkdown,
  readRunDir,
  recordError,
  recordJudgeRequest,
  recordMessage,
  recordRequest,
  recordResult,
  sortJudgeRequests,
  stripVolatile,
  VOLATILE_KEYS,
} from './recording'
export {
  CURRENT_MULTISHOT_GOLDEN_VERSION,
  goldenRecords,
  multishotGoldenVersions,
} from './records'
export {
  type MultishotGoldenCase,
  type MultishotGoldenScenario,
  multishotGoldenScenarios,
} from './scenarios'
export type {
  MultishotGoldenOutcome,
  MultishotGoldenRecord,
  MultishotGoldenRecordSet,
  MultishotMatrixGoldenRecord,
  MultishotRecordedMessage,
  MultishotRecordedRequest,
  RecordedJudgeRequest,
  RecordedMultishotError,
  RecordedMultishotResult,
} from './types'
