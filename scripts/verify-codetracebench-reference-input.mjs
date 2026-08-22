import { createHash } from 'node:crypto'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, posix, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const referenceDir = join(
  repoRoot,
  'benchmarks',
  'trace-analysis',
  'codetracebench-glm52-20260730',
)

export const REFERENCE_INPUT = Object.freeze({
  dataset: 'codetracebench',
  datasetRevision: 'aa213b84ffb6690fc37ca15766d6ca174ec36d4d',
  datasetSplit: 'verified-miniswe-normalizer-compatible-32',
  caseCount: 32,
  labelsSha256: '5d8b4024c3e2114965cbf2f2fa0124bbf59b3fb134824fa06dd6a38ee07e8412',
  traceManifestSha256: '40269e155df3227fd965e11d0d99ce75d5e5f6db3c15a1325dfedc66dbbaa0e1',
  importOutputSha256: '7c1198f821e61a308751cd4e5cb72b7758d0060bad39e27cde6713177e2aca2d',
  verificationArtifactsSha256:
    'c6d6e14d5a3c78ee183961628f7640143862e4cd9ec55766965e7b74d6ed04d2',
})

const SEARCHED_ARTIFACTS = Object.freeze({
  'final-test-output': ['panes/post-test.txt', 'sessions/tests.log', 'test_output.txt'],
  'final-result': ['results.json', 'result.json', 'report.json', '*_result.json'],
  'final-metrics': ['*_metrics.json'],
})
const ARTIFACT_ROLES = Object.freeze(Object.keys(SEARCHED_ARTIFACTS))

function fail(message) {
  throw new Error(`CodeTraceBench input check failed: ${message}`)
}

function assert(condition, message) {
  if (!condition) fail(message)
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function readRegularFile(path, label) {
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    fail(`${label} does not exist: ${path}`)
  }
  assert(stat.isFile(), `${label} must be a regular file: ${path}`)
  return readFileSync(path)
}

function parseJson(bytes, label) {
  try {
    return JSON.parse(bytes.toString('utf8'))
  } catch {
    fail(`${label} is not valid JSON`)
  }
}

/**
 * Order two strings by UTF-16 code unit, the ordering `compareCodeUnits` in
 * `src/ledger-core/canonical.ts` applies. Every ordering this file compares
 * against canonical bytes must use it: RFC 8785 canonicalizes an array by
 * position, so a host collation in front of `canonicalJson` decides the bytes.
 */
function compareCodeUnits(left, right) {
  if (left < right) return -1
  if (left > right) return 1
  return 0
}

function normalizeTraceFiles(value, expectedCount) {
  assert(Array.isArray(value), 'result inputs.traceFiles must be an array')
  assert(
    value.length === expectedCount,
    `expected ${expectedCount} trace records, found ${value.length}`,
  )

  const traceIds = new Set()
  const relativePaths = new Set()
  return value.map((entry, index) => {
    assert(
      entry && typeof entry === 'object' && !Array.isArray(entry),
      `trace record ${index} is invalid`,
    )
    const { traceId, relativePath, sha256: expectedSha256 } = entry
    assert(
      typeof traceId === 'string' && traceId.length > 0,
      `trace record ${index} has no traceId`,
    )
    assert(
      typeof relativePath === 'string' && relativePath.length > 0,
      `trace record ${index} has no relativePath`,
    )
    assert(
      !isAbsolute(relativePath) &&
        relativePath === basename(relativePath) &&
        !relativePath.includes('/') &&
        !relativePath.includes('\\') &&
        !relativePath.includes('\0'),
      `trace record ${index} has an unsafe relativePath`,
    )
    assert(
      relativePath === `${traceId}.otlp.jsonl`,
      `trace record ${index} path does not match its traceId`,
    )
    assert(
      typeof expectedSha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedSha256),
      `trace record ${index} has an invalid SHA-256`,
    )
    assert(!traceIds.has(traceId), `duplicate traceId: ${traceId}`)
    assert(!relativePaths.has(relativePath), `duplicate trace path: ${relativePath}`)
    traceIds.add(traceId)
    relativePaths.add(relativePath)
    return { traceId, relativePath, sha256: expectedSha256 }
  }).sort((left, right) => compareCodeUnits(left.traceId, right.traceId))
}

