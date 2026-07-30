import { readdir, readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import { OtlpFileTraceStore, otlpTextToTraceAnalysisStore } from '../trace-analyst/store-otlp'
import { createAnalystAi } from './ax-service'
import type { AnalystBenchmarkCase, AnalystBenchmarkRunner } from './benchmark'
import { registryBenchmarkRunner, traceStoreEvidenceResolver } from './benchmark'
import {
  type AgentRxRow,
  agentRxBenchmarkCase,
  agentRxPredictionsToFindings,
  type CodeTraceBenchRow,
  codeTraceBenchCase,
} from './benchmark-datasets'
import {
  appendVerificationArtifactsToOtlp,
  DEFAULT_MAX_VERIFICATION_ARTIFACT_BYTES,
  loadCodeTraceVerificationArtifacts,
  sha256Digest,
  type VerificationArtifactManifest,
} from './benchmark-verification-artifacts'
import { createTraceAnalystKind, type TraceAnalystKindSpec } from './kind-factory'
import { AnalystRegistry } from './registry'
import { buildTraceToolsForGroup } from './tool-groups'
import type { AnalystFinding, AnalystRunInputs } from './types'
import { makeFinding } from './types'

export type PublicAnalystBenchmarkDataset = 'agentrx' | 'codetracebench'

export interface PublicAnalystBenchmarkModelConfig {
  baseUrl: string
  apiKey: string
  model: string
  maxOutputTokens: number
  timeoutMs: number
}

export interface PreparedPublicAnalystBenchmark {
  cases: AnalystBenchmarkCase<AnalystRunInputs>[]
  sourceRowCount: number
  selectedCaseIds: string[]
  labelsSha256: string
  traceFiles: Array<{
    traceId: string
    path: string
    sha256: string
  }>
  verificationArtifacts: VerificationArtifactManifest[]
  selection: PublicBenchmarkSelectionReport
}

export interface PublicBenchmarkValueDistribution {
  total: number
  missing: number
  counts: Record<string, number>
}

export interface PublicBenchmarkDistributions {
  class: PublicBenchmarkValueDistribution
  agent: PublicBenchmarkValueDistribution
  model: PublicBenchmarkValueDistribution
  difficulty: PublicBenchmarkValueDistribution
  solved: PublicBenchmarkValueDistribution
}

export interface PublicBenchmarkSelectionReport {
  method: 'census' | 'deterministic-hash'
  seed: number
  sourceCount: number
  selectedCount: number
  stratified: false
  representativeOfInput: boolean
  source: PublicBenchmarkDistributions
  selected: PublicBenchmarkDistributions
}

export async function loadPublicBenchmarkRows(
  path: string,
): Promise<Array<Record<string, unknown>>> {
  const text = await readFile(path, 'utf8')
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
  if (isRecord(parsed)) return [parsed]
  throw new TypeError(`public analyst benchmark dataset must contain JSON objects: ${path}`)
}

export function selectPublicBenchmarkRows(
  dataset: PublicAnalystBenchmarkDataset,
  rows: readonly Record<string, unknown>[],
  options: { limit: number; seed: number },
): Array<Record<string, unknown>> {
  positiveInteger(options.limit, 'limit')
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
        selectionKey(options.seed, left).localeCompare(selectionKey(options.seed, right)) ||
        left.localeCompare(right),
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
          ? 'incorrect'
          : 'clean'
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
  const rows = await loadPublicBenchmarkRows(labelsPath)
  const selected = selectPublicBenchmarkRows(options.dataset, rows, {
    limit: options.limit,
    seed: options.seed,
  })
  const selectedTrajectoryIds = new Set(
    selected.map((row) => publicBenchmarkRowId(options.dataset, row)),
  )
  const stores = await indexSelectedSingleTraceFiles(
    resolve(options.traceDir),
    selectedTrajectoryIds,
  )
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
      verificationManifest = artifacts.manifest
      if (verificationManifest.status === 'missing') {
        throw new Error(
          `CodeTraceBench '${trajectoryId}' has no final verification artifact under ${verificationManifest.caseDirectoriesSearched.join(', ')}; searched ${Object.values(verificationManifest.searched).flat().join(', ')}`,
        )
      }
      const collisions = await indexed.store.hasSpans({
        trace_id: trajectoryId,
        span_ids: verificationManifest.files.map((file) => file.spanId),
      })
      if (collisions.length > 0) {
        throw new Error(
          `CodeTraceBench '${trajectoryId}' trace already contains benchmark verification span '${collisions[0]}'`,
        )
      }
      traceStore = otlpTextToTraceAnalysisStore(
        appendVerificationArtifactsToOtlp(
          await readFile(indexed.path, 'utf8'),
          trajectoryId,
          artifacts,
        ),
      )
      artifactDir = verificationManifest.caseDirectory
      verificationArtifacts.push(verificationManifest)
    }

    const input: AnalystRunInputs = { traceStore, artifactDir }
    const benchmarkCase =
      options.dataset === 'agentrx'
        ? agentRxBenchmarkCase(row as unknown as AgentRxRow, input)
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
        traceFile: indexed.path,
        traceFileSha256: indexed.sha256,
        ...(verificationManifest ? { verificationArtifacts: verificationManifest } : {}),
      },
    })
    traceFiles.push({
      traceId: trajectoryId,
      path: indexed.path,
      sha256: indexed.sha256,
    })
  }

  return {
    cases,
    sourceRowCount: rows.length,
    selectedCaseIds: cases.map((testCase) => testCase.id),
    labelsSha256: sha256Digest(await readFile(labelsPath)),
    traceFiles,
    verificationArtifacts,
    selection: publicBenchmarkSelectionReport(options.dataset, rows, selected, options.seed),
  }
}

