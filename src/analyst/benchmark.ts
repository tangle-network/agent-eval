import { performance } from 'node:perf_hooks'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import { assertValidAnalystScoringCase, scoreAnalystFindings } from './benchmark-scoring'
import { summarizeAnalystBenchmarkRunner } from './benchmark-summary'
import type { AnalystRegistry, RegistryRunOpts } from './registry'
import type {
  AnalystFinding,
  AnalystRunInputs,
  AnalystRunResult,
  AnalystUsageReceipt,
  EvidenceRef,
} from './types'
import { assertValidAnalystUsageReceipt } from './usage-receipt'

export { scoreAnalystFindings } from './benchmark-scoring'

export interface AnalystEvidenceExpectation {
  uri: string
  kind?: EvidenceRef['kind']
}

export interface AnalystIssueExpectation {
  id: string
  findingIds?: readonly string[]
  areas?: readonly string[]
  subjects?: readonly string[]
  evidence?: readonly AnalystEvidenceExpectation[]
  evidenceMode?: 'any' | 'all'
  /** Exact evidence location for the first unrecoverable or causal step. */
  criticalEvidence?: readonly AnalystEvidenceExpectation[]
}

export type AnalystBenchmarkLabelState = 'positive' | 'trusted-negative' | 'unlabeled'

export interface AnalystBenchmarkCase<TInput = unknown> {
  id: string
  /** Independent source unit used for resampling, such as a task or incident. */
  clusterId: string
  /** Whether labels prove an issue, prove no issue, or leave the outcome unknown. */
  labelState: AnalystBenchmarkLabelState
  input: TInput
  expectedIssues: readonly AnalystIssueExpectation[]
  /** Complete set of labeled locations used to measure label-location agreement. */
  labeledEvidence?: readonly AnalystEvidenceExpectation[]
  tags?: readonly string[]
  metadata?: Record<string, unknown>
}

export interface AnalystFindingScore {
  expectedIssueCount: number
  matchedIssueIds: string[]
  missedIssueIds: string[]
  supportedFindingIndexes: number[]
  unsupportedFindingIndexes: number[]
  unlabeledEvidence: EvidenceRef[]
  issueRecall: number
  findingPrecision: number
  f1: number
  criticalStepAccuracy: number | null
  /** Share of findings that cite at least one evidence location. */
  citationCoverage: number | null
  /** Share of citations that include a non-empty source excerpt. */
  citationExcerptCoverage: number | null
  /** Share of citations that agree with a labeled case location. */
  citationLabelAgreement: number | null
  predictionOnLabelEmptyCase: boolean
}

export interface AnalystEvidenceResolutionError {
  evidence: EvidenceRef
  class: string
  message: string
}

export interface AnalystEvidenceResolution {
  checked: number
  resolved: number
  unresolvedEvidence: EvidenceRef[]
  errors: AnalystEvidenceResolutionError[]
  /** Null when no citations were checked or any resolution attempt failed. */
  validity: number | null
}

export type AnalystEvidenceResolver<TInput = unknown> = (input: {
  caseId: string
  caseInput: TInput
  evidence: EvidenceRef
  signal?: AbortSignal
}) => boolean | Promise<boolean>

/**
 * Resolve canonical `trace://<trace>/span/<span>` evidence against a trace store.
 * Other evidence kinds and URI schemes require a caller-supplied resolver.
 */
export function traceStoreEvidenceResolver<TInput>(
  getStore: (input: TInput) => TraceAnalysisStore,
): AnalystEvidenceResolver<TInput> {
  return async ({ caseInput, evidence, signal }) => {
    if (evidence.kind !== 'span') return false
    const location = parseTraceSpanUri(evidence.uri)
    if (!location) return false
    const result = await getStore(caseInput).viewSpans(
      {
        trace_id: location.traceId,
        span_ids: [location.spanId],
      },
      signal ? { signal } : undefined,
    )
    return (
      result.trace_id === location.traceId &&
      result.missing_span_ids.length === 0 &&
      result.spans.some((span) => span.span_id === location.spanId)
    )
  }
}

export interface AnalystBenchmarkOutput {
  findings: readonly AnalystFinding[]
  usage?: AnalystUsageReceipt
  metadata?: Record<string, unknown>
  /**
   * End-to-end duration measured by an external runner before import.
   * Use null when the source explicitly did not capture duration.
   */
  observedLatencyMs?: number | null
  /** Marks a completed transport as a failed analyst run while retaining usage and metadata. */
  error?: AnalystBenchmarkError
}

