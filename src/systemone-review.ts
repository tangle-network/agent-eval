import { z } from 'zod'
import {
  ANALYST_SEVERITIES,
  type AnalystFinding,
  type EvidenceRef,
  makeFinding,
} from './analyst/types'
import { canonicalString, hashCanonical, jsonDocument } from './ledger-core/canonical'
import { deepFreezeCanonicalJson } from './ledger-core/deep-freeze'
import type { SystemOneQuestions, SystemOneRequest, SystemOneResult } from './systemone-protocol'
import { parseSystemOneRequest, parseSystemOneResult } from './systemone-protocol'

const name = z.string().trim().min(1)
const probability = z.number().finite().gt(0).max(1)
const checkSchema = z
  .object({
    claim: name,
    area: name,
    subject: name,
    severity: z.enum(ANALYST_SEVERITIES),
    /** Choice labels or score-level keys, never scores invented from category order. */
    supports: z.array(z.string()).min(1),
    refutes: z.array(z.string()).min(1),
    supportAtLeast: probability,
    refuteAtLeast: probability,
    /** Host-supplied coverage of the question's required evidence, not model self-assessment. */
    coverage: z.enum(['complete', 'partial', 'missing']),
    evidence: z.array(
      z
        .object({
          kind: z.enum(['span', 'event', 'artifact', 'finding', 'metric']),
          uri: name,
          excerpt: z.string().optional(),
        })
        .strict(),
    ),
  })
  .strict()
  .refine((value) => value.supportAtLeast + value.refuteAtLeast > 1, {
    message: 'Support and refutation thresholds must not overlap',
  })

/** Optional interpretation of native choices/scores. Policy and evidence belong to the caller. */
export type SystemOneReviewCheck = z.infer<typeof checkSchema>
export interface SystemOneReviewInput<Q extends SystemOneQuestions = SystemOneQuestions> {
  version: string
  request: SystemOneRequest<Q>
  checks: { [K in keyof Q]: SystemOneReviewCheck }
}

export interface PreparedSystemOneReview<Q extends SystemOneQuestions = SystemOneQuestions>
  extends SystemOneReviewInput<Q> {
  /** Binds questions, option order, context, evidence, thresholds and definition version. */
  digest: string
}

export interface SystemOneReviewAssessment {
  question: string
  status: 'supported' | 'refuted' | 'unresolved'
  reason:
    | 'support-threshold'
    | 'refutation-threshold'
    | 'missing-evidence'
    | 'partial-negative-evidence'
    | 'below-threshold'
    | 'ambiguous-thresholds'
  /** Unnormalized marginal mass of caller-designated native alternatives. Not calibrated risk. */
  supportProbability: number
  refutationProbability: number
  unresolvedProbability: number
  modelConfidence: number | null
  check: SystemOneReviewCheck
}

export interface SystemOneReviewReport {
  reviewDigest: string
  requestedModel: string
  servedModel: string
  assessments: SystemOneReviewAssessment[]
}

function alternatives(question: SystemOneQuestions[string]): string[] {
  if (question.type === 'noul') return ['true', 'false']
  return question.type === 'choice'
    ? Object.keys(question.criteria)
    : question.criteria.map((_, index) => String(index))
}

/** Validate before paid admission; make a detached, frozen snapshot without rewriting native JSON. */
export function prepareSystemOneReview<const Q extends SystemOneQuestions>(
  input: SystemOneReviewInput<Q>,
): PreparedSystemOneReview<Q> {
  if (!input.version?.trim()) throw new TypeError('Review version is required')
  parseSystemOneRequest(input.request)
  // Document form drops only optional undefined object fields; canonicalization rejects loss.
  const document = jsonDocument(input)
  canonicalString(document)
  // Canonical bytes are for hashing, not dispatch: option order can affect a classifier.
  const snapshot = structuredClone(document) as SystemOneReviewInput<Q>
  const keys = Object.keys(snapshot.request.questions)
  if (
    !snapshot.checks ||
    Object.keys(snapshot.checks).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(snapshot.checks, key))
  ) {
    throw new TypeError('Review checks must match the exact question names')
  }
  for (const key of keys) {
    const check = checkSchema.parse(snapshot.checks[key])
    const labels = [...check.supports, ...check.refutes]
    const allowed = alternatives(snapshot.request.questions[key]!)
    if (
      new Set(labels).size !== labels.length ||
      labels.some((label) => !allowed.includes(label))
    ) {
      throw new TypeError('Review alternatives must exist and be disjoint')
    }
    if (check.coverage !== 'missing' && check.evidence.length === 0) {
      throw new TypeError('Review evidence references are required for non-missing coverage')
    }
    // Validation must not normalize a label into a different native option.
    if (canonicalString(jsonDocument(check)) !== canonicalString(snapshot.checks[key])) {
      throw new TypeError('Review metadata must not require normalization')
    }
  }
  const order = keys.map((key) => [key, alternatives(snapshot.request.questions[key]!)])
  return deepFreezeCanonicalJson({ ...snapshot, digest: hashCanonical({ snapshot, order }) })
}