function sortTraceFiles(traceFiles) {
  return [...traceFiles].sort((left, right) => compareCodeUnits(left.traceId, right.traceId))
}

function verifyLabels(labelsPath, inputs, traceFiles, expected) {
  const labelsBytes = readRegularFile(labelsPath, 'labels file')
  const labelsSha256 = sha256(labelsBytes)
  assert(
    labelsSha256 === expected.labelsSha256,
    `labels SHA-256 mismatch: expected ${expected.labelsSha256}, received ${labelsSha256}`,
  )
  assert(
    inputs.labelsSha256 === expected.labelsSha256,
    'result labels SHA-256 does not match the reference input',
  )
  assert(
    inputs.sourceRowCount === expected.caseCount,
    `result sourceRowCount must be ${expected.caseCount}`,
  )

  const labels = parseJson(labelsBytes, 'labels file')
  assert(Array.isArray(labels), 'labels file must contain an array')
  assert(
    labels.length === expected.caseCount,
    `expected ${expected.caseCount} label rows, found ${labels.length}`,
  )

  const labelIds = new Set()
  for (const [index, row] of labels.entries()) {
    assert(
      row && typeof row === 'object' && !Array.isArray(row),
      `label row ${index} is invalid`,
    )
    assert(
      typeof row.traj_id === 'string' && row.traj_id.length > 0,
      `label row ${index} has no traj_id`,
    )
    assert(!labelIds.has(row.traj_id), `duplicate label traj_id: ${row.traj_id}`)
    labelIds.add(row.traj_id)
  }

  const traceIds = new Set(traceFiles.map((trace) => trace.traceId))
  const missingLabels = [...traceIds].filter((traceId) => !labelIds.has(traceId))
  const labelsWithoutTraces = [...labelIds].filter((traceId) => !traceIds.has(traceId))
  assert(
    missingLabels.length === 0 && labelsWithoutTraces.length === 0,
    `label/trace IDs differ: missing labels [${missingLabels.join(', ')}], missing traces [${labelsWithoutTraces.join(', ')}]`,
  )

  return { labelsSha256, labelsById: new Map(labels.map((row) => [row.traj_id, row])) }
}

