import { constants } from 'node:fs'
import { type FileHandle, open, readdir } from 'node:fs/promises'
import { relative, resolve, sep } from 'node:path'
import { compareCodeUnits } from '../ledger-core/canonical'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import {
  createOtlpBufferTraceStore,
  DEFAULT_MAX_TRACE_FILE_BYTES,
  otlpTextToTraceAnalysisStore,
} from '../trace-analyst/store-otlp'
import { type AnalystBenchmarkCase, traceStoreEvidenceResolver } from './benchmark'
import {
  type AgentRxRow,
  agentRxBenchmarkCase,
  type CodeTraceBenchRow,
  codeTraceBenchCase,
} from './benchmark-datasets'
import {
  assertNoBenchmarkLabelsInArtifact,
  assertNoBenchmarkLabelsInTrace,
} from './benchmark-evidence-validation'
import {
  isRecord,
  type PreparedPublicAnalystBenchmark,
  type PublicAnalystBenchmarkDataset,
  type PublicBenchmarkDistributions,
  type PublicBenchmarkSelectionReport,
  type PublicBenchmarkValueDistribution,
  positiveSafeInteger,
  safeInteger,
} from './benchmark-public-types'
import {
  appendVerificationArtifactsToOtlp,
  DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES,
  loadCodeTraceVerificationArtifacts,
  sha256Digest,
  type VerificationArtifactManifest,
} from './benchmark-verification-artifacts'
import type { AnalystRunInputs } from './types'

const DEFAULT_MAX_PUBLIC_BENCHMARK_LABEL_BYTES = 256 * 1024 * 1024
const INPUT_OPEN_FLAGS = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)

interface ImmutableInputSnapshot {
  bytes: Buffer
  sha256: string
  text: string
}

export async function loadPublicBenchmarkRows(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  const snapshot = await readImmutableInputSnapshot(
    resolve(path),
    DEFAULT_MAX_PUBLIC_BENCHMARK_LABEL_BYTES,
  )
  return parsePublicBenchmarkRows(snapshot.text, path)
}

function parsePublicBenchmarkRows(text: string, path: string): Array<Record<string, unknown>> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error(`public analyst benchmark dataset is empty: ${path}`)

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return parseJsonl(trimmed, path)
  }
  if (Array.isArray(parsed)) return records(parsed, path)
  if (isRecord(parsed) && Array.isArray(parsed.data)) return records(parsed.data, `${path}.data`)
  if (isRecord(parsed) && Array.isArray(parsed.cases)) {
    return records(parsed.cases, `${path}.cases`)
  }
  if (isRecord(parsed)) return [parsed]
  throw new TypeError(`public analyst benchmark dataset must contain JSON objects: ${path}`)
}

export function selectPublicBenchmarkRows(
  dataset: PublicAnalystBenchmarkDataset,
  rows: readonly Record<string, unknown>[],
  options: { limit: number; seed: number },
): Array<Record<string, unknown>> {
  positiveSafeInteger(options.limit, 'limit')
  safeInteger(options.seed, 'seed')
  if (rows.length === 0) throw new Error('public analyst benchmark dataset has no rows')

  const byId = new Map<string, Record<string, unknown>>()
  for (const row of rows) {
    const id = publicBenchmarkRowId(dataset, row)
    if (byId.has(id)) {
      throw new Error(`public analyst benchmark dataset repeats trajectory id '${id}'`)
    }
    byId.set(id, row)
  }

  return [...byId]
    .sort(
      ([left], [right]) =>
        compareCodeUnits(selectionKey(options.seed, left), selectionKey(options.seed, right)) ||
        compareCodeUnits(left, right),
    )
    .slice(0, Math.min(options.limit, byId.size))
    .map(([, row]) => row)
}

