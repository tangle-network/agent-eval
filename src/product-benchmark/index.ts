import { existsSync, readFileSync, statSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { ValidationError } from '../errors'

export const productBenchmarkSplits = ['practice', 'dev', 'holdout', 'safety', 'sentinel'] as const

export type ProductBenchmarkSplit = (typeof productBenchmarkSplits)[number]

export interface ProductBenchmarkRepoRef {
  readonly url: string
  readonly commit: string
  readonly branch: string
}

export interface ProductBenchmarkSubstrateVersions {
  readonly agentEval: string
  readonly agentRuntime: string
  readonly agentInterface: string
  readonly sandbox: string
  readonly agentBench?: string
}

export interface ProductBenchmarkProfileRef {
  readonly id: string
  readonly profileHash: string
  readonly agentProfilePath: string
}

export interface ProductBenchmarkArm {
  readonly id: string
  readonly profileId: string
  readonly mutableSurfaces: readonly string[]
  readonly policyAxes: Record<string, unknown>
}

export interface ProductBenchmarkScenario {
  readonly id: string
  readonly split: ProductBenchmarkSplit
  readonly tags: readonly string[]
  readonly sourceAllowedForSynthesis: boolean
}

export interface ProductBenchmarkBudgets {
  readonly maxUsd: number
  readonly maxCells: number
  readonly maxWallMs: number
}

export interface ProductBenchmarkManifest {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly benchmarkId: string
  readonly repo: ProductBenchmarkRepoRef
  readonly substrate: ProductBenchmarkSubstrateVersions
  readonly profiles: readonly ProductBenchmarkProfileRef[]
  readonly arms: readonly ProductBenchmarkArm[]
  readonly scenarios: readonly ProductBenchmarkScenario[]
  readonly budgets: ProductBenchmarkBudgets
  readonly expectedArtifactDir: string
}

export interface AgentProfileRuntimeReceipt {
  readonly model: string
  readonly harness: string
  readonly backend: string
  readonly reasoningEffort?: string
}

export type RuntimeResolution = AgentProfileRuntimeReceipt

export interface ProductBenchmarkRecord {
  readonly schemaVersion: 1
  readonly projectId: string
  readonly benchmarkId: string
  readonly runId: string
  readonly scenarioId: string
  readonly split: ProductBenchmarkSplit
  readonly armId: string
  readonly rep: number
  readonly agentProfile: {
    readonly id: string
    readonly hash: string
    readonly path: string
    readonly declared: RuntimeResolution
    readonly resolved: RuntimeResolution
  }
  readonly model: {
    readonly provider: string
    readonly id: string
  }
  readonly backend: {
    readonly kind: string
    readonly version: string
  }
  readonly outcome: {
    readonly pass: boolean
    readonly score: number
    readonly dimensions: Record<string, number>
    readonly failureMode: string | null
  }
  readonly usage: {
    readonly inputTokens: number
    readonly outputTokens: number
    readonly costUsd: number
    readonly wallMs: number
    readonly toolCalls: number
  }
  readonly integrity: {
    readonly realBackend: boolean
    readonly rawCapture: boolean
    readonly traceCapture: boolean
    readonly noStubRows: boolean
    readonly priced: boolean
    readonly profileMaterialized: boolean
  }
  readonly artifacts: {
    readonly records: string
    readonly traces: string
    readonly raws: string
    readonly scores: string
    readonly workspace: string
  }
}

export interface ProductBenchmarkRunInput {
  readonly manifestPath: string
  readonly recordsPath: string
  readonly artifactRoot?: string
  readonly checkArtifacts?: boolean
}

export interface ProductBenchmarkValidationReport {
  readonly manifestPath: string
  readonly recordsPath: string
  readonly records: number
  /** Manifest repo fields that are empty or the `'unknown'` export sentinel. */
  readonly repoFailures: readonly string[]
  /** Manifest substrate versions that are empty or the `'unknown'` export
   *  sentinel — a bundle without substrate identity is not reproducible. */
  readonly substrateFailures: readonly string[]
  readonly projects: readonly string[]
  readonly benchmarks: readonly string[]
  readonly arms: readonly string[]
  readonly scenarios: readonly string[]
  readonly passed: number
  readonly failed: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly wallMs: number
  readonly integrityFailures: readonly string[]
  readonly missingArtifacts: readonly string[]
}

export interface ProductBenchmarkArtifactPaths {
  readonly manifestPath: string
  readonly recordsPath: string
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function fail(path: string, message: string): never {
  throw new ValidationError(`${path}: ${message}`)
}

function wrapValidationError(path: string, err: unknown): never {
  if (err instanceof ValidationError) {
    throw new ValidationError(`${path}: ${err.message}`, { cause: err })
  }
  throw new ValidationError(`${path}: ${err instanceof Error ? err.message : String(err)}`, {
    cause: err,
  })
}

function expectObject(value: unknown, path: string): Record<string, unknown> {
  if (!isObject(value)) fail(path, 'must be an object')
  return value
}

function expectString(value: unknown, path: string): string {
  if (typeof value !== 'string' || value.trim().length === 0)
    fail(path, 'must be a non-empty string')
  return value
}

function expectBoolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'must be a boolean')
  return value
}