export interface AnalystBenchmarkError {
  class: string
  message: string
  code?: string
  status?: number
}

export interface AnalystBenchmarkRunner<TInput = unknown> {
  id: string
  analyze(
    input: TInput,
    context: { caseId: string; repetition: number; signal?: AbortSignal },
  ): AnalystBenchmarkOutput | Promise<AnalystBenchmarkOutput>
}

export interface AnalystBenchmarkObservation {
  runnerId: string
  caseId: string
  clusterId: string
  labelState: AnalystBenchmarkLabelState
  repetition: number
  executionIndex: number
  latencyMs: number | null
  latencySource: 'benchmark-clock' | 'runner-reported' | 'uncaptured'
  findings: readonly AnalystFinding[]
  score: AnalystFindingScore
  evidenceResolution?: AnalystEvidenceResolution
  caseTags: readonly string[]
  caseMetadata?: Record<string, unknown>
  usage?: AnalystUsageReceipt
  runnerMetadata?: Record<string, unknown>
  error?: AnalystBenchmarkError
}

export interface AnalystLatencyDistribution {
  min: number
  mean: number
  p50: number
  p95: number
  max: number
}

export interface AnalystBenchmarkSummary {
  runnerId: string
  plannedRuns: number
  completedRuns: number
  failedRuns: number
  issueBearingRuns: number
  trustedNegativeRuns: number
  unlabeledRuns: number
  /** Pooled across all labeled issues and findings. */
  issueRecall: number | null
  /** Pooled across all labeled issues and findings. */
  findingPrecision: number | null
  /** Harmonic mean of the pooled precision and recall. */
  f1: number | null
  /** Mean of per-case recall over issue-bearing runs. */
  macroIssueRecall: number | null
  /** Mean of per-case precision over issue-bearing runs. */
  macroFindingPrecision: number | null
  /** Mean of per-case F1 over issue-bearing runs. */
  macroF1: number | null
  criticalStepAccuracy: number | null
  citationCoverage: number | null
  citationExcerptCoverage: number | null
  citationLabelAgreement: number | null
  citationResolution: number | null
  citationResolutionUnknownRuns: number
  unresolvedCitations: number
  citationResolutionErrors: number
  trustedNegativeFalsePositiveRate: number | null
  trustedNegativeFailureRate: number | null
  unlabeledPredictionRate: number | null
  unlabeledFailureRate: number | null
  /** Primary repeatability measure over complete finding identity and evidence. */
  predictionAgreement: number | null
  /** Repeated cases contributing equally to predictionAgreement. */
  predictionAgreementCases: number
  /** Secondary repeatability detail over matched expected labels. */
  matchedLabelAgreement: number | null
  /** Positive repeated cases contributing equally to matchedLabelAgreement. */
  matchedLabelAgreementCases: number
  latencyMs: AnalystLatencyDistribution | null
  benchmarkClockLatencyRuns: number
  runnerReportedLatencyRuns: number
  latencyUnknownRuns: number
  calls: number
  callsUnknownRuns: number
  inputTokens: number
  outputTokens: number
  reasoningTokens: number
  cachedTokens: number
  cacheWriteTokens: number
  tokenUsageUnknownRuns: number
  reasoningTokenUsageUnknownRuns: number
  cachedTokenUsageUnknownRuns: number
  cacheWriteTokenUsageUnknownRuns: number
  knownCostUsd: number
  costUnknownRuns: number
}

export interface AnalystBenchmarkDatasetRef {
  id: string
  revision: string
  split?: string
}

export interface AnalystBenchmarkDescriptor {
  id?: string
  dataset?: AnalystBenchmarkDatasetRef
  command?: string
  environment?: Record<string, string>
  metadata?: Record<string, unknown>
}

export interface AnalystBenchmarkProvenance extends AnalystBenchmarkDescriptor {
  startedAt: string
  endedAt: string
  caseCount: number
  runnerIds: string[]
  repetitions: number
  maxConcurrency: number
  runnerOrderSeed: number
}

export interface AnalystBenchmarkResult {
  provenance: AnalystBenchmarkProvenance
  observations: AnalystBenchmarkObservation[]
  summaries: AnalystBenchmarkSummary[]
}