export function publicBenchmarkDistributions(
  dataset: PublicAnalystBenchmarkDataset,
  rows: readonly Record<string, unknown>[],
): PublicBenchmarkDistributions {
  const values: Record<keyof PublicBenchmarkDistributions, Array<string | undefined>> = {
    class: [],
    agent: [],
    model: [],
    difficulty: [],
    solved: [],
  }
  for (const row of rows) {
    const benchmarkCase =
      dataset === 'agentrx'
        ? agentRxBenchmarkCase(row as unknown as AgentRxRow, undefined)
        : codeTraceBenchCase(row as unknown as CodeTraceBenchRow, undefined)
    values.class.push(
      dataset === 'codetracebench'
        ? benchmarkCase.expectedIssues.length > 0
          ? 'positive'
          : row.solved === true
            ? 'trusted-negative'
            : row.solved === false
              ? 'unlabeled-failure'
              : 'unlabeled-unknown'
        : benchmarkCase.expectedIssues[0]?.areas?.[0],
    )
    values.agent.push(
      scalarDistributionValue(row.agent) ??
        (dataset === 'agentrx' ? rootAgent(row as unknown as AgentRxRow) : undefined),
    )
    values.model.push(scalarDistributionValue(row.model))
    values.difficulty.push(scalarDistributionValue(row.difficulty))
    values.solved.push(scalarDistributionValue(row.solved))
  }
  return {
    class: valueDistribution(values.class),
    agent: valueDistribution(values.agent),
    model: valueDistribution(values.model),
    difficulty: valueDistribution(values.difficulty),
    solved: valueDistribution(values.solved),
  }
}

export function publicBenchmarkSelectionReport(
  dataset: PublicAnalystBenchmarkDataset,
  source: readonly Record<string, unknown>[],
  selected: readonly Record<string, unknown>[],
  seed: number,
): PublicBenchmarkSelectionReport {
  const census = source.length === selected.length
  return {
    method: census ? 'census' : 'deterministic-hash',
    seed,
    sourceCount: source.length,
    selectedCount: selected.length,
    stratified: false,
    representativeOfInput: census,
    source: publicBenchmarkDistributions(dataset, source),
    selected: publicBenchmarkDistributions(dataset, selected),
  }
}