function expectNumber(
  value: unknown,
  path: string,
  opts: { readonly min?: number; readonly max?: number; readonly integer?: boolean } = {},
): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) fail(path, 'must be a finite number')
  if (opts.integer && !Number.isInteger(value)) fail(path, 'must be an integer')
  if (opts.min !== undefined && value < opts.min) fail(path, `must be >= ${opts.min}`)
  if (opts.max !== undefined && value > opts.max) fail(path, `must be <= ${opts.max}`)
  return value
}

function expectStringArray(value: unknown, path: string): string[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  return value.map((entry, index) => expectString(entry, `${path}[${index}]`))
}

function expectObjectArray(value: unknown, path: string): Record<string, unknown>[] {
  if (!Array.isArray(value)) fail(path, 'must be an array')
  return value.map((entry, index) => expectObject(entry, `${path}[${index}]`))
}

function expectSplit(value: unknown, path: string): ProductBenchmarkSplit {
  const split = expectString(value, path)
  if (!productBenchmarkSplits.includes(split as ProductBenchmarkSplit)) {
    fail(path, `must be one of ${productBenchmarkSplits.join(', ')}`)
  }
  return split as ProductBenchmarkSplit
}

function optionalString(value: unknown, path: string): string | undefined {
  if (value === undefined) return undefined
  return expectString(value, path)
}

function expectDimensions(value: unknown, path: string): Record<string, number> {
  const obj = expectObject(value, path)
  const out: Record<string, number> = {}
  for (const [key, raw] of Object.entries(obj)) out[key] = expectNumber(raw, `${path}.${key}`)
  return out
}

function expectRuntimeResolution(value: unknown, path: string): RuntimeResolution {
  const obj = expectObject(value, path)
  return {
    model: expectString(obj.model, `${path}.model`),
    harness: expectString(obj.harness, `${path}.harness`),
    backend: expectString(obj.backend, `${path}.backend`),
    ...(obj.reasoningEffort !== undefined
      ? { reasoningEffort: optionalString(obj.reasoningEffort, `${path}.reasoningEffort`) }
      : {}),
  }
}

