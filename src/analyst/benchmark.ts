import { performance } from 'node:perf_hooks'
import { linearSumAssignment } from 'linear-sum-assignment'
import type { TraceAnalysisStore } from '../trace-analyst/store'
import type { AnalystRegistry, RegistryRunOpts } from './registry'
import type {
  AnalystFinding,
  AnalystRunInputs,
  AnalystRunResult,
  AnalystUsageReceipt,
  EvidenceRef,
} from './types'

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

export interface AnalystBenchmarkCase<TInput = unknown> {
  id: string
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
  /** Share of citations that agree with a labeled case location. */
  citationLabelAgreement: number | null
  cleanFalsePositive: boolean
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
  return async ({ caseInput, evidence }) => {
    if (evidence.kind !== 'span') return false
    const location = parseTraceSpanUri(evidence.uri)
    if (!location) return false
    const result = await getStore(caseInput).viewSpans({
      trace_id: location.traceId,
      span_ids: [location.spanId],
    })
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
  repetition: number
  executionIndex: number
  latencyMs: number
  findings: readonly AnalystFinding[]
  score: AnalystFindingScore
  evidenceResolution?: AnalystEvidenceResolution
  caseTags: readonly string[]
  caseMetadata?: Record<string, unknown>
  usage?: AnalystUsageReceipt
  runnerMetadata?: Record<string, unknown>
  error?: { class: string; message: string }
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
  issueRecall: number | null
  findingPrecision: number | null
  f1: number | null
  criticalStepAccuracy: number | null
  citationCoverage: number | null
  citationLabelAgreement: number | null
  citationResolution: number | null
  citationResolutionUnknownRuns: number
  unresolvedCitations: number
  citationResolutionErrors: number
  cleanCaseFalsePositiveRate: number | null
  cleanCaseFailureRate: number | null
  runAgreement: number | null
  latencyMs: AnalystLatencyDistribution
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
  signal?: AbortSignal
}

export function scoreAnalystFindings(
  testCase: Pick<AnalystBenchmarkCase, 'id' | 'expectedIssues' | 'labeledEvidence'>,
  findings: readonly AnalystFinding[],
): AnalystFindingScore {
  validateCase(testCase)
  const matchedFindingByIssue = matchFindingsToIssues(testCase.expectedIssues, findings)
  const matchedIssueIds = testCase.expectedIssues
    .filter((_, index) => matchedFindingByIssue.has(index))
    .map((issue) => issue.id)
  const missedIssueIds = testCase.expectedIssues
    .filter((_, index) => !matchedFindingByIssue.has(index))
    .map((issue) => issue.id)
  const supportedFindingIndexes = new Set(matchedFindingByIssue.values())

  const unsupportedFindingIndexes = findings
    .map((_, index) => index)
    .filter((index) => !supportedFindingIndexes.has(index))
  const expectedIssueCount = testCase.expectedIssues.length
  const issueRecall = expectedIssueCount === 0 ? 1 : matchedIssueIds.length / expectedIssueCount
  const findingPrecision =
    findings.length === 0
      ? expectedIssueCount === 0
        ? 1
        : 0
      : supportedFindingIndexes.size / findings.length
  const f1 = harmonicMean(findingPrecision, issueRecall)
  const allEvidence = findings.flatMap((finding) => finding.evidence_refs)

  const criticalIssues = testCase.expectedIssues.filter(
    (issue) => (issue.criticalEvidence?.length ?? 0) > 0,
  )
  const criticalHits = testCase.expectedIssues.filter((issue) => {
    if ((issue.criticalEvidence?.length ?? 0) === 0) return false
    return matchesEvidence(allEvidence, issue.criticalEvidence ?? [], 'any')
  }).length

  const findingsWithEvidence = findings.filter((finding) => finding.evidence_refs.length > 0).length
  const unlabeledEvidence = testCase.labeledEvidence
    ? allEvidence.filter(
        (ref) => !testCase.labeledEvidence!.some((expected) => evidenceMatches(ref, expected)),
      )
    : []

  return {
    expectedIssueCount,
    matchedIssueIds,
    missedIssueIds,
    supportedFindingIndexes: [...supportedFindingIndexes].sort((a, b) => a - b),
    unsupportedFindingIndexes,
    unlabeledEvidence,
    issueRecall,
    findingPrecision,
    f1,
    criticalStepAccuracy: criticalIssues.length === 0 ? null : criticalHits / criticalIssues.length,
    citationCoverage: findings.length === 0 ? null : findingsWithEvidence / findings.length,
    citationLabelAgreement:
      testCase.labeledEvidence === undefined
        ? null
        : allEvidence.length === 0
          ? findings.length === 0
            ? null
            : 0
          : (allEvidence.length - unlabeledEvidence.length) / allEvidence.length,
    cleanFalsePositive: expectedIssueCount === 0 && findings.length > 0,
  }
}

function matchFindingsToIssues(
  issues: readonly AnalystIssueExpectation[],
  findings: readonly AnalystFinding[],
): Map<number, number> {
  if (issues.length === 0) return new Map()
  const cardinalityWeight = issues.length + 1
  const scores = issues.map((issue) => [
    ...findings.map((finding) => {
      if (!findingMatchesIssue(finding, issue)) return -1
      const criticalHit =
        (issue.criticalEvidence?.length ?? 0) > 0 &&
        matchesEvidence(finding.evidence_refs, issue.criticalEvidence ?? [], 'any')
      return cardinalityWeight + Number(criticalHit)
    }),
    ...Array.from({ length: issues.length }, () => 0),
  ])
  const assignment = linearSumAssignment(scores, { maximaze: true }).rowAssignments
  const matches = new Map<number, number>()
  for (const [issueIndex, column] of assignment.entries()) {
    if (column < 0 || column >= findings.length) continue
    if (!findingMatchesIssue(findings[column]!, issues[issueIndex]!)) continue
    matches.set(issueIndex, column)
  }
  return matches
}

export async function runAnalystBenchmark<TInput>(
  options: RunAnalystBenchmarkOptions<TInput>,
): Promise<AnalystBenchmarkResult> {
  validateBenchmarkOptions(options)
  const startedAt = new Date().toISOString()
  const repetitions = options.repetitions ?? 1
  const runnerOrderSeed = options.runnerOrderSeed ?? 0
  const maxConcurrency = Math.min(
    options.maxConcurrency ?? 1,
    options.runners.length * options.cases.length * repetitions,
  )
  const jobs = benchmarkJobs(options.cases, options.runners, repetitions, runnerOrderSeed)
  const observations: AnalystBenchmarkObservation[] = []
  let cursor = 0
  const worker = async (): Promise<void> => {
    while (cursor < jobs.length) {
      options.signal?.throwIfAborted()
      const job = jobs[cursor++]!
      observations.push(await runBenchmarkJob(job, options.signal, options.resolveEvidence))
    }
  }
  await Promise.all(Array.from({ length: maxConcurrency }, worker))
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
      summarizeRunner(
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
    return {
      runnerId: job.runner.id,
      caseId: job.testCase.id,
      repetition: job.repetition,
      executionIndex: job.executionIndex,
      latencyMs: performance.now() - started,
      findings: output.findings,
      score: scoreAnalystFindings(job.testCase, output.findings),
      evidenceResolution: resolveEvidence
        ? await resolveFindingEvidence(job.testCase, output.findings, resolveEvidence, signal)
        : undefined,
      caseTags: [...(job.testCase.tags ?? [])],
      caseMetadata: job.testCase.metadata,
      usage: output.usage,
      runnerMetadata: output.metadata,
    }
  } catch (error) {
    if (signal?.aborted) throw error
    const findings: AnalystFinding[] = []
    return {
      runnerId: job.runner.id,
      caseId: job.testCase.id,
      repetition: job.repetition,
      executionIndex: job.executionIndex,
      latencyMs: performance.now() - started,
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

function summarizeRunner(
  runnerId: string,
  observations: readonly AnalystBenchmarkObservation[],
): AnalystBenchmarkSummary {
  const issueBearing = observations.filter(
    (observation) => observation.score.expectedIssueCount > 0,
  )
  const expectedIssues = issueBearing.reduce(
    (sum, observation) => sum + observation.score.expectedIssueCount,
    0,
  )
  const matchedIssues = issueBearing.reduce(
    (sum, observation) => sum + observation.score.matchedIssueIds.length,
    0,
  )
  const issueFindings = issueBearing.reduce(
    (sum, observation) => sum + observation.findings.length,
    0,
  )
  const supportedFindings = issueBearing.reduce(
    (sum, observation) => sum + observation.score.supportedFindingIndexes.length,
    0,
  )
  const issueRecall = expectedIssues === 0 ? null : matchedIssues / expectedIssues
  const findingPrecision =
    expectedIssues === 0 ? null : issueFindings === 0 ? 0 : supportedFindings / issueFindings
  const critical = observations
    .map((observation) => observation.score.criticalStepAccuracy)
    .filter((value): value is number => value !== null)
  const findingsWithEvidence = observations.reduce(
    (sum, observation) =>
      sum + observation.findings.filter((finding) => finding.evidence_refs.length > 0).length,
    0,
  )
  const allFindings = observations.reduce(
    (sum, observation) => sum + observation.findings.length,
    0,
  )
  const citationObservations = observations.filter(
    (observation) => observation.score.citationLabelAgreement !== null,
  )
  const citationCount = citationObservations.reduce(
    (sum, observation) =>
      sum +
      observation.findings.reduce((count, finding) => count + finding.evidence_refs.length, 0),
    0,
  )
  const invalidCitationCount = citationObservations.reduce(
    (sum, observation) => sum + observation.score.unlabeledEvidence.length,
    0,
  )
  const clean = observations.filter((observation) => observation.score.expectedIssueCount === 0)
  const completedClean = clean.filter((observation) => !observation.error)
  const resolvedCitations = observations.reduce(
    (sum, observation) => sum + (observation.evidenceResolution?.resolved ?? 0),
    0,
  )
  const unresolvedCitations = observations.reduce(
    (sum, observation) => sum + (observation.evidenceResolution?.unresolvedEvidence.length ?? 0),
    0,
  )
  const citationResolutionErrors = observations.reduce(
    (sum, observation) => sum + (observation.evidenceResolution?.errors.length ?? 0),
    0,
  )
  const resolutionAttempts = observations.filter((observation) =>
    observation.findings.some((finding) => finding.evidence_refs.length > 0),
  )
  const citationResolutionUnknownRuns = resolutionAttempts.filter(
    (observation) =>
      !observation.evidenceResolution || observation.evidenceResolution.errors.length > 0,
  ).length
  const usages = observations.map((observation) => observation.usage)
  const knownCostUsd = usages.reduce((sum, usage) => {
    if (!usage) return sum
    return sum + (usage.cost.kind === 'uncaptured' ? (usage.knownCostUsd ?? 0) : usage.cost.usd)
  }, 0)
  return {
    runnerId,
    plannedRuns: observations.length,
    completedRuns: observations.filter((observation) => !observation.error).length,
    failedRuns: observations.filter((observation) => Boolean(observation.error)).length,
    issueRecall,
    findingPrecision,
    f1:
      findingPrecision === null || issueRecall === null
        ? null
        : harmonicMean(findingPrecision, issueRecall),
    criticalStepAccuracy: critical.length === 0 ? null : mean(critical),
    citationCoverage: allFindings === 0 ? null : findingsWithEvidence / allFindings,
    citationLabelAgreement:
      citationObservations.length === 0
        ? null
        : citationCount === 0
          ? 0
          : (citationCount - invalidCitationCount) / citationCount,
    citationResolution:
      resolutionAttempts.length === 0 ||
      citationResolutionUnknownRuns > 0 ||
      resolvedCitations + unresolvedCitations === 0
        ? null
        : resolvedCitations / (resolvedCitations + unresolvedCitations),
    citationResolutionUnknownRuns,
    unresolvedCitations,
    citationResolutionErrors,
    cleanCaseFalsePositiveRate:
      completedClean.length === 0
        ? null
        : completedClean.filter((observation) => observation.score.cleanFalsePositive).length /
          completedClean.length,
    cleanCaseFailureRate:
      clean.length === 0
        ? null
        : clean.filter((observation) => Boolean(observation.error)).length / clean.length,
    runAgreement: issueAgreement(observations.filter((observation) => !observation.error)),
    latencyMs: latencyDistribution(observations.map((observation) => observation.latencyMs)),
    calls: usages.reduce((sum, usage) => sum + (usage?.calls ?? 0), 0),
    callsUnknownRuns: usages.filter((usage) => !usage || usage.calls === null).length,
    inputTokens: usages.reduce((sum, usage) => sum + (usage?.tokens?.input ?? 0), 0),
    outputTokens: usages.reduce((sum, usage) => sum + (usage?.tokens?.output ?? 0), 0),
    reasoningTokens: usages.reduce((sum, usage) => sum + (usage?.tokens?.reasoning ?? 0), 0),
    cachedTokens: usages.reduce((sum, usage) => sum + (usage?.tokens?.cached ?? 0), 0),
    cacheWriteTokens: usages.reduce((sum, usage) => sum + (usage?.tokens?.cacheWrite ?? 0), 0),
    tokenUsageUnknownRuns: usages.filter((usage) => !usage?.tokens).length,
    reasoningTokenUsageUnknownRuns: usages.filter((usage) => usage?.tokens?.reasoning === undefined)
      .length,
    cachedTokenUsageUnknownRuns: usages.filter((usage) => usage?.tokens?.cached === undefined)
      .length,
    cacheWriteTokenUsageUnknownRuns: usages.filter(
      (usage) => usage?.tokens?.cacheWrite === undefined,
    ).length,
    knownCostUsd,
    costUnknownRuns: usages.filter((usage) => !usage || usage.cost.kind === 'uncaptured').length,
  }
}

function findingMatchesIssue(finding: AnalystFinding, issue: AnalystIssueExpectation): boolean {
  if (issue.findingIds && !issue.findingIds.includes(finding.finding_id)) return false
  if (issue.areas && !issue.areas.includes(finding.area)) return false
  if (issue.subjects && (!finding.subject || !issue.subjects.includes(finding.subject)))
    return false
  if (
    issue.evidence &&
    !matchesEvidence(finding.evidence_refs, issue.evidence, issue.evidenceMode ?? 'any')
  ) {
    return false
  }
  return true
}

function matchesEvidence(
  actual: readonly EvidenceRef[],
  expected: readonly AnalystEvidenceExpectation[],
  mode: 'any' | 'all',
): boolean {
  if (expected.length === 0) return true
  const match = (target: AnalystEvidenceExpectation) =>
    actual.some((ref) => evidenceMatches(ref, target))
  return mode === 'all' ? expected.every(match) : expected.some(match)
}

function evidenceMatches(actual: EvidenceRef, expected: AnalystEvidenceExpectation): boolean {
  return (
    actual.uri === expected.uri && (expected.kind === undefined || actual.kind === expected.kind)
  )
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

function validateCase(
  testCase: Pick<AnalystBenchmarkCase, 'id' | 'expectedIssues' | 'labeledEvidence'>,
): void {
  if (!testCase.id.trim()) throw new TypeError('analyst benchmark case id must not be empty')
  const ids = new Set<string>()
  for (const issue of testCase.expectedIssues) {
    if (!issue.id.trim()) throw new TypeError(`${testCase.id}: expected issue id must not be empty`)
    if (ids.has(issue.id))
      throw new TypeError(`${testCase.id}: duplicate expected issue id '${issue.id}'`)
    ids.add(issue.id)
    if (
      !issue.findingIds?.length &&
      !issue.areas?.length &&
      !issue.subjects?.length &&
      !issue.evidence?.length
    ) {
      throw new TypeError(
        `${testCase.id}/${issue.id}: expected issue must identify a finding by id, area, subject, or evidence`,
      )
    }
  }
  for (const ref of testCase.labeledEvidence ?? []) {
    if (!ref.uri.trim()) {
      throw new TypeError(`${testCase.id}: labeled evidence URI must not be empty`)
    }
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
  for (const testCase of options.cases) validateCase(testCase)
}

function assertUniqueNonEmpty(values: readonly string[], label: string): void {
  const seen = new Set<string>()
  for (const value of values) {
    if (!value.trim()) throw new TypeError(`analyst benchmark ${label} id must not be empty`)
    if (seen.has(value)) throw new TypeError(`duplicate analyst benchmark ${label} id '${value}'`)
    seen.add(value)
  }
}

function harmonicMean(a: number, b: number): number {
  return a + b === 0 ? 0 : (2 * a * b) / (a + b)
}

function mean(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((sum, value) => sum + value, 0) / values.length
}

function latencyDistribution(values: readonly number[]): AnalystLatencyDistribution {
  const sorted = [...values].sort((a, b) => a - b)
  return {
    min: sorted[0] ?? 0,
    mean: mean(sorted),
    p50: percentile(sorted, 0.5),
    p95: percentile(sorted, 0.95),
    max: sorted.at(-1) ?? 0,
  }
}

function percentile(sorted: readonly number[], quantile: number): number {
  if (sorted.length === 0) return 0
  return sorted[Math.ceil(quantile * sorted.length) - 1] ?? sorted.at(-1) ?? 0
}

function stableHash(value: string): number {
  let hash = 2166136261
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

function issueAgreement(observations: readonly AnalystBenchmarkObservation[]): number | null {
  const byCase = new Map<string, AnalystBenchmarkObservation[]>()
  for (const observation of observations) {
    const rows = byCase.get(observation.caseId) ?? []
    rows.push(observation)
    byCase.set(observation.caseId, rows)
  }
  const agreements: number[] = []
  for (const rows of byCase.values()) {
    for (let left = 0; left < rows.length; left++) {
      for (let right = left + 1; right < rows.length; right++) {
        agreements.push(
          jaccard(rows[left]!.score.matchedIssueIds, rows[right]!.score.matchedIssueIds),
        )
      }
    }
  }
  return agreements.length === 0 ? null : mean(agreements)
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  const a = new Set(left)
  const b = new Set(right)
  const union = new Set([...a, ...b])
  if (union.size === 0) return 1
  let intersection = 0
  for (const value of a) if (b.has(value)) intersection += 1
  return intersection / union.size
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
