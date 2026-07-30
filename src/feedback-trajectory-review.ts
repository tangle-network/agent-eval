import type { AnalystFinding, EvidenceRef } from './analyst/types'
import type { FeedbackLabelSource, FeedbackTrajectory } from './feedback-trajectory'
import { canonicalString, hashCanonical } from './ledger-core/canonical'

export type AnalystReviewSource = Exclude<FeedbackLabelSource, 'system'>
export type AnalystFindingDigest = `sha256:${string}`

export interface AnalystMissedIssue {
  id: string
  reason: string
  evidence?: EvidenceRef[]
}

interface AnalystReviewDecisionBase {
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
  findings: AnalystFinding[]
  findingIds: string[]
  analystIds: string[]
  reviewDecisions: AnalystReviewDecision[]
}

/** Bind an analyst finding's complete canonical JSON content to a stable digest. */
export function analystFindingDigest(finding: AnalystFinding): AnalystFindingDigest {
  return hashCanonical(snapshotAnalystFinding(finding, 'analyst finding'))
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
  const findings = snapshotAnalystFindings(
    artifact.findings,
    `analyst trajectory "${trajectory.id}"`,
  )
  const findingIds = findings.map((finding) => finding.finding_id)
  const analystIds = stringArray(
    artifact.analystIds,
    `analyst trajectory "${trajectory.id}" analyst ids`,
  )
  const knownAnalystIds = new Set(analystIds)
  for (const [index, finding] of findings.entries()) {
    if (!knownAnalystIds.has(finding.analyst_id)) {
      throw new TypeError(
        `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" omits generating analyst "${finding.analyst_id}" at finding ${index}`,
      )
    }
  }
  return {
    runId,
    findings,
    findingIds,
    analystIds,
    reviewDecisions: validateAnalystReviewDecisions({
      runId,
      findings,
      analystIds,
      decisions: analysis.reviewDecisions,
      requireComplete: true,
    }),
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
  findings: readonly AnalystFinding[]
  analystIds: readonly string[]
  decisions: unknown
  requireComplete?: boolean
}): AnalystReviewDecision[] {
  if (!Array.isArray(input.decisions)) {
    throw new TypeError('analyst review decisions must be an array')
  }
  const findings = snapshotAnalystFindings(input.findings)
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

    if (value.verdict === 'completeness_assessed') {
      assertOnlyKeys(
        value,
        ['verdict', 'missedIssues', 'source', 'reviewerId', 'reviewId', 'reason', 'decidedAt'],
        `analyst review decision ${index}`,
      )
      completenessCount += 1
      if (completenessCount > 1) {
        throw new TypeError('duplicate completeness_assessed analyst review decision')
      }
      return {
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