export function validateProductBenchmarkManifest(value: unknown): ProductBenchmarkManifest {
  const obj = expectObject(value, 'manifest')
  if (obj.schemaVersion !== 1) fail('manifest.schemaVersion', 'must be 1')
  const repo = expectObject(obj.repo, 'manifest.repo')
  const substrate = expectObject(obj.substrate, 'manifest.substrate')
  const profiles = expectObjectArray(obj.profiles, 'manifest.profiles').map((profile, index) => ({
    id: expectString(profile.id, `manifest.profiles[${index}].id`),
    profileHash: expectString(profile.profileHash, `manifest.profiles[${index}].profileHash`),
    agentProfilePath: expectString(
      profile.agentProfilePath,
      `manifest.profiles[${index}].agentProfilePath`,
    ),
  }))
  const arms = expectObjectArray(obj.arms, 'manifest.arms').map((arm, index) => ({
    id: expectString(arm.id, `manifest.arms[${index}].id`),
    profileId: expectString(arm.profileId, `manifest.arms[${index}].profileId`),
    mutableSurfaces: expectStringArray(
      arm.mutableSurfaces,
      `manifest.arms[${index}].mutableSurfaces`,
    ),
    policyAxes: expectObject(arm.policyAxes, `manifest.arms[${index}].policyAxes`),
  }))
  const scenarios = expectObjectArray(obj.scenarios, 'manifest.scenarios').map(
    (scenario, index) => ({
      id: expectString(scenario.id, `manifest.scenarios[${index}].id`),
      split: expectSplit(scenario.split, `manifest.scenarios[${index}].split`),
      tags: expectStringArray(scenario.tags, `manifest.scenarios[${index}].tags`),
      sourceAllowedForSynthesis: expectBoolean(
        scenario.sourceAllowedForSynthesis,
        `manifest.scenarios[${index}].sourceAllowedForSynthesis`,
      ),
    }),
  )
  const budgets = expectObject(obj.budgets, 'manifest.budgets')
  if (profiles.length === 0) fail('manifest.profiles', 'must contain at least one profile')
  if (arms.length === 0) fail('manifest.arms', 'must contain at least one arm')
  if (scenarios.length === 0) fail('manifest.scenarios', 'must contain at least one scenario')
  assertUnique(
    profiles.map((profile) => profile.id),
    'manifest.profiles.id',
  )
  assertUnique(
    arms.map((arm) => arm.id),
    'manifest.arms.id',
  )
  assertUnique(
    scenarios.map((scenario) => scenario.id),
    'manifest.scenarios.id',
  )
  const profileIds = new Set(profiles.map((profile) => profile.id))
  for (const arm of arms) {
    if (!profileIds.has(arm.profileId))
      fail(`manifest.arms.${arm.id}.profileId`, `unknown profile ${arm.profileId}`)
  }
  return {
    schemaVersion: 1,
    projectId: expectString(obj.projectId, 'manifest.projectId'),
    benchmarkId: expectString(obj.benchmarkId, 'manifest.benchmarkId'),
    repo: {
      url: expectString(repo.url, 'manifest.repo.url'),
      commit: expectString(repo.commit, 'manifest.repo.commit'),
      branch: expectString(repo.branch, 'manifest.repo.branch'),
    },
    substrate: {
      agentEval: expectString(substrate.agentEval, 'manifest.substrate.agentEval'),
      agentRuntime: expectString(substrate.agentRuntime, 'manifest.substrate.agentRuntime'),
      agentInterface: expectString(substrate.agentInterface, 'manifest.substrate.agentInterface'),
      sandbox: expectString(substrate.sandbox, 'manifest.substrate.sandbox'),
      ...(substrate.agentBench !== undefined
        ? { agentBench: expectString(substrate.agentBench, 'manifest.substrate.agentBench') }
        : {}),
    },
    profiles,
    arms,
    scenarios,
    budgets: {
      maxUsd: expectNumber(budgets.maxUsd, 'manifest.budgets.maxUsd', { min: 0 }),
      maxCells: expectNumber(budgets.maxCells, 'manifest.budgets.maxCells', {
        min: 0,
        integer: true,
      }),
      maxWallMs: expectNumber(budgets.maxWallMs, 'manifest.budgets.maxWallMs', {
        min: 0,
        integer: true,
      }),
    },
    expectedArtifactDir: expectString(obj.expectedArtifactDir, 'manifest.expectedArtifactDir'),
  }
}

