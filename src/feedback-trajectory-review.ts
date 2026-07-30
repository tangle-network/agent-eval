import { type ExactAnalystRunResult, snapshotExactExecutionPlan } from './analyst/exact-types'
import type {
  AnalystFinding,
  AnalystRunResult,
  AnalystUsageReceipt,
  EvidenceRef,
} from './analyst/types'
import { assertValidAnalystUsageReceipt } from './analyst/usage-receipt'
import type { FeedbackLabelSource, FeedbackTrajectory } from './feedback-trajectory'
import { canonicalString, hashCanonical } from './ledger-core/canonical'
import { deepFreezeCanonicalJson } from './ledger-core/deep-freeze'

export type AnalystReviewSource = Exclude<FeedbackLabelSource, 'system'>
export type AnalystFindingDigest = `sha256:${string}`
export type AnalystRunDigest = `sha256:${string}`

export interface AnalystMissedIssue {
  id: string
  reason: string
  evidence?: EvidenceRef[]
}

interface AnalystReviewDecisionBase {
  runDigest: AnalystRunDigest
  source: AnalystReviewSource
  reviewerId: string
  reviewId: string
  reason: string
  decidedAt: string
}

export type AnalystReviewDecision =
  | (AnalystReviewDecisionBase & {
      findingId: string
      findingDigest: AnalystFindingDigest
      verdict: 'confirmed' | 'rejected'
      missedIssues?: never
    })
  | (AnalystReviewDecisionBase & {
      verdict: 'completeness_assessed'
      missedIssues: AnalystMissedIssue[]
      findingId?: never
      findingDigest?: never
    })

export interface AnalystReviewCounts {
  emitted: number
  confirmed: number
  rejected: number
  missed: number
}

export interface AnalystReviewQuality {
  precision: number
  recall: number
  f1: number
  counts: AnalystReviewCounts
}

export interface StoredAnalystReview {
  runId: string
  runDigest: AnalystRunDigest
  findings: AnalystFinding[]
  findingIds: string[]
  analystIds: string[]
  reviewDecisions: AnalystReviewDecision[]
}

/** Bind an analyst finding's complete canonical JSON content to a stable digest. */
export function analystFindingDigest(finding: AnalystFinding): AnalystFindingDigest {
  return hashCanonical(snapshotAnalystFinding(finding, 'analyst finding'))
}

/** Bind the complete analyst result to one immutable review target. */
export function analystRunDigest(run: AnalystRunResult): AnalystRunDigest {
  return hashCanonical(snapshotAnalystRun(run, 'analyst run'))
}

export function snapshotAnalystRun(value: unknown, context = 'analyst run'): AnalystRunResult {
  const snapshot = snapshotAnalystRunRecord(value, context)
  if (snapshot.execution_plan !== undefined) {
    return sealExactAnalystRunReceipt(snapshot, context)
  }
  if (snapshot.completion !== undefined) {
    throw new TypeError(`${context} completion is valid only for an exact run`)
  }
  return snapshot as unknown as AnalystRunResult
}

/** Canonicalize, validate, and deeply freeze one complete or failed exact-run receipt. */
export function snapshotExactAnalystRunReceipt(
  value: unknown,
  context = 'exact analyst run receipt',
): ExactAnalystRunResult {
  return sealExactAnalystRunReceipt(snapshotAnalystRunRecord(value, context), context)
}

function snapshotAnalystRunRecord(value: unknown, context: string): Record<string, unknown> {
  let snapshot: unknown
  try {
    snapshot = JSON.parse(canonicalString(value)) as unknown
  } catch (cause) {
    throw new TypeError(`${context} must have a canonical JSON representation`, { cause })
  }
  if (!isRecord(snapshot)) throw new TypeError(`${context} must be an object`)
  assertOnlyKeys(
    snapshot,
    [
      'run_id',
      'correlation_id',
      'started_at',
      'ended_at',
      'findings',
      'per_analyst',
      'total_cost_usd',
      'total_cost_provenance',
      'execution_plan',
      'completion',
    ],
    context,
  )
  requiredString(snapshot.run_id, `${context} run_id`)
  requiredString(snapshot.correlation_id, `${context} correlation_id`)
  canonicalTimestamp(snapshot.started_at, `${context} started_at`)
  canonicalTimestamp(snapshot.ended_at, `${context} ended_at`)
  snapshot.findings = snapshotAnalystFindings(snapshot.findings, `${context} findings`)
  if (!Array.isArray(snapshot.per_analyst)) {
    throw new TypeError(`${context} per_analyst must be an array`)
  }
  for (const [index, summary] of snapshot.per_analyst.entries()) {
    assertAnalystRunSummary(summary, `${context} per_analyst ${index}`)
  }
  if (
    typeof snapshot.total_cost_usd !== 'number' ||
    !Number.isFinite(snapshot.total_cost_usd) ||
    snapshot.total_cost_usd < 0
  ) {
    throw new TypeError(`${context} total_cost_usd must be a finite non-negative number`)
  }
  if (snapshot.total_cost_provenance !== undefined) {
    assertCostProvenance(snapshot.total_cost_provenance, `${context} total_cost_provenance`)
  }
  return snapshot
}