export function createPublicBenchmarkModelRunner(
  dataset: PublicAnalystBenchmarkDataset,
  config: PublicAnalystBenchmarkModelConfig,
): AnalystBenchmarkRunner<AnalystRunInputs> {
  const registry = new AnalystRegistry()
  const spec = benchmarkSpec(dataset, config.maxOutputTokens)
  registry.register(
    createTraceAnalystKind(spec, {
      ai: createAnalystAi({
        apiKey: required(config.apiKey, 'apiKey'),
        baseUrl: required(config.baseUrl, 'baseUrl'),
        model: required(config.model, 'model'),
      }),
    }),
  )
  const rawRunner = registryBenchmarkRunner({
    id: 'model',
    registry,
    runOptions: {
      only: [spec.id],
      timeoutMs: positiveInteger(config.timeoutMs, 'timeoutMs'),
    },
  })

  return {
    id: 'model',
    async analyze(input, context) {
      const output = await rawRunner.analyze(input, context)
      const trajectoryId = trajectoryIdFromCaseId(dataset, context.caseId)
      return {
        ...output,
        findings: adaptPublicBenchmarkFindings(dataset, trajectoryId, output.findings, 'model'),
        metadata: {
          ...output.metadata,
          outputAdapter:
            dataset === 'agentrx'
              ? 'agentrx-taxonomy-and-root-step'
              : 'codetracebench-incorrect-step',
        },
      }
    },
  }
}

export function emptyPublicBenchmarkRunner(): AnalystBenchmarkRunner<AnalystRunInputs> {
  return {
    id: 'empty',
    analyze() {
      return {
        findings: [],
        usage: {
          calls: 0,
          tokens: { input: 0, output: 0 },
          cost: { kind: 'observed', usd: 0 },
        },
        metadata: { baseline: 'emit-no-findings' },
      }
    },
  }
}

export function adaptPublicBenchmarkFindings(
  dataset: PublicAnalystBenchmarkDataset,
  trajectoryId: string,
  findings: readonly AnalystFinding[],
  analystId: string,
): AnalystFinding[] {
  return dataset === 'agentrx'
    ? adaptAgentRxFindings(trajectoryId, findings, analystId)
    : adaptCodeTraceFindings(trajectoryId, findings, analystId)
}

