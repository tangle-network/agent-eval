import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { link, lstat, mkdir, open, readFile, unlink } from 'node:fs/promises'
import { arch, platform } from 'node:os'
import { dirname, resolve } from 'node:path'
import { resolveExternalOptimizerProcessLimits } from '../campaign/external-optimizer-contracts'
import { resolveModelPricing } from '../metrics'
import type { AnalystBenchmarkObservation } from './benchmark'
import {
  ANALYST_BENCHMARK_COST_LEDGER_FILE,
  ANALYST_BENCHMARK_LOCAL_RECEIPT_FILE,
  ANALYST_BENCHMARK_MANIFEST_FILE,
  ANALYST_BENCHMARK_OBSERVATIONS_FILE,
  type AnalystBenchmarkLocalRunReceipt,
  type AnalystBenchmarkProgressRow,
  type AnalystBenchmarkRunIdentity,
  type AnalystBenchmarkRunManifest,
  assertAnalystBenchmarkObservation,
  assertExactKeys,
  canonicalJson,
  digestCanonical,
  isRecord,
  isSha256,
  observationKey,
  parseJson,
} from './benchmark-command-artifact'
import {
  ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256,
  ANALYST_BENCHMARK_IMPLEMENTATION_SHA256,
} from './benchmark-implementation'
import { effectiveAnalystProtocolSha256 } from './benchmark-instructions-override'
import type {
  PreparedPublicAnalystBenchmark,
  PublicAnalystBenchmarkDataset,
  PublicAnalystBenchmarkModelSettings,
} from './benchmark-real-model'

export interface AnalystBenchmarkOutputPaths {
  directory: string
  initializationComplete: string
  manifest: string
  observations: string
  costLedger: string
  modelResponses: string
  localReceipt: string
  result: string
  report: string
}

export const ANALYST_BENCHMARK_INITIALIZATION_COMPLETE_FILE = 'initialization-complete.json'

export interface AnalystBenchmarkProgress {
  observations: AnalystBenchmarkObservation[]
  nextSequence: number
  previousRowSha256: string | null
}

interface AnalystBenchmarkPersistenceConfig {
  dataset: PublicAnalystBenchmarkDataset
  analyst: string
  labelsPath: string
  traceDir: string
  artifactDir?: string
  revision: string
  split: string
  model: PublicAnalystBenchmarkModelSettings
  limit: number
  seed: number
  concurrency: number
  repetitions: number
  rlmSamples: number
  maxCostUsd: number
  maxArtifactBytes: number
  /** Absent when the analyst owns its own transport (`prime`). */
  modelOwnerModule?: string
  command: string
}

export async function openOutputDirectory(
  outDir: string,
  resume: boolean,
): Promise<AnalystBenchmarkOutputPaths> {
  const directory = resolve(outDir)
  if (resume) {
    let outputStat: Awaited<ReturnType<typeof lstat>>
    try {
      outputStat = await lstat(directory)
    } catch (error) {
      if (isNodeError(error, 'ENOENT')) {
        throw new Error(`cannot resume missing benchmark output directory: ${directory}`)
      }
      throw error
    }
    if (!outputStat.isDirectory() || outputStat.isSymbolicLink()) {
      throw new Error(`benchmark output must be a real directory: ${directory}`)
    }
  } else {
    await mkdir(dirname(directory), { recursive: true })
    try {
      await mkdir(directory)
    } catch (error) {
      if (isNodeError(error, 'EEXIST')) {
        throw new Error(`refusing to use existing benchmark output directory: ${directory}`)
      }
      throw error
    }
    await syncDirectory(dirname(directory))
  }
  return {
    directory,
    initializationComplete: resolve(directory, ANALYST_BENCHMARK_INITIALIZATION_COMPLETE_FILE),
    manifest: resolve(directory, ANALYST_BENCHMARK_MANIFEST_FILE),
    observations: resolve(directory, ANALYST_BENCHMARK_OBSERVATIONS_FILE),
    costLedger: resolve(directory, ANALYST_BENCHMARK_COST_LEDGER_FILE),
    modelResponses: resolve(directory, 'model-responses'),
    localReceipt: resolve(directory, ANALYST_BENCHMARK_LOCAL_RECEIPT_FILE),
    result: resolve(directory, 'result.json'),
    report: resolve(directory, 'report.md'),
  }
}

