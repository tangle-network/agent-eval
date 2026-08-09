import { spawnSync } from 'node:child_process'
import { appendFile, copyFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import {
  ANALYST_BENCHMARK_DEPENDENCY_LOCK_DIGEST_ALGORITHM,
  ANALYST_BENCHMARK_DEPENDENCY_LOCK_FILES,
  ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256,
  ANALYST_BENCHMARK_IMPLEMENTATION_DIGEST_ALGORITHM,
  ANALYST_BENCHMARK_IMPLEMENTATION_FILES,
  ANALYST_BENCHMARK_IMPLEMENTATION_SHA256,
  analystBenchmarkDependencyLockDigest,
  analystBenchmarkImplementationDigest,
} from './benchmark-implementation'

const REPOSITORY_ROOT = fileURLToPath(new URL('../../', import.meta.url))
const CHECKER = join(REPOSITORY_ROOT, 'scripts/check-analyst-benchmark-implementation.mjs')

const EXPECTED_FILES = [
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
  'src/analyst/dspy-rlm-engine.ts',
  'src/analyst/engine.ts',
  'src/analyst/exact-types.ts',
  'src/analyst/finding-signature.ts',
  'src/analyst/finding-subject.ts',
  'src/analyst/kind-factory.ts',
  'src/analyst/parse-tolerant.ts',
  'src/analyst/prime-bridge-transport.ts',
  'src/analyst/prime-protocol.ts',
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
  'src/trace-analyst/tools.ts',
  'src/trace-analyst/types.ts',
  'src/trace/attribute-vocabulary.ts',
  'src/trace/otlp-attributes.ts',
  'src/trace/raw-provider-sink.ts',
  'src/verdict-cache.ts',
] as const

describe('public analyst benchmark implementation digest', () => {
  it('pins the complete behavior-defining source manifest without hashing itself', () => {
    expect(ANALYST_BENCHMARK_IMPLEMENTATION_DIGEST_ALGORITHM).toBe(
      'sha256-canonical-source-manifest',
    )
    expect(ANALYST_BENCHMARK_IMPLEMENTATION_FILES).toEqual(EXPECTED_FILES)
    expect(ANALYST_BENCHMARK_IMPLEMENTATION_FILES).not.toContain(
      'src/analyst/benchmark-implementation.ts',
    )
    expect(analystBenchmarkImplementationDigest()).toBe(ANALYST_BENCHMARK_IMPLEMENTATION_SHA256)
    expect(ANALYST_BENCHMARK_IMPLEMENTATION_SHA256).toMatch(/^[a-f0-9]{64}$/)
    expect(ANALYST_BENCHMARK_DEPENDENCY_LOCK_DIGEST_ALGORITHM).toBe(
      'sha256-canonical-file-manifest',
    )
    expect(ANALYST_BENCHMARK_DEPENDENCY_LOCK_FILES).toEqual([
      'clients/python/pyproject.toml',
      'clients/python/uv.lock',
      'package.json',
      'pnpm-lock.yaml',
    ])
    expect(analystBenchmarkDependencyLockDigest()).toBe(ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256)
  })

  it('recomputes the pinned digest from the repository sources', () => {
    const result = runChecker(REPOSITORY_ROOT)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(ANALYST_BENCHMARK_IMPLEMENTATION_SHA256)
    expect(result.stdout).toContain(ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256)
    expect(result.stdout).toContain(`(${EXPECTED_FILES.length} files)`)
  })

  it('fails when any bound source changes without a new digest', async () => {
    const sourceRoot = await copyImplementationSources()
    try {
      await appendFile(join(sourceRoot, EXPECTED_FILES[0]), '\n// digest mutation proof\n')

      const result = runChecker(sourceRoot)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('implementation digest mismatch')
    } finally {
      await rm(sourceRoot, { recursive: true, force: true })
    }
  })

  it('fails when a transitive runtime source is missing from the manifest', async () => {
    const sourceRoot = await copyImplementationSources()
    try {
      const extraSource = 'src/analyst/benchmark-unlisted-proof.ts'
      await writeFile(join(sourceRoot, extraSource), 'export const unlistedProof = true\n')
      await appendFile(
        join(sourceRoot, 'src/analyst/benchmark-command.ts'),
        "\nexport { unlistedProof } from './benchmark-unlisted-proof'\n",
      )

      const result = runChecker(sourceRoot)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('implementation source manifest mismatch')
      expect(result.stderr).toContain(extraSource)
    } finally {
      await rm(sourceRoot, { recursive: true, force: true })
    }
  })
})

async function copyImplementationSources() {
  const sourceRoot = await mkdtemp(join(tmpdir(), 'analyst-implementation-digest-'))
  for (const path of EXPECTED_FILES) {
    const destination = join(sourceRoot, path)
    await mkdir(dirname(destination), { recursive: true })
    await copyFile(join(REPOSITORY_ROOT, path), destination)
  }
  for (const path of ANALYST_BENCHMARK_DEPENDENCY_LOCK_FILES) {
    await copyFile(join(REPOSITORY_ROOT, path), join(sourceRoot, path))
  }
  return sourceRoot
}

function runChecker(sourceRoot: string) {
  return spawnSync(process.execPath, [CHECKER, '--source-root', sourceRoot], { encoding: 'utf8' })
}
