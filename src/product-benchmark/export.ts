/**
 * Export side of the product benchmark bundle contract: convert product
 * eval run directories (`records.jsonl` of `RunRecord` rows + trace/raw
 * artifacts) into a portable `product-benchmark-manifest.json` +
 * `product-benchmark-records.jsonl` bundle that
 * `validateProductBenchmarkRun` accepts.
 *
 * Product-specific policy (safety-split detection, tool-call recovery,
 * profile id fallback, artifact materialization) enters through explicit
 * options; everything else is the shared union of the tax/legal/creative
 * exporters. Scenario catalogs, smoke runners, and CLIs stay in the
 * products.
 *
 * Input rows are checked structurally, not with `validateRunRecord`:
 * product harnesses record bare model aliases and partial provenance, and
 * the bundle contract's own validators re-check every field that matters
 * on the way out.
 */

import { spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { ValidationError } from '../errors'
import type { RunRecord } from '../run-record'
import type {
  ProductBenchmarkManifest,
  ProductBenchmarkRecord,
  ProductBenchmarkSplit,
  RuntimeResolution,
} from './index'
import { validateProductBenchmarkManifest, validateProductBenchmarkRecord } from './index'

/** Full mutable-surface superset a product arm may declare. */
export const productBenchmarkMutableSurfaces = [
  'prompt',
  'resources.files',
  'tools',
  'mcp',
  'hooks',
  'subagents',
] as const

export interface ProductBenchmarkExportOptions {
  /** Source eval run directories, each containing a `records.jsonl` of RunRecord rows. */
  readonly runDirs: readonly string[]
  /** Destination directory for the bundle (manifest + records + materialized source runs). */
  readonly outDir: string
  readonly projectId: string
  readonly benchmarkId: string
  /** Repo-relative path of the product's canonical agent profile source. */
  readonly agentProfilePath: string
  /** Pass threshold applied when a row carries no explicit `outcome.raw.pass`. Default 0.7. */
  readonly passThreshold?: number
  /**
   * First scenario tag. Defaults to `projectId` with a trailing `-agent`
   * stripped (`tax-agent` → `tax`), matching the product exporters.
   */
  readonly scenarioTagPrefix?: string
  /** Profile id used when a row has no `agentProfile.profileId`. Defaults to the row's arm id. */
  readonly fallbackProfileId?: string
  /** Arm mutable surfaces recorded in the manifest. Defaults to the full superset. */
  readonly mutableSurfaces?: readonly string[]
  /**
   * Copy each run dir into `<outDir>/source-runs/` and record
   * bundle-relative artifact paths (portable, self-contained). When false,
   * artifacts keep absolute paths into the original run dirs. Default true.
   */
  readonly materializeSourceRuns?: boolean
  /**
   * Override split classification for a row. Return undefined to fall back
   * to the default (`outcome.raw.safety === 1` → safety, then splitTag).
   */
  readonly classifySplit?: (record: RunRecord) => ProductBenchmarkSplit | undefined
  /** Recovers a tool-call count when the row's raw bag carries none (e.g. from turn artifacts). */
  readonly toolCallFallback?: (record: RunRecord, runDir: string) => number
  /** Backend version recorded per row. Defaults to the cwd package.json's `@tangle-network/sandbox` range. */
  readonly backendVersion?: string
  /**
   * Explicit substrate versions for the manifest, merged over what the cwd
   * package.json / node_modules resolve. Use when a substrate package is not
   * installed where the export runs — the validator refuses an `'unknown'`
   * version, so provide the real one rather than shipping the sentinel.
   */
  readonly substrate?: Partial<ProductBenchmarkManifest['substrate']>
}

export interface ProductBenchmarkSingleRunExportOptions
  extends Omit<ProductBenchmarkExportOptions, 'runDirs'> {
  readonly runDir: string
}

export interface ProductBenchmarkExportResult {
  readonly manifestPath: string
  readonly recordsPath: string
  readonly records: number
}

interface ResolvedExportOptions {
  readonly projectId: string
  readonly benchmarkId: string
  readonly agentProfilePath: string
  readonly passThreshold: number
  readonly scenarioTagPrefix: string
  readonly fallbackProfileId?: string
  readonly mutableSurfaces: readonly string[]
  readonly classifySplit?: (record: RunRecord) => ProductBenchmarkSplit | undefined
  readonly toolCallFallback?: (record: RunRecord, runDir: string) => number
  readonly backendVersion: string
}

// ── Provenance helpers ───────────────────────────────────────────────

function sha256(value: string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`
}

function safePathPart(value: string): string {
  return (
    value
      .replace(/[^a-zA-Z0-9_.-]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'artifact'
  )
}

function git(args: readonly string[], fallback: string): string {
  const res = spawnSync('git', args, { cwd: process.cwd(), encoding: 'utf8' })
  const value = res.status === 0 ? res.stdout.trim() : ''
  return value.length > 0 ? value : fallback
}

function knownEnv(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value && value !== 'unknown' ? value : undefined
}

function ciBranchName(): string | undefined {
  const direct =
    knownEnv('GITHUB_HEAD_REF') ?? knownEnv('GITHUB_REF_NAME') ?? knownEnv('VERCEL_GIT_COMMIT_REF')
  if (direct) return direct
  const ref = knownEnv('GITHUB_REF')
  return ref?.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : undefined
}

function repoBranch(): string {
  const ci = ciBranchName()
  if (ci) return ci
  const branch = git(['branch', '--show-current'], '')
  if (branch) return branch
  const name = git(['name-rev', '--name-only', '--exclude=tags/*', 'HEAD'], '')
  if (name && name !== 'undefined') return name
  return `detached:${git(['rev-parse', '--short', 'HEAD'], 'unknown')}`
}

/** Repo identity from the exporting process's cwd. `'unknown'` values are flagged by `validateProductBenchmarkRun`. */
export function productBenchmarkRepoIdentity(): ProductBenchmarkManifest['repo'] {
  return {
    url: git(['config', '--get', 'remote.origin.url'], 'unknown'),
    commit: git(['rev-parse', 'HEAD'], 'unknown'),
    branch: repoBranch(),
  }
}

/** The declared range from the cwd package.json when present, else the
 *  INSTALLED version read from node_modules (covers transitive installs —
 *  a product that gets sandbox via agent-runtime still records real
 *  provenance), else the `'unknown'` sentinel the validator refuses. */
function packageVersion(name: string): string {
  const pkg = JSON.parse(readFileSync(resolve('package.json'), 'utf8')) as {
    name?: string
    version?: string
    dependencies?: Record<string, string>
    devDependencies?: Record<string, string>
  }
  if (pkg.name === name && pkg.version) return pkg.version
  const declared = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name]
  if (declared) return declared
  const installed = resolve('node_modules', name, 'package.json')
  if (existsSync(installed)) {
    const installedPkg = JSON.parse(readFileSync(installed, 'utf8')) as { version?: string }
    if (installedPkg.version) return installedPkg.version
  }
  return 'unknown'
}

// ── Run record ingestion ─────────────────────────────────────────────

function readRunRecords(path: string): RunRecord[] {
  const lines = readFileSync(path, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
  return lines.map((line, index) => {
    let parsed: unknown
    try {
      parsed = JSON.parse(line)
    } catch (err) {
      throw new ValidationError(
        `${path}:${index + 1}: ${err instanceof Error ? err.message : String(err)}`,
        { cause: err },
      )
    }
    return expectRunRecordShape(parsed, `${path}:${index + 1}`)
  })
}

function expectRunRecordShape(value: unknown, path: string): RunRecord {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new ValidationError(`${path}: run record must be an object`)
  }
  const obj = value as Record<string, unknown>
  for (const key of ['runId', 'model'] as const) {
    if (typeof obj[key] !== 'string' || obj[key].length === 0) {
      throw new ValidationError(`${path}: run record ${key} must be a non-empty string`)
    }
  }
  for (const key of ['costUsd', 'wallMs'] as const) {
    if (typeof obj[key] !== 'number' || !Number.isFinite(obj[key])) {
      throw new ValidationError(`${path}: run record ${key} must be a finite number`)
    }
  }
  const tokenUsage = obj.tokenUsage as Record<string, unknown> | undefined
  if (
    !tokenUsage ||
    typeof tokenUsage.input !== 'number' ||
    typeof tokenUsage.output !== 'number'
  ) {
    throw new ValidationError(`${path}: run record tokenUsage.input/output must be numbers`)
  }
  const outcome = obj.outcome as Record<string, unknown> | undefined
  if (!outcome?.raw || typeof outcome.raw !== 'object') {
    throw new ValidationError(`${path}: run record outcome.raw must be an object`)
  }
  return value as RunRecord
}

// ── Row mapping ──────────────────────────────────────────────────────

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function splitOf(record: RunRecord, opts: ResolvedExportOptions): ProductBenchmarkSplit {
  const custom = opts.classifySplit?.(record)
  if (custom) return custom
  if ((record.outcome.raw as Record<string, number>).safety === 1) return 'safety'
  if (record.splitTag === 'holdout') return 'holdout'
  if (record.splitTag === 'dev') return 'dev'
  return 'practice'
}

function scoreOf(record: RunRecord): number {
  const score = record.outcome.holdoutScore ?? record.outcome.searchScore
  if (typeof score === 'number' && Number.isFinite(score)) return clamp01(score)
  const rawScore = record.outcome.raw.score ?? record.outcome.raw.composite
  return typeof rawScore === 'number' && Number.isFinite(rawScore) ? clamp01(rawScore) : 0
}

function rawPassOf(record: RunRecord): boolean | null {
  const rawPass = (record.outcome.raw as Record<string, unknown>).pass
  if (typeof rawPass === 'boolean') return rawPass
  if (typeof rawPass === 'number' && Number.isFinite(rawPass)) return rawPass >= 1
  return null
}

function passOf(record: RunRecord, score: number, threshold: number): boolean {
  const rawPass = rawPassOf(record)
  if (rawPass !== null) return rawPass && !record.failureMode
  return score >= threshold && !record.failureMode
}

/** A failed row always carries a failure mode; synthesized when the harness left it empty. */
function failureModeOf(record: RunRecord, score: number, threshold: number): string | null {
  if (record.failureMode) return record.failureMode
  const belowThreshold = `quality-below-threshold: ${Math.round(score * 100)}% < ${Math.round(threshold * 100)}%`
  if (rawPassOf(record) === false) {
    return score < threshold ? belowThreshold : 'product-pass-failed'
  }
  if (passOf(record, score, threshold)) return null
  return belowThreshold
}

function numericDimensions(record: RunRecord): Record<string, number> {
  const dimensions: Record<string, number> = {}
  for (const [key, value] of Object.entries(record.outcome.raw ?? {})) {
    if (typeof value === 'number' && Number.isFinite(value)) dimensions[key] = value
  }
  if (Object.keys(dimensions).length === 0) dimensions.score = scoreOf(record)
  return dimensions
}

function armIdOf(record: RunRecord): string {
  if (record.candidateId) return record.candidateId
  const variant = record.agentProfile?.dimensions?.variant
  if (typeof variant === 'string' && variant.length > 0) return variant
  const variantId = record.agentProfile?.dimensions?.variantId
  if (typeof variantId === 'string' && variantId.length > 0) return variantId
  return 'production-profile'
}

function backendOf(record: RunRecord): string {
  const backend = record.agentProfile?.dimensions?.backend
  return typeof backend === 'string' && backend.length > 0 ? backend : 'unknown'
}

function modelProvider(record: RunRecord): string {
  const backend = backendOf(record)
  if (backend === 'cli-bridge') return 'cli-bridge'
  if (backend === 'sandbox') return 'router'
  if (record.model.startsWith('router/')) return 'router'
  return backend === 'unknown' ? 'router' : backend
}

function runtimeResolution(record: RunRecord, opts: ResolvedExportOptions): RuntimeResolution {
  const reasoningEffort = record.agentProfile?.dimensions?.reasoningLevel
  return {
    model: record.agentProfile?.model ?? record.model,
    harness: record.agentProfile?.harness?.id ?? `${opts.projectId}-canonical-eval`,
    backend: backendOf(record),
    ...(typeof reasoningEffort === 'string' && reasoningEffort.length > 0
      ? { reasoningEffort }
      : {}),
  }
}

function sourceProfileHash(record: RunRecord): string {
  return (
    record.agentProfile?.sourceProfile?.hash ??
    record.agentProfile?.cellId ??
    sha256(
      JSON.stringify({
        candidateId: record.candidateId,
        promptHash: record.promptHash,
        configHash: record.configHash,
      }),
    )
  )
}

function materializedProfileHash(record: RunRecord, runtime: RuntimeResolution): string {
  return sha256(
    JSON.stringify({ sourceProfileHash: sourceProfileHash(record), model: runtime.model }),
  )
}

function profileIdOf(
  record: RunRecord,
  armId: string,
  runtime: RuntimeResolution,
  opts: ResolvedExportOptions,
): string {
  const base = record.agentProfile?.profileId ?? opts.fallbackProfileId ?? armId
  const withArm = base.endsWith(`:${armId}`) ? base : `${base}:${armId}`
  return `${withArm}:${runtime.model}`
}

function toolCallsOf(record: RunRecord, runDir: string, opts: ResolvedExportOptions): number {
  const raw = record.outcome.raw as Record<string, unknown>
  const primary = Number(raw.tool_call_count ?? raw.tool_calls ?? raw.toolCalls ?? 0)
  if (Number.isFinite(primary) && primary > 0) return primary
  const fallback = opts.toolCallFallback?.(record, runDir)
  if (fallback !== undefined && Number.isFinite(fallback) && fallback > 0) return fallback
  return Number.isFinite(primary) ? primary : 0
}

// ── Artifact layout ──────────────────────────────────────────────────

const TRACE_CANDIDATES = ['traces.jsonl', 'traces', 'trace', 'trace-store'] as const
const RAW_CANDIDATES = ['raws.jsonl', 'raw-events'] as const
const SCORE_CANDIDATES = ['scores.json', 'manifest.json'] as const

function firstExisting(runDir: string, candidates: readonly string[]): string {
  return candidates.find((candidate) => existsSync(join(runDir, candidate))) ?? candidates[0]!
}

function relativeArtifacts(runDir: string): ProductBenchmarkRecord['artifacts'] {
  return {
    records: 'records.jsonl',
    traces: firstExisting(runDir, TRACE_CANDIDATES),
    raws: firstExisting(runDir, RAW_CANDIDATES),
    scores: firstExisting(runDir, SCORE_CANDIDATES),
    workspace: existsSync(join(runDir, 'workspace')) ? 'workspace' : '.',
  }
}

function absoluteArtifacts(runDir: string): ProductBenchmarkRecord['artifacts'] {
  const rel = relativeArtifacts(runDir)
  return {
    records: resolve(runDir, rel.records),
    traces: resolve(runDir, rel.traces),
    raws: resolve(runDir, rel.raws),
    scores: resolve(runDir, rel.scores),
    workspace: resolve(runDir, rel.workspace),
  }
}

function materializeRunArtifacts(
  runDir: string,
  outDir: string,
  index: number,
): ProductBenchmarkRecord['artifacts'] {
  if (resolve(runDir) === resolve(outDir)) return relativeArtifacts(runDir)
  const rel = relative(runDir, outDir)
  if (rel && !rel.startsWith('..') && !isAbsolute(rel)) {
    throw new ValidationError(`outDir must not be nested inside runDir: ${outDir}`)
  }
  const id = `${String(index + 1).padStart(2, '0')}-${safePathPart(basename(runDir))}-${sha256(runDir).slice(7, 19)}`
  const destRel = join('source-runs', id)
  const destAbs = join(outDir, destRel)
  mkdirSync(dirname(destAbs), { recursive: true })
  cpSync(runDir, destAbs, { recursive: true, force: true })
  const source = relativeArtifacts(runDir)
  return {
    records: join(destRel, source.records),
    traces: join(destRel, source.traces),
    raws: join(destRel, source.raws),
    scores: join(destRel, source.scores),
    workspace: source.workspace === '.' ? destRel : join(destRel, source.workspace),
  }
}

function existsArtifact(artifactRoot: string, value: string): boolean {
  return existsSync(resolve(artifactRoot, value))
}

// ── Record + manifest construction ───────────────────────────────────

/** Map one RunRecord row to a validated product benchmark record. */
export function runRecordToProductBenchmarkRecord(
  record: RunRecord,
  runDir: string,
  artifactRoot: string,
  artifacts: ProductBenchmarkRecord['artifacts'],
  options: ProductBenchmarkExportOptions | ProductBenchmarkSingleRunExportOptions,
): ProductBenchmarkRecord {
  const opts = resolveOptions(options)
  const runtime = runtimeResolution(record, opts)
  const score = scoreOf(record)
  const armId = armIdOf(record)
  const inputTokens = record.tokenUsage.input
  const outputTokens = record.tokenUsage.output
  const toolCallCount = toolCallsOf(record, runDir, opts)
  const dimensions = numericDimensions(record)
  if (!('tool_calls' in dimensions)) dimensions.tool_calls = toolCallCount
  const product: ProductBenchmarkRecord = {
    schemaVersion: 1,
    projectId: opts.projectId,
    benchmarkId: opts.benchmarkId,
    runId: record.runId,
    scenarioId: record.scenarioId ?? record.experimentId,
    split: splitOf(record, opts),
    armId,
    rep: Number(record.seed ?? 0) + 1,
    agentProfile: {
      id: profileIdOf(record, armId, runtime, opts),
      hash: materializedProfileHash(record, runtime),
      path: opts.agentProfilePath,
      declared: runtime,
      resolved: runtime,
    },
    model: { provider: modelProvider(record), id: record.model },
    backend: { kind: backendOf(record), version: opts.backendVersion },
    outcome: {
      pass: passOf(record, score, opts.passThreshold),
      score,
      dimensions,
      failureMode: failureModeOf(record, score, opts.passThreshold),
    },
    usage: {
      inputTokens,
      outputTokens,
      costUsd: record.costUsd,
      // Rounded: the bundle contract requires integer milliseconds.
      wallMs: Math.round(record.wallMs),
      toolCalls: toolCallCount,
    },
    integrity: {
      realBackend: inputTokens + outputTokens > 0,
      rawCapture: existsArtifact(artifactRoot, artifacts.raws),
      traceCapture: existsArtifact(artifactRoot, artifacts.traces),
      noStubRows: inputTokens + outputTokens > 0,
      priced: record.costUsd > 0,
      profileMaterialized: Boolean(record.agentProfile?.cellId),
    },
    artifacts,
  }
  return validateProductBenchmarkRecord(product)
}

/** One record per arm id, failing loud when records sharing an arm id
 *  disagree on any attribute the manifest arm carries (profile, model,
 *  backend, harness, reasoning effort) — an id-only dedup would silently
 *  keep one policy and misrepresent the rest. */
function uniqueArmRecords(records: readonly ProductBenchmarkRecord[]): ProductBenchmarkRecord[] {
  const byArm = new Map<string, ProductBenchmarkRecord>()
  for (const record of records) {
    const prior = byArm.get(record.armId)
    if (!prior) {
      byArm.set(record.armId, record)
      continue
    }
    const fields = [
      ['profileId', prior.agentProfile.id, record.agentProfile.id],
      ['model', prior.agentProfile.resolved.model, record.agentProfile.resolved.model],
      ['backend', prior.agentProfile.resolved.backend, record.agentProfile.resolved.backend],
      ['harness', prior.agentProfile.resolved.harness, record.agentProfile.resolved.harness],
      [
        'reasoningEffort',
        prior.agentProfile.resolved.reasoningEffort,
        record.agentProfile.resolved.reasoningEffort,
      ],
    ] as const
    for (const [name, a, b] of fields) {
      if (a !== b) {
        throw new ValidationError(
          `records for arm '${record.armId}' disagree on ${name} (${String(a)} vs ${String(b)}) — one arm id must map to one policy`,
        )
      }
    }
  }
  return [...byArm.values()]
}

/** One record per scenario id, failing loud on a divergent split — the
 *  manifest scenario carries one split, so two records disagreeing would be
 *  silently misfiled. */
function uniqueScenarioRecords(
  records: readonly ProductBenchmarkRecord[],
): ProductBenchmarkRecord[] {
  const byScenario = new Map<string, ProductBenchmarkRecord>()
  for (const record of records) {
    const prior = byScenario.get(record.scenarioId)
    if (!prior) {
      byScenario.set(record.scenarioId, record)
      continue
    }
    if (prior.split !== record.split) {
      throw new ValidationError(
        `records for scenario '${record.scenarioId}' disagree on split (${prior.split} vs ${record.split})`,
      )
    }
  }
  return [...byScenario.values()]
}

/** Derive the bundle manifest from already-normalized records. */
export function buildProductBenchmarkManifest(
  records: readonly ProductBenchmarkRecord[],
  options: Pick<
    ProductBenchmarkExportOptions,
    'outDir' | 'projectId' | 'benchmarkId' | 'scenarioTagPrefix' | 'mutableSurfaces' | 'substrate'
  >,
): ProductBenchmarkManifest {
  if (records.length === 0) {
    throw new ValidationError('cannot build a product benchmark manifest from zero records')
  }
  const scenarioTagPrefix = options.scenarioTagPrefix ?? defaultScenarioTagPrefix(options.projectId)
  const mutableSurfaces = options.mutableSurfaces ?? productBenchmarkMutableSurfaces
  const byProfile = new Map<string, ProductBenchmarkManifest['profiles'][number]>()
  for (const record of records) {
    byProfile.set(record.agentProfile.id, {
      id: record.agentProfile.id,
      profileHash: record.agentProfile.hash,
      agentProfilePath: record.agentProfile.path,
    })
  }
  const manifest: ProductBenchmarkManifest = {
    schemaVersion: 1,
    projectId: options.projectId,
    benchmarkId: options.benchmarkId,
    repo: productBenchmarkRepoIdentity(),
    substrate: {
      agentEval: packageVersion('@tangle-network/agent-eval'),
      agentRuntime: packageVersion('@tangle-network/agent-runtime'),
      agentInterface: packageVersion('@tangle-network/agent-interface'),
      sandbox: packageVersion('@tangle-network/sandbox'),
      ...options.substrate,
    },
    profiles: [...byProfile.values()],
    arms: uniqueArmRecords(records).map((record) => ({
      id: record.armId,
      profileId: record.agentProfile.id,
      mutableSurfaces: [...mutableSurfaces],
      policyAxes: {
        carrier: record.armId.includes('policy') ? 'resource-file' : 'profile',
        model: record.agentProfile.resolved.model,
        backend: record.agentProfile.resolved.backend,
        harness: record.agentProfile.resolved.harness,
        ...(record.agentProfile.resolved.reasoningEffort !== undefined
          ? { reasoningEffort: record.agentProfile.resolved.reasoningEffort }
          : {}),
      },
    })),
    scenarios: uniqueScenarioRecords(records).map((record) => ({
      id: record.scenarioId,
      split: record.split,
      tags: [scenarioTagPrefix, options.benchmarkId, record.split],
      sourceAllowedForSynthesis: false,
    })),
    budgets: {
      maxUsd: records.reduce((sum, record) => sum + record.usage.costUsd, 0),
      maxCells: records.length,
      maxWallMs: records.reduce((sum, record) => sum + record.usage.wallMs, 0),
    },
    expectedArtifactDir: resolve(options.outDir),
  }
  return validateProductBenchmarkManifest(manifest)
}

// ── Entry points ─────────────────────────────────────────────────────

/** Single-run convenience wrapper over `exportProductBenchmarkRuns`. */
export function exportProductBenchmark(
  options: ProductBenchmarkSingleRunExportOptions,
): ProductBenchmarkExportResult {
  const { runDir, ...rest } = options
  return exportProductBenchmarkRuns({ ...rest, runDirs: [runDir] })
}

/**
 * Export one or more product eval run dirs into a validated product
 * benchmark bundle at `outDir`. Both the manifest and every record are
 * run through the contract validators before anything is written.
 */
export function exportProductBenchmarkRuns(
  options: ProductBenchmarkExportOptions,
): ProductBenchmarkExportResult {
  const opts = resolveOptions(options)
  const outDir = resolve(options.outDir)
  const runDirs = options.runDirs.map((runDir) => resolve(runDir))
  if (runDirs.length === 0) throw new ValidationError('export requires at least one run directory')
  const materialize = options.materializeSourceRuns !== false
  const rows = runDirs.flatMap((runDir) => {
    const sourceRecordsPath = join(runDir, 'records.jsonl')
    if (!existsSync(sourceRecordsPath)) throw new ValidationError(`missing ${sourceRecordsPath}`)
    const records = readRunRecords(sourceRecordsPath)
    if (records.length === 0) throw new ValidationError(`${sourceRecordsPath} is empty`)
    return records.map((record) => ({ record, runDir }))
  })
  mkdirSync(outDir, { recursive: true })
  const artifactsByRunDir = new Map<string, ProductBenchmarkRecord['artifacts']>()
  for (const [index, runDir] of runDirs.entries()) {
    artifactsByRunDir.set(
      runDir,
      materialize ? materializeRunArtifacts(runDir, outDir, index) : absoluteArtifacts(runDir),
    )
  }
  const artifactRoot = materialize ? outDir : '/'
  const normalized = rows.map(({ record, runDir }) =>
    runRecordToProductBenchmarkRecord(
      record,
      runDir,
      artifactRoot,
      artifactsByRunDir.get(runDir)!,
      { ...options, runDirs, backendVersion: opts.backendVersion },
    ),
  )
  const manifest = buildProductBenchmarkManifest(normalized, {
    outDir,
    projectId: opts.projectId,
    benchmarkId: opts.benchmarkId,
    scenarioTagPrefix: opts.scenarioTagPrefix,
    mutableSurfaces: opts.mutableSurfaces,
    ...(options.substrate !== undefined ? { substrate: options.substrate } : {}),
  })
  const manifestPath = join(outDir, 'product-benchmark-manifest.json')
  const recordsPath = join(outDir, 'product-benchmark-records.jsonl')
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
  writeFileSync(recordsPath, `${normalized.map((record) => JSON.stringify(record)).join('\n')}\n`)
  return { manifestPath, recordsPath, records: normalized.length }
}

function defaultScenarioTagPrefix(projectId: string): string {
  return projectId.replace(/-agent$/, '') || projectId
}

function resolveOptions(
  options: ProductBenchmarkExportOptions | ProductBenchmarkSingleRunExportOptions,
): ResolvedExportOptions {
  return {
    projectId: options.projectId,
    benchmarkId: options.benchmarkId,
    agentProfilePath: options.agentProfilePath,
    passThreshold: options.passThreshold ?? 0.7,
    scenarioTagPrefix: options.scenarioTagPrefix ?? defaultScenarioTagPrefix(options.projectId),
    ...(options.fallbackProfileId !== undefined
      ? { fallbackProfileId: options.fallbackProfileId }
      : {}),
    mutableSurfaces: options.mutableSurfaces ?? productBenchmarkMutableSurfaces,
    ...(options.classifySplit !== undefined ? { classifySplit: options.classifySplit } : {}),
    ...(options.toolCallFallback !== undefined
      ? { toolCallFallback: options.toolCallFallback }
      : {}),
    backendVersion: options.backendVersion ?? packageVersion('@tangle-network/sandbox'),
  }
}
