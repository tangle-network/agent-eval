import { createHash } from 'node:crypto'
import { readdir, readFile, realpath, stat } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { TextDecoder } from 'node:util'
import type { CodeTraceBenchRow } from './benchmark-datasets'

export const DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES = 2 * 1024 * 1024

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
  files: Array<VerificationArtifactFile & { content: string }>
}

const SEARCHED_ARTIFACTS: Record<VerificationArtifactRole, string[]> = {
  'final-test-output': ['panes/post-test.txt', 'sessions/tests.log'],
  'final-result': ['results.json', 'result.json', '*_result.json'],
  'final-metrics': ['*_metrics.json'],
}

const REQUIRED_ROLES = new Set<VerificationArtifactRole>(['final-test-output', 'final-result'])

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
    const canonicalPath = await realpath(candidate.path)
    assertContained(artifactRoot, canonicalPath, candidate.relativePath)
    const metadata = await stat(canonicalPath)
    if (!metadata.isFile()) continue
    const bytes = await readFile(canonicalPath)
    totalBytes += bytes.byteLength
    if (totalBytes > maxBytes) {
      throw new RangeError(
        `CodeTraceBench '${options.row.traj_id}' verification artifacts require ${totalBytes} bytes, over the ${maxBytes}-byte limit`,
      )
    }
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
    const relativePath = slashRelative(caseDirectory!, canonicalPath)
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
  const hasFinalVerification = [...REQUIRED_ROLES].some((role) => roles.has(role))
  return {
    manifest: {
      traceId: options.row.traj_id,
      status: hasFinalVerification ? 'present' : 'missing',
      caseDirectory: caseDirectory!,
      caseDirectoriesSearched,
      totalBytes,
      maxBytes,
      files: files.map(({ content: _content, ...file }) => file),
      missingRoles,
      searched: searchedArtifacts(),
    },
    files,
  }
}

export function appendVerificationArtifactsToOtlp(
  otlpText: string,
  traceId: string,
  artifacts: LoadedVerificationArtifacts,
): string {
  if (!otlpText.trim()) throw new Error(`trace '${traceId}' OTLP input is empty`)
  if (artifacts.manifest.traceId !== traceId) {
    throw new Error(
      `verification artifacts for trace '${artifacts.manifest.traceId}' cannot be attached to '${traceId}'`,
    )
  }
  if (artifacts.manifest.status !== 'present' || artifacts.files.length === 0) {
    throw new Error(`trace '${traceId}' has no final verification artifacts to attach`)
  }
  const lines = artifacts.files.map((artifact, index) =>
    JSON.stringify({
      trace_id: traceId,
      span_id: artifact.spanId,
      parent_span_id: null,
      name: `final verification: ${artifact.relativePath}`,
      start_time: new Date(Date.UTC(2099, 0, 1, 0, 0, index)).toISOString(),
      end_time: new Date(Date.UTC(2099, 0, 1, 0, 0, index, 1)).toISOString(),
      status: { code: 'STATUS_CODE_OK' },
      resource: {
        attributes: {
          'service.name': 'agent-eval-public-benchmark',
        },
      },
      attributes: {
        'openinference.span.kind': 'EVALUATOR',
        'benchmark.evidence.role': 'final-verification',
        'artifact.role': artifact.role,
        'artifact.path': artifact.relativePath,
        'artifact.sha256': artifact.sha256,
        'artifact.bytes': artifact.bytes,
        'artifact.content': artifact.content,
      },
    }),
  )
  return `${otlpText.trimEnd()}\n${lines.join('\n')}\n`
}

export function sha256Digest(value: string | NodeJS.ArrayBufferView): string {
  return createHash('sha256').update(value).digest('hex')
}

async function artifactCandidates(
  caseDirectory: string,
): Promise<Array<{ role: VerificationArtifactRole; path: string; relativePath: string }>> {
  const entries = await readdir(caseDirectory, { withFileTypes: true })
  const rootFiles = entries.filter((entry) => entry.isFile()).map((entry) => entry.name)
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
        left.relativePath.localeCompare(right.relativePath),
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
  return {
    manifest: {
      traceId,
      status: 'missing',
      caseDirectory,
      caseDirectoriesSearched,
      totalBytes: 0,
      maxBytes,
      files: [],
      missingRoles: Object.keys(SEARCHED_ARTIFACTS) as VerificationArtifactRole[],
      searched: searchedArtifacts(),
    },
    files: [],
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
  if (rel === '..' || rel.startsWith(`..${sep}`)) {
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
  return (
    error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
  )
}
