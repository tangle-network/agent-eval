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

describe('public analyst benchmark implementation digest', () => {
  // The manifest matches the import graph because `assertCompleteSourceManifest`
  // in the checker says so on every `pnpm build` and `pnpm verify:package`.
  // A second hand-copied list here would restate the constant, not check it.
  it('pins the complete behavior-defining source manifest without hashing itself', () => {
    expect(ANALYST_BENCHMARK_IMPLEMENTATION_DIGEST_ALGORITHM).toBe(
      'sha256-canonical-source-manifest',
    )
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

  // The checker is a Node subprocess that hashes 100+ copied files and walks
  // the transitive module graph: 6-10s under load, so the 5s default flakes.
  const CHECKER_TIMEOUT_MS = 60_000

  it('recomputes the pinned digest from the repository sources', {
    timeout: CHECKER_TIMEOUT_MS,
  }, () => {
    const result = runChecker(REPOSITORY_ROOT)

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(ANALYST_BENCHMARK_IMPLEMENTATION_SHA256)
    expect(result.stdout).toContain(ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256)
    expect(result.stdout).toContain(`(${ANALYST_BENCHMARK_IMPLEMENTATION_FILES.length} files)`)
  })

  it('fails when any bound source changes without a new digest', {
    timeout: CHECKER_TIMEOUT_MS,
  }, async () => {
    const sourceRoot = await copyImplementationSources()
    const [firstBoundSource] = ANALYST_BENCHMARK_IMPLEMENTATION_FILES
    if (firstBoundSource === undefined) throw new Error('manifest is empty')
    try {
      await appendFile(join(sourceRoot, firstBoundSource), '\n// digest mutation proof\n')

      const result = runChecker(sourceRoot)

      expect(result.status).toBe(1)
      expect(result.stderr).toContain('implementation digest mismatch')
    } finally {
      await rm(sourceRoot, { recursive: true, force: true })
    }
  })

  it('fails when a transitive runtime source is missing from the manifest', {
    timeout: CHECKER_TIMEOUT_MS,
  }, async () => {
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
  for (const path of ANALYST_BENCHMARK_IMPLEMENTATION_FILES) {
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