export async function prepareOutputLockPath(outDir: string): Promise<string> {
  const directory = resolve(outDir)
  await mkdir(dirname(directory), { recursive: true })
  return `${directory}.lock`
}

export function createRunIdentity(
  config: AnalystBenchmarkPersistenceConfig,
  prepared: PreparedPublicAnalystBenchmark,
): AnalystBenchmarkRunIdentity {
  const model = commandModelIdentity(config.model)
  const caseDefinitions = prepared.cases.map((testCase) => ({
    id: testCase.id,
    clusterId: testCase.clusterId,
    labelState: testCase.labelState,
    expectedIssues: testCase.expectedIssues,
    labeledEvidence: testCase.labeledEvidence ?? [],
    tags: testCase.tags ?? [],
    metadata: testCase.metadata ?? {},
  }))
  return {
    config: {
      dataset: config.dataset,
      datasetRevision: config.revision,
      datasetSplit: config.split,
      model: {
        id: config.model.model,
        ...model,
      },
      limit: config.limit,
      seed: config.seed,
      concurrency: config.concurrency,
      repetitions: config.repetitions,
      rlmSamples: config.rlmSamples,
      maxCostUsd: config.maxCostUsd,
      maxArtifactBytes: config.maxArtifactBytes,
      analystProtocolSha256: effectiveAnalystProtocolSha256(
        config.dataset,
        config.model.instructionsOverride,
      ),
      ...(config.model.instructionsOverride
        ? { instructionsOverrideSha256: config.model.instructionsOverride.sha256 }
        : {}),
      implementationSha256: ANALYST_BENCHMARK_IMPLEMENTATION_SHA256,
      dependencyLockSha256: ANALYST_BENCHMARK_DEPENDENCY_LOCK_SHA256,
      runnerIds: ['empty', config.analyst] as const,
    },
    inputs: {
      labelsSha256: prepared.labelsSha256,
      sourceRowCount: prepared.sourceRowCount,
      selectedCaseIds: [...prepared.selectedCaseIds],
      traceFiles: prepared.traceFiles.map((traceFile) => ({ ...traceFile })),
      verificationArtifactsSha256: digestCanonical(prepared.verificationArtifacts),
      caseDefinitionsSha256: digestCanonical(caseDefinitions),
    },
  }
}

function commandModelIdentity(config: PublicAnalystBenchmarkModelSettings) {
  const catalogPricing = resolveModelPricing(config.model)
  const pricing =
    config.pricing ??
    (catalogPricing
      ? {
          inputUsdPerMillion: catalogPricing.input * 1_000,
          outputUsdPerMillion: catalogPricing.output * 1_000,
        }
      : undefined)
  if (!pricing) {
    throw new Error(`benchmark model '${config.model}' has no recorded pricing`)
  }
  const recursive = config.dspyRlm
  return {
    ownerCallRef: config.callRef,
    maxOutputTokens: config.maxOutputTokens,
    maxReasoningTokens: config.maxReasoningTokens ?? config.maxOutputTokens * 4,
    maxRequestBytes: config.maxModelRequestBytes ?? 16 * 1024 * 1024,
    maxResponseBytes: config.maxModelResponseBytes ?? 4 * 1024 * 1024,
    requestTimeoutMs: config.modelRequestTimeoutMs ?? config.timeoutMs,
    timeoutMs: config.timeoutMs,
    pricing: { ...pricing },
    recursiveLimits: {
      maxIterations: recursive?.maxIterations ?? 14,
      maxLlmCalls: recursive?.maxLlmCalls ?? 8,
      maxToolCalls: recursive?.maxToolCalls ?? 80,
      maxOutputChars: recursive?.maxOutputChars ?? 8_000,
      maxModelRequests: recursive?.maxModelRequests ?? null,
      traceToolRequestBytes: recursive?.traceToolRequestBytes ?? 1_000_000,
      traceToolResponseBytes: recursive?.traceToolResponseBytes ?? 4_000_000,
      traceToolTimeoutMs: recursive?.traceToolTimeoutMs ?? 60_000,
    },
    processLimits: resolveExternalOptimizerProcessLimits(recursive?.runner?.limits),
  }
}