function assertAnalystRunSummary(value: unknown, context: string): void {
  if (!isRecord(value)) throw new TypeError(`${context} must be an object`)
  assertOnlyKeys(
    value,
    [
      'analyst_id',
      'status',
      'reason',
      'findings_count',
      'latency_ms',
      'usage',
      'allocated_budget_usd',
      'error',
    ],
    context,
  )
  requiredString(value.analyst_id, `${context} analyst_id`)
  if (value.status !== 'ok' && value.status !== 'skipped' && value.status !== 'failed') {
    throw new TypeError(`${context} status is invalid`)
  }
  if (value.reason !== undefined) requiredString(value.reason, `${context} reason`)
  if (value.status === 'skipped' && value.reason === undefined) {
    throw new TypeError(`${context} skipped summary requires reason`)
  }
  nonnegativeSafeInteger(value.findings_count, `${context} findings_count`)
  finiteNonnegative(value.latency_ms, `${context} latency_ms`)
  assertAnalystUsageReceipt(value.usage, `${context} usage`)
  if (value.allocated_budget_usd !== undefined && value.allocated_budget_usd !== null) {
    finiteNonnegative(value.allocated_budget_usd, `${context} allocated_budget_usd`)
  }
  if (value.error !== undefined) {
    if (value.status !== 'failed' || !isRecord(value.error)) {
      throw new TypeError(`${context} error is valid only for failed summaries`)
    }
    assertOnlyKeys(value.error, ['class', 'message'], `${context} error`)
    requiredString(value.error.class, `${context} error class`)
    requiredString(value.error.message, `${context} error message`)
  } else if (value.status === 'failed') {
    throw new TypeError(`${context} failed summary requires error`)
  }
}

function assertAnalystUsageReceipt(value: unknown, context: string): void {
  if (!isRecord(value)) throw new TypeError(`${context} must be an object`)
  assertOnlyKeys(value, ['calls', 'tokens', 'cost', 'knownCostUsd'], context)
  for (const field of ['calls', 'tokens', 'cost'] as const) {
    if (!Object.hasOwn(value, field)) {
      throw new TypeError(`${context} ${field} is required`)
    }
  }
  if (value.tokens !== null) {
    if (!isRecord(value.tokens)) throw new TypeError(`${context} tokens must be an object or null`)
    assertOnlyKeys(
      value.tokens,
      ['input', 'output', 'reasoning', 'cached', 'cacheWrite'],
      `${context} tokens`,
    )
  }
  assertCostProvenance(value.cost, `${context} cost`)
  assertValidAnalystUsageReceipt(value as unknown as AnalystUsageReceipt, context)
}

function assertCostProvenance(value: unknown, context: string): void {
  if (!isRecord(value)) throw new TypeError(`${context} must be an object`)
  assertOnlyKeys(value, ['kind', 'usd'], context)
  if (value.kind === 'uncaptured') {
    if (value.usd !== null) throw new TypeError(`${context} uncaptured usd must be null`)
    return
  }
  if (value.kind !== 'observed' && value.kind !== 'estimated') {
    throw new TypeError(`${context} kind is invalid`)
  }
  finiteNonnegative(value.usd, `${context} usd`)
}