export function validateProductBenchmarkRecord(value: unknown): ProductBenchmarkRecord {
  const obj = expectObject(value, 'record')
  if (obj.schemaVersion !== 1) fail('record.schemaVersion', 'must be 1')
  const agentProfile = expectObject(obj.agentProfile, 'record.agentProfile')
  const model = expectObject(obj.model, 'record.model')
  const backend = expectObject(obj.backend, 'record.backend')
  const outcome = expectObject(obj.outcome, 'record.outcome')
  const usage = expectObject(obj.usage, 'record.usage')
  const integrity = expectObject(obj.integrity, 'record.integrity')
  const artifacts = expectObject(obj.artifacts, 'record.artifacts')
  const record: ProductBenchmarkRecord = {
    schemaVersion: 1,
    projectId: expectString(obj.projectId, 'record.projectId'),
    benchmarkId: expectString(obj.benchmarkId, 'record.benchmarkId'),
    runId: expectString(obj.runId, 'record.runId'),
    scenarioId: expectString(obj.scenarioId, 'record.scenarioId'),
    split: expectSplit(obj.split, 'record.split'),
    armId: expectString(obj.armId, 'record.armId'),
    rep: expectNumber(obj.rep, 'record.rep', { min: 1, integer: true }),
    agentProfile: {
      id: expectString(agentProfile.id, 'record.agentProfile.id'),
      hash: expectString(agentProfile.hash, 'record.agentProfile.hash'),
      path: expectString(agentProfile.path, 'record.agentProfile.path'),
      declared: expectRuntimeResolution(agentProfile.declared, 'record.agentProfile.declared'),
      resolved: expectRuntimeResolution(agentProfile.resolved, 'record.agentProfile.resolved'),
    },
    model: {
      provider: expectString(model.provider, 'record.model.provider'),
      id: expectString(model.id, 'record.model.id'),
    },
    backend: {
      kind: expectString(backend.kind, 'record.backend.kind'),
      version: expectString(backend.version, 'record.backend.version'),
    },
    outcome: {
      pass: expectBoolean(outcome.pass, 'record.outcome.pass'),
      score: expectNumber(outcome.score, 'record.outcome.score', { min: 0, max: 1 }),
      dimensions: expectDimensions(outcome.dimensions, 'record.outcome.dimensions'),
      failureMode:
        outcome.failureMode === null
          ? null
          : expectString(outcome.failureMode, 'record.outcome.failureMode'),
    },
    usage: {
      inputTokens: expectNumber(usage.inputTokens, 'record.usage.inputTokens', {
        min: 0,
        integer: true,
      }),
      outputTokens: expectNumber(usage.outputTokens, 'record.usage.outputTokens', {
        min: 0,
        integer: true,
      }),
      costUsd: expectNumber(usage.costUsd, 'record.usage.costUsd', { min: 0 }),
      wallMs: expectNumber(usage.wallMs, 'record.usage.wallMs', { min: 0, integer: true }),
      toolCalls: expectNumber(usage.toolCalls, 'record.usage.toolCalls', { min: 0, integer: true }),
    },
    integrity: {
      realBackend: expectBoolean(integrity.realBackend, 'record.integrity.realBackend'),
      rawCapture: expectBoolean(integrity.rawCapture, 'record.integrity.rawCapture'),
      traceCapture: expectBoolean(integrity.traceCapture, 'record.integrity.traceCapture'),
      noStubRows: expectBoolean(integrity.noStubRows, 'record.integrity.noStubRows'),
      priced: expectBoolean(integrity.priced, 'record.integrity.priced'),
      profileMaterialized: expectBoolean(
        integrity.profileMaterialized,
        'record.integrity.profileMaterialized',
      ),
    },
    artifacts: {
      records: expectString(artifacts.records, 'record.artifacts.records'),
      traces: expectString(artifacts.traces, 'record.artifacts.traces'),
      raws: expectString(artifacts.raws, 'record.artifacts.raws'),
      scores: expectString(artifacts.scores, 'record.artifacts.scores'),
      workspace: expectString(artifacts.workspace, 'record.artifacts.workspace'),
    },
  }
  if (record.integrity.realBackend && record.usage.inputTokens + record.usage.outputTokens === 0) {
    fail('record.usage', 'realBackend rows must carry non-zero token usage')
  }
  return record
}

export function productBenchmarkIntegrityFailures(record: ProductBenchmarkRecord): string[] {
  const failures: string[] = []
  for (const [key, value] of Object.entries(record.integrity)) {
    if (!value) failures.push(`${record.runId}:${key}=false`)
  }
  return failures
}

export function readProductBenchmarkRecords(path: string): ProductBenchmarkRecord[] {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  const records: ProductBenchmarkRecord[] = []
  for (const [index, line] of lines.entries()) {
    try {
      records.push(validateProductBenchmarkRecord(JSON.parse(line)))
    } catch (err) {
      wrapValidationError(`${path}:${index + 1}`, err)
    }
  }
  return records
}

export function readProductBenchmarkManifest(path: string): ProductBenchmarkManifest {
  try {
    return validateProductBenchmarkManifest(JSON.parse(readFileSync(path, 'utf8')))
  } catch (err) {
    wrapValidationError(path, err)
  }
}

