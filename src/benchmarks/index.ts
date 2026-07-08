/**
 * Reference benchmark wrappers — entry point.
 *
 * Core surface (exported here):
 *   - The `BenchmarkAdapter` contract.
 *   - `runBenchmarkAdapter` for campaign-backed benchmark execution.
 *   - `calibrateBenchmarkMetric` for weak/strong metric checks.
 *   - Standard retrieval parsers for BEIR/MTEB/MS MARCO/TREC/MIRACL-style files.
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

export {
  type BenchmarkMetricCalibrationOptions,
  type BenchmarkMetricCalibrationResult,
  calibrateBenchmarkMetric,
} from './calibration'
export * as routing from './routing/index'
export {
  type BenchmarkDistribution,
  type BenchmarkReport,
  type BenchmarkRunOptions,
  type BenchmarkRunResult,
  type BenchmarkSliceSummary,
  renderBenchmarkReportMarkdown,
  runBenchmarkAdapter,
  summarizeBenchmarkCampaign,
} from './runner'
export {
  type BuildStandardRetrievalItemsOptions,
  buildStandardRetrievalItems,
  createRetrievalIdBenchmarkAdapter,
  evaluateStandardRetrieval,
  normalizeRetrievedDocumentIds,
  parseBeirCorpusJsonl,
  parseBeirQueriesJsonl,
  parseJsonlRows,
  parseQrels,
  parseTsvRows,
  type RetrievalIdAdapterOptions,
  retrievalMetricsAtCutoff,
  type StandardRetrievalArtifact,
  type StandardRetrievalDocument,
  type StandardRetrievalEvaluationOptions,
  type StandardRetrievalPayload,
  type StandardRetrievalQrel,
  type StandardRetrievalQuery,
  type StandardRetrievalResult,
} from './standard-formats'
export type {
  BenchmarkAdapter,
  BenchmarkDatasetItem,
  BenchmarkEvaluation,
  BenchmarkFamily,
  BenchmarkResponder,
  BenchmarkScenario,
  BenchmarkSource,
  BenchmarkTaskKind,
} from './types'
export { BENCHMARK_SPLIT_SEED, deterministicSplit } from './types'
