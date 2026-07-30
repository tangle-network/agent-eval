import { createHash } from 'node:crypto'
import { lstatSync, readFileSync, readdirSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, resolve } from 'node:path'
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
  traceManifestSha256: '0da6343e6dd16d7786d78b548d39f5a9b8893e3dc0d4947954fb3b4259e3d459',
})

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
      relativePath === `${traceId}.jsonl`,
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
  })
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

  return labelsSha256
}

function verifyTraceDirectory(traceDir, traceFiles) {
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

  const expectedNames = traceFiles.map((trace) => trace.relativePath).sort()
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
  return traceBytes
}

export function verifyReferenceInput({
  labelsPath,
  resultPath,
  traceDir,
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

  const labelsSha256 = verifyLabels(labelsPath, inputs, traceFiles, expected)
  const traceBytes = verifyTraceDirectory(traceDir, traceFiles)

  return {
    dataset: expected.dataset,
    datasetRevision: expected.datasetRevision,
    datasetSplit: expected.datasetSplit,
    cases: expected.caseCount,
    labelsSha256,
    traceManifestSha256,
    traceBytes,
  }
}

function main() {
  const args = process.argv.slice(2)
  if (args.length !== 2 || args[0] !== '--trace-dir' || args[1].length === 0) {
    fail(
      'usage: node scripts/verify-codetracebench-reference-input.mjs --trace-dir <imported-trace-directory>',
    )
  }

  const summary = verifyReferenceInput({
    labelsPath: join(referenceDir, 'input-labels.json'),
    resultPath: join(referenceDir, 'result.json'),
    traceDir: resolve(args[1]),
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
