import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import { dirname, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'

const CHECKER_PATH = fileURLToPath(import.meta.url)
const REPOSITORY_ROOT = resolve(dirname(CHECKER_PATH), '..')
const IMPLEMENTATION_MODULE_PATH = resolve(
  REPOSITORY_ROOT,
  'src/analyst/benchmark-implementation.ts',
)
const DIGEST_DOMAIN = 'agent-eval/public-analyst-benchmark/implementation'
const DEPENDENCY_LOCK_DIGEST_DOMAIN = 'agent-eval/public-analyst-benchmark/dependency-lock'
const NON_TYPESCRIPT_IMPLEMENTATION_FILES = [
  'clients/python/src/agent_eval_rpc/dspy_rlm_bridge.py',
  'clients/python/src/agent_eval_rpc/optimizer_bridge_common.py',
]
const UTF8 = new TextDecoder('utf-8', { fatal: true })

const implementation = await loadImplementationModule()
const options = parseOptions(process.argv.slice(2))

try {
  assertImplementationModule(implementation)
  const discoveredFiles = await discoverImplementationFiles(options.sourceRoot)
  assertCompleteSourceManifest(
    implementation.ANALYST_BENCHMARK_IMPLEMENTATION_FILES,
    discoveredFiles,
  )
  const actual = await computeDigest(
    options.sourceRoot,
    implementation.ANALYST_BENCHMARK_IMPLEMENTATION_FILES,
    DIGEST_DOMAIN,
  )
  const actualDependencyLock = await computeDigest(
    options.sourceRoot,
    implementation.ANALYST_BENCHMARK_DEPENDENCY_LOCK_FILES,
    DEPENDENCY_LOCK_DIGEST_DOMAIN,
  )
  if (options.printOnly) {
    console.log(actual)
    console.log(actualDependencyLock)
    process.exit(0)
  }
  const expected = implementation.ANALYST_BENCHMARK_IMPLEMENTATION_SHA256
  if (actual !== expected) {
    throw new Error(
      `public analyst benchmark implementation digest mismatch: expected ${expected}, computed ${actual}`,
    )
  }
  const expectedDependencyLock = implementation.ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256
  // --source-only verifies source identity alone: a consumer rebuilding this
  // package with deliberately rewritten dependency manifests (runtime's
  // packed-cohort verifier, a vendored fork) still proves the benchmark
  // implementation is untouched, while the release path (verify:package and
  // the test suite) keeps enforcing the dependency-lock pin.
  if (!options.sourceOnly && actualDependencyLock !== expectedDependencyLock) {
    throw new Error(
      `public analyst benchmark dependency lock digest mismatch: expected ${expectedDependencyLock}, computed ${actualDependencyLock}`,
    )
  }
  console.log(
    `public analyst benchmark digests valid: implementation ${actual} (${implementation.ANALYST_BENCHMARK_IMPLEMENTATION_FILES.length} files), dependency lock ${actualDependencyLock} (${implementation.ANALYST_BENCHMARK_DEPENDENCY_LOCK_FILES.length} files)`,
  )
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error))
  process.exitCode = 1
}

async function loadImplementationModule() {
  const source = await readFile(IMPLEMENTATION_MODULE_PATH, 'utf8')
  const sourceUrl = `data:text/javascript;base64,${Buffer.from(source).toString('base64')}`
  return import(sourceUrl)
}

async function discoverImplementationFiles(sourceRoot) {
  const result = await build({
    absWorkingDir: sourceRoot,
    entryPoints: ['src/analyst/benchmark-command.ts'],
    bundle: true,
    write: false,
    metafile: true,
    platform: 'node',
    format: 'esm',
    packages: 'external',
    treeShaking: false,
    external: ['./benchmark-implementation'],
    logLevel: 'silent',
  })
  const files = [
    ...Object.keys(result.metafile.inputs).map((path) => path.replaceAll('\\', '/')),
    ...NON_TYPESCRIPT_IMPLEMENTATION_FILES,
  ]
    .sort()
  for (const file of files) {
    const supportedTypescript = file.startsWith('src/') && file.endsWith('.ts')
    const supportedPython = NON_TYPESCRIPT_IMPLEMENTATION_FILES.includes(file)
    if (!supportedTypescript && !supportedPython) {
      throw new Error(`unsupported public analyst benchmark implementation input: ${file}`)
    }
  }
  return files
}