export async function preparePublicAnalystBenchmark(options: {
  dataset: PublicAnalystBenchmarkDataset
  labelsPath: string
  traceDir: string
  artifactDir?: string
  maxArtifactBytes?: number
  limit: number
  seed: number
}): Promise<PreparedPublicAnalystBenchmark> {
  const labelsPath = resolve(options.labelsPath)
  const traceRoot = resolve(options.traceDir)
  const artifactRoot = options.artifactDir ? resolve(options.artifactDir) : undefined
  const labelSnapshot = await readImmutableInputSnapshot(
    labelsPath,
    DEFAULT_MAX_PUBLIC_BENCHMARK_LABEL_BYTES,
  )
  const rows = parsePublicBenchmarkRows(labelSnapshot.text, labelsPath)
  const selected = selectPublicBenchmarkRows(options.dataset, rows, {
    limit: options.limit,
    seed: options.seed,
  })
  const selectedTrajectoryIds = new Set(
    selected.map((row) => publicBenchmarkRowId(options.dataset, row)),
  )
  const stores = await indexSelectedSingleTraceFiles(traceRoot, selectedTrajectoryIds)
  const resolver = traceStoreEvidenceResolver<AnalystRunInputs>((input) => {
    if (!input.traceStore) throw new Error('prepared benchmark case has no trace store')
    return input.traceStore
  })
  const traceFiles: PreparedPublicAnalystBenchmark['traceFiles'] = []
  const verificationArtifacts: VerificationArtifactManifest[] = []
  const cases: AnalystBenchmarkCase<AnalystRunInputs>[] = []

  for (const row of selected) {
    const trajectoryId = publicBenchmarkRowId(options.dataset, row)
    const indexed = stores.get(trajectoryId)
    if (!indexed) {
      throw new Error(
        `public analyst benchmark trace directory has no single-trace OTLP JSONL for '${trajectoryId}'`,
      )
    }
    let modelVisibleOtlp = indexed.text
    let traceStore = indexed.store
    let artifactDir: string | undefined
    let verificationManifest: VerificationArtifactManifest | undefined
    if (options.dataset === 'codetracebench') {
      if (!options.artifactDir?.trim()) {
        throw new Error(
          '--artifact-dir is required for CodeTraceBench so final verification evidence is not omitted',
        )
      }
      const artifacts = await loadCodeTraceVerificationArtifacts({
        artifactDir: options.artifactDir,
        row: row as unknown as CodeTraceBenchRow,
        maxBytes: options.maxArtifactBytes ?? DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES,
      })
      for (const artifact of artifacts.files) {
        assertNoBenchmarkLabelsInArtifact({
          traceId: trajectoryId,
          relativePath: artifact.relativePath,
          content: artifact.content,
        })
      }
      verificationManifest = shareableVerificationManifest(
        artifacts.manifest,
        artifactRoot ?? resolve(options.artifactDir),
      )
      const collisions = await indexed.store.hasSpans({
        trace_id: trajectoryId,
        span_ids: [
          ...artifacts.manifest.files.map((file) => file.spanId),
          artifacts.manifest.outcomeSpanId,
        ],
      })
      if (collisions.length > 0) {
        throw new Error(
          `CodeTraceBench '${trajectoryId}' trace already contains benchmark verification span '${collisions[0]}'`,
        )
      }
      modelVisibleOtlp = appendVerificationArtifactsToOtlp(
        indexed.text,
        trajectoryId,
        artifacts,
        indexed.latestTimestamp,
      )
      traceStore = otlpTextToTraceAnalysisStore(modelVisibleOtlp)
      artifactDir =
        artifacts.manifest.status === 'present' ? artifacts.manifest.caseDirectory : undefined
      verificationArtifacts.push(verificationManifest)
    }
    const labelLeakScan = assertNoBenchmarkLabelsInTrace({
      traceId: trajectoryId,
      otlpText: modelVisibleOtlp,
    })

    const input: AnalystRunInputs = { traceStore, artifactDir }
    const benchmarkCase =
      options.dataset === 'agentrx'
        ? agentRxBenchmarkCase(row as unknown as AgentRxRow, input, {
            stepCount: indexed.stepCount,
          })
        : codeTraceBenchCase(row as unknown as CodeTraceBenchRow, input)

    for (const evidence of benchmarkCase.labeledEvidence ?? []) {
      const resolved = await resolver({
        caseId: benchmarkCase.id,
        caseInput: input,
        evidence: { kind: evidence.kind ?? 'span', uri: evidence.uri },
      })
      if (!resolved) {
        throw new Error(
          `${benchmarkCase.id}: missing labeled span ${spanIdFromEvidence(evidence.uri) ?? evidence.uri} in ${indexed.path}`,
        )
      }
    }

    cases.push({
      ...benchmarkCase,
      metadata: {
        ...benchmarkCase.metadata,
        traceFileRelativePath: slashRelative(traceRoot, indexed.path),
        traceFileSha256: indexed.sha256,
        labelLeakScan,
        ...(verificationManifest ? { verificationArtifacts: verificationManifest } : {}),
      },
    })
    traceFiles.push({
      traceId: trajectoryId,
      relativePath: slashRelative(traceRoot, indexed.path),
      sha256: indexed.sha256,
    })
  }

  return {
    cases,
    sourceRowCount: rows.length,
    selectedCaseIds: cases.map((testCase) => testCase.id),
    labelsSha256: labelSnapshot.sha256,
    traceFiles,
    verificationArtifacts,
    selection: publicBenchmarkSelectionReport(options.dataset, rows, selected, options.seed),
  }
}

async function indexSelectedSingleTraceFiles(
  traceDir: string,
  selectedTraceIds: ReadonlySet<string>,
): Promise<
  Map<
    string,
    {
      path: string
      sha256: string
      store: TraceAnalysisStore
      latestTimestamp: string
      text: string
      stepCount: number
    }
  >
