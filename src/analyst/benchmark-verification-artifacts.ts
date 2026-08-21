import { createHash } from 'node:crypto'
import { constants, type Stats } from 'node:fs'
import { type FileHandle, open, readdir, realpath, stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import { compareCodeUnits } from '../ledger-core/canonical'
import type { CodeTraceBenchRow } from './benchmark-datasets'
import {
  parseVerificationOutcome,
  type VerificationOutcome,
} from './benchmark-verification-outcome'

export const DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES = 8 * 1024 * 1024

export type VerificationArtifactRole = 'final-test-output' | 'final-result' | 'final-metrics'

export interface VerificationArtifactFile {
  role: VerificationArtifactRole
  path: string
  relativePath: string
  sha256: string
  bytes: number
  spanId: string
}

export interface VerificationArtifactManifest {
  traceId: string
  status: 'present' | 'missing'
  outcome: VerificationOutcome
  outcomeSpanId: string
  caseDirectory: string
  caseDirectoriesSearched: string[]
  totalBytes: number
  maxBytes: number
  files: VerificationArtifactFile[]
  missingRoles: VerificationArtifactRole[]
  searched: Record<VerificationArtifactRole, string[]>
}

export interface LoadedVerificationArtifacts {
  manifest: VerificationArtifactManifest
  outcome: VerificationOutcome
  files: Array<VerificationArtifactFile & { content: string }>
}

const SEARCHED_ARTIFACTS: Record<VerificationArtifactRole, string[]> = {
  'final-test-output': ['panes/post-test.txt', 'sessions/tests.log', 'test_output.txt'],
  'final-result': ['results.json', 'result.json', 'report.json', '*_result.json'],
  'final-metrics': ['*_metrics.json'],
}

const REQUIRED_ROLES = new Set<VerificationArtifactRole>(['final-result'])

const UTF8 = new TextDecoder('utf-8', { fatal: true })

export async function loadCodeTraceVerificationArtifacts(options: {
  artifactDir: string
  row: CodeTraceBenchRow
  maxBytes?: number
}): Promise<LoadedVerificationArtifacts> {
  const maxBytes = positiveInteger(
    options.maxBytes ?? DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES,
    'max verification artifact bytes',
  )
  const sourceRelativePath = nonEmpty(
    options.row.source_relpath,
    `CodeTraceBench '${options.row.traj_id}' source_relpath`,
  )
  const artifactRoot = await realpath(resolve(options.artifactDir))
  const caseDirectoriesSearched = [
    resolve(artifactRoot, options.row.traj_id, sourceRelativePath),
    resolve(artifactRoot, sourceRelativePath),
  ].filter((path, index, paths) => paths.indexOf(path) === index)
  for (const path of caseDirectoriesSearched) {
    assertContained(artifactRoot, path, sourceRelativePath)
  }
  const existingCaseDirectories = new Set<string>()
  for (const path of caseDirectoriesSearched) {
    try {
      const canonicalPath = await realpath(path)
      assertContained(artifactRoot, canonicalPath, sourceRelativePath)
      const metadata = await stat(canonicalPath)
      if (!metadata.isDirectory()) {
        throw new TypeError(
          `CodeTraceBench '${options.row.traj_id}' artifact case path is not a directory: ${canonicalPath}`,
        )
      }
      existingCaseDirectories.add(canonicalPath)
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  if (existingCaseDirectories.size === 0) {
    return missingArtifacts(
      options.row.traj_id,
      caseDirectoriesSearched[0]!,
      caseDirectoriesSearched,
      maxBytes,
    )
  }
  if (existingCaseDirectories.size > 1) {
    throw new Error(
      `CodeTraceBench '${options.row.traj_id}' artifact directory is ambiguous: ${[...existingCaseDirectories].join(', ')}`,
    )
  }
  const [caseDirectory] = existingCaseDirectories

  const candidates = await artifactCandidates(caseDirectory!)
  const files: LoadedVerificationArtifacts['files'] = []
  let totalBytes = 0
  for (const candidate of candidates) {
    const snapshot = await readArtifactSnapshot({
      artifactRoot,
      candidatePath: candidate.path,
      relativePath: candidate.relativePath,
      traceId: options.row.traj_id,
      totalBytes,
      maxBytes,
    })
    const { bytes, canonicalPath } = snapshot
    totalBytes += bytes.byteLength
    let content: string
    try {
      content = UTF8.decode(bytes)
    } catch {
      throw new TypeError(
        `CodeTraceBench '${options.row.traj_id}' verification artifact is not UTF-8 text: ${canonicalPath}`,
      )
    }
    if (!content.trim()) {
      throw new Error(
        `CodeTraceBench '${options.row.traj_id}' verification artifact is empty: ${canonicalPath}`,
      )
    }
    const relativePath = candidate.relativePath
    files.push({
      role: candidate.role,
      path: canonicalPath,
      relativePath,
      sha256: sha256Digest(bytes),
      bytes: bytes.byteLength,
      spanId: verificationSpanId(candidate.role, relativePath),
      content,
    })
  }

  const roles = new Set(files.map((file) => file.role))
  const missingRoles = (Object.keys(SEARCHED_ARTIFACTS) as VerificationArtifactRole[]).filter(
    (role) => !roles.has(role),
  )
  const hasFinalVerification = [...REQUIRED_ROLES].every((role) => roles.has(role))
  const outcome = hasFinalVerification
    ? loadVerificationOutcome(
        files
          .filter((file) => file.role === 'final-result')
          .map((file) => ({ relativePath: file.relativePath, content: file.content })),
        options.row,
      )
    : unavailableOutcome('missing-result')
  const outcomeSpanId = verificationOutcomeSpanId(options.row.traj_id, outcome)
  return {
    manifest: {
      traceId: options.row.traj_id,
      status: hasFinalVerification ? 'present' : 'missing',
      outcome,
      outcomeSpanId,
      caseDirectory: caseDirectory!,
      caseDirectoriesSearched,
      totalBytes,
      maxBytes,
      files: files.map(({ content: _content, ...file }) => file),
      missingRoles,
      searched: searchedArtifacts(),
    },
    outcome,
    files,
  }
}

export function appendVerificationArtifactsToOtlp(
  otlpText: string,
  traceId: string,
  artifacts: LoadedVerificationArtifacts,
  afterTimestamp: string,
): string {
  if (!otlpText.trim()) throw new Error(`trace '${traceId}' OTLP input is empty`)
  if (artifacts.manifest.traceId !== traceId) {
    throw new Error(
      `verification artifacts for trace '${artifacts.manifest.traceId}' cannot be attached to '${traceId}'`,
    )
  }
  if (!artifacts.outcome || !artifacts.manifest.outcomeSpanId) {
    throw new Error(`trace '${traceId}' has no final verification artifacts to attach`)
  }
  const afterMs = Date.parse(afterTimestamp)
  if (!Number.isFinite(afterMs)) {
    throw new TypeError(`trace '${traceId}' latest timestamp is invalid: ${afterTimestamp}`)
  }
  const outcome = artifacts.outcome
  const outcomeLine = JSON.stringify({
    trace_id: traceId,
    span_id: artifacts.manifest.outcomeSpanId,
    parent_span_id: null,
    name: `final verification outcome: ${outcome.status}`,
    start_time: timestampAfter(afterMs, 1, traceId),
    end_time: timestampAfter(afterMs, 2, traceId),
    status: {
      code:
        outcome.status === 'passed'
          ? 'STATUS_CODE_OK'
          : outcome.status === 'failed'
            ? 'STATUS_CODE_ERROR'
            : 'STATUS_CODE_UNSET',
    },
    resource: {
      attributes: {
        'service.name': 'agent-eval-public-benchmark',
      },
    },
    attributes: {
      'openinference.span.kind': 'EVALUATOR',
      'benchmark.evidence.role': 'final-verification',
      'benchmark.verification.outcome': outcome.status,
      'benchmark.verification.passed_check_count': outcome.passedCheckCount,
      'benchmark.verification.failed_check_count': outcome.failedCheckCount,
      'benchmark.verification.passed_checks': JSON.stringify(outcome.passedChecks),
      'benchmark.verification.failed_checks': JSON.stringify(outcome.failedChecks),
      'benchmark.verification.sources': JSON.stringify(outcome.sources),
      ...(outcome.reason ? { 'benchmark.verification.reason': outcome.reason } : {}),
      ...(outcome.parseError
        ? { 'benchmark.verification.parse_error': JSON.stringify(outcome.parseError) }
        : {}),
    },
  })
  const artifactLines = artifacts.files
    .filter((artifact) => artifact.role === 'final-test-output')
    .map((artifact, index) =>
      JSON.stringify({
        trace_id: traceId,
        span_id: artifact.spanId,
        parent_span_id: null,
        name: `final verification artifact: ${artifact.relativePath}`,
        start_time: timestampAfter(afterMs, index * 2 + 3, traceId),
        end_time: timestampAfter(afterMs, index * 2 + 4, traceId),
        status: { code: 'STATUS_CODE_UNSET' },
        resource: {
          attributes: {
            'service.name': 'agent-eval-public-benchmark',
          },
        },
        attributes: {
          'openinference.span.kind': 'EVALUATOR',
          'benchmark.evidence.role': 'final-verification-artifact',
          'benchmark.verification.outcome': outcome.status,
          'artifact.role': artifact.role,
          'artifact.path': artifact.relativePath,
          'artifact.sha256': artifact.sha256,
          'artifact.bytes': artifact.bytes,
          'artifact.content': artifact.content,
        },
      }),
    )
  return `${otlpText.trimEnd()}\n${[outcomeLine, ...artifactLines].join('\n')}\n`
}

function timestampAfter(afterMs: number, offsetMs: number, traceId: string): string {
  const date = new Date(afterMs + offsetMs)
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError(`trace '${traceId}' cannot place final verification after its latest span`)
  }
  return date.toISOString()
}

export function sha256Digest(value: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(value).digest('hex')
}

async function readArtifactSnapshot(options: {
  artifactRoot: string
  candidatePath: string
  relativePath: string
  traceId: string
  totalBytes: number
  maxBytes: number
}): Promise<{ canonicalPath: string; bytes: Buffer }> {
  const safeOpenFlags =
    constants.O_RDONLY |
    (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW | constants.O_NONBLOCK)
  let handle: FileHandle
  try {
    handle = await open(options.candidatePath, safeOpenFlags)
  } catch (error) {
    if (isNodeError(error, 'ELOOP')) {
      throw new Error(
        `CodeTraceBench '${options.traceId}' verification artifact must not be a symbolic link: ${options.relativePath}`,
      )
    }
    throw error
  }

  try {
    const before = await handle.stat()
    if (!before.isFile()) {
      throw new TypeError(
        `CodeTraceBench '${options.traceId}' verification artifact is not a regular file: ${options.relativePath}`,
      )
    }
    const bytes = checkedFileSize(before.size, options)
    const descriptorPath = await openedDescriptorPath(handle.fd)
    if (descriptorPath !== null) {
      assertContained(options.artifactRoot, descriptorPath, options.relativePath)
    }

    const canonicalPath = await realpath(options.candidatePath)
    assertContained(options.artifactRoot, canonicalPath, options.relativePath)
    const current = await stat(canonicalPath)
    if (!sameFile(before, current)) {
      throw changedArtifact(options.traceId, options.relativePath)
    }

    const content = Buffer.allocUnsafe(bytes)
    let offset = 0
    while (offset < content.byteLength) {
      const { bytesRead } = await handle.read(content, offset, content.byteLength - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    const eofProbe = Buffer.allocUnsafe(1)
    const { bytesRead: trailingBytes } = await handle.read(
      eofProbe,
      0,
      eofProbe.byteLength,
      content.byteLength,
    )
    const after = await handle.stat()
    if (offset !== content.byteLength || trailingBytes !== 0 || !sameSnapshot(before, after)) {
      throw changedArtifact(options.traceId, options.relativePath)
    }
    return { canonicalPath, bytes: content }
  } finally {
    await handle.close()
  }
}

function checkedFileSize(
  bytes: number,
  options: {
    traceId: string
    relativePath: string
    totalBytes: number
    maxBytes: number
  },
): number {
  if (!Number.isSafeInteger(bytes) || bytes < 0) {
    throw new RangeError(
      `CodeTraceBench '${options.traceId}' verification artifact has an invalid byte size: ${options.relativePath}`,
    )
  }
  if (bytes > options.maxBytes) {
    throw new RangeError(
      `CodeTraceBench '${options.traceId}' verification artifact '${options.relativePath}' requires ${bytes} bytes, over the ${options.maxBytes}-byte per-file limit`,
    )
  }
  if (options.totalBytes > options.maxBytes - bytes) {
    throw new RangeError(
      `CodeTraceBench '${options.traceId}' verification artifacts require ${options.totalBytes + bytes} bytes, over the ${options.maxBytes}-byte cumulative limit`,
    )
  }
  return bytes
}

async function openedDescriptorPath(fileDescriptor: number): Promise<string | null> {
  if (process.platform !== 'linux') return null
  try {
    return await realpath(`/proc/self/fd/${fileDescriptor}`)
  } catch (error) {
    if (
      isNodeError(error, 'ENOENT') ||
      isNodeError(error, 'ENOTDIR') ||
      isNodeError(error, 'EACCES')
    ) {
      return null
    }
    throw error
  }
}

function sameFile(left: Stats, right: Stats): boolean {
  return (
    left.isFile() &&
    right.isFile() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size
  )
}

function sameSnapshot(left: Stats, right: Stats): boolean {
  return (
    sameFile(left, right) &&
    left.mode === right.mode &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  )
}

function changedArtifact(traceId: string, relativePath: string): Error {
  return new Error(
    `CodeTraceBench '${traceId}' verification artifact changed while being read: ${relativePath}`,
  )
}

async function artifactCandidates(
  caseDirectory: string,
): Promise<Array<{ role: VerificationArtifactRole; path: string; relativePath: string }>> {
  const entries = await readdir(caseDirectory, { withFileTypes: true })
  const rootFiles = entries
    .filter((entry) => entry.isFile() || entry.isSymbolicLink())
    .map((entry) => entry.name)
  const testOutput = await firstExisting(caseDirectory, SEARCHED_ARTIFACTS['final-test-output'])
  const finalResults = [
    ...SEARCHED_ARTIFACTS['final-result']
      .filter((name) => !name.includes('*'))
      .map((name) => resolve(caseDirectory, name)),
    ...rootFiles
      .filter((name) => name.endsWith('_result.json'))
      .map((name) => resolve(caseDirectory, name)),
  ]
  const finalMetrics = rootFiles
    .filter((name) => name.endsWith('_metrics.json'))
    .map((name) => resolve(caseDirectory, name))

  const candidates = [
    ...testOutput.map((path) => candidate('final-test-output', caseDirectory, path)),
    ...(await existing(finalResults)).map((path) => candidate('final-result', caseDirectory, path)),
    ...(await existing(finalMetrics)).map((path) =>
      candidate('final-metrics', caseDirectory, path),
    ),
  ]
  const seen = new Set<string>()
  return candidates
    .filter((entry) => {
      if (seen.has(entry.path)) return false
      seen.add(entry.path)
      return true
    })
    .sort(
      (left, right) =>
        artifactRoleOrder(left.role) - artifactRoleOrder(right.role) ||
        compareCodeUnits(left.relativePath, right.relativePath),
    )
}

async function firstExisting(
  caseDirectory: string,
  candidates: readonly string[],
): Promise<string[]> {
  for (const relativePath of candidates) {
    const path = resolve(caseDirectory, relativePath)
    if (await isFile(path)) return [path]
  }
  return []
}

async function existing(paths: readonly string[]): Promise<string[]> {
  const out: string[] = []
  for (const path of paths) {
    if (await isFile(path)) out.push(path)
  }
  return out
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch (error) {
    if (isMissing(error)) return false
    throw error
  }
}

function candidate(
  role: VerificationArtifactRole,
  caseDirectory: string,
  path: string,
): { role: VerificationArtifactRole; path: string; relativePath: string } {
  return { role, path, relativePath: slashRelative(caseDirectory, path) }
}

function missingArtifacts(
  traceId: string,
  caseDirectory: string,
  caseDirectoriesSearched: string[],
  maxBytes: number,
): LoadedVerificationArtifacts {
  const outcome = unavailableOutcome('missing-result')
  return {
    manifest: {
      traceId,
      status: 'missing',
      outcome,
      outcomeSpanId: verificationOutcomeSpanId(traceId, outcome),
      caseDirectory,
      caseDirectoriesSearched,
      totalBytes: 0,
      maxBytes,
      files: [],
      missingRoles: Object.keys(SEARCHED_ARTIFACTS) as VerificationArtifactRole[],
      searched: searchedArtifacts(),
    },
    outcome,
    files: [],
  }
}

function verificationOutcomeSpanId(traceId: string, outcome: VerificationOutcome): string {
  return `benchmark-verification-outcome-${sha256Digest(
    `${traceId}\u0000${JSON.stringify(outcome.sources)}\u0000${outcome.status}`,
  ).slice(0, 16)}`
}

function unavailableOutcome(
  reason: NonNullable<VerificationOutcome['reason']>,
): VerificationOutcome {
  return {
    status: 'unavailable',
    reason,
    sources: [],
    passedCheckCount: 0,
    failedCheckCount: 0,
    passedChecks: [],
    failedChecks: [],
  }
}

function loadVerificationOutcome(
  files: Parameters<typeof parseVerificationOutcome>[0],
  row: CodeTraceBenchRow,
): VerificationOutcome {
  try {
    const outcome = parseVerificationOutcome(files)
    if (outcome.status === 'unavailable' || typeof row.solved !== 'boolean') {
      return outcome
    }
    const labelStatus = row.solved ? 'passed' : 'failed'
    if (outcome.status === labelStatus) {
      return outcome
    }
    return {
      ...outcome,
      status: 'unavailable',
      reason: 'result-label-disagreement',
      parseError: {
        class: 'ResultLabelDisagreementError',
        message: `CodeTraceBench '${row.traj_id}' solved=${row.solved} disagrees with parsed final verification status '${outcome.status}' from ${outcome.sources
          .map((source) => `${source.path}=${source.status}`)
          .join(', ')}`,
      },
    }
  } catch (error) {
    return {
      ...unavailableOutcome('result-parse-error'),
      parseError: {
        class: error instanceof Error ? error.constructor.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function verificationSpanId(role: VerificationArtifactRole, relativePath: string): string {
  return `benchmark-verification-${sha256Digest(`${role}\u0000${relativePath}`).slice(0, 16)}`
}

function artifactRoleOrder(role: VerificationArtifactRole): number {
  return role === 'final-test-output' ? 0 : role === 'final-result' ? 1 : 2
}

function assertContained(root: string, candidate: string, source: string): void {
  const rel = relative(root, candidate)
  if (isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) {
    throw new Error(`verification artifact path escapes --artifact-dir: ${source}`)
  }
}

function searchedArtifacts(): Record<VerificationArtifactRole, string[]> {
  return {
    'final-test-output': [...SEARCHED_ARTIFACTS['final-test-output']],
    'final-result': [...SEARCHED_ARTIFACTS['final-result']],
    'final-metrics': [...SEARCHED_ARTIFACTS['final-metrics']],
  }
}

function slashRelative(root: string, path: string): string {
  return relative(root, path).split(sep).join('/')
}

function nonEmpty(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new TypeError(`${field} must be a non-empty string`)
  }
  return value.trim()
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
  return value
}

function isMissing(error: unknown): boolean {
  return isNodeError(error, 'ENOENT')
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