function verifyTraceDirectory(traceDir, traceFiles, expected) {
  let stat
  try {
    stat = lstatSync(traceDir)
  } catch {
    fail(`trace directory does not exist: ${traceDir}`)
  }
  assert(stat.isDirectory(), `trace directory must be a real directory: ${traceDir}`)

  const entries = readdirSync(traceDir, { withFileTypes: true })
  for (const entry of entries) {
    assert(entry.isFile(), `trace directory entry must be a regular file: ${entry.name}`)
  }

  const expectedNames = [
    ...traceFiles.map((trace) => trace.relativePath),
    'codetracebench-import.json',
  ].sort()
  const actualNames = entries.map((entry) => entry.name).sort()
  const missing = expectedNames.filter((name) => !actualNames.includes(name))
  const extra = actualNames.filter((name) => !expectedNames.includes(name))
  assert(
    missing.length === 0 && extra.length === 0,
    `trace directory differs: missing [${missing.join(', ')}], extra [${extra.join(', ')}]`,
  )

  let traceBytes = 0
  for (const trace of traceFiles) {
    const bytes = readRegularFile(join(traceDir, trace.relativePath), `trace ${trace.traceId}`)
    const actualSha256 = sha256(bytes)
    assert(
      actualSha256 === trace.sha256,
      `trace ${trace.traceId} SHA-256 mismatch: expected ${trace.sha256}, received ${actualSha256}`,
    )
    traceBytes += bytes.length
  }
  const receipt = parseJson(
    readRegularFile(join(traceDir, 'codetracebench-import.json'), 'trace import receipt'),
    'trace import receipt',
  )
  assertRecord(receipt, 'trace import receipt')
  assert(receipt.kind === 'traces.codetracebench-import', 'trace import receipt kind differs')
  assert(receipt.input?.revision === expected.datasetRevision, 'trace import revision differs')
  assert(receipt.input?.rowsSha256 === expected.labelsSha256, 'trace import labels SHA-256 differs')
  assert(receipt.counts?.traces === expected.caseCount, 'trace import trace count differs')
  assert(receipt.settings?.outputLayout === '<traj_id>.otlp.jsonl', 'trace import layout differs')
  assert(receipt.safety?.labelLeakScan === 'passed', 'trace import leak scan did not pass')
  assert(Array.isArray(receipt.traces), 'trace import receipt traces must be an array')
  const receiptTraces = receipt.traces.map((entry, index) => {
    assertRecord(entry, `trace import receipt trace ${index}`)
    assertRecord(entry.output, `trace import receipt trace ${index} output`)
    return {
      traceId: nonEmptyString(entry.traceId, `trace import receipt trace ${index} traceId`),
      relativePath: safeRelativePath(
        entry.output.path,
        `trace import receipt trace ${index} output path`,
      ),
      sha256: nonEmptyString(
        entry.output.sha256,
        `trace import receipt trace ${index} output SHA-256`,
      ),
    }
  })
  const outputSha256 = sha256(
    JSON.stringify(
      receiptTraces.map((trace) => ({ traceId: trace.traceId, sha256: trace.sha256 })),
    ),
  )
  assert(outputSha256 === receipt.outputSha256, 'trace import output digest is inconsistent')
  assert(
    outputSha256 === expected.importOutputSha256,
    `trace import output SHA-256 mismatch: expected ${expected.importOutputSha256}, received ${outputSha256}`,
  )
  assert(
    canonicalJson(sortTraceFiles(receiptTraces)) === canonicalJson(traceFiles),
    'trace import receipt does not match result trace files',
  )
  return { traceBytes, importOutputSha256: outputSha256 }
}