function adaptAgentRxFindings(
  trajectoryId: string,
  findings: readonly AnalystFinding[],
  analystId: string,
): AnalystFinding[] {
  if (findings.length === 0) return []
  if (findings.length !== 1) {
    throw new Error(
      `AgentRx model analyst must emit zero or one root cause, received ${findings.length}`,
    )
  }
  const source = findings[0]!
  if (!source.subject) {
    throw new Error('AgentRx model analyst finding is missing its failure-category subject')
  }
  const steps = exactFindingSteps(trajectoryId, source)
  if (steps.length !== 1) {
    throw new Error(
      `AgentRx model analyst must cite exactly one root-cause step, received ${steps.length}`,
    )
  }
  const [adapted] = agentRxPredictionsToFindings(
    trajectoryId,
    [
      {
        failure_case: source.subject,
        step_number: steps[0]!,
        description: source.rationale ?? source.claim,
      },
    ],
    {
      analystId,
      producedAt: source.produced_at,
      confidence: source.confidence,
    },
  )
  if (!adapted) throw new Error('AgentRx output adapter produced no root-cause finding')
  return [
    {
      ...adapted,
      metadata: {
        ...adapted.metadata,
        sourceFindingId: source.finding_id,
      },
    },
  ]
}

function adaptCodeTraceFindings(
  trajectoryId: string,
  findings: readonly AnalystFinding[],
  analystId: string,
): AnalystFinding[] {
  const clean = findings.filter((finding) => finding.subject === 'clean')
  if (clean.length > 0) {
    if (findings.length !== 1) {
      throw new Error('CodeTraceBench model analyst mixed a clean verdict with incorrect steps')
    }
    exactFindingSteps(trajectoryId, clean[0]!)
    return []
  }
  const byStep = new Map<number, AnalystFinding>()
  for (const source of findings) {
    const steps = exactFindingSteps(trajectoryId, source)
    for (const step of steps) {
      if (byStep.has(step)) continue
      byStep.set(
        step,
        makeFinding({
          analyst_id: analystId,
          area: 'incorrect',
          subject: `incorrect-step-${step}`,
          claim: `Step ${step} is incorrect. ${source.claim}`,
          rationale: source.rationale,
          severity: source.severity,
          confidence: source.confidence,
          evidence_refs: [
            {
              kind: 'span',
              uri: stepEvidenceUri(trajectoryId, step),
              excerpt: source.evidence_refs.find(
                (evidence) => evidence.uri === stepEvidenceUri(trajectoryId, step),
              )?.excerpt,
            },
          ],
          recommended_action: source.recommended_action,
          metadata: { sourceFindingId: source.finding_id },
          produced_at: source.produced_at,
          id_basis: `incorrect-step-${step}`,
        }),
      )
    }
  }
  return [...byStep].sort(([left], [right]) => left - right).map(([, finding]) => finding)
}

function exactFindingSteps(trajectoryId: string, finding: AnalystFinding): number[] {
  if (finding.evidence_refs.length === 0) {
    throw new Error(`model finding '${finding.finding_id}' has no step evidence`)
  }
  const steps = finding.evidence_refs.map((evidence) => {
    const parsed = parseStepEvidence(evidence.uri)
    if (!parsed || parsed.traceId !== trajectoryId) {
      throw new Error(
        `model finding '${finding.finding_id}' cites non-case evidence '${evidence.uri}'`,
      )
    }
    return parsed.step
  })
  return [...new Set(steps)]
}

function benchmarkSpec(
  dataset: PublicAnalystBenchmarkDataset,
  maxOutputTokens: number,
): TraceAnalystKindSpec {
  const common = {
    version: '1.0.0',
    buildTools: (store: TraceAnalysisStore) => buildTraceToolsForGroup('all', store),
    subqueries: { maxCalls: 0 },
    maxTurns: 12,
    maxRuntimeChars: 8_000,
    maxOutputTokens: positiveInteger(maxOutputTokens, 'maxOutputTokens'),
    minimumEvidenceCitations: 1,
    cost: { kind: 'llm' as const },
  }
  if (dataset === 'agentrx') {
    return {
      ...common,
      id: 'agentrx-root-cause-localizer',
      description:
        'Finds the first unrecoverable failure step and classifies it with the AgentRx taxonomy.',
      area: 'agentrx-model-output',
      actorDescription: AGENT_RX_PROMPT,
    }
  }
  return {
    ...common,
    id: 'codetracebench-step-localizer',
    description: 'Finds task-causal incorrect steps using the trajectory and final verification.',
    area: 'incorrect',
    actorDescription: CODE_TRACE_BENCH_ANALYST_PROMPT,
  }
}