function sealExactAnalystRunReceipt(
  run: Record<string, unknown>,
  context: string,
): ExactAnalystRunResult {
  if (run.execution_plan === undefined) {
    throw new TypeError(`${context} exact run requires execution_plan`)
  }
  const plan = snapshotExactExecutionPlan(run.execution_plan, `${context} execution_plan`)
  const completion = snapshotExactRunCompletion(run.completion, `${context} completion`)
  run.execution_plan = plan
  run.completion = completion
  const summaries = run.per_analyst as Array<{
    analyst_id: string
    status: 'ok' | 'skipped' | 'failed'
    findings_count: number
    usage: { cost: { kind: string; usd: number | null }; knownCostUsd?: number }
    allocated_budget_usd?: number | null
  }>
  const findings = run.findings as AnalystFinding[]
  const planned = plan.analysts.map((analyst) => analyst.id)
  const completed = summaries.map((summary) => summary.analyst_id)
  const ordered = completed.every((analystId, index) => analystId === planned[index])
  if (!ordered || (completion.status === 'complete' && completed.length !== planned.length)) {
    throw new TypeError(
      completion.status === 'complete'
        ? `${context} complete receipt must contain every execution_plan analyst in exact order`
        : `${context} failed receipt per_analyst must be an execution_plan prefix`,
    )
  }
  const completedIds = new Set(completed)
  for (const finding of findings) {
    if (!completedIds.has(finding.analyst_id)) {
      throw new TypeError(`${context} finding names an analyst absent from per_analyst`)
    }
  }
  for (const summary of summaries) {
    const actual = findings.filter((finding) => finding.analyst_id === summary.analyst_id).length
    if (summary.findings_count !== actual) {
      throw new TypeError(
        `${context} findings_count does not match findings for "${summary.analyst_id}"`,
      )
    }
    const hasAllocation = Object.hasOwn(summary, 'allocated_budget_usd')
    if (summary.status === 'skipped') {
      if (hasAllocation) {
        throw new TypeError(
          `${context} skipped summary "${summary.analyst_id}" cannot report an allocated budget`,
        )
      }
      continue
    }
    const allocation = summary.allocated_budget_usd
    const validAllocation =
      hasAllocation &&
      (plan.policy.budget.kind === 'none'
        ? allocation === null
        : typeof allocation === 'number' &&
          plan.policy.budget.allocations_usd[summary.analyst_id] !== null &&
          plan.policy.budget.allocations_usd[summary.analyst_id] !== undefined &&
          allocation <= plan.policy.budget.allocations_usd[summary.analyst_id]!)
    if (!validAllocation) {
      throw new TypeError(
        `${context} summary "${summary.analyst_id}" allocation does not match its execution plan`,
      )
    }
  }
  let knownCost = 0
  for (const summary of summaries) {
    const amount =
      summary.usage.cost.kind === 'uncaptured'
        ? (summary.usage.knownCostUsd ?? 0)
        : (summary.usage.cost.usd ?? 0)
    knownCost = finiteNonnegative(knownCost + amount, `${context} aggregate known cost`)
  }
  if (run.total_cost_usd !== knownCost) {
    throw new TypeError(`${context} total_cost_usd does not match per_analyst usage`)
  }
  if (run.total_cost_provenance === undefined) {
    throw new TypeError(`${context} exact run requires total_cost_provenance`)
  }
  const costs = summaries.map((summary) => summary.usage.cost)
  const expectedProvenance = costs.some((cost) => cost.kind === 'uncaptured')
    ? { kind: 'uncaptured', usd: null }
    : {
        kind: costs.some((cost) => cost.kind === 'estimated') ? 'estimated' : 'observed',
        usd: costs.reduce(
          (sum, cost) =>
            finiteNonnegative(sum + (cost.usd ?? 0), `${context} aggregate captured cost`),
          0,
        ),
      }
  if (hashCanonical(run.total_cost_provenance) !== hashCanonical(expectedProvenance)) {
    throw new TypeError(`${context} total_cost_provenance does not match per_analyst usage`)
  }
  return deepFreezeCanonicalJson(run as unknown as ExactAnalystRunResult)
}

function snapshotExactRunCompletion(
  value: unknown,
  context: string,
): ExactAnalystRunResult['completion'] {
  if (!isRecord(value)) throw new TypeError(`${context} must be an object`)
  if (value.status === 'complete') {
    assertOnlyKeys(value, ['status'], context)
    return value as ExactAnalystRunResult['completion']
  }
  if (value.status !== 'failed') {
    throw new TypeError(`${context} status must be complete or failed`)
  }
  assertOnlyKeys(value, ['status', 'error'], context)
  if (!isRecord(value.error)) throw new TypeError(`${context} failed receipt requires error`)
  assertOnlyKeys(value.error, ['class', 'message'], `${context} error`)
  requiredString(value.error.class, `${context} error class`)
  requiredString(value.error.message, `${context} error message`)
  return value as unknown as ExactAnalystRunResult['completion']
}