function verifyArtifactDirectory(
  artifactDir,
  value,
  labelsById,
  expectedCount,
  expectedDigest,
  maxArtifactBytes,
) {
  assert(Array.isArray(value), 'result inputs.verificationArtifacts must be an array')
  assert(
    value.length === expectedCount,
    `expected ${expectedCount} verification artifact records, found ${value.length}`,
  )
  const verificationArtifactsSha256 = sha256(canonicalJson(value))
  assert(
    verificationArtifactsSha256 === expectedDigest,
    `verification artifact manifest SHA-256 mismatch: expected ${expectedDigest}, received ${verificationArtifactsSha256}`,
  )
  const artifactRoot = realDirectory(artifactDir, 'artifact directory')
  const seen = new Set()
  let artifactBytes = 0
  let artifactFiles = 0
  let presentCases = 0

  for (const [index, manifest] of value.entries()) {
    assertRecord(manifest, `verification artifact record ${index}`)
    const traceId = nonEmptyString(manifest.traceId, `verification artifact record ${index} traceId`)
    assert(!seen.has(traceId), `duplicate verification artifact traceId: ${traceId}`)
    seen.add(traceId)
    const label = labelsById.get(traceId)
    assert(label, `verification artifact traceId has no label row: ${traceId}`)
    const sourceRelativePath = safeRelativePath(
      label.source_relpath,
      `label '${traceId}' source_relpath`,
    )
    const searched = [
      posix.join(traceId, sourceRelativePath),
      sourceRelativePath,
    ].filter((path, pathIndex, paths) => paths.indexOf(path) === pathIndex)
    assert(
      canonicalJson(manifest.caseDirectoriesSearched) === canonicalJson(searched),
      `verification artifact '${traceId}' searched directories differ`,
    )
    assert(
      canonicalJson(manifest.searched) === canonicalJson(SEARCHED_ARTIFACTS),
      `verification artifact '${traceId}' search rules differ`,
    )
    assert(
      manifest.maxBytes === maxArtifactBytes,
      `verification artifact '${traceId}' maxBytes differs from execution`,
    )

    const existing = searched
      .map((path) => ({ declared: path, absolute: resolveInside(artifactRoot, path) }))
      .filter(({ absolute }) => existsSync(absolute))
      .map(({ declared, absolute }) => {
        const canonical = realDirectory(absolute, `verification artifact '${traceId}' case directory`)
        assertContained(artifactRoot, canonical, declared)
        return { declared, canonical }
      })
    const uniqueExisting = [
      ...new Map(existing.map((entry) => [entry.canonical, entry])).values(),
    ]
    assert(
      uniqueExisting.length <= 1,
      `verification artifact '${traceId}' has ambiguous case directories`,
    )

    if (uniqueExisting.length === 0) {
      assert(manifest.status === 'missing', `verification artifact '${traceId}' status must be missing`)
      assert(manifest.caseDirectory === searched[0], `verification artifact '${traceId}' caseDirectory differs`)
      assert(Array.isArray(manifest.files) && manifest.files.length === 0, `verification artifact '${traceId}' must have no files`)
      assert(manifest.totalBytes === 0, `verification artifact '${traceId}' totalBytes must be zero`)
      continue
    }

    const caseDirectory = uniqueExisting[0].canonical
    const portableCaseDirectory = slashRelative(artifactRoot, caseDirectory)
    assert(
      manifest.caseDirectory === portableCaseDirectory,
      `verification artifact '${traceId}' caseDirectory differs`,
    )
    const discovered = discoverArtifacts(caseDirectory).map((entry) => ({
      ...entry,
      path: posix.join(portableCaseDirectory, entry.relativePath),
    }))
    const recorded = normalizeArtifactFiles(manifest.files, portableCaseDirectory, traceId)
    assert(
      canonicalJson(recorded.map(publicArtifactIdentity)) ===
        canonicalJson(discovered.map(publicArtifactIdentity)),
      `verification artifact '${traceId}' file set differs`,
    )

    let caseBytes = 0
    for (const file of recorded) {
      const bytes = readRegularFile(
        resolveInside(artifactRoot, file.path),
        `verification artifact '${traceId}' ${file.relativePath}`,
      )
      const actualSha256 = sha256(bytes)
      assert(
        actualSha256 === file.sha256,
        `verification artifact '${traceId}' ${file.relativePath} SHA-256 mismatch`,
      )
      assert(
        bytes.length === file.bytes,
        `verification artifact '${traceId}' ${file.relativePath} byte count mismatch`,
      )
      caseBytes += bytes.length
    }
    assert(
      manifest.totalBytes === caseBytes,
      `verification artifact '${traceId}' totalBytes mismatch`,
    )
    const discoveredRoles = new Set(recorded.map((file) => file.role))
    const expectedMissingRoles = ARTIFACT_ROLES.filter((role) => !discoveredRoles.has(role))
    assert(
      canonicalJson(manifest.missingRoles) === canonicalJson(expectedMissingRoles),
      `verification artifact '${traceId}' missingRoles differ`,
    )
    const expectedStatus = discoveredRoles.has('final-result') ? 'present' : 'missing'
    assert(
      manifest.status === expectedStatus,
      `verification artifact '${traceId}' status must be ${expectedStatus}`,
    )
    if (expectedStatus === 'present') presentCases += 1
    artifactBytes += caseBytes
    artifactFiles += recorded.length
  }

  assert(seen.size === labelsById.size, 'verification artifact and label IDs differ')
  return {
    verificationArtifactsSha256,
    artifactBytes,
    artifactFiles,
    presentCases,
    missingCases: expectedCount - presentCases,
  }
}

