export const ANALYST_BENCHMARK_IMPLEMENTATION_DIGEST_ALGORITHM = 'sha256-canonical-source-manifest'

export const ANALYST_BENCHMARK_DEPENDENCY_LOCK_DIGEST_ALGORITHM = 'sha256-canonical-file-manifest'

export const ANALYST_BENCHMARK_DEPENDENCY_LOCK_FILES = Object.freeze([
  'package.json',
  'pnpm-lock.yaml',
])

export const ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256 =
  '1e03f2daed356d60316aabefb407ec1e437ac94d408d61eea4ae096e9c6fbb5b'

export const ANALYST_BENCHMARK_IMPLEMENTATION_FILES = Object.freeze([
  'src/analyst/benchmark-agentrx-calibration.ts',
  'src/analyst/benchmark-command-artifact.ts',
  'src/analyst/benchmark-command-persistence.ts',
  'src/analyst/benchmark-command-result.ts',
  'src/analyst/benchmark-command-validation.ts',
  'src/analyst/benchmark-command.ts',
  'src/analyst/benchmark-comparison.ts',
  'src/analyst/benchmark-dataset-agentrx.ts',
  'src/analyst/benchmark-dataset-codetrace.ts',
  'src/analyst/benchmark-dataset-utils.ts',
  'src/analyst/benchmark-datasets.ts',
  'src/analyst/benchmark-evidence-validation.ts',
  'src/analyst/benchmark-public-adapters.ts',
  'src/analyst/benchmark-public-calibration.ts',
  'src/analyst/benchmark-public-data.ts',
  'src/analyst/benchmark-public-errors.ts',
  'src/analyst/benchmark-public-model.ts',
  'src/analyst/benchmark-public-types.ts',
  'src/analyst/benchmark-real-model.ts',
  'src/analyst/benchmark-report.ts',
  'src/analyst/benchmark-response-cache.ts',
  'src/analyst/benchmark-scoring.ts',
  'src/analyst/benchmark-summary.ts',
  'src/analyst/benchmark-verification-artifacts.ts',
  'src/analyst/benchmark-verification-outcome.ts',
  'src/analyst/benchmark.ts',
  'src/analyst/types.ts',
  'src/analyst/usage-receipt.ts',
  'src/campaign/search-ledger-errors.ts',
  'src/campaign/search-ledger-file.ts',
  'src/campaign/single-run-lock.ts',
  'src/campaign/storage.ts',
  'src/concurrency.ts',
  'src/cost-ledger.ts',
  'src/errors.ts',
  'src/judge-calibration.ts',
  'src/ledger-core/atomic-file-lock.ts',
  'src/ledger-core/canonical.ts',
  'src/ledger-core/index.ts',
  'src/ledger-core/journal-file.ts',
  'src/ledger-core/journal.ts',
  'src/ledger-core/trusted-head.ts',
  'src/llm-client.ts',
  'src/math/normal.ts',
  'src/math/special-functions.ts',
  'src/math/student-t.ts',
  'src/metrics.ts',
  'src/statistics.ts',
  'src/trace-analyst/errors.ts',
  'src/trace-analyst/otlp-span.ts',
  'src/trace-analyst/shared-abortable-task.ts',
  'src/trace-analyst/store-boundary.ts',
  'src/trace-analyst/store-bounds.ts',
  'src/trace-analyst/store-contract.ts',
  'src/trace-analyst/store-otlp.ts',
  'src/trace-analyst/store-schemas.ts',
  'src/trace-analyst/store.ts',
  'src/trace-analyst/types.ts',
  'src/trace/attribute-vocabulary.ts',
  'src/trace/otlp-attributes.ts',
  'src/trace/raw-provider-sink.ts',
])

export const ANALYST_BENCHMARK_IMPLEMENTATION_SHA256 =
  'd43f886677a88591a4f612cf1f51f13001fbeb9dbb8fcc9a627f9a77452a34ce'

export function analystBenchmarkImplementationDigest() {
  return ANALYST_BENCHMARK_IMPLEMENTATION_SHA256
}

export function analystBenchmarkDependencyLockDigest() {
  return ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256
}