export function createLocalRunReceipt(
  config: AnalystBenchmarkPersistenceConfig,
  paths: AnalystBenchmarkOutputPaths,
): Omit<AnalystBenchmarkLocalRunReceipt, 'runIdentitySha256' | 'localIdentitySha256'> {
  return {
    kind: 'agent-eval/analyst-benchmark-local-run',
    local: {
      labelsPath: resolve(config.labelsPath),
      traceDir: resolve(config.traceDir),
      ...(config.artifactDir ? { artifactDir: resolve(config.artifactDir) } : {}),
      outputDir: paths.directory,
      ...(config.modelOwnerModule === undefined
        ? {}
        : { modelOwnerModule: config.modelOwnerModule }),
    },
    command: config.command,
    environment: {
      node: process.version,
      platform: platform(),
      arch: arch(),
    },
    files: {
      manifest: paths.manifest,
      observations: paths.observations,
      costLedger: paths.costLedger,
      modelResponses: paths.modelResponses,
      result: paths.result,
      report: paths.report,
    },
  }
}

export async function initializeRunFiles(
  paths: AnalystBenchmarkOutputPaths,
  identity: AnalystBenchmarkRunIdentity,
  identitySha256: string,
  localIdentitySha256: string,
  localReceiptInput: Omit<
    AnalystBenchmarkLocalRunReceipt,
    'runIdentitySha256' | 'localIdentitySha256'
  >,
): Promise<AnalystBenchmarkRunManifest> {
  const existingManifest = await readOptionalRegularFile(paths.manifest, 'benchmark run manifest')
  const manifest = existingManifest
    ? await readAndValidateManifestContent(
        paths.manifest,
        existingManifest,
        identity,
        identitySha256,
        localIdentitySha256,
      )
    : {
        kind: 'agent-eval/analyst-benchmark-run' as const,
        createdAt: new Date().toISOString(),
        identitySha256,
        localIdentitySha256,
        identity,
      }
  const localReceipt: AnalystBenchmarkLocalRunReceipt = {
    ...localReceiptInput,
    runIdentitySha256: identitySha256,
    localIdentitySha256,
  }
  const manifestContent = `${JSON.stringify(manifest, null, 2)}\n`
  const localReceiptContent = `${JSON.stringify(localReceipt, null, 2)}\n`
  const initializationCompleteContent = renderInitializationComplete(manifest)

  await assertAbsentOrExact(paths.observations, '', 'benchmark observation log')
  await assertAbsentOrExact(paths.localReceipt, localReceiptContent, 'benchmark local run receipt')
  await assertAbsentOrExact(paths.manifest, manifestContent, 'benchmark run manifest')
  for (const path of [paths.costLedger, paths.modelResponses, paths.result, paths.report]) {
    if (await regularFileExists(path)) {
      throw new Error(
        `benchmark initialization marker is missing but later run artifact exists: ${path}`,
      )
    }
  }
  if (await regularFileExists(paths.initializationComplete)) {
    throw new Error(
      `benchmark initialization marker already exists during partial initialization: ${paths.initializationComplete}`,
    )
  }

  await writeExclusiveOrVerify(paths.observations, '')
  await writeExclusiveOrVerify(paths.localReceipt, localReceiptContent)
  await writeExclusiveOrVerify(paths.manifest, manifestContent)
  await writeExclusiveOrVerify(paths.initializationComplete, initializationCompleteContent)
  return manifest
}