function discoverArtifacts(caseDirectory) {
  const rootEntries = readdirSync(caseDirectory, { withFileTypes: true })
  const rootFiles = rootEntries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
  const testOutput = SEARCHED_ARTIFACTS['final-test-output']
    .map((path) => ({ role: 'final-test-output', relativePath: path }))
    .find((entry) => existsSync(resolveInside(caseDirectory, entry.relativePath)))
  const finalResults = [
    ...SEARCHED_ARTIFACTS['final-result']
      .filter((path) => !path.includes('*'))
      .map((relativePath) => ({ role: 'final-result', relativePath })),
    ...rootFiles
      .filter((path) => path.endsWith('_result.json'))
      .map((relativePath) => ({ role: 'final-result', relativePath })),
  ]
  const finalMetrics = rootFiles
    .filter((path) => path.endsWith('_metrics.json'))
    .map((relativePath) => ({ role: 'final-metrics', relativePath }))
  const candidates = [
    ...(testOutput ? [testOutput] : []),
    ...finalResults.filter((entry) => existsSync(resolveInside(caseDirectory, entry.relativePath))),
    ...finalMetrics,
  ]
  const seen = new Set()
  return candidates
    .filter((entry) => {
      const key = `${entry.role}:${entry.relativePath}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
    .sort(
      (left, right) =>
        ARTIFACT_ROLES.indexOf(left.role) - ARTIFACT_ROLES.indexOf(right.role) ||
        compareCodeUnits(left.relativePath, right.relativePath),
    )
}

function normalizeArtifactFiles(value, caseDirectory, traceId) {
  assert(Array.isArray(value), `verification artifact '${traceId}' files must be an array`)
  const seen = new Set()
  return value.map((file, index) => {
    assertRecord(file, `verification artifact '${traceId}' file ${index}`)
    assert(
      ARTIFACT_ROLES.includes(file.role),
      `verification artifact '${traceId}' file ${index} has an invalid role`,
    )
    const relativePath = safeRelativePath(
      file.relativePath,
      `verification artifact '${traceId}' file ${index} relativePath`,
    )
    const path = safeRelativePath(
      file.path,
      `verification artifact '${traceId}' file ${index} path`,
    )
    assert(
      path === posix.join(caseDirectory, relativePath),
      `verification artifact '${traceId}' file ${index} path differs`,
    )
    assert(!seen.has(path), `verification artifact '${traceId}' repeats file '${path}'`)
    seen.add(path)
    assert(
      typeof file.sha256 === 'string' && /^[a-f0-9]{64}$/.test(file.sha256),
      `verification artifact '${traceId}' file ${index} has an invalid SHA-256`,
    )
    assert(
      Number.isSafeInteger(file.bytes) && file.bytes >= 0,
      `verification artifact '${traceId}' file ${index} has invalid bytes`,
    )
    assert(
      typeof file.spanId === 'string' && file.spanId.length > 0,
      `verification artifact '${traceId}' file ${index} has no spanId`,
    )
    return {
      role: file.role,
      path,
      relativePath,
      sha256: file.sha256,
      bytes: file.bytes,
      spanId: file.spanId,
    }
  })
}

function publicArtifactIdentity(file) {
  return { role: file.role, path: file.path, relativePath: file.relativePath }
}

function safeRelativePath(value, label) {
  const path = nonEmptyString(value, label)
  assert(
    !isAbsolute(path) &&
      !path.includes('\\') &&
      !path.includes('\0') &&
      path.split('/').every((segment) => segment.length > 0 && segment !== '.' && segment !== '..'),
    `${label} is unsafe`,
  )
  return path
}

function resolveInside(root, portablePath) {
  const path = resolve(root, ...safeRelativePath(portablePath, 'artifact path').split('/'))
  assertContained(root, path, portablePath)
  return path
}

function assertContained(root, path, label) {
  const relation = relative(root, path)
  assert(
    relation !== '' && relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation),
    `path escapes artifact directory: ${label}`,
  )
}

function realDirectory(path, label) {
  let metadata
  try {
    metadata = lstatSync(path)
  } catch {
    fail(`${label} does not exist: ${path}`)
  }
  assert(metadata.isDirectory(), `${label} must be a real directory: ${path}`)
  return realpathSync(path)
}

function slashRelative(root, path) {
  return relative(root, path).split(sep).join('/')
}

function nonEmptyString(value, label) {
  assert(typeof value === 'string' && value.length > 0, `${label} must be a non-empty string`)
  return value
}

function assertRecord(value, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value), `${label} is invalid`)
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') {
    assert(Number.isFinite(value), 'cannot hash a non-finite number')
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  if (value && typeof value === 'object') {
    return `{${Object.keys(value)
      .filter((key) => value[key] !== undefined)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
      .join(',')}}`
  }
  fail(`cannot hash ${typeof value}`)
}

export function verifyReferenceInput({
  labelsPath,
  resultPath,
  traceDir,
  artifactDir,
  expected = REFERENCE_INPUT,
}) {
  const result = parseJson(readRegularFile(resultPath, 'result file'), 'result file')
  const inputs = result?.inputs
  assert(inputs && typeof inputs === 'object' && !Array.isArray(inputs), 'result has no inputs')
  assert(inputs.dataset === expected.dataset, `result dataset must be ${expected.dataset}`)
  assert(
    inputs.datasetRevision === expected.datasetRevision,
    `result dataset revision must be ${expected.datasetRevision}`,
  )
  assert(
    inputs.datasetSplit === expected.datasetSplit,
    `result dataset split must be ${expected.datasetSplit}`,
  )

  const traceFiles = normalizeTraceFiles(inputs.traceFiles, expected.caseCount)
  const traceManifestSha256 = sha256(JSON.stringify(traceFiles))
  assert(
    traceManifestSha256 === expected.traceManifestSha256,
    `trace manifest SHA-256 mismatch: expected ${expected.traceManifestSha256}, received ${traceManifestSha256}`,
  )

  const { labelsSha256, labelsById } = verifyLabels(labelsPath, inputs, traceFiles, expected)
  const traceVerification = verifyTraceDirectory(traceDir, traceFiles, expected)
  const artifacts = verifyArtifactDirectory(
    artifactDir,
    inputs.verificationArtifacts,
    labelsById,
    expected.caseCount,
    expected.verificationArtifactsSha256,
    inputs.execution?.maxArtifactBytes,
  )

  return {
    dataset: expected.dataset,
    datasetRevision: expected.datasetRevision,
    datasetSplit: expected.datasetSplit,
    cases: expected.caseCount,
    labelsSha256,
    traceManifestSha256,
    ...traceVerification,
    ...artifacts,
  }
}

function main() {
  const args = process.argv.slice(2)
  const traceIndex = args.indexOf('--trace-dir')
  const artifactIndex = args.indexOf('--artifact-dir')
  if (
    args.length !== 4 ||
    traceIndex < 0 ||
    artifactIndex < 0 ||
    !args[traceIndex + 1] ||
    !args[artifactIndex + 1]
  ) {
    fail(
      'usage: node scripts/verify-codetracebench-reference-input.mjs --trace-dir <imported-trace-directory> --artifact-dir <extracted-artifact-directory>',
    )
  }

  const summary = verifyReferenceInput({
    labelsPath: join(referenceDir, 'input-labels.json'),
    resultPath: join(referenceDir, 'result.json'),
    traceDir: resolve(args[traceIndex + 1]),
    artifactDir: resolve(args[artifactIndex + 1]),
  })
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`)
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main()
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  }
}