function finiteNonnegative(value: unknown, context: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new TypeError(`${context} must be a non-negative finite number`)
  }
  return value
}

function nonnegativeSafeInteger(value: unknown, context: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${context} must be a non-negative safe integer`)
  }
  return value as number
}

export function snapshotAnalystFindings(
  value: unknown,
  context = 'analyst run findings',
): AnalystFinding[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${context} must be an array`)
  }
  const findings = value.map((finding, index) =>
    snapshotAnalystFinding(finding, `${context} finding ${index}`),
  )
  assertUniqueFindingIds(findings.map((finding) => finding.finding_id))
  return findings
}

export function readAnalystReview(trajectory: FeedbackTrajectory): StoredAnalystReview | undefined {
  const analystAttempts = trajectory.attempts.filter(
    (attempt) => isRecord(attempt.artifact) && attempt.artifact.type === 'analyst-run',
  )
  const analysis = isRecord(trajectory.metadata?.analysis)
    ? trajectory.metadata.analysis
    : undefined
  if (analystAttempts.length === 0) {
    if (analysis?.kind === 'analyst-run') {
      throw new TypeError(
        `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" is missing its archived run`,
      )
    }
    return undefined
  }
  if (analystAttempts.length !== 1) {
    throw new TypeError(
      `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" must contain exactly one archived run`,
    )
  }
  if (analysis?.kind !== 'analyst-run') {
    throw new TypeError(
      `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" is missing review state`,
    )
  }

  const artifact = analystAttempts[0]!.artifact
  if (!isRecord(artifact)) {
    throw new TypeError(
      `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" has an invalid archived run`,
    )
  }
  const runId = requiredString(
    artifact.analystRunId,
    `analyst trajectory "${trajectory.id}" run id`,
  )
  if (analysis.runId !== runId) {
    throw new TypeError(
      `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" run identity does not match its review state`,
    )
  }
  const artifactRunDigest = requiredDigest(
    artifact.runDigest,
    `analyst trajectory "${trajectory.id}" archived run digest`,
  )
  const storedRunDigest = requiredDigest(
    analysis.runDigest,
    `analyst trajectory "${trajectory.id}" review run digest`,
  )
  if (artifactRunDigest !== storedRunDigest) {
    throw new TypeError(
      `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" run digest does not match its review state`,
    )
  }
  const findings = snapshotAnalystFindings(
    artifact.findings,
    `analyst trajectory "${trajectory.id}"`,
  )
  const findingIds = findings.map((finding) => finding.finding_id)
  const analystIds = stringArray(
    artifact.analystIds,
    `analyst trajectory "${trajectory.id}" analyst ids`,
  )
  const attemptMetadata = analystAttempts[0]!.metadata
  if (!isRecord(attemptMetadata)) {
    throw new TypeError(
      `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" is missing archived run metadata`,
    )
  }
  const archivedRun = snapshotAnalystRun(
    {
      run_id: runId,
      correlation_id: artifact.correlationId,
      started_at: analysis.startedAt,
      ended_at: analysis.endedAt,
      findings,
      per_analyst: attemptMetadata.perAnalyst,
      total_cost_usd: analysis.knownCostUsd,
      ...(analysis.costProvenance === undefined
        ? {}
        : { total_cost_provenance: analysis.costProvenance }),
      ...(artifact.executionPlan === undefined
        ? {}
        : {
            execution_plan: artifact.executionPlan,
            completion: artifact.completion,
          }),
    },
    `analyst trajectory "${trajectory.id}" archived run`,
  )
  const knownAnalystIds = new Set(analystIds)
  for (const [index, finding] of findings.entries()) {
    if (!knownAnalystIds.has(finding.analyst_id)) {
      throw new TypeError(
        `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" omits generating analyst "${finding.analyst_id}" at finding ${index}`,
      )
    }
  }
  const reviewDecisions = validateAnalystReviewDecisions({
    runId,
    runDigest: storedRunDigest,
    findings,
    analystIds,
    decisions: analysis.reviewDecisions,
    requireComplete: true,
  })
  const expectedRunDigest = analystRunDigest(archivedRun)
  if (storedRunDigest !== expectedRunDigest) {
    throw new TypeError(
      `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" archived run digest mismatch`,
    )
  }
  return {
    runId,
    runDigest: expectedRunDigest,
    findings,
    findingIds,
    analystIds,
    reviewDecisions,
  }
}

