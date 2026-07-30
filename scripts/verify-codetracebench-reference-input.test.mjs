import { createHash } from 'node:crypto'
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, test } from 'vitest'
import { verifyReferenceInput } from './verify-codetracebench-reference-input.mjs'

const tempRoots = []

afterEach(() => {
  for (const root of tempRoots.splice(0)) rmSync(root, { force: true, recursive: true })
})

function sha256(value) {
  return createHash('sha256').update(value).digest('hex')
}

function canonicalJson(value) {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') {
    return JSON.stringify(value)
  }
  if (typeof value === 'number') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`
  return `{${Object.keys(value)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`)
    .join(',')}}`
}

function sortTraceFiles(traceFiles) {
  return [...traceFiles].sort((left, right) => {
    if (left.traceId < right.traceId) return -1
    if (left.traceId > right.traceId) return 1
    return 0
  })
}

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'codetracebench-input-'))
  tempRoots.push(root)

  const labelsPath = join(root, 'labels.json')
  const resultPath = join(root, 'result.json')
  const traceDir = join(root, 'traces')
  const labelsBytes = Buffer.from(
    `${JSON.stringify(
      [
        { traj_id: 'case-a', source_relpath: 'source/case-a' },
        { traj_id: 'case-b', source_relpath: 'source/case-b' },
      ],
      null,
      2,
    )}\n`,
  )
  const traces = [
    {
      traceId: 'case-b',
      relativePath: 'case-b.otlp.jsonl',
      bytes: Buffer.from('{"step":2}\n'),
    },
    {
      traceId: 'case-a',
      relativePath: 'case-a.otlp.jsonl',
      bytes: Buffer.from('{"step":1}\n'),
    },
  ]
  const traceFiles = traces.map(({ traceId, relativePath, bytes }) => ({
    traceId,
    relativePath,
    sha256: sha256(bytes),
  }))

  writeFileSync(labelsPath, labelsBytes)
  return { labelsBytes, labelsPath, resultPath, root, traceDir, traceFiles, traces }
}

function completeFixture() {
  const fixture = makeFixture()
  const { labelsBytes, resultPath, root, traceDir, traceFiles, traces } = fixture
  mkdirSync(traceDir)
  for (const trace of traces) writeFileSync(join(traceDir, trace.relativePath), trace.bytes)
  const receiptTraces = traces.map((trace, index) => ({
    index,
    traceId: trace.traceId,
    output: {
      path: trace.relativePath,
      sha256: sha256(trace.bytes),
      bytes: trace.bytes.length,
    },
  }))
  const importOutputSha256 = sha256(
    JSON.stringify(
      receiptTraces.map((trace) => ({
        traceId: trace.traceId,
        sha256: trace.output.sha256,
      })),
    ),
  )
  writeFileSync(
    join(traceDir, 'codetracebench-import.json'),
    JSON.stringify({
      kind: 'traces.codetracebench-import',
      input: {
        revision: 'fixture-revision',
        rowsSha256: sha256(labelsBytes),
      },
      counts: { traces: 2 },
      settings: { outputLayout: '<traj_id>.otlp.jsonl' },
      safety: { labelLeakScan: 'passed' },
      traces: receiptTraces,
      outputSha256: importOutputSha256,
    }),
  )
  const artifactDir = join(root, 'artifacts')
  mkdirSync(artifactDir)
  const maxArtifactBytes = 1024
  const verificationArtifacts = traces.map((trace) => {
    const sourceRelativePath = `source/${trace.traceId}`
    const caseDirectory = `${trace.traceId}/${sourceRelativePath}`
    const absoluteCaseDirectory = join(artifactDir, ...caseDirectory.split('/'))
    mkdirSync(absoluteCaseDirectory, { recursive: true })
    const bytes = Buffer.from(`{"case":"${trace.traceId}","passed":true}\n`)
    writeFileSync(join(absoluteCaseDirectory, 'result.json'), bytes)
    return {
      traceId: trace.traceId,
      status: 'present',
      outcome: {
        status: 'passed',
        sources: [{ path: 'result.json', format: 'terminal-bench', status: 'passed' }],
        passedCheckCount: 1,
        failedCheckCount: 0,
        passedChecks: ['passed'],
        failedChecks: [],
      },
      outcomeSpanId: `outcome-${trace.traceId}`,
      caseDirectory,
      caseDirectoriesSearched: [caseDirectory, sourceRelativePath],
      totalBytes: bytes.length,
      maxBytes: maxArtifactBytes,
      files: [
        {
          role: 'final-result',
          path: `${caseDirectory}/result.json`,
          relativePath: 'result.json',
          sha256: sha256(bytes),
          bytes: bytes.length,
          spanId: `result-${trace.traceId}`,
        },
      ],
      missingRoles: ['final-test-output', 'final-metrics'],
      searched: {
        'final-test-output': ['panes/post-test.txt', 'sessions/tests.log', 'test_output.txt'],
        'final-result': ['results.json', 'result.json', 'report.json', '*_result.json'],
        'final-metrics': ['*_metrics.json'],
      },
    }
  })

  const expected = {
    dataset: 'codetracebench',
    datasetRevision: 'fixture-revision',
    datasetSplit: 'fixture-split',
    caseCount: 2,
    labelsSha256: sha256(labelsBytes),
    traceManifestSha256: sha256(JSON.stringify(sortTraceFiles(traceFiles))),
    importOutputSha256,
    verificationArtifactsSha256: sha256(canonicalJson(verificationArtifacts)),
  }
  writeFileSync(
    resultPath,
    JSON.stringify({
      inputs: {
        dataset: expected.dataset,
        datasetRevision: expected.datasetRevision,
        datasetSplit: expected.datasetSplit,
        labelsSha256: expected.labelsSha256,
        sourceRowCount: expected.caseCount,
        traceFiles,
        verificationArtifacts,
        execution: { maxArtifactBytes },
      },
    }),
  )
  return { ...fixture, artifactDir, expected, verificationArtifacts }
}