export interface RunAnalystBenchmarkOptions<TInput> {
  cases: readonly AnalystBenchmarkCase<TInput>[]
  runners: readonly AnalystBenchmarkRunner<TInput>[]
  repetitions?: number
  maxConcurrency?: number
  runnerOrderSeed?: number
  resolveEvidence?: AnalystEvidenceResolver<TInput>
  benchmark?: AnalystBenchmarkDescriptor
  /** Previously persisted rows. Exact case, runner, repetition, and execution identities are required. */
  initialObservations?: readonly AnalystBenchmarkObservation[]
  onObservation?: (observation: AnalystBenchmarkObservation) => void | Promise<void>
  signal?: AbortSignal
}

export async function runAnalystBenchmark<TInput>(
  options: RunAnalystBenchmarkOptions<TInput>,
): Promise<AnalystBenchmarkResult> {
  validateBenchmarkOptions(options)
  const startedAt = new Date().toISOString()
  const repetitions = options.repetitions ?? 1
  const runnerOrderSeed = options.runnerOrderSeed ?? 0
  const allJobs = benchmarkJobs(options.cases, options.runners, repetitions, runnerOrderSeed)
  const maxConcurrency = Math.min(options.maxConcurrency ?? 1, allJobs.length)
  const initialObservations = validateInitialObservations(
    options.initialObservations ?? [],
    allJobs,
  )
  const completed = new Set(initialObservations.map(observationKey))
  const jobs = allJobs.filter((job) => !completed.has(jobKey(job)))
  const observations: AnalystBenchmarkObservation[] = [...initialObservations]
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      options.signal?.throwIfAborted()
      const job = jobs[cursor++]!
      const observation = await runBenchmarkJob(job, options.signal, options.resolveEvidence)
      options.signal?.throwIfAborted()
      await options.onObservation?.(observation)
      options.signal?.throwIfAborted()
      observations.push(observation)
    }
  }
  await Promise.all(Array.from({ length: Math.min(maxConcurrency, jobs.length) }, worker))
  options.signal?.throwIfAborted()
  const runnerOrder = new Map(options.runners.map((runner, index) => [runner.id, index]))
  const caseOrder = new Map(options.cases.map((testCase, index) => [testCase.id, index]))
  observations.sort(
    (a, b) =>
      (runnerOrder.get(a.runnerId) ?? 0) - (runnerOrder.get(b.runnerId) ?? 0) ||
      (caseOrder.get(a.caseId) ?? 0) - (caseOrder.get(b.caseId) ?? 0) ||
      a.repetition - b.repetition,
  )
  return {
    provenance: {
      ...options.benchmark,
      startedAt,
      endedAt: new Date().toISOString(),
      caseCount: options.cases.length,
      runnerIds: options.runners.map((runner) => runner.id),
      repetitions,
      maxConcurrency,
      runnerOrderSeed,
    },
    observations,
    summaries: options.runners.map((runner) =>
      summarizeAnalystBenchmarkRunner(
        runner.id,
        observations.filter((observation) => observation.runnerId === runner.id),
      ),
    ),
  }
}

export function registryBenchmarkRunner(options: {
  id: string
  registry: AnalystRegistry
  runOptions?: Omit<RegistryRunOpts, 'signal'>
  /** Count any selected analyst failure as a failed benchmark run. */
  failOnAnalystFailure?: boolean
}): AnalystBenchmarkRunner<AnalystRunInputs> {
  return {
    id: options.id,
    async analyze(input, context) {
      const result = await options.registry.run(
        `${options.id}:${context.caseId}:${context.repetition}`,
        input,
        { ...options.runOptions, signal: context.signal },
      )
      return {
        findings: result.findings,
        usage: mergeRegistryUsage(result),
        metadata: { analystRun: result },
        ...(options.failOnAnalystFailure ? { error: registryRunFailure(result) } : {}),
      }
    },
  }
}

