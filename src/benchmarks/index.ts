/**
 * Reference benchmark wrappers — entry point.
 *
 * Three benchmarks ship under `src/benchmarks/`:
 *   - `gsm8k`           — exact-match math reasoning (HF mirror,
 *                          dataset NOT bundled — see `gsm8k/index.ts`).
 *   - `swebench-lite`   — 30-instance SWE-Bench subset (STUB; needs
 *                          external grader).
 *   - `routing`         — synthetic 16-task router benchmark, ships
 *                          in the package.
 *
 * Every benchmark exposes the same three exports — `loadDataset`,
 * `evaluate`, `assignSplit` — and a typed adapter class. Pick the
 * import path that matches the benchmark.
 *
 * Shared types (`BenchmarkAdapter`, `BenchmarkDatasetItem`,
 * `BenchmarkEvaluation`, `deterministicSplit`, `BENCHMARK_SPLIT_SEED`)
 * live in `./types`.
 */

export type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkEvaluation,
} from './types'
export { deterministicSplit, BENCHMARK_SPLIT_SEED } from './types'

export * as gsm8k from './gsm8k/index'
export * as swebenchLite from './swebench-lite/index'
export * as routing from './routing/index'