export function completedAnalystReviewQuality(review: StoredAnalystReview): AnalystReviewQuality {
  const findingDecisions = review.reviewDecisions.filter(
    (decision): decision is Extract<AnalystReviewDecision, { verdict: 'confirmed' | 'rejected' }> =>
      decision.verdict !== 'completeness_assessed',
  )
  const completeness = review.reviewDecisions.filter(
    (decision): decision is Extract<AnalystReviewDecision, { verdict: 'completeness_assessed' }> =>
      decision.verdict === 'completeness_assessed',
  )
  if (completeness.length !== 1) {
    throw new TypeError(
      'feedbackTrajectoryToOptimizerRow: analyst run requires exactly one independent completeness_assessed decision',
    )
  }

  const confirmed = findingDecisions.filter((decision) => decision.verdict === 'confirmed').length
  const rejected = findingDecisions.length - confirmed
  const emitted = review.findingIds.length
  const missed = completeness[0]!.missedIssues.length
  const precision = emitted === 0 ? 1 : confirmed / emitted
  const recallDenominator = confirmed + missed
  const recall = recallDenominator === 0 ? 1 : confirmed / recallDenominator
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall)
  return {
    precision,
    recall,
    f1,
    counts: { emitted, confirmed, rejected, missed },
  }
}

export function validateAnalystReviewDecisions(input: {
  runId: string
  runDigest: AnalystRunDigest
  findings: readonly AnalystFinding[]
  analystIds: readonly string[]
  decisions: unknown
  requireComplete?: boolean
}): AnalystReviewDecision[] {
  if (!Array.isArray(input.decisions)) {
    throw new TypeError('analyst review decisions must be an array')
  }
  const findings = snapshotAnalystFindings(input.findings)
  const expectedRunDigest = requiredDigest(input.runDigest, 'analyst review run digest')
  const findingsById = new Map(findings.map((finding) => [finding.finding_id, finding]))
  const generatingAnalystIds = new Set(input.analystIds)
  const seenFindingIds = new Set<string>()
  let completenessCount = 0

  const decisions = input.decisions.map((value, index): AnalystReviewDecision => {
    if (!isRecord(value)) {
      throw new TypeError(`analyst review decision ${index} must be an object`)
    }
    const source = requiredString(value.source, `analyst review decision ${index} source`)
    if (!isAnalystReviewSource(source)) {
      throw new TypeError(
        `analyst review decision ${index} source must be user, judge, environment, metric, or policy`,
      )
    }
    const reviewerId = requiredString(
      value.reviewerId,
      `analyst review decision ${index} reviewerId`,
    )
    if (generatingAnalystIds.has(reviewerId)) {
      throw new TypeError(
        `analyst review decision ${index} reviewerId must differ from the generating analyst`,
      )
    }
    const reviewId = requiredString(value.reviewId, `analyst review decision ${index} reviewId`)
    if (reviewId === input.runId) {
      throw new TypeError(
        `analyst review decision ${index} reviewId must identify an independent review`,
      )
    }
    const reason = requiredString(value.reason, `analyst review decision ${index} reason`)
    const decidedAt = canonicalTimestamp(
      value.decidedAt,
      `analyst review decision ${index} decidedAt`,
    )
    const runDigest = requiredDigest(value.runDigest, `analyst review decision ${index} runDigest`)
    if (runDigest !== expectedRunDigest) {
      throw new TypeError(`analyst review decision ${index} run digest mismatch`)
    }

    if (value.verdict === 'completeness_assessed') {
      assertOnlyKeys(
        value,
        [
          'runDigest',
          'verdict',
          'missedIssues',
          'source',
          'reviewerId',
          'reviewId',
          'reason',
          'decidedAt',
        ],
        `analyst review decision ${index}`,
      )
      completenessCount += 1
      if (completenessCount > 1) {
        throw new TypeError('duplicate completeness_assessed analyst review decision')
      }
      return {
        runDigest,
        verdict: 'completeness_assessed',
        missedIssues: validateMissedIssues(
          value.missedIssues,
          findingsById,
          `analyst review decision ${index}`,
        ),
        source,
        reviewerId,
        reviewId,
        reason,
        decidedAt,
      }
    }

    if (value.verdict !== 'confirmed' && value.verdict !== 'rejected') {
      throw new TypeError(
        `analyst review decision ${index} verdict must be confirmed, rejected, or completeness_assessed`,
      )
    }
    assertOnlyKeys(
      value,
      [
        'runDigest',
        'findingId',
        'findingDigest',
        'verdict',
        'source',
        'reviewerId',
        'reviewId',
        'reason',
        'decidedAt',
      ],
      `analyst review decision ${index}`,
    )
    const findingId = requiredString(value.findingId, `analyst review decision ${index} findingId`)
    const finding = findingsById.get(findingId)
    if (!finding) {
      throw new TypeError(`analyst review decision references unknown finding id "${findingId}"`)
    }
    if (seenFindingIds.has(findingId)) {
      throw new TypeError(`duplicate analyst review decision for finding id "${findingId}"`)
    }
    seenFindingIds.add(findingId)
    const findingDigest = requiredString(
      value.findingDigest,
      `analyst review decision ${index} findingDigest`,
    )
    const expectedDigest = analystFindingDigest(finding)
    if (findingDigest !== expectedDigest) {
      throw new TypeError(
        `analyst review decision ${index} digest mismatch for finding id "${findingId}"`,
      )
    }
    return {
      runDigest,
      findingId,
      findingDigest: expectedDigest,
      verdict: value.verdict,
      source,
      reviewerId,
      reviewId,
      reason,
      decidedAt,
    }
  })

  if (input.requireComplete) {
    const missing = findings
      .map((finding) => finding.finding_id)
      .filter((findingId) => !seenFindingIds.has(findingId))
    if (missing.length > 0) {
      throw new TypeError(
        `feedbackTrajectoryToOptimizerRow: missing independent decisions for finding ids: ${missing.join(', ')}`,
      )
    }
    if (completenessCount !== 1) {
      throw new TypeError(
        'feedbackTrajectoryToOptimizerRow: analyst run requires exactly one independent completeness_assessed decision',
      )
    }
  }
  return decisions
}

