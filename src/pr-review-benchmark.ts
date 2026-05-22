/** @deprecated Use agent-profile-cell instead. Will be removed in a future release. */

import { clamp01 } from './run-score'

export type PrReviewSource =
  | 'drew'
  | 'donovan'
  | 'shady'
  | 'codex'
  | 'claude-code'
  | 'gpt-5.5-high'
  | 'claude-opus-4.7-high'
  | 'kimi'
  | 'opencode'
  | (string & {})

export type PrReviewSeverity = 'critical' | 'high' | 'medium' | 'low' | 'nit'

export type PrReviewOutcome = 'accepted' | 'fixed' | 'rejected' | 'duplicate' | 'noise' | 'unknown'

export interface PrReviewComment {
  id: string
  source: PrReviewSource
  body: string
  model?: string
  author?: string
  path?: string
  line?: number
  severity?: PrReviewSeverity
  outcome?: PrReviewOutcome
  createdAt?: string
  metadata?: Record<string, unknown>
}

export interface PrReviewReferenceFinding {
  id: string
  title: string
  severity: PrReviewSeverity
  path?: string
  line?: number
  /**
   * Stable terms that should appear in a useful finding. Keep these
   * factual: API names, invariant names, table names, error classes.
   */
  keywords?: string[]
  fixedByCommit?: string
  sourceCommentIds?: string[]
  metadata?: Record<string, unknown>
}

export interface PrReviewAuditCase {
  id: string
  repo: string
  prNumber?: number
  baseSha?: string
  headSha?: string
  title?: string
  diff?: string
  split?: 'train' | 'validation' | 'test' | 'holdout' | (string & {})
  comments: PrReviewComment[]
  referenceFindings: PrReviewReferenceFinding[]
  metadata?: Record<string, unknown>
}

export interface PrReviewScoreWeights {
  recall: number
  precision: number
  actionability: number
  severityCalibration: number
  lowNoise: number
}

export interface PrReviewMatchedFinding {
  referenceId: string
  commentId: string
  score: number
}

export interface PrReviewScore {
  caseId: string
  source: PrReviewSource
  commentCount: number
  referenceCount: number
  matchedFindings: PrReviewMatchedFinding[]
  recall: number
  precision: number
  actionability: number
  severityCalibration: number
  lowNoise: number
  aggregate: number
  notes: string[]
}

export interface PrReviewBenchmarkSummary {
  source: PrReviewSource
  caseCount: number
  commentCount: number
  aggregateMean: number
  recallMean: number
  precisionMean: number
  actionabilityMean: number
  severityCalibrationMean: number
  lowNoiseMean: number
}

export const DEFAULT_PR_REVIEW_SCORE_WEIGHTS: PrReviewScoreWeights = {
  recall: 4,
  precision: 2,
  actionability: 1.5,
  severityCalibration: 1,
  lowNoise: 1,
}

export function commentsForSource(
  auditCase: PrReviewAuditCase,
  source: PrReviewSource,
): PrReviewComment[] {
  return auditCase.comments.filter((comment) => comment.source === source)
}

export function scorePrReviewSource(
  auditCase: PrReviewAuditCase,
  source: PrReviewSource,
  weights: Partial<PrReviewScoreWeights> = {},
): PrReviewScore {
  return scorePrReviewComments(auditCase, commentsForSource(auditCase, source), source, weights)
}