async function runBenchmarkJob<TInput>(
  job: {
    runner: AnalystBenchmarkRunner<TInput>
    testCase: AnalystBenchmarkCase<TInput>
    repetition: number
    executionIndex: number
  },
  signal?: AbortSignal,
  resolveEvidence?: AnalystEvidenceResolver<TInput>,
): Promise<AnalystBenchmarkObservation> {
  const started = performance.now()
  try {
    const output = await job.runner.analyze(job.testCase.input, {
      caseId: job.testCase.id,
      repetition: job.repetition,
      signal,
    })
    if (output.usage) {
      assertValidAnalystUsageReceipt(output.usage, 'analyst benchmark usage')
    }
    const benchmarkLatencyMs = performance.now() - started
    const latency = resolveBenchmarkLatency(output.observedLatencyMs, benchmarkLatencyMs)
    const scoredFindings = output.error ? [] : output.findings
    return {
      runnerId: job.runner.id,
      caseId: job.testCase.id,
      clusterId: job.testCase.clusterId,
      labelState: job.testCase.labelState,
      repetition: job.repetition,
      executionIndex: job.executionIndex,
      latencyMs: latency.value,
      latencySource: latency.source,
      findings: output.findings,
      score: scoreAnalystFindings(job.testCase, scoredFindings),
      evidenceResolution: resolveEvidence
        ? await resolveFindingEvidence(job.testCase, output.findings, resolveEvidence, signal)
        : undefined,
      caseTags: [...(job.testCase.tags ?? [])],
      caseMetadata: job.testCase.metadata,
      usage: output.usage,
      runnerMetadata: output.metadata,
      ...(output.error ? { error: output.error } : {}),
    }
  } catch (error) {
    if (signal?.aborted) throw error
    const findings: AnalystFinding[] = []
    return {
      runnerId: job.runner.id,
      caseId: job.testCase.id,
      clusterId: job.testCase.clusterId,
      labelState: job.testCase.labelState,
      repetition: job.repetition,
      executionIndex: job.executionIndex,
      latencyMs: performance.now() - started,
      latencySource: 'benchmark-clock',
      findings,
      score: scoreAnalystFindings(job.testCase, findings),
      caseTags: [...(job.testCase.tags ?? [])],
      caseMetadata: job.testCase.metadata,
      error: {
        class: error instanceof Error ? error.constructor.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      },
    }
  }
}

function resolveBenchmarkLatency(
  observedLatencyMs: number | null | undefined,
  fallbackMs: number,
): {
  value: number | null
  source: AnalystBenchmarkObservation['latencySource']
} {
  if (observedLatencyMs === undefined) {
    return { value: fallbackMs, source: 'benchmark-clock' }
  }
  if (observedLatencyMs === null) return { value: null, source: 'uncaptured' }
  if (!Number.isFinite(observedLatencyMs) || observedLatencyMs < 0) {
    throw new RangeError('analyst benchmark observedLatencyMs must be finite and non-negative')
  }
  return { value: observedLatencyMs, source: 'runner-reported' }
}

function registryRunFailure(result: AnalystRunResult): AnalystBenchmarkOutput['error'] | undefined {
  const failed = result.per_analyst.filter((summary) => summary.status === 'failed')
  if (failed.length === 0) return undefined
  return {
    class: 'AnalystRunFailure',
    message: failed
      .map(
        (summary) =>
          `${summary.analyst_id}: ${summary.error?.class ?? 'Error'}: ${summary.error?.message ?? 'analyst failed'}`,
      )
      .join('; '),
  }
}

function benchmarkJobs<TInput>(
  cases: readonly AnalystBenchmarkCase<TInput>[],
  runners: readonly AnalystBenchmarkRunner<TInput>[],
  repetitions: number,
  runnerOrderSeed: number,
): Array<{
  runner: AnalystBenchmarkRunner<TInput>
  testCase: AnalystBenchmarkCase<TInput>
  repetition: number
  executionIndex: number
}> {
  const seededRunners = [...runners].sort(
    (left, right) =>
      stableHash(`${runnerOrderSeed}\u0000${left.id}`) -
        stableHash(`${runnerOrderSeed}\u0000${right.id}`) || left.id.localeCompare(right.id),
  )
  let executionIndex = 0
  return cases.flatMap((testCase, caseIndex) =>
    Array.from({ length: repetitions }, (_, repetition) => {
      const blockIndex = caseIndex * repetitions + repetition
      const rotation = blockIndex % seededRunners.length
      const ordered = [...seededRunners.slice(rotation), ...seededRunners.slice(0, rotation)]
      return ordered.map((runner) => ({
        runner,
        testCase,
        repetition,
        executionIndex: executionIndex++,
      }))
    }).flat(),
  )
}