const AGENT_RX_PROMPT = `Analyze exactly one failed agent trajectory.
Find the first unrecoverable critical failure, not every later symptom.
Use the trace tools to inspect the complete trajectory.
Emit zero findings only when the trace does not contain enough evidence.
Otherwise emit exactly one finding.
Its subject MUST be exactly one of:
instruction-plan-adherence-failure
invention-of-new-information
invalid-invocation
misinterpretation-of-tool-output-handoff-failure
intent-plan-misalignment
underspecified-user-intent
intent-not-supported
guardrails-triggered
system-failure
inconclusive
The finding MUST cite exactly one URI in the form trace://<encoded-trace-id>/span/step-<n>.
The cited step is the first unrecoverable critical failure.`

export const CODE_TRACE_BENCH_ANALYST_PROMPT = `Analyze exactly one coding-agent trajectory and its attached final verification.
Inspect every final-verification EVALUATOR span before classifying any assistant step.
Use viewTrace to locate those spans.
If the trace is oversized, use searchTrace for final-verification to find their span ids.
Use viewSpans or searchSpan when artifact.content is truncated.
Identify task-causal incorrect assistant actions: state changes that introduce a verified defect, incorrect hypotheses that drive consequential later actions, or reasoning that contradicts observed evidence and changes the result.
A command, tool, or inspection error is not an incorrect step when the agent recovers and it does not cause the final task result.
Do not label a step merely because it is redundant, verbose, inefficient, or a failed but recovered probe.
When final verification fails, trace each observed failure back to the assistant action that caused it; do not label unrelated local errors.
When final verification passes, do not manufacture incorrect steps from recovered errors.
Emit one finding per incorrect assistant step.
Each finding MUST cite exactly one URI in the form trace://<encoded-trace-id>/span/step-<n>.
Use subject incorrect-step-<n>.
When the trajectory has no incorrect steps, emit exactly one info finding with subject clean, claim "No incorrect steps were found.", and cite the first assistant step as the inspection anchor.
Never mix the clean finding with incorrect-step findings.`

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
    }
  >()
  for (const path of files) {
    const store = new OtlpFileTraceStore({ path })
    const overview = await store.getOverview()
    if (overview.total_traces !== 1 || overview.sample_trace_ids.length !== 1) {
      throw new Error(
        `public analyst benchmark trace file must contain exactly one trace: ${path} contains ${overview.total_traces}`,
      )
    }
    const traceId = overview.sample_trace_ids[0]!
    if (!selectedTraceIds.has(traceId)) continue
    if (indexed.has(traceId)) {
      throw new Error(`public analyst benchmark trace id '${traceId}' appears in multiple files`)
    }
    indexed.set(traceId, {
      path,
      sha256: sha256Digest(await readFile(path)),
      store,
    })
  }
  return indexed
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

function trajectoryIdFromCaseId(dataset: PublicAnalystBenchmarkDataset, caseId: string): string {
  const prefix = dataset === 'agentrx' ? 'agentrx:' : 'codetrace:'
  if (!caseId.startsWith(prefix) || caseId.length === prefix.length) {
    throw new Error(`unexpected ${dataset} benchmark case id '${caseId}'`)
  }
  return caseId.slice(prefix.length)
}

function parseStepEvidence(uri: string): { traceId: string; step: number } | null {
  const match = /^trace:\/\/([^/]+)\/span\/step-(\d+)$/.exec(uri)
  if (!match) return null
  try {
    const traceId = decodeURIComponent(match[1]!)
    const step = Number(match[2])
    return traceId && Number.isSafeInteger(step) && step > 0 ? { traceId, step } : null
  } catch {
    return null
  }
}

function spanIdFromEvidence(uri: string): string | null {
  const match = /\/span\/([^/]+)$/.exec(uri)
  return match?.[1] ? decodeURIComponent(match[1]) : null
}

function stepEvidenceUri(traceId: string, step: number): string {
  return `trace://${encodeURIComponent(traceId)}/span/step-${step}`
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

function required(value: string, field: string): string {
  const trimmed = value.trim()
  if (!trimmed) throw new TypeError(`${field} must be a non-empty string`)
  return trimmed
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`)
  }
  return value
}

function safeInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value)) throw new RangeError(`${field} must be a safe integer`)
  return value
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