export function scorePrReviewComments(
  auditCase: PrReviewAuditCase,
  comments: PrReviewComment[],
  source: PrReviewSource,
  weights: Partial<PrReviewScoreWeights> = {},
): PrReviewScore {
  const matchedFindings = matchReferenceFindings(auditCase.referenceFindings, comments)
  const matchedCommentIds = new Set(matchedFindings.map((match) => match.commentId))
  const positiveComments = comments.filter((comment) => isPositiveOutcome(comment.outcome))
  const negativeComments = comments.filter((comment) => isNegativeOutcome(comment.outcome))
  const actionableComments = comments.filter(isActionableComment)
  const severityComments = comments.filter((comment) => comment.severity)
  const severityAligned = severityComments.filter((comment) =>
    isSeverityAligned(comment, auditCase.referenceFindings, matchedFindings),
  )

  const recall = auditCase.referenceFindings.length
    ? matchedFindings.length / auditCase.referenceFindings.length
    : comments.length === 0
      ? 1
      : 0

  const precisionDenominator = positiveComments.length + negativeComments.length
  const precision =
    precisionDenominator > 0
      ? positiveComments.length / precisionDenominator
      : comments.length > 0
        ? matchedCommentIds.size / comments.length
        : auditCase.referenceFindings.length === 0
          ? 1
          : 0

  const actionability = comments.length ? actionableComments.length / comments.length : 1
  const severityCalibration = severityComments.length
    ? severityAligned.length / severityComments.length
    : matchedFindings.length
      ? 0.5
      : 1
  const lowNoise = comments.length ? 1 - negativeComments.length / comments.length : 1
  const aggregate = aggregatePrReviewScore(
    { recall, precision, actionability, severityCalibration, lowNoise },
    weights,
  )

  return {
    caseId: auditCase.id,
    source,
    commentCount: comments.length,
    referenceCount: auditCase.referenceFindings.length,
    matchedFindings,
    recall,
    precision,
    actionability,
    severityCalibration,
    lowNoise,
    aggregate,
    notes: buildScoreNotes({
      comments,
      referenceCount: auditCase.referenceFindings.length,
      matchedFindings,
      negativeComments,
      actionableComments,
    }),
  }
}

export function summarizePrReviewBenchmark(scores: PrReviewScore[]): PrReviewBenchmarkSummary[] {
  const bySource = new Map<PrReviewSource, PrReviewScore[]>()
  for (const score of scores) {
    bySource.set(score.source, [...(bySource.get(score.source) ?? []), score])
  }
  return [...bySource.entries()]
    .map(([source, sourceScores]) => ({
      source,
      caseCount: sourceScores.length,
      commentCount: sum(sourceScores.map((score) => score.commentCount)),
      aggregateMean: mean(sourceScores.map((score) => score.aggregate)),
      recallMean: mean(sourceScores.map((score) => score.recall)),
      precisionMean: mean(sourceScores.map((score) => score.precision)),
      actionabilityMean: mean(sourceScores.map((score) => score.actionability)),
      severityCalibrationMean: mean(sourceScores.map((score) => score.severityCalibration)),
      lowNoiseMean: mean(sourceScores.map((score) => score.lowNoise)),
    }))
    .sort((a, b) => b.aggregateMean - a.aggregateMean)
}

export function aggregatePrReviewScore(
  dimensions: Pick<
    PrReviewScore,
    'recall' | 'precision' | 'actionability' | 'severityCalibration' | 'lowNoise'
  >,
  weights: Partial<PrReviewScoreWeights> = {},
): number {
  const merged = { ...DEFAULT_PR_REVIEW_SCORE_WEIGHTS, ...weights }
  const weightSum = Object.values(merged).reduce((total, value) => total + Math.max(0, value), 0)
  if (weightSum <= 0) return 0
  return (
    (merged.recall * clamp01(dimensions.recall) +
      merged.precision * clamp01(dimensions.precision) +
      merged.actionability * clamp01(dimensions.actionability) +
      merged.severityCalibration * clamp01(dimensions.severityCalibration) +
      merged.lowNoise * clamp01(dimensions.lowNoise)) /
    weightSum
  )
}

function matchReferenceFindings(
  references: PrReviewReferenceFinding[],
  comments: PrReviewComment[],
): PrReviewMatchedFinding[] {
  const matches: PrReviewMatchedFinding[] = []
  const usedCommentIds = new Set<string>()

  for (const reference of references) {
    const candidates = comments
      .filter((comment) => !usedCommentIds.has(comment.id))
      .map((comment) => ({ comment, score: matchScore(reference, comment) }))
      .filter(({ score }) => score >= 0.55)
      .sort((a, b) => b.score - a.score)
    const best = candidates[0]
    if (!best) continue
    usedCommentIds.add(best.comment.id)
    matches.push({ referenceId: reference.id, commentId: best.comment.id, score: best.score })
  }

  return matches
}