test('accepts the exact labels and trace bytes', () => {
  const fixture = completeFixture()
  const summary = verifyReferenceInput(fixture)
  expect(summary).toEqual({
    dataset: 'codetracebench',
    datasetRevision: 'fixture-revision',
    datasetSplit: 'fixture-split',
    cases: 2,
    labelsSha256: fixture.expected.labelsSha256,
    traceManifestSha256: fixture.expected.traceManifestSha256,
    traceBytes: 22,
    importOutputSha256: fixture.expected.importOutputSha256,
    verificationArtifactsSha256: fixture.expected.verificationArtifactsSha256,
    artifactBytes: fixture.verificationArtifacts.reduce((sum, row) => sum + row.totalBytes, 0),
    artifactFiles: 2,
    presentCases: 2,
    missingCases: 0,
  })
})

test('uses the same manifest for the same trace files in a different order', () => {
  const fixture = completeFixture()
  const result = JSON.parse(readFileSync(fixture.resultPath, 'utf8'))
  result.inputs.traceFiles.reverse()
  writeFileSync(fixture.resultPath, JSON.stringify(result))

  expect(verifyReferenceInput(fixture).traceManifestSha256).toBe(
    fixture.expected.traceManifestSha256,
  )
})

test('rejects changed trace bytes', () => {
  const fixture = completeFixture()
  writeFileSync(join(fixture.traceDir, 'case-a.otlp.jsonl'), '{"step":9}\n')
  expect(() => verifyReferenceInput(fixture)).toThrow(/case-a SHA-256 mismatch/)
})

test('rejects extra trace files', () => {
  const fixture = completeFixture()
  writeFileSync(join(fixture.traceDir, 'extra.jsonl'), '{}\n')
  expect(() => verifyReferenceInput(fixture)).toThrow(/extra \[extra\.jsonl\]/)
})

test('rejects linked trace files', () => {
  const fixture = completeFixture()
  rmSync(join(fixture.traceDir, 'case-a.otlp.jsonl'))
  symlinkSync(
    join(fixture.traceDir, 'case-b.otlp.jsonl'),
    join(fixture.traceDir, 'case-a.otlp.jsonl'),
  )
  expect(() => verifyReferenceInput(fixture)).toThrow(
    /must be a regular file: case-a\.otlp\.jsonl/,
  )
})

test('rejects unsafe paths from the result', () => {
  const fixture = completeFixture()
  const result = JSON.parse(readFileSync(fixture.resultPath, 'utf8'))
  result.inputs.traceFiles[0].relativePath = '../case-b.jsonl'
  writeFileSync(fixture.resultPath, JSON.stringify(result))
  expect(() => verifyReferenceInput(fixture)).toThrow(/unsafe relativePath/)
})

test('rejects changed verification artifact bytes', () => {
  const fixture = completeFixture()
  const [first] = fixture.verificationArtifacts
  writeFileSync(
    join(fixture.artifactDir, ...first.files[0].path.split('/')),
    '{"case":"changed","passed":true}\n',
  )
  expect(() => verifyReferenceInput(fixture)).toThrow(/verification artifact .* SHA-256 mismatch/)
})