export async function readAndValidateResumeFiles(
  paths: AnalystBenchmarkOutputPaths,
  currentIdentity: AnalystBenchmarkRunIdentity,
  currentIdentitySha256: string,
  currentLocalIdentitySha256: string,
  localReceiptInput: Omit<
    AnalystBenchmarkLocalRunReceipt,
    'runIdentitySha256' | 'localIdentitySha256'
  >,
): Promise<AnalystBenchmarkRunManifest> {
  if (!(await regularFileExists(paths.initializationComplete))) {
    return initializeRunFiles(
      paths,
      currentIdentity,
      currentIdentitySha256,
      currentLocalIdentitySha256,
      localReceiptInput,
    )
  }
  const manifest = await readAndValidateManifest(
    paths.manifest,
    currentIdentity,
    currentIdentitySha256,
    currentLocalIdentitySha256,
  )
  const localReceiptContent = await readRegularFile(
    paths.localReceipt,
    'benchmark local run receipt',
  )
  const value = parseJson(localReceiptContent, paths.localReceipt)
  if (!isRecord(value)) {
    throw new TypeError(`benchmark local run receipt must be an object: ${paths.localReceipt}`)
  }
  assertExactKeys(
    value,
    [
      'kind',
      'runIdentitySha256',
      'localIdentitySha256',
      'local',
      'command',
      'environment',
      'files',
    ],
    'benchmark local run receipt',
  )
  if (
    value.kind !== 'agent-eval/analyst-benchmark-local-run' ||
    value.runIdentitySha256 !== currentIdentitySha256 ||
    value.localIdentitySha256 !== currentLocalIdentitySha256 ||
    !isRecord(value.local)
  ) {
    throw new Error('benchmark local run receipt does not match the requested resume')
  }
  const expectedLocalReceipt: AnalystBenchmarkLocalRunReceipt = {
    ...localReceiptInput,
    runIdentitySha256: currentIdentitySha256,
    localIdentitySha256: currentLocalIdentitySha256,
  }
  const storedLocalIdentitySha256 = digestCanonical(value.local)
  if (
    storedLocalIdentitySha256 !== currentLocalIdentitySha256 ||
    canonicalJson(value.local) !== canonicalJson(localReceiptInput.local)
  ) {
    throw new Error('benchmark local paths or model-owner module do not match the requested resume')
  }
  if (localReceiptContent !== `${JSON.stringify(expectedLocalReceipt, null, 2)}\n`) {
    throw new Error(`benchmark local run receipt does not exactly match: ${paths.localReceipt}`)
  }
  const initializationCompleteContent = await readRegularFile(
    paths.initializationComplete,
    'benchmark initialization marker',
  )
  if (initializationCompleteContent !== renderInitializationComplete(manifest)) {
    throw new Error(
      `benchmark initialization marker does not match the run manifest: ${paths.initializationComplete}`,
    )
  }
  return manifest
}

async function readAndValidateManifest(
  path: string,
  currentIdentity: AnalystBenchmarkRunIdentity,
  currentIdentitySha256: string,
  currentLocalIdentitySha256: string,
): Promise<AnalystBenchmarkRunManifest> {
  const content = await readRegularFile(path, 'benchmark run manifest')
  const manifest = await readAndValidateManifestContent(
    path,
    content,
    currentIdentity,
    currentIdentitySha256,
    currentLocalIdentitySha256,
  )
  if (content !== `${JSON.stringify(manifest, null, 2)}\n`) {
    throw new Error(`benchmark run manifest does not exactly match: ${path}`)
  }
  return manifest
}

async function readAndValidateManifestContent(
  path: string,
  content: string,
  currentIdentity: AnalystBenchmarkRunIdentity,
  currentIdentitySha256: string,
  currentLocalIdentitySha256: string,
): Promise<AnalystBenchmarkRunManifest> {
  const value = parseJson(content, path)
  if (!isRecord(value)) throw new TypeError(`benchmark run manifest must be an object: ${path}`)
  assertExactKeys(
    value,
    ['kind', 'createdAt', 'identitySha256', 'localIdentitySha256', 'identity'],
    'benchmark run manifest',
  )
  if (value.kind !== 'agent-eval/analyst-benchmark-run') {
    throw new TypeError(`unsupported benchmark run manifest: ${path}`)
  }
  if (typeof value.createdAt !== 'string' || !Number.isFinite(Date.parse(value.createdAt))) {
    throw new TypeError(`benchmark run manifest has an invalid createdAt: ${path}`)
  }
  if (
    !isSha256(value.identitySha256) ||
    !isSha256(value.localIdentitySha256) ||
    !isRecord(value.identity)
  ) {
    throw new TypeError(`benchmark run manifest has an invalid identity: ${path}`)
  }
  const storedIdentitySha256 = digestCanonical(value.identity)
  if (storedIdentitySha256 !== value.identitySha256) {
    throw new Error(`benchmark run manifest identity digest does not match its contents: ${path}`)
  }
  if (
    currentIdentitySha256 !== value.identitySha256 ||
    currentLocalIdentitySha256 !== value.localIdentitySha256 ||
    canonicalJson(currentIdentity) !== canonicalJson(value.identity)
  ) {
    throw new Error(
      `benchmark resume configuration or inputs do not match ${ANALYST_BENCHMARK_MANIFEST_FILE}`,
    )
  }
  return {
    kind: 'agent-eval/analyst-benchmark-run',
    createdAt: value.createdAt,
    identitySha256: currentIdentitySha256,
    localIdentitySha256: currentLocalIdentitySha256,
    identity: currentIdentity,
  }
}