function matchScore(reference: PrReviewReferenceFinding, comment: PrReviewComment): number {
  let score = 0
  if (reference.sourceCommentIds?.includes(comment.id)) score += 1
  if (
    reference.path &&
    comment.path &&
    normalizePath(reference.path) === normalizePath(comment.path)
  ) {
    score += 0.35
  }
  if (reference.line && comment.line && Math.abs(reference.line - comment.line) <= 3) score += 0.15

  const terms = [...(reference.keywords ?? []), ...tokenize(reference.title)]
  const uniqueTerms = [...new Set(terms.map(normalizeTerm).filter((term) => term.length >= 3))]
  if (uniqueTerms.length > 0) {
    const bodyTerms = new Set(tokenize(comment.body).map(normalizeTerm))
    const overlap = uniqueTerms.filter((term) => bodyTerms.has(term)).length
    score += 0.5 * (overlap / uniqueTerms.length)
  }

  return clamp01(score)
}

function isActionableComment(comment: PrReviewComment): boolean {
  const body = comment.body.trim()
  if (!comment.path && !/\b(file|line|function|method|class|module|test|migration)\b/i.test(body)) {
    return false
  }
  return /\b(fix|change|add|remove|guard|check|reject|validate|test|assert|return|throw|fail|block)\b/i.test(
    body,
  )
}

function isSeverityAligned(
  comment: PrReviewComment,
  references: PrReviewReferenceFinding[],
  matches: PrReviewMatchedFinding[],
): boolean {
  if (!comment.severity) return false
  const match = matches.find((candidate) => candidate.commentId === comment.id)
  if (!match) return comment.severity === 'nit' || comment.severity === 'low'
  const reference = references.find((candidate) => candidate.id === match.referenceId)
  if (!reference) return false
  return Math.abs(severityRank(comment.severity) - severityRank(reference.severity)) <= 1
}

function buildScoreNotes(input: {
  comments: PrReviewComment[]
  referenceCount: number
  matchedFindings: PrReviewMatchedFinding[]
  negativeComments: PrReviewComment[]
  actionableComments: PrReviewComment[]
}): string[] {
  const notes: string[] = []
  if (input.referenceCount > 0 && input.matchedFindings.length === 0) {
    notes.push('no reference findings matched')
  }
  if (input.negativeComments.length > 0) {
    notes.push(`${input.negativeComments.length} comment(s) labelled rejected/duplicate/noise`)
  }
  if (input.comments.length > 0 && input.actionableComments.length === 0) {
    notes.push('comments were not actionable enough for a PR reviewer benchmark')
  }
  return notes
}

function isPositiveOutcome(outcome: PrReviewOutcome | undefined): boolean {
  return outcome === 'accepted' || outcome === 'fixed'
}

function isNegativeOutcome(outcome: PrReviewOutcome | undefined): boolean {
  return outcome === 'rejected' || outcome === 'duplicate' || outcome === 'noise'
}

function severityRank(severity: PrReviewSeverity): number {
  switch (severity) {
    case 'critical':
      return 5
    case 'high':
      return 4
    case 'medium':
      return 3
    case 'low':
      return 2
    case 'nit':
      return 1
  }
}

function tokenize(input: string): string[] {
  return input.match(/[a-zA-Z0-9_.$/-]+/g) ?? []
}

function normalizeTerm(input: string): string {
  return input.toLowerCase().replace(/^[^a-z0-9_]+|[^a-z0-9_]+$/g, '')
}

function normalizePath(input: string): string {
  return input.replace(/^\.\/+/, '')
}

function mean(values: number[]): number {
  return values.length ? sum(values) / values.length : 0
}

function sum(values: number[]): number {
  return values.reduce((total, value) => total + value, 0)
}