/** Re-score the same retained distribution without new inference or any authorization effect. */
export function assessSystemOneReview<Q extends SystemOneQuestions>(
  review: PreparedSystemOneReview<Q>,
  raw: unknown,
): SystemOneReviewReport {
  const { digest, ...input } = review
  const prepared = prepareSystemOneReview(input)
  if (prepared.digest !== digest) throw new TypeError('Review definition changed after preparation')
  const result = parseSystemOneResult(raw, prepared.request)
  const assessments = Object.entries(prepared.checks).map(([question, check]) => {
    const answer = result.answers[question]!
    const probabilities: Record<string, number> =
      answer.type === 'noul' ? { true: answer.noul, false: 1 - answer.noul } : answer.probabilities
    const sum = (labels: string[]) =>
      labels.reduce((total, label) => total + probabilities[label]!, 0)
    const supportProbability = sum(check.supports)
    const refutationProbability = sum(check.refutes)
    const used = new Set([...check.supports, ...check.refutes])
    const unresolvedProbability = sum(
      Object.keys(probabilities).filter((label) => !used.has(label)),
    )
    let status: SystemOneReviewAssessment['status'] = 'unresolved'
    let reason: SystemOneReviewAssessment['reason'] = 'below-threshold'
    if (supportProbability > 1 || refutationProbability > 1 || unresolvedProbability > 1) {
      throw new TypeError('Review probability mass exceeds one; do not silently normalize it')
    }
    if (check.coverage === 'missing') reason = 'missing-evidence'
    else if (
      supportProbability >= check.supportAtLeast &&
      refutationProbability >= check.refuteAtLeast
    ) {
      reason = 'ambiguous-thresholds'
    } else if (supportProbability >= check.supportAtLeast) {
      status = 'supported'
      reason = 'support-threshold'
    } else if (refutationProbability >= check.refuteAtLeast) {
      if (check.coverage === 'complete') {
        status = 'refuted'
        reason = 'refutation-threshold'
      } else reason = 'partial-negative-evidence'
    }
    return {
      question,
      status,
      reason,
      supportProbability,
      refutationProbability,
      unresolvedProbability,
      modelConfidence: answer.type === 'noul' ? null : answer.confidence,
      check: structuredClone(check),
    }
  })
  return {
    reviewDigest: digest,
    requestedModel: review.request.model,
    servedModel: result.model,
    assessments,
  }
}

/** Ordinary analyst findings; a negative review is not a global safety certificate. */
export function systemOneReviewFindings<Q extends SystemOneQuestions>(
  review: PreparedSystemOneReview<Q>,
  result: SystemOneResult<Q>,
  options: { analystId: string; producedAt?: string },
): AnalystFinding[] {
  if (!options.analystId.trim()) throw new TypeError('Analyst id is required')
  const report = assessSystemOneReview(review, result)
  return report.assessments
    .filter((item) => item.status !== 'refuted')
    .map((item) =>
      makeFinding({
        analyst_id: options.analystId,
        ...(options.producedAt === undefined ? {} : { produced_at: options.producedAt }),
        subject: item.check.subject,
        area: item.status === 'unresolved' ? 'assessment-coverage' : item.check.area,
        severity: item.status === 'unresolved' ? 'info' : item.check.severity,
        claim:
          item.status === 'supported'
            ? `Model-supported hypothesis: ${item.check.claim}`
            : `Unresolved review: ${item.check.claim}`,
        evidence_refs: structuredClone(item.check.evidence) as EvidenceRef[],
        // For unresolved findings, confidence describes the deterministic unresolved status only.
        confidence: item.status === 'supported' ? item.supportProbability : 1,
        derived_from_judge: true,
        id_basis: hashCanonical([item.question, item.status, review.version, item.check.claim]),
        metadata: {
          review_digest: report.reviewDigest,
          question: item.question,
          requested_model: report.requestedModel,
          served_model: report.servedModel,
          assessment: item.status,
          assessment_reason: item.reason,
          evidence_coverage: item.check.coverage,
          support_probability: item.supportProbability,
          refutation_probability: item.refutationProbability,
          unresolved_probability: item.unresolvedProbability,
          model_confidence: item.modelConfidence,
          calibration: 'not-established',
          confidence_basis:
            item.status === 'supported' ? 'model-support-mass' : 'deterministic-status',
          native_answer: structuredClone(result.answers[item.question]),
        },
      }),
    )
}