function renderInitializationComplete(manifest: AnalystBenchmarkRunManifest): string {
  return `${JSON.stringify(
    {
      kind: 'agent-eval/analyst-benchmark-initialization-complete',
      runIdentitySha256: manifest.identitySha256,
      localIdentitySha256: manifest.localIdentitySha256,
      createdAt: manifest.createdAt,
    },
    null,
    2,
  )}\n`
}

async function assertAbsentOrExact(path: string, expected: string, label: string): Promise<void> {
  const existing = await readOptionalRegularFile(path, label)
  if (existing !== undefined && existing !== expected) {
    throw new Error(`${label} does not exactly match interrupted initialization: ${path}`)
  }
}

async function readOptionalRegularFile(path: string, label: string): Promise<string | undefined> {
  if (!(await regularFileExists(path))) return undefined
  return readRegularFile(path, label)
}

export function createObservationAppender(
  path: string,
  runIdentitySha256: string,
  progress: AnalystBenchmarkProgress,
): (observation: AnalystBenchmarkObservation) => Promise<void> {
  let writes = Promise.resolve()
  const seen = new Set(progress.observations.map(observationKey))
  return (observation) => {
    const write = writes.then(async () => {
      assertAnalystBenchmarkObservation(observation, 'benchmark observation')
      const key = observationKey(observation)
      if (seen.has(key)) {
        throw new Error(
          `refusing duplicate benchmark observation '${observation.runnerId}/${observation.caseId}/${observation.repetition}'`,
        )
      }
      const rowWithoutDigest = {
        sequence: progress.nextSequence,
        runIdentitySha256,
        previousRowSha256: progress.previousRowSha256,
        observation,
      }
      const row: AnalystBenchmarkProgressRow = {
        ...rowWithoutDigest,
        rowSha256: digestCanonical(rowWithoutDigest),
      }
      await appendDurable(path, `${JSON.stringify(row)}\n`)
      progress.nextSequence += 1
      progress.previousRowSha256 = row.rowSha256
      progress.observations.push(observation)
      seen.add(key)
    })
    writes = write
    return write
  }
}

