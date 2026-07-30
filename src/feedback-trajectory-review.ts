import type { FeedbackLabelSource, FeedbackTrajectory } from './feedback-trajectory'

export type AnalystReviewSource = Exclude<FeedbackLabelSource, 'system'>

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
      verdict: 'confirmed' | 'rejected'
    })
  | (AnalystReviewDecisionBase & {
      verdict: 'confirmed_clean'
      findingId?: never
    })

export interface StoredAnalystReview {
  runId: string
  findingIds: string[]
  analystIds: string[]
  reviewDecisions: AnalystReviewDecision[]
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
  if (!Array.isArray(artifact.findings)) {
    throw new TypeError(
      `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" findings must be an array`,
    )
  }
  const findingIds = artifact.findings.map((finding, index) => {
    if (!isRecord(finding)) {
      throw new TypeError(
        `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" finding ${index} must be an object`,
      )
    }
    return requiredString(
      finding.finding_id,
      `analyst trajectory "${trajectory.id}" finding ${index} id`,
    )
  })
  assertUniqueFindingIds(findingIds)
  const analystIds = stringArray(
    artifact.analystIds,
    `analyst trajectory "${trajectory.id}" analyst ids`,
  )
  const knownAnalystIds = new Set(analystIds)
  for (const [index, finding] of artifact.findings.entries()) {
    if (!isRecord(finding)) continue
    const analystId = requiredString(
      finding.analyst_id,
      `analyst trajectory "${trajectory.id}" finding ${index} analyst id`,
    )
    if (!knownAnalystIds.has(analystId)) {
      throw new TypeError(
        `feedbackTrajectoryToOptimizerRow: analyst trajectory "${trajectory.id}" omits generating analyst "${analystId}"`,
      )
    }
  }
  return {
    runId,
    findingIds,
    analystIds,
    reviewDecisions: validateAnalystReviewDecisions({
      runId,
      findingIds,
      analystIds,
      decisions: analysis.reviewDecisions,
    }),
  }
}

export function completedAnalystReviewScore(review: StoredAnalystReview): number {
  if (review.findingIds.length === 0) {
    const cleanDecisions = review.reviewDecisions.filter(
      (decision) => decision.verdict === 'confirmed_clean',
    )
    if (cleanDecisions.length !== 1) {
      throw new TypeError(
        'feedbackTrajectoryToOptimizerRow: a zero-finding analyst run requires one independent confirmed_clean decision',
      )
    }
    return 1
  }

  const decisionsByFinding = new Map(
    review.reviewDecisions
      .filter(
        (
          decision,
        ): decision is Extract<AnalystReviewDecision, { verdict: 'confirmed' | 'rejected' }> =>
          decision.verdict !== 'confirmed_clean',
      )
      .map((decision) => [decision.findingId, decision]),
  )
  const missing = review.findingIds.filter((findingId) => !decisionsByFinding.has(findingId))
  if (missing.length > 0) {
    throw new TypeError(
      `feedbackTrajectoryToOptimizerRow: missing independent decisions for finding ids: ${missing.join(', ')}`,
    )
  }
  const confirmed = [...decisionsByFinding.values()].filter(
    (decision) => decision.verdict === 'confirmed',
  ).length
  return confirmed / review.findingIds.length
}

export function validateAnalystReviewDecisions(input: {
  runId: string
  findingIds: readonly string[]
  analystIds: readonly string[]
  decisions: unknown
}): AnalystReviewDecision[] {
  if (!Array.isArray(input.decisions)) {
    throw new TypeError('analyst review decisions must be an array')
  }
  const knownFindingIds = new Set(input.findingIds)
  const generatingAnalystIds = new Set(input.analystIds)
  const seenFindingIds = new Set<string>()
  let hasCleanDecision = false

  return input.decisions.map((value, index) => {
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
    const decidedAt = requiredString(value.decidedAt, `analyst review decision ${index} decidedAt`)
    if (Number.isNaN(Date.parse(decidedAt))) {
      throw new TypeError(`analyst review decision ${index} decidedAt must be a valid timestamp`)
    }

    if (value.verdict === 'confirmed_clean') {
      if (input.findingIds.length > 0) {
        throw new TypeError('confirmed_clean is valid only for a zero-finding analyst run')
      }
      if (value.findingId !== undefined) {
        throw new TypeError('confirmed_clean must not reference a finding id')
      }
      if (hasCleanDecision) {
        throw new TypeError('duplicate confirmed_clean analyst review decision')
      }
      hasCleanDecision = true
      return {
        verdict: 'confirmed_clean',
        source,
        reviewerId,
        reviewId,
        reason,
        decidedAt,
      }
    }

    if (value.verdict !== 'confirmed' && value.verdict !== 'rejected') {
      throw new TypeError(
        `analyst review decision ${index} verdict must be confirmed, rejected, or confirmed_clean`,
      )
    }
    const findingId = requiredString(value.findingId, `analyst review decision ${index} findingId`)
    if (!knownFindingIds.has(findingId)) {
      throw new TypeError(`analyst review decision references unknown finding id "${findingId}"`)
    }
    if (seenFindingIds.has(findingId)) {
      throw new TypeError(`duplicate analyst review decision for finding id "${findingId}"`)
    }
    seenFindingIds.add(findingId)
    return {
      findingId,
      verdict: value.verdict,
      source,
      reviewerId,
      reviewId,
      reason,
      decidedAt,
    }
  })
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

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new TypeError(`${name} must be an array of strings`)
  }
  return value
}

function requiredString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new TypeError(`${name} must be a non-empty string`)
  }
  return value
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