function validateInitialObservations<TInput>(
  observations: readonly AnalystBenchmarkObservation[],
  jobs: readonly {
    runner: AnalystBenchmarkRunner<TInput>
    testCase: AnalystBenchmarkCase<TInput>
    repetition: number
    executionIndex: number
  }[],
): AnalystBenchmarkObservation[] {
  const expected = new Map(jobs.map((job) => [jobKey(job), job]))
  const seen = new Set<string>()
  return observations.map((observation) => {
    const key = observationKey(observation)
    if (seen.has(key)) {
      throw new TypeError(
        `duplicate initial analyst benchmark observation '${observation.runnerId}/${observation.caseId}/${observation.repetition}'`,
      )
    }
    seen.add(key)
    const job = expected.get(key)
    if (!job) {
      throw new TypeError(
        `initial analyst benchmark observation does not match a planned job: '${observation.runnerId}/${observation.caseId}/${observation.repetition}'`,
      )
    }
    if (observation.executionIndex !== job.executionIndex) {
      throw new TypeError(
        `initial analyst benchmark observation '${observation.runnerId}/${observation.caseId}/${observation.repetition}' has executionIndex ${observation.executionIndex}; expected ${job.executionIndex}`,
      )
    }
    if (
      observation.clusterId !== job.testCase.clusterId ||
      observation.labelState !== job.testCase.labelState
    ) {
      throw new TypeError(
        `initial analyst benchmark observation '${observation.runnerId}/${observation.caseId}/${observation.repetition}' does not match the current case labels`,
      )
    }
    if (
      JSON.stringify(observation.caseTags) !== JSON.stringify(job.testCase.tags ?? []) ||
      JSON.stringify(observation.caseMetadata) !== JSON.stringify(job.testCase.metadata)
    ) {
      throw new TypeError(
        `initial analyst benchmark observation '${observation.runnerId}/${observation.caseId}/${observation.repetition}' does not match the current case metadata`,
      )
    }
    const expectedScore = scoreAnalystFindings(
      job.testCase,
      observation.error ? [] : observation.findings,
    )
    if (JSON.stringify(observation.score) !== JSON.stringify(expectedScore)) {
      throw new TypeError(
        `initial analyst benchmark observation '${observation.runnerId}/${observation.caseId}/${observation.repetition}' has stale or invalid scores`,
      )
    }
    if (observation.usage) {
      assertValidAnalystUsageReceipt(
        observation.usage,
        `initial analyst benchmark observation '${observation.runnerId}/${observation.caseId}/${observation.repetition}' usage`,
      )
    }
    if (
      !['benchmark-clock', 'runner-reported', 'uncaptured'].includes(observation.latencySource) ||
      (observation.latencySource === 'uncaptured' && observation.latencyMs !== null) ||
      (observation.latencySource !== 'uncaptured' &&
        (observation.latencyMs === null ||
          !Number.isFinite(observation.latencyMs) ||
          observation.latencyMs < 0))
    ) {
      throw new TypeError(
        `initial analyst benchmark observation '${observation.runnerId}/${observation.caseId}/${observation.repetition}' has invalid latency`,
      )
    }
    return { ...observation }
  })
}

function jobKey(job: {
  runner: { id: string }
  testCase: { id: string }
  repetition: number
}): string {
  return `${job.runner.id}\u0000${job.testCase.id}\u0000${job.repetition}`
}

function observationKey(observation: {
  runnerId: string
  caseId: string
  repetition: number
}): string {
  return `${observation.runnerId}\u0000${observation.caseId}\u0000${observation.repetition}`
}

