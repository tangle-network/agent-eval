export const ANALYST_BENCHMARK_IMPLEMENTATION_DIGEST_ALGORITHM = 'sha256-canonical-source-manifest'

export const ANALYST_BENCHMARK_DEPENDENCY_LOCK_DIGEST_ALGORITHM = 'sha256-canonical-file-manifest'

export const ANALYST_BENCHMARK_DEPENDENCY_LOCK_FILES = Object.freeze([
  'clients/python/pyproject.toml',
  'clients/python/uv.lock',
  'package.json',
  'pnpm-lock.yaml',
])

export const ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256 =
  'ca56679a57495f6d4012ed2b242586da36c231195bd802507ec18cc541b89fe5'

/** The published benchmark evidence was produced at this package version, by
 * the retired one-shot direct runner, before trace analysts moved to the
 * recursive DSPy RLM engine. Both evidence digests below are historical facts
 * about that artifact: the current implementation and dependency manifest have
 * since changed, so they cannot describe the current engine. A fresh certified
 * run must replace the published evidence before any accuracy number is
 * attributed to the engine that ships today. */
export const ANALYST_BENCHMARK_EVIDENCE_PACKAGE_VERSION = '0.137.0'

export const ANALYST_BENCHMARK_EVIDENCE_DEPENDENCY_LOCK_SHA256 =
  '1e03f2daed356d60316aabefb407ec1e437ac94d408d61eea4ae096e9c6fbb5b'

export const ANALYST_BENCHMARK_EVIDENCE_IMPLEMENTATION_SHA256 =
  '4dba263b6256a30d56c7fdb2d992d3a953c0035d731f359b704db806f68f75ac'

export const ANALYST_BENCHMARK_IMPLEMENTATION_FILES = Object.freeze([
  'clients/python/src/agent_eval_rpc/dspy_rlm_bridge.py',
  'clients/python/src/agent_eval_rpc/optimizer_bridge_common.py',
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
  'src/analyst/benchmark-instructions-override.ts',
  'src/analyst/benchmark-public-adapters.ts',
  'src/analyst/benchmark-public-calibration.ts',
  'src/analyst/benchmark-public-consensus.ts',
  'src/analyst/benchmark-public-data.ts',
  'src/analyst/benchmark-public-errors.ts',
  'src/analyst/benchmark-public-model.ts',
  'src/analyst/benchmark-public-prompt.ts',
  'src/analyst/benchmark-public-rlm.ts',
  'src/analyst/benchmark-public-types.ts',
  'src/analyst/benchmark-real-model.ts',
  'src/analyst/benchmark-report.ts',
  'src/analyst/benchmark-response-cache.ts',
  'src/analyst/benchmark-runner-prime.ts',
  'src/analyst/benchmark-scoring.ts',
  'src/analyst/benchmark-summary.ts',
  'src/analyst/benchmark-verification-artifacts.ts',
  'src/analyst/benchmark-verification-outcome.ts',
  'src/analyst/benchmark.ts',
  'src/analyst/definition.ts',
  'src/analyst/dspy-rlm-engine.ts',
  'src/analyst/engine.ts',
  'src/analyst/equal-terms.ts',
  'src/analyst/exact-types.ts',
  'src/analyst/finding-signature.ts',
  'src/analyst/finding-subject.ts',
  'src/analyst/kind-factory.ts',
  'src/analyst/parse-tolerant.ts',
  'src/analyst/prime-bridge-transport.ts',
  'src/analyst/prime-protocol.ts',
  'src/analyst/reply-contract.ts',
  'src/analyst/tool-groups.ts',
  'src/analyst/trace-tool-callback.ts',
  'src/analyst/types.ts',
  'src/analyst/usage-receipt.ts',
  'src/campaign/external-optimizer-callback.ts',
  'src/campaign/external-optimizer-contracts.ts',
  'src/campaign/external-optimizer-http.ts',
  'src/campaign/external-optimizer-model-proxy.ts',
  'src/campaign/external-optimizer-process.ts',
  'src/campaign/external-optimizer-resources.ts',
  'src/campaign/external-optimizer-subprocess.ts',
  'src/campaign/search-ledger-errors.ts',
  'src/campaign/search-ledger-file.ts',
  'src/campaign/single-run-lock.ts',
  'src/campaign/storage.ts',
  'src/concurrency.ts',
  'src/cost-ledger.ts',
  'src/errors.ts',
  'src/integrity/served-model.ts',
  'src/judge-calibration.ts',
  'src/judge-families.ts',
  'src/ledger-core/atomic-file-lock.ts',
  'src/ledger-core/canonical.ts',
  'src/ledger-core/deep-freeze.ts',
  'src/ledger-core/index.ts',
  'src/ledger-core/journal-file.ts',
  'src/ledger-core/journal.ts',
  'src/ledger-core/trusted-head.ts',
  'src/llm-client.ts',
  'src/math/normal.ts',
  'src/math/special-functions.ts',
  'src/math/student-t.ts',
  'src/metrics.ts',
  'src/statistics/agreement-irr.ts',
  'src/statistics/descriptive.ts',
  'src/statistics/effect-sizes.ts',
  'src/statistics/index.ts',
  'src/statistics/internal.ts',
  'src/statistics/multiplicity.ts',
  'src/statistics/paired-binary.ts',
  'src/statistics/paired-tests.ts',
  'src/statistics/power-and-mde.ts',
  'src/statistics/random.ts',
  'src/statistics/rank-tests.ts',
  'src/statistics/sequential-eprocess.ts',
  'src/trace-analyst/errors.ts',
  'src/trace-analyst/otlp-span.ts',
  'src/trace-analyst/shared-abortable-task.ts',
  'src/trace-analyst/store-boundary.ts',
  'src/trace-analyst/store-bounds.ts',
  'src/trace-analyst/store-contract.ts',
  'src/trace-analyst/store-otlp.ts',
  'src/trace-analyst/store-schemas.ts',
  'src/trace-analyst/store.ts',
  'src/trace-analyst/tools.ts',
  'src/trace-analyst/types.ts',
  'src/trace/attribute-vocabulary.ts',
  'src/trace/otlp-attributes.ts',
  'src/trace/raw-provider-sink.ts',
  'src/verdict-cache.ts',
])

export const ANALYST_BENCHMARK_IMPLEMENTATION_SHA256 =
  '54cd9cc6d699dec0fced94f9850406adda8faf31a0280f6dbe2ff1bd31d795d5'

export function analystBenchmarkImplementationDigest() {
  return ANALYST_BENCHMARK_IMPLEMENTATION_SHA256
}

export function analystBenchmarkDependencyLockDigest() {
  return ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256
}