export function assertUniqueFindingIds(findingIds: readonly string[]): void {
  const seen = new Set<string>()
  for (const findingId of findingIds) {
    if (findingId.trim().length === 0) throw new TypeError('analyst finding id must not be empty')
    if (seen.has(findingId)) {
      throw new TypeError(`analyst run contains duplicate finding id "${findingId}"`)
    }
    seen.add(findingId)
  }
}

function snapshotAnalystFinding(value: unknown, context: string): AnalystFinding {
  let snapshot: unknown
  try {
    snapshot = JSON.parse(canonicalString(value)) as unknown
  } catch (cause) {
    throw new TypeError(`${context} must have a canonical JSON representation`, { cause })
  }
  assertAnalystFinding(snapshot, context)
  return snapshot
}

function assertAnalystFinding(value: unknown, context: string): asserts value is AnalystFinding {
  if (!isRecord(value)) throw new TypeError(`${context} must be an object`)
  assertOnlyKeys(
    value,
    [
      'schema_version',
      'finding_id',
      'analyst_id',
      'produced_at',
      'severity',
      'area',
      'claim',
      'rationale',
      'evidence_refs',
      'recommended_action',
      'validation_plan',
      'confidence',
      'subject',
      'derived_from_judge',
      'metadata',
    ],
    context,
  )
  if (value.schema_version !== '1.0.0') {
    throw new TypeError(`${context} schema_version must be "1.0.0"`)
  }
  requiredString(value.finding_id, `${context} finding_id`)
  requiredString(value.analyst_id, `${context} analyst_id`)
  canonicalTimestamp(value.produced_at, `${context} produced_at`)
  if (
    value.severity !== 'critical' &&
    value.severity !== 'high' &&
    value.severity !== 'medium' &&
    value.severity !== 'low' &&
    value.severity !== 'info'
  ) {
    throw new TypeError(`${context} severity is invalid`)
  }
  requiredString(value.area, `${context} area`)
  requiredString(value.claim, `${context} claim`)
  optionalString(value.rationale, `${context} rationale`)
  value.evidence_refs = validateEvidenceRefs(value.evidence_refs, `${context} evidence_refs`)
  optionalString(value.recommended_action, `${context} recommended_action`)
  optionalString(value.validation_plan, `${context} validation_plan`)
  if (
    typeof value.confidence !== 'number' ||
    !Number.isFinite(value.confidence) ||
    value.confidence < 0 ||
    value.confidence > 1
  ) {
    throw new TypeError(`${context} confidence must be a finite number from 0 through 1`)
  }
  optionalString(value.subject, `${context} subject`)
  if (value.derived_from_judge !== undefined && typeof value.derived_from_judge !== 'boolean') {
    throw new TypeError(`${context} derived_from_judge must be a boolean`)
  }
  if (value.metadata !== undefined && !isRecord(value.metadata)) {
    throw new TypeError(`${context} metadata must be an object`)
  }
}