> {
  if (selectedTraceIds.size === 0) {
    throw new Error('public analyst benchmark selected no trace ids')
  }
  const entries = await readdir(traceDir, { withFileTypes: true })
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl'))
    .map((entry) => resolve(traceDir, entry.name))
    .sort()
  if (files.length === 0) {
    throw new Error(`public analyst benchmark trace directory has no JSONL files: ${traceDir}`)
  }

  const indexed = new Map<
    string,
    {
      path: string
      sha256: string
      store: TraceAnalysisStore
      latestTimestamp: string
      text: string
      stepCount: number
    }
  >()
  for (const path of files) {
    const snapshot = await readImmutableInputSnapshot(path, DEFAULT_MAX_TRACE_FILE_BYTES)
    const store = createOtlpBufferTraceStore(snapshot.bytes)
    const overview = await store.getOverview()
    if (overview.total_traces !== 1 || overview.sample_trace_ids.length !== 1) {
      throw new Error(
        `public analyst benchmark trace file must contain exactly one trace: ${path} contains ${overview.total_traces}`,
      )
    }
    if (!overview.time_range) {
      throw new Error(`public analyst benchmark trace file has no valid timestamps: ${path}`)
    }
    const traceId = overview.sample_trace_ids[0]!
    if (!selectedTraceIds.has(traceId)) continue
    if (indexed.has(traceId)) {
      throw new Error(`public analyst benchmark trace id '${traceId}' appears in multiple files`)
    }
    indexed.set(traceId, {
      path,
      sha256: snapshot.sha256,
      store,
      latestTimestamp: overview.time_range.latest,
      text: snapshot.text,
      stepCount: traceStepCount(snapshot.text, path),
    })
  }
  return indexed
}

async function readImmutableInputSnapshot(
  path: string,
  maxBytes: number,
): Promise<ImmutableInputSnapshot> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw new RangeError('benchmark input maxBytes must be a positive safe integer')
  }
  const handle = await open(path, INPUT_OPEN_FLAGS)
  try {
    return await readImmutableInputHandle(handle, path, maxBytes)
  } finally {
    await handle.close()
  }
}

async function readImmutableInputHandle(
  handle: FileHandle,
  path: string,
  maxBytes: number,
): Promise<ImmutableInputSnapshot> {
  const before = await handle.stat({ bigint: true })
  if (!before.isFile()) {
    throw new TypeError(`public analyst benchmark input must be a regular file: ${path}`)
  }
  if (before.size > BigInt(maxBytes)) {
    throw new RangeError(
      `public analyst benchmark input exceeds ${maxBytes} bytes: ${path} has ${before.size}`,
    )
  }

  const size = Number(before.size)
  const bytes = Buffer.allocUnsafe(size)
  let offset = 0
  while (offset < size) {
    const result = await handle.read(bytes, offset, size - offset, offset)
    if (result.bytesRead === 0) {
      throw new Error(`public analyst benchmark input changed while being read: ${path}`)
    }
    offset += result.bytesRead
  }
  const overflow = Buffer.allocUnsafe(1)
  const extra = await handle.read(overflow, 0, 1, size)
  const after = await handle.stat({ bigint: true })
  if (
    extra.bytesRead !== 0 ||
    before.dev !== after.dev ||
    before.ino !== after.ino ||
    before.size !== after.size ||
    before.mtimeNs !== after.mtimeNs ||
    before.ctimeNs !== after.ctimeNs
  ) {
    throw new Error(`public analyst benchmark input changed while being read: ${path}`)
  }

  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch (error) {
    throw new TypeError(
      `public analyst benchmark input is not valid UTF-8: ${path}: ${error instanceof Error ? error.message : String(error)}`,
    )
  }
  return Object.freeze({
    bytes,
    sha256: sha256Digest(bytes),
    text,
  })
}

