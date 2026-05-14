/**
 * Reference benchmark wrappers — entry point.
 *
 * Core surface (exported here):
 *   - The `BenchmarkAdapter` contract.
 *   - `deterministicSplit` + `BENCHMARK_SPLIT_SEED` for split assignment.
 *   - `routing` — synthetic 16-task router benchmark. The only novel
 *     benchmark we built; ships in the package.
 *
 * Example wrappers (under `examples/benchmarks/`, NOT in the bundle):
 *   - `gsm8k`         — exact-match math reasoning (HF mirror, dataset
 *                       not bundled).
 *   - `swebench-lite` — 30-instance SWE-Bench subset via an external
 *                       grader command.
 *
 * The example wrappers are reference implementations of `BenchmarkAdapter`.
 * Read them, copy them, adapt them. They're intentionally not in the main
 * entry — every team will configure them differently.
 */

export * as routing from './routing/index'
export type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkEvaluation,
} from './types'
export { BENCHMARK_SPLIT_SEED, deterministicSplit } from './types'
