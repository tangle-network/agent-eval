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

function makeFixture() {
  const root = mkdtempSync(join(tmpdir(), 'codetracebench-input-'))
  tempRoots.push(root)

  const labelsPath = join(root, 'labels.json')
  const resultPath = join(root, 'result.json')
  const traceDir = join(root, 'traces')
  const labelsBytes = Buffer.from(
    `${JSON.stringify([{ traj_id: 'case-a' }, { traj_id: 'case-b' }], null, 2)}\n`,
  )
  const traces = [
    {
      traceId: 'case-b',
      relativePath: 'case-b.jsonl',
      bytes: Buffer.from('{"step":2}\n'),
    },
    {
      traceId: 'case-a',
      relativePath: 'case-a.jsonl',
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
  const { labelsBytes, resultPath, traceDir, traceFiles, traces } = fixture
  mkdirSync(traceDir)
  for (const trace of traces) writeFileSync(join(traceDir, trace.relativePath), trace.bytes)

  const expected = {
    dataset: 'codetracebench',
    datasetRevision: 'fixture-revision',
    datasetSplit: 'fixture-split',
    caseCount: 2,
    labelsSha256: sha256(labelsBytes),
    traceManifestSha256: sha256(JSON.stringify(traceFiles)),
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
      },
    }),
  )
  return { ...fixture, expected }
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
  })
})

test('rejects changed trace bytes', () => {
  const fixture = completeFixture()
  writeFileSync(join(fixture.traceDir, 'case-a.jsonl'), '{"step":9}\n')
  expect(() => verifyReferenceInput(fixture)).toThrow(/case-a SHA-256 mismatch/)
})

test('rejects extra trace files', () => {
  const fixture = completeFixture()
  writeFileSync(join(fixture.traceDir, 'extra.jsonl'), '{}\n')
  expect(() => verifyReferenceInput(fixture)).toThrow(/extra \[extra\.jsonl\]/)
})

test('rejects linked trace files', () => {
  const fixture = completeFixture()
  rmSync(join(fixture.traceDir, 'case-a.jsonl'))
  symlinkSync(join(fixture.traceDir, 'case-b.jsonl'), join(fixture.traceDir, 'case-a.jsonl'))
  expect(() => verifyReferenceInput(fixture)).toThrow(/must be a regular file: case-a\.jsonl/)
})

test('rejects unsafe paths from the result', () => {
  const fixture = completeFixture()
  const result = JSON.parse(readFileSync(fixture.resultPath, 'utf8'))
  result.inputs.traceFiles[0].relativePath = '../case-b.jsonl'
  writeFileSync(fixture.resultPath, JSON.stringify(result))
  expect(() => verifyReferenceInput(fixture)).toThrow(/unsafe relativePath/)
})