export async function readProgress(
  path: string,
  runIdentitySha256: string,
  caseIds: readonly string[],
  repetitions: number,
  analystRunnerId: string,
): Promise<AnalystBenchmarkProgress> {
  const text = await readRegularFile(path, 'benchmark observation log')
  const rawLines = text.split('\n')
  if (rawLines.at(-1) === '') rawLines.pop()
  const observations: AnalystBenchmarkObservation[] = []
  const seen = new Set<string>()
  const executionIndexes = new Set<number>()
  let previousRowSha256: string | null = null
  const allowedCases = new Set(caseIds)
  const plannedObservationCount = caseIds.length * 2 * repetitions

  for (const [index, line] of rawLines.entries()) {
    if (!line.trim()) {
      throw new Error(`benchmark observation log contains an empty row at line ${index + 1}`)
    }
    const parsed = parseJson(line, `${path}:${index + 1}`)
    if (!isRecord(parsed)) {
      throw new TypeError(`benchmark observation row ${index + 1} must be an object`)
    }
    assertExactKeys(
      parsed,
      ['sequence', 'runIdentitySha256', 'previousRowSha256', 'observation', 'rowSha256'],
      `benchmark observation row ${index + 1}`,
    )
    assertAnalystBenchmarkObservation(
      parsed.observation,
      `benchmark observation row ${index + 1}.observation`,
    )
    const observation = parsed.observation
    const key = observationKey(observation)
    if (seen.has(key)) {
      throw new Error(
        `duplicate benchmark observation '${observation.runnerId}/${observation.caseId}/${observation.repetition}' at line ${index + 1}`,
      )
    }
    if (parsed.sequence !== index) {
      throw new Error(
        `benchmark observation row ${index + 1} has sequence ${String(parsed.sequence)}; expected ${index}`,
      )
    }
    if (parsed.runIdentitySha256 !== runIdentitySha256) {
      throw new Error(`benchmark observation row ${index + 1} belongs to another run`)
    }
    if (parsed.previousRowSha256 !== previousRowSha256) {
      throw new Error(`benchmark observation row ${index + 1} breaks the digest chain`)
    }
    if (!isSha256(parsed.rowSha256)) {
      throw new TypeError(`benchmark observation row ${index + 1} has an invalid digest`)
    }
    const expectedDigest = digestCanonical({
      sequence: parsed.sequence,
      runIdentitySha256: parsed.runIdentitySha256,
      previousRowSha256: parsed.previousRowSha256,
      observation,
    })
    if (expectedDigest !== parsed.rowSha256) {
      throw new Error(`benchmark observation row ${index + 1} digest does not match its contents`)
    }
    if (
      !allowedCases.has(observation.caseId) ||
      (observation.runnerId !== 'empty' && observation.runnerId !== analystRunnerId) ||
      observation.repetition >= repetitions ||
      observation.executionIndex >= plannedObservationCount
    ) {
      throw new Error(
        `benchmark observation row ${index + 1} does not match a planned case, runner, and repetition`,
      )
    }
    if (executionIndexes.has(observation.executionIndex)) {
      throw new Error(
        `duplicate benchmark executionIndex ${observation.executionIndex} at line ${index + 1}`,
      )
    }
    observations.push(observation)
    seen.add(key)
    executionIndexes.add(observation.executionIndex)
    previousRowSha256 = parsed.rowSha256
  }

  return {
    observations,
    nextSequence: observations.length,
    previousRowSha256,
  }
}

export async function writeExclusiveOrVerify(path: string, content: string): Promise<void> {
  try {
    await writeExclusive(path, content)
  } catch (error) {
    if (!isNodeError(error, 'EEXIST')) throw error
    const existing = await readRegularFile(path, 'existing benchmark artifact')
    if (existing !== content) {
      throw new Error(`refusing to replace existing benchmark artifact: ${path}`)
    }
  }
}

export async function regularFileExists(path: string): Promise<boolean> {
  try {
    const fileStat = await lstat(path)
    if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
      throw new Error(`benchmark artifact path must be a real file: ${path}`)
    }
    return true
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) return false
    throw error
  }
}

async function appendDurable(path: string, content: string): Promise<void> {
  const handle = await open(path, constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW)
  try {
    await handle.writeFile(content, 'utf8')
    await handle.sync()
  } finally {
    await handle.close()
  }
}

async function writeExclusive(path: string, content: string): Promise<void> {
  const temporary = `${path}.tmp-${process.pid}-${randomUUID()}`
  let handle: Awaited<ReturnType<typeof open>> | undefined
  try {
    handle = await open(temporary, 'wx')
    await handle.writeFile(content, 'utf8')
    await handle.sync()
    await handle.close()
    handle = undefined
    await link(temporary, path)
    await syncDirectory(dirname(path))
  } finally {
    await handle?.close().catch(() => undefined)
    await unlink(temporary).catch(() => undefined)
  }
}

export async function readRegularFile(path: string, label: string): Promise<string> {
  let fileStat: Awaited<ReturnType<typeof lstat>>
  try {
    fileStat = await lstat(path)
  } catch (error) {
    if (isNodeError(error, 'ENOENT')) throw new Error(`${label} is missing: ${path}`)
    throw error
  }
  if (!fileStat.isFile() || fileStat.isSymbolicLink()) {
    throw new Error(`${label} must be a real file: ${path}`)
  }
  return readFile(path, 'utf8')
}

async function syncDirectory(path: string): Promise<void> {
  const directory = await open(path, 'r')
  try {
    await directory.sync()
  } finally {
    await directory.close()
  }
}

function isNodeError(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === code
}