function validateMissedIssues(
  value: unknown,
  findingsById: ReadonlyMap<string, AnalystFinding>,
  context: string,
): AnalystMissedIssue[] {
  if (!Array.isArray(value)) {
    throw new TypeError(`${context} missedIssues must be an array`)
  }
  const seen = new Set<string>()
  return value.map((issue, index) => {
    const issueContext = `${context} missedIssues ${index}`
    if (!isRecord(issue)) throw new TypeError(`${issueContext} must be an object`)
    assertOnlyKeys(issue, ['id', 'reason', 'evidence'], issueContext)
    const id = requiredString(issue.id, `${issueContext} id`)
    if (findingsById.has(id)) {
      throw new TypeError(`${issueContext} id "${id}" is already an emitted finding id`)
    }
    if (seen.has(id)) {
      throw new TypeError(`duplicate missed issue id "${id}"`)
    }
    seen.add(id)
    const reason = requiredString(issue.reason, `${issueContext} reason`)
    return {
      id,
      reason,
      ...(issue.evidence === undefined
        ? {}
        : { evidence: validateEvidenceRefs(issue.evidence, `${issueContext} evidence`) }),
    }
  })
}

function validateEvidenceRefs(value: unknown, context: string): EvidenceRef[] {
  if (!Array.isArray(value)) throw new TypeError(`${context} must be an array`)
  return value.map((evidence, index) => {
    const evidenceContext = `${context} ${index}`
    if (!isRecord(evidence)) throw new TypeError(`${evidenceContext} must be an object`)
    assertOnlyKeys(evidence, ['kind', 'uri', 'excerpt'], evidenceContext)
    if (
      evidence.kind !== 'span' &&
      evidence.kind !== 'event' &&
      evidence.kind !== 'artifact' &&
      evidence.kind !== 'finding' &&
      evidence.kind !== 'metric'
    ) {
      throw new TypeError(`${evidenceContext} kind is invalid`)
    }
    const uri = requiredString(evidence.uri, `${evidenceContext} uri`)
    const excerpt = evidence.excerpt
    optionalString(excerpt, `${evidenceContext} excerpt`)
    return {
      kind: evidence.kind,
      uri,
      ...(excerpt === undefined ? {} : { excerpt: excerpt as string }),
    }
  })
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  name: string,
): void {
  const allowedKeys = new Set(allowed)
  const unexpected = Object.keys(value).filter((key) => !allowedKeys.has(key))
  if (unexpected.length > 0) {
    throw new TypeError(`${name} contains unknown fields: ${unexpected.sort().join(', ')}`)
  }
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${name} must be an array of strings`)
  }
  const strings = value.map((item) => requiredString(item, name))
  if (new Set(strings).size !== strings.length) {
    throw new TypeError(`${name} must contain unique values`)
  }
  return strings
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
}

function requiredDigest(value: unknown, name: string): AnalystRunDigest {
  const digest = requiredString(value, name)
  if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
    throw new TypeError(`${name} must be a sha256 digest`)
  }
  return digest as AnalystRunDigest
}

function optionalString(value: unknown, name: string): void {
  if (value !== undefined && typeof value !== 'string') {
    throw new TypeError(`${name} must be a string`)
  }
}

function canonicalTimestamp(value: unknown, name: string): string {
  const timestamp = requiredString(value, name)
  const parsed = new Date(timestamp)
  if (Number.isNaN(parsed.valueOf()) || parsed.toISOString() !== timestamp) {
    throw new TypeError(`${name} must be a canonical ISO 8601 UTC timestamp`)
  }
  return timestamp
}

function isAnalystReviewSource(value: string): value is AnalystReviewSource {
  return (
    value === 'user' ||
    value === 'judge' ||
    value === 'environment' ||
    value === 'metric' ||
    value === 'policy'
  )
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