async function resolveFindingEvidence<TInput>(
  testCase: AnalystBenchmarkCase<TInput>,
  findings: readonly AnalystFinding[],
  resolver: AnalystEvidenceResolver<TInput>,
  signal?: AbortSignal,
): Promise<AnalystEvidenceResolution> {
  const evidence = findings.flatMap((finding) => finding.evidence_refs)
  const resolved: EvidenceRef[] = []
  const unresolvedEvidence: EvidenceRef[] = []
  const errors: AnalystEvidenceResolutionError[] = []
  for (const ref of evidence) {
    signal?.throwIfAborted()
    try {
      if (
        await resolver({
          caseId: testCase.id,
          caseInput: testCase.input,
          evidence: ref,
          signal,
        })
      ) {
        resolved.push(ref)
      } else {
        unresolvedEvidence.push(ref)
      }
    } catch (error) {
      if (signal?.aborted) throw error
      errors.push({
        evidence: ref,
        class: error instanceof Error ? error.constructor.name : 'Error',
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }
  return {
    checked: evidence.length,
    resolved: resolved.length,
    unresolvedEvidence,
    errors,
    validity: evidence.length === 0 || errors.length > 0 ? null : resolved.length / evidence.length,
  }
}

function parseTraceSpanUri(uri: string): { traceId: string; spanId: string } | null {
  const match = /^trace:\/\/([^/]+)\/span\/([^/]+)$/.exec(uri)
  if (!match) return null
  try {
    const traceId = decodeURIComponent(match[1]!)
    const spanId = decodeURIComponent(match[2]!)
    return traceId && spanId ? { traceId, spanId } : null
  } catch {
    return null
  }
}

function validateBenchmarkOptions<TInput>(options: RunAnalystBenchmarkOptions<TInput>): void {
  if (options.cases.length === 0) throw new TypeError('runAnalystBenchmark requires cases')
  if (options.runners.length === 0) throw new TypeError('runAnalystBenchmark requires runners')
  const repetitions = options.repetitions ?? 1
  const maxConcurrency = options.maxConcurrency ?? 1
  if (!Number.isSafeInteger(repetitions) || repetitions < 1) {
    throw new RangeError('runAnalystBenchmark repetitions must be a positive safe integer')
  }
  if (!Number.isSafeInteger(maxConcurrency) || maxConcurrency < 1) {
    throw new RangeError('runAnalystBenchmark maxConcurrency must be a positive safe integer')
  }
  if (!Number.isSafeInteger(options.runnerOrderSeed ?? 0)) {
    throw new RangeError('runAnalystBenchmark runnerOrderSeed must be a safe integer')
  }
  assertUniqueNonEmpty(
    options.cases.map((testCase) => testCase.id),
    'case',
  )
  assertUniqueNonEmpty(
    options.runners.map((runner) => runner.id),
    'runner',
  )
  for (const testCase of options.cases) validateBenchmarkCase(testCase)
}

function validateBenchmarkCase(testCase: AnalystBenchmarkCase): void {
  assertValidAnalystScoringCase(testCase)
  if (!testCase.clusterId.trim()) {
    throw new TypeError(`${testCase.id}: analyst benchmark clusterId must not be empty`)
  }
  if (
    testCase.labelState !== 'positive' &&
    testCase.labelState !== 'trusted-negative' &&
    testCase.labelState !== 'unlabeled'
  ) {
    throw new TypeError(`${testCase.id}: analyst benchmark labelState is invalid`)
  }
  if (testCase.labelState === 'positive' && testCase.expectedIssues.length === 0) {
    throw new TypeError(`${testCase.id}: positive case requires at least one expected issue`)
  }
  if (testCase.labelState !== 'positive' && testCase.expectedIssues.length > 0) {
    throw new TypeError(
      `${testCase.id}: ${testCase.labelState} case cannot contain expected issues`,
    )
  }
}

function assertUniqueNonEmpty(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (!value.trim()) throw new TypeError(`analyst benchmark ${label} id must not be empty`)
    if (seen.has(value)) throw new TypeError(`duplicate analyst benchmark ${label} id '${value}'`)
    seen.add(value)
  }
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function mergeRegistryUsage(result: AnalystRunResult): AnalystUsageReceipt {
  const usages = result.per_analyst.map((summary) => summary.usage)
  const calls = usages.every((usage) => usage.calls !== null)
    ? usages.reduce((sum, usage) => sum + (usage.calls ?? 0), 0)
    : null
  const tokens = usages.every((usage) => usage.tokens !== null)
    ? usages.reduce(
        (sum, usage) => ({
          input: sum.input + (usage.tokens?.input ?? 0),
          output: sum.output + (usage.tokens?.output ?? 0),
          reasoning: sum.reasoning + (usage.tokens?.reasoning ?? 0),
          cached: sum.cached + (usage.tokens?.cached ?? 0),
          cacheWrite: sum.cacheWrite + (usage.tokens?.cacheWrite ?? 0),
        }),
        { input: 0, output: 0, reasoning: 0, cached: 0, cacheWrite: 0 },
      )
    : null
  const knownCostUsd = usages.reduce(
    (sum, usage) =>
      sum + (usage.cost.kind === 'uncaptured' ? (usage.knownCostUsd ?? 0) : usage.cost.usd),
    0,
  )
  const cost = usages.some((usage) => usage.cost.kind === 'uncaptured')
    ? ({ kind: 'uncaptured', usd: null } as const)
    : usages.some((usage) => usage.cost.kind === 'estimated')
      ? ({ kind: 'estimated', usd: knownCostUsd } as const)
      : ({ kind: 'observed', usd: knownCostUsd } as const)
  return {
    calls,
    tokens,
    cost,
    ...(cost.kind === 'uncaptured' ? { knownCostUsd } : {}),
  }
}
