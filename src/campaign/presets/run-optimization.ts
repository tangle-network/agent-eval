/**
 * `runOptimization` improves a mutable surface with a caller-owned proposer,
 * as a search on the one kernel (`runSearch`).
 *
 * The baseline is the seeded root. The scenarios are the train split: the
 * proposer reads their scores, and the policy ranks on them because the loop
 * has no private selection split. A "generation" is one proposal of
 * `populationSize` candidates from the node the policy chose (by default the
 * incumbent, once every earlier candidate is measured). Every candidate is a
 * node measured on every scenario at every repeat, one cell at a time on the
 * run's lanes. The kept surface is the policy's leader: a budget decision on
 * the train split that claims nothing; `runImprovementLoop` compares it with
 * the baseline on separate cases.
 *
 * The search ledger is always written, beside the run (`<runDir>/search/`) or
 * where `searchLedger` puts it, and it is the run's only checkpoint: running
 * again on the same run directory and options continues an interrupted run
 * instead of starting over, and reruns nothing that settled.
 */

export type {
  PremeasuredOptimizationBaseline,
  RunOptimizationBaseOptions,
  RunOptimizationOptions,
  RunOptimizationResult,
} from './optimization-run-input'
export { runOptimization } from './optimization-runner'