function assertCompleteSourceManifest(manifest, discovered) {
  const manifestSet = new Set(manifest)
  const discoveredSet = new Set(discovered)
  const missing = discovered.filter((file) => !manifestSet.has(file))
  const extra = manifest.filter((file) => !discoveredSet.has(file))
  if (missing.length > 0 || extra.length > 0) {
    throw new Error(
      `public analyst benchmark implementation source manifest mismatch: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
    )
  }
}

function parseOptions(args) {
  let sourceRoot = REPOSITORY_ROOT
  let printOnly = false
  let sourceOnly = false
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--print') {
      printOnly = true
      continue
    }
    if (args[index] === '--source-only') {
      sourceOnly = true
      continue
    }
    if (args[index] === '--source-root' && args[index + 1]) {
      sourceRoot = resolve(args[index + 1])
      index += 1
      continue
    }
    throw new Error(
      'usage: node scripts/check-analyst-benchmark-implementation.mjs [--source-root PATH] [--print] [--source-only]',
    )
  }
  return { sourceRoot, printOnly, sourceOnly }
}

function assertImplementationModule(value) {
  if (
    value.ANALYST_BENCHMARK_IMPLEMENTATION_DIGEST_ALGORITHM !==
    'sha256-canonical-source-manifest'
  ) {
    throw new Error('unsupported public analyst benchmark implementation digest algorithm')
  }
  const files = value.ANALYST_BENCHMARK_IMPLEMENTATION_FILES
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error('public analyst benchmark implementation file manifest must not be empty')
  }
  const sorted = [...files].sort()
  if (new Set(files).size !== files.length || files.some((file, index) => file !== sorted[index])) {
    throw new Error(
      'public analyst benchmark implementation file manifest must be unique and sorted',
    )
  }
  for (const file of files) {
    if (
      typeof file !== 'string' ||
      file.length === 0 ||
      file.startsWith('/') ||
      file.includes('\\') ||
      file.split('/').includes('..') ||
      (!file.endsWith('.ts') && !file.endsWith('.py'))
    ) {
      throw new Error(`invalid public analyst benchmark implementation source path: ${file}`)
    }
  }
  if (files.includes('src/analyst/benchmark-implementation.ts')) {
    throw new Error('the implementation digest must not hash its own source module')
  }
  if (
    typeof value.ANALYST_BENCHMARK_IMPLEMENTATION_SHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.ANALYST_BENCHMARK_IMPLEMENTATION_SHA256)
  ) {
    throw new Error('public analyst benchmark implementation digest must be a lowercase SHA-256')
  }
  if (
    value.ANALYST_BENCHMARK_DEPENDENCY_LOCK_DIGEST_ALGORITHM !==
    'sha256-canonical-file-manifest'
  ) {
    throw new Error('unsupported public analyst benchmark dependency lock digest algorithm')
  }
  assertFileManifest(value.ANALYST_BENCHMARK_DEPENDENCY_LOCK_FILES, [
    'clients/python/pyproject.toml',
    'clients/python/uv.lock',
    'package.json',
    'pnpm-lock.yaml',
  ])
  if (
    typeof value.ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(value.ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256)
  ) {
    throw new Error('public analyst benchmark dependency lock digest must be a lowercase SHA-256')
  }
}

function assertFileManifest(files, expected) {
  if (!Array.isArray(files) || JSON.stringify(files) !== JSON.stringify(expected)) {
    throw new Error(`public analyst benchmark file manifest must equal [${expected.join(', ')}]`)
  }
}

async function computeDigest(root, files, domain) {
  const entries = []
  for (const path of files) {
    const absolutePath = resolve(root, path)
    assertContained(root, absolutePath, path)
    const metadata = await stat(absolutePath)
    if (!metadata.isFile()) {
      throw new Error(`public analyst benchmark implementation source is not a file: ${path}`)
    }
    const source = normalizeLineEndings(UTF8.decode(await readFile(absolutePath)))
    entries.push({
      path,
      sha256: createHash('sha256').update(source, 'utf8').digest('hex'),
    })
  }
  return createHash('sha256')
    .update(JSON.stringify({ domain, files: entries }))
    .digest('hex')
}

function assertContained(root, path, label) {
  const relation = relative(resolve(root), path)
  if (relation === '..' || relation.startsWith(`..${sep}`) || relation === '') {
    throw new Error(`implementation source escapes its source root: ${label}`)
  }
}

function normalizeLineEndings(value) {
  return value.replace(/\r\n?/g, '\n')
}