export function validateProductBenchmarkRun(
  input: ProductBenchmarkRunInput,
): ProductBenchmarkValidationReport {
  const manifest = readProductBenchmarkManifest(input.manifestPath)
  const records = readProductBenchmarkRecords(input.recordsPath)
  const manifestProjectBench = `${manifest.projectId}/${manifest.benchmarkId}`
  const integrityFailures = records.flatMap(productBenchmarkIntegrityFailures)
  const missingArtifacts =
    input.checkArtifacts === false
      ? []
      : records.flatMap((record) =>
          missingArtifactsForRecord(record, input.artifactRoot ?? dirname(input.recordsPath)),
        )
  for (const [index, record] of records.entries()) {
    const recordProjectBench = `${record.projectId}/${record.benchmarkId}`
    if (recordProjectBench !== manifestProjectBench) {
      fail(
        `records[${index}]`,
        `project/benchmark ${recordProjectBench} does not match manifest ${manifestProjectBench}`,
      )
    }
    if (!manifest.arms.some((arm) => arm.id === record.armId))
      fail(`records[${index}].armId`, `unknown arm ${record.armId}`)
    if (!manifest.scenarios.some((scenario) => scenario.id === record.scenarioId)) {
      fail(`records[${index}].scenarioId`, `unknown scenario ${record.scenarioId}`)
    }
  }
  const repoFailures = (['url', 'commit', 'branch'] as const)
    .filter((key) => manifest.repo[key].trim().length === 0 || manifest.repo[key] === 'unknown')
    .map((key) => `manifest.repo.${key}`)
  const substrateFailures = (['agentEval', 'agentRuntime', 'agentInterface', 'sandbox'] as const)
    .filter(
      (key) => manifest.substrate[key].trim().length === 0 || manifest.substrate[key] === 'unknown',
    )
    .map((key) => `manifest.substrate.${key}`)
  return {
    manifestPath: input.manifestPath,
    recordsPath: input.recordsPath,
    records: records.length,
    repoFailures,
    substrateFailures,
    projects: sortedUnique(records.map((record) => record.projectId)),
    benchmarks: sortedUnique(records.map((record) => record.benchmarkId)),
    arms: sortedUnique(records.map((record) => record.armId)),
    scenarios: sortedUnique(records.map((record) => record.scenarioId)),
    passed: records.filter((record) => record.outcome.pass).length,
    failed: records.filter((record) => !record.outcome.pass).length,
    inputTokens: sum(records, (record) => record.usage.inputTokens),
    outputTokens: sum(records, (record) => record.usage.outputTokens),
    costUsd: sum(records, (record) => record.usage.costUsd),
    wallMs: sum(records, (record) => record.usage.wallMs),
    integrityFailures,
    missingArtifacts,
  }
}

function missingArtifactsForRecord(record: ProductBenchmarkRecord, artifactRoot: string): string[] {
  const missing: string[] = []
  for (const [key, value] of Object.entries(record.artifacts)) {
    const path = resolveArtifactPath(value, artifactRoot)
    if (!existsSync(path)) missing.push(`${record.runId}:${key}:${value}`)
  }
  return missing
}

function resolveArtifactPath(value: string, artifactRoot: string): string {
  return value.startsWith('/') ? value : join(artifactRoot, value)
}

function assertUnique(values: readonly string[], path: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (seen.has(value)) fail(path, `duplicate ${value}`)
    seen.add(value)
  }
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort()
}

function sum<T>(items: readonly T[], fn: (item: T) => number): number {
  return items.reduce((total, item) => total + fn(item), 0)
}

export function findProductBenchmarkArtifacts(
  runDir: string,
): ProductBenchmarkArtifactPaths | null {
  const manifestPath = join(runDir, 'product-benchmark-manifest.json')
  const recordsPath = join(runDir, 'product-benchmark-records.jsonl')
  if (
    existsSync(manifestPath) &&
    statSync(manifestPath).isFile() &&
    existsSync(recordsPath) &&
    statSync(recordsPath).isFile()
  ) {
    return { manifestPath, recordsPath }
  }
  return null
}

/**
 * Fail-loud gate over a bundle directory: locates the manifest + records,
 * runs `validateProductBenchmarkRun`, and throws with every repo,
 * integrity, and artifact failure listed. Returns the report when clean.
 */
export function assertProductBenchmarkRun(runDir: string): ProductBenchmarkValidationReport {
  const artifacts = findProductBenchmarkArtifacts(runDir)
  if (!artifacts) {
    fail(runDir, 'missing product-benchmark-manifest.json or product-benchmark-records.jsonl')
  }
  const report = validateProductBenchmarkRun({ ...artifacts, artifactRoot: runDir })
  const failures = [
    ...report.repoFailures,
    ...report.substrateFailures,
    ...report.integrityFailures,
    ...report.missingArtifacts,
  ]
  if (failures.length > 0) {
    fail(runDir, `product benchmark validation failed:\n${failures.join('\n')}`)
  }
  return report
}

export type {
  ProductBenchmarkExportOptions,
  ProductBenchmarkExportResult,
  ProductBenchmarkSingleRunExportOptions,
} from './export'
export {
  buildProductBenchmarkManifest,
  exportProductBenchmark,
  exportProductBenchmarkRuns,
  productBenchmarkMutableSurfaces,
  productBenchmarkRepoIdentity,
  runRecordToProductBenchmarkRecord,
} from './export'