function traceStepCount(text: string, path: string): number {
  const steps = parseJsonl(text, path)
    .map((row) => row.span_id)
    .filter((spanId): spanId is string => typeof spanId === 'string')
    .map((spanId) => /^step-(\d+)$/.exec(spanId)?.[1])
    .filter((step): step is string => step !== undefined)
    .map(Number)
    .filter((step) => Number.isSafeInteger(step) && step > 0)
  if (steps.length === 0) {
    throw new Error(`public analyst benchmark trace has no step-<n> spans: ${path}`)
  }
  return Math.max(...steps)
}

function shareableVerificationManifest(
  manifest: VerificationArtifactManifest,
  artifactRoot: string,
): VerificationArtifactManifest {
  return {
    ...manifest,
    caseDirectory: slashRelative(artifactRoot, manifest.caseDirectory),
    caseDirectoriesSearched: manifest.caseDirectoriesSearched.map((path) =>
      slashRelative(artifactRoot, path),
    ),
    files: manifest.files.map((file) => ({
      ...file,
      path: slashRelative(artifactRoot, file.path),
    })),
  }
}

function slashRelative(root: string, path: string): string {
  const value = relative(root, path)
  if (!value || value === '..' || value.startsWith(`..${sep}`)) {
    if (!value) return '.'
    throw new Error(`benchmark artifact path escapes its declared root: ${path}`)
  }
  return value.replaceAll('\\', '/')
}

function parseJsonl(text: string, path: string): Array<Record<string, unknown>> {
  const rows: Array<Record<string, unknown>> = []
  for (const [index, line] of text.split(/\r?\n/).entries()) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let parsed: unknown
    try {
      parsed = JSON.parse(trimmed)
    } catch (error) {
      throw new Error(
        `${path}:${index + 1}: invalid JSON: ${error instanceof Error ? error.message : String(error)}`,
      )
    }
    if (!isRecord(parsed)) {
      throw new TypeError(`${path}:${index + 1}: dataset row must be a JSON object`)
    }
    rows.push(parsed)
  }
  if (rows.length === 0) throw new Error(`public analyst benchmark dataset is empty: ${path}`)
  return rows
}

function records(values: readonly unknown[], path: string): Array<Record<string, unknown>> {
  return values.map((value, index) => {
    if (!isRecord(value)) throw new TypeError(`${path}[${index}] must be a JSON object`)
    return value
  })
}

function publicBenchmarkRowId(
  dataset: PublicAnalystBenchmarkDataset,
  row: Record<string, unknown>,
): string {
  const value = dataset === 'agentrx' ? row.trajectory_id : row.traj_id
  if ((typeof value !== 'string' && typeof value !== 'number') || !String(value).trim()) {
    throw new TypeError(
      `${dataset} dataset row requires a non-empty ${dataset === 'agentrx' ? 'trajectory_id' : 'traj_id'}`,
    )
  }
  return String(value)
}

function spanIdFromEvidence(uri: string): string | null {
  const match = /\/span\/([^/]+)$/.exec(uri)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function selectionKey(seed: number, id: string): string {
  return sha256Digest(`${seed}\u0000${id}`)
}

function valueDistribution(
  values: readonly (string | undefined)[],
): PublicBenchmarkValueDistribution {
  const counts = new Map<string, number>()
  let missing = 0
  for (const value of values) {
    if (value === undefined) {
      missing += 1
      continue
    }
    counts.set(value, (counts.get(value) ?? 0) + 1)
  }
  return {
    total: values.length,
    missing,
    counts: Object.fromEntries([...counts].sort(([left], [right]) => left.localeCompare(right))),
  }
}

function scalarDistributionValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'number' || typeof value === 'boolean') return String(value)
  return undefined
}

function rootAgent(row: AgentRxRow): string | undefined {
  const rootCauseId = row.root_cause_failure_id ?? row.root_cause?.failure_id
  const root = row.failures.find((failure) => String(failure.failure_id) === String(rootCauseId))
  return scalarDistributionValue(root?.failed_agent)
}
