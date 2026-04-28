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
 *   - `swebench-lite` — 30-instance SWE-Bench subset (stub; needs an
 *                       external grader).
 *
 * The example wrappers are reference implementations of `BenchmarkAdapter`.
 * Read them, copy them, adapt them. They're intentionally not in the main
 * entry — every team will configure them differently.
 */

export type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkEvaluation,
} from './types'
export { deterministicSplit, BENCHMARK_SPLIT_SEED } from './types'

export * as routing from './routing/index'
