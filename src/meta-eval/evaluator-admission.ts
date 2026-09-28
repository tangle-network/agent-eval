import { z } from 'zod'
import { ValidationError } from '../errors'
import { type ComputedInterval, computeInterval } from '../experiment/ast'
import { compareCodeUnits, hashCanonical, type LedgerHash } from '../ledger-core/canonical'

const identity = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value)
export const evaluatorAdmissionPolicySchema = z
  .object({
    confidence: z.number().finite().gt(0).lt(1),
    maxFalseAcceptanceRate: z.number().finite().min(0).lt(1),
    maxFalseRejectionRate: z.number().finite().min(0).lt(1),
  })
  .strict()

/** Register both error limits before inspecting audit judgments. */
export type EvaluatorAdmissionPolicy = z.infer<typeof evaluatorAdmissionPolicySchema>

export const evaluatorAuditObservationSchema = z
  .object({
    id: identity,
    independentUnitId: identity,
    evidenceRef: identity,
    expected: z.enum(['accept', 'reject']),
    observed: z.enum(['accept', 'reject', 'unknown']),
    exposure: z.enum(['fresh', 'development']),
  })
  .strict()

/** Actual control judgments. Variants from one source retain one independent identity. */
export type EvaluatorAuditObservation = z.infer<typeof evaluatorAuditObservationSchema>

const inputSchema = z
  .object({
    evaluatorDigest: z.string().regex(/^sha256:[a-f0-9]{64}$/),
    population: identity,
    samplingFrame: identity,
    authority: z
      .object({
        evaluatorAuthorId: identity,
        auditorId: identity,
        independenceEvidenceRef: identity,
      })
      .strict(),
    policy: evaluatorAdmissionPolicySchema,
    observations: z.array(evaluatorAuditObservationSchema),
  })
  .strict()

export type EvaluatorAuditInput = z.infer<typeof inputSchema>

export interface EvaluatorErrorRate {
  /** Eligible control judgments in this class, including unknown judgments. */
  cases: number
  independentUnits: number
  /** Units with at least one observed mistake. */
  errorUnits: number
  /** Units with unknown judgments and no observed mistake yet. */
  unresolvedUnits: number
  unknownCases: number
  /** Missing judgments do not become measured zeros. */
  errorRate: number | null
  /** Exact bounds conservatively include every possible outcome of unknown judgments. */
  interval: ComputedInterval | null
  limit: number
  verdict: 'pass' | 'fail' | 'inconclusive'
}

export interface EvaluatorAdmissionReport {
  evaluatorDigest: LedgerHash
  policyDigest: LedgerHash
  inputDigest: LedgerHash
  reportDigest: LedgerHash
  population: string
  samplingFrame: string
  authority: EvaluatorAuditInput['authority']
  policy: EvaluatorAdmissionPolicy
  /** Joint coverage for the two reported error-rate intervals. */
  confidence: number
  intervalConfidence: number
  verdict: 'admit' | 'reject' | 'inconclusive'
  reasons: string[]
  observations: EvaluatorAuditObservation[]
  coverage: {
    cases: number
    independentUnits: number
    eligibleCases: number
    eligibleIndependentUnits: number
    excludedCases: number
    unknownCases: number
  }
  exclusions: Array<{ id: string; independentUnitId: string; reason: 'development-exposure' }>
  falseAcceptance: EvaluatorErrorRate
  falseRejection: EvaluatorErrorRate
}

function errorRate(
  rows: readonly EvaluatorAuditObservation[],
  expected: 'accept' | 'reject',
  limit: number,
  level: number,
): EvaluatorErrorRate {
  const cases = rows.filter((row) => row.expected === expected)
  const units = new Map<string, { error: boolean; unknown: boolean }>()
  for (const row of cases) {
    const unit = units.get(row.independentUnitId) ?? { error: false, unknown: false }
    unit.unknown ||= row.observed === 'unknown'
    unit.error ||= row.observed !== 'unknown' && row.observed !== expected
    units.set(row.independentUnitId, unit)
  }
  const n = units.size
  const errorUnits = [...units.values()].filter((unit) => unit.error).length
  const unresolvedUnits = [...units.values()].filter((unit) => unit.unknown && !unit.error).length
  const unknownCases = cases.filter((row) => row.observed === 'unknown').length
  // Unknown judgments contribute to n; their most favorable and adverse outcomes bound the rate.
  const interval =
    n === 0
      ? null
      : {
          lower: computeInterval(
            { kind: 'clopper-pearson', level },
            {
              kind: 'binomial',
              successes: errorUnits,
              trials: n,
            },
          ).lower,
          upper: computeInterval(
            { kind: 'clopper-pearson', level },
            {
              kind: 'binomial',
              successes: errorUnits + unresolvedUnits,
              trials: n,
            },
          ).upper,
          level,
        }
  const verdict =
    interval && interval.lower > limit
      ? 'fail'
      : interval && interval.upper <= limit
        ? 'pass'
        : 'inconclusive'
  return {
    cases: cases.length,
    independentUnits: n,
    errorUnits,
    unresolvedUnits,
    unknownCases,
    errorRate: n === 0 || unresolvedUnits > 0 ? null : errorUnits / n,
    interval,
    limit,
    verdict,
  }
}

function eligibleControls<
  T extends Pick<EvaluatorAuditObservation, 'id' | 'independentUnitId' | 'exposure'>,
>(observations: T[]) {
  const ids = new Set<string>()
  for (const row of observations) {
    if (ids.has(row.id))
      throw new ValidationError(`duplicate evaluator audit observation '${row.id}'`)
    ids.add(row.id)
  }
  observations.sort((a, b) => compareCodeUnits(a.id, b.id))
  const developmentUnits = new Set(
    observations
      .filter((row) => row.exposure === 'development')
      .map((row) => row.independentUnitId),
  )
  const eligible = observations.filter((row) => !developmentUnits.has(row.independentUnitId))
  const exclusions = observations
    .filter((row) => developmentUnits.has(row.independentUnitId))
    .map((row) => ({
      id: row.id,
      independentUnitId: row.independentUnitId,
      reason: 'development-exposure' as const,
    }))
  return { eligible, exclusions }
}

function simultaneousIntervalConfidence(confidence: number): number {
  const level = 1 - (1 - confidence) / 2
  if (level >= 1)
    throw new ValidationError(
      'evaluator audit confidence is too close to one for simultaneous intervals',
    )
  return level
}

const capacitySchema = z
  .object({
    policy: evaluatorAdmissionPolicySchema,
    controls: z
      .array(evaluatorAuditObservationSchema.omit({ observed: true, evidenceRef: true }))
      .default([]),
  })
  .strict()

export type EvaluatorAuditPlanInput = z.input<typeof capacitySchema>

/** The zero-error eligibility floor, not a statistical power calculation. */
function zeroErrorUpperBound(trials: number, level: number): number {
  return -Math.expm1(Math.log((1 - level) / 2) / trials)
}

function minimumAuditUnits(limit: number, level: number): number | null {
  if (limit === 0) return null
  const estimate = Math.ceil(Math.log((1 - level) / 2) / Math.log1p(-limit))
  if (!Number.isFinite(estimate) || estimate > Number.MAX_SAFE_INTEGER) return null
  const clears = (trials: number) => zeroErrorUpperBound(trials, level) <= limit
  let minimum = Math.max(1, estimate)
  while (minimum > 1 && clears(minimum - 1)) minimum -= 1
  while (!clears(minimum)) {
    if (minimum === Number.MAX_SAFE_INTEGER) return null
    minimum += 1
  }
  return minimum
}

/**
 * Can the fixed control roster meet the policy even with zero errors?
 * Planning uses the admission rule's exact bounds and source-unit exclusions.
 * It accepts no judgments or authority and returns no admission report.
 */
export function planEvaluatorAudit(input: EvaluatorAuditPlanInput) {
  const parsed = capacitySchema.safeParse(input)
  if (!parsed.success)
    throw new ValidationError(`invalid evaluator audit plan: ${parsed.error.message}`)
  const { policy, controls } = parsed.data
  const { eligible } = eligibleControls(controls)
  const level = simultaneousIntervalConfidence(policy.confidence)
  const capacity = (expected: EvaluatorAuditObservation['expected'], limit: number) => {
    const independentUnits = new Set(
      eligible.filter((row) => row.expected === expected).map((row) => row.independentUnitId),
    ).size
    const bestPossibleUpperBound =
      independentUnits === 0 ? null : zeroErrorUpperBound(independentUnits, level)
    const minimumIndependentUnits = minimumAuditUnits(limit, level)
    return {
      independentUnits,
      bestPossibleUpperBound,
      limit,
      minimumIndependentUnits,
      additionalIndependentUnits:
        minimumIndependentUnits === null
          ? null
          : Math.max(0, minimumIndependentUnits - independentUnits),
    }
  }
  const falseAcceptance = capacity('reject', policy.maxFalseAcceptanceRate)
  const falseRejection = capacity('accept', policy.maxFalseRejectionRate)
  const sufficient = [falseAcceptance, falseRejection].every(
    (rate) => rate.bestPossibleUpperBound !== null && rate.bestPossibleUpperBound <= rate.limit,
  )
  return { sufficient, falseAcceptance, falseRejection }
}

export type EvaluatorAuditPlan = ReturnType<typeof planEvaluatorAudit>

/**
 * Audit frozen judgments using independent source units and exact binomial bounds.
 * A unit fails a class when any control in that class is misjudged.
 * The execution owner enforces auditor separation, fresh sampling, and evidence authenticity.
 */
export function auditEvaluator(input: EvaluatorAuditInput): EvaluatorAdmissionReport {
  const parsed = inputSchema.safeParse(input)
  if (!parsed.success) throw new ValidationError(`invalid evaluator audit: ${parsed.error.message}`)
  const audit = parsed.data
  if (audit.authority.evaluatorAuthorId === audit.authority.auditorId) {
    throw new ValidationError('evaluator admission requires a separate declared audit authority')
  }
  const { eligible, exclusions } = eligibleControls(audit.observations)
  const intervalConfidence = simultaneousIntervalConfidence(audit.policy.confidence)
  const falseAcceptance = errorRate(
    eligible,
    'reject',
    audit.policy.maxFalseAcceptanceRate,
    intervalConfidence,
  )
  const falseRejection = errorRate(
    eligible,
    'accept',
    audit.policy.maxFalseRejectionRate,
    intervalConfidence,
  )
  const rates = [falseAcceptance, falseRejection]
  const verdict = rates.some((rate) => rate.verdict === 'fail')
    ? 'reject'
    : rates.every((rate) => rate.verdict === 'pass')
      ? 'admit'
      : 'inconclusive'
  const reasons: string[] = []
  for (const [name, rate] of [
    ['false acceptance', falseAcceptance],
    ['false rejection', falseRejection],
  ] as const) {
    if (rate.independentUnits === 0) reasons.push(`${name}: no eligible independent units`)
    else if (rate.unknownCases > 0)
      reasons.push(`${name}: ${rate.unknownCases} judgments are unknown`)
    if (rate.verdict === 'fail') reasons.push(`${name}: lower error bound exceeds ${rate.limit}`)
    else if (rate.verdict === 'inconclusive' && rate.interval)
      reasons.push(`${name}: upper error bound does not establish the required limit`)
  }
  if (verdict === 'admit')
    reasons.push(
      'both error bounds meet the registered limits, including the worst case for unknown judgments',
    )
  const body: Omit<EvaluatorAdmissionReport, 'reportDigest'> = {
    evaluatorDigest: audit.evaluatorDigest as LedgerHash,
    policyDigest: hashCanonical(audit.policy),
    inputDigest: hashCanonical(audit),
    population: audit.population,
    samplingFrame: audit.samplingFrame,
    authority: audit.authority,
    policy: audit.policy,
    confidence: audit.policy.confidence,
    intervalConfidence,
    verdict,
    reasons,
    observations: audit.observations,
    coverage: {
      cases: audit.observations.length,
      independentUnits: new Set(audit.observations.map((row) => row.independentUnitId)).size,
      eligibleCases: eligible.length,
      eligibleIndependentUnits: new Set(eligible.map((row) => row.independentUnitId)).size,
      excludedCases: exclusions.length,
      unknownCases: eligible.filter((row) => row.observed === 'unknown').length,
    },
    exclusions,
    falseAcceptance,
    falseRejection,
  }
  return { ...body, reportDigest: hashCanonical(body) }
}

const probabilityThresholdsSchema = z
  .object({
    rejectAtOrBelow: z.number().finite().min(0).max(1),
    acceptAtOrAbove: z.number().finite().min(0).max(1),
  })
  .strict()
  .refine((value) => value.rejectAtOrBelow < value.acceptAtOrAbove, {
    message: 'rejection and acceptance thresholds must not overlap',
  })
const probabilityObservationSchema = evaluatorAuditObservationSchema
  .omit({ observed: true })
  .extend({ acceptProbability: z.number().finite().min(0).max(1).nullable() })
  .strict()
const probabilityAuditSchema = inputSchema.extend({
  thresholds: probabilityThresholdsSchema,
  observations: z.array(probabilityObservationSchema),
})

/** A frozen caller-owned rule over P(accept), not the provider's entropy/confidence statistic. */
export type ProbabilityPolicyAuditInput = z.infer<typeof probabilityAuditSchema>

export interface ProbabilityPolicyAuditReport extends EvaluatorAdmissionReport {
  probabilityPolicy: {
    sourceEvaluatorDigest: LedgerHash
    thresholds: ProbabilityPolicyAuditInput['thresholds']
    /** Retain probabilities by observation id so the reported mapping can be reproduced. */
    observations: Array<{ id: string; acceptProbability: number | null }>
  }
}

/**
 * Audit a fixed probability-to-decision rule with the existing independent-unit error bounds.
 * No threshold search, model calls, promotion, or assumption of calibrated probabilities.
 * Null scores and the open interval between thresholds remain unknown, never correct by default.
 */
export function auditProbabilityPolicy(
  input: ProbabilityPolicyAuditInput,
): ProbabilityPolicyAuditReport {
  const parsed = probabilityAuditSchema.safeParse(input)
  if (!parsed.success) {
    throw new ValidationError(`invalid probability policy audit: ${parsed.error.message}`)
  }
  const { thresholds, observations, ...source } = parsed.data
  observations.sort((a, b) => compareCodeUnits(a.id, b.id))
  const probabilityPolicy = {
    sourceEvaluatorDigest: source.evaluatorDigest as LedgerHash,
    thresholds,
    observations: observations.map(({ id, acceptProbability }) => ({ id, acceptProbability })),
  }
  const audit = auditEvaluator({
    ...source,
    evaluatorDigest: hashCanonical({
      kind: 'probability-policy-v1',
      sourceEvaluatorDigest: source.evaluatorDigest,
      thresholds,
    }),
    observations: observations.map(({ acceptProbability, ...observation }) => ({
      ...observation,
      observed:
        acceptProbability === null
          ? 'unknown'
          : acceptProbability >= thresholds.acceptAtOrAbove
            ? 'accept'
            : acceptProbability <= thresholds.rejectAtOrBelow
              ? 'reject'
              : 'unknown',
    })),
  })
  const { reportDigest: _baseDigest, ...baseReport } = audit
  const body = {
    ...baseReport,
    // Bind the actual probabilities too, including changes that select the same action.
    inputDigest: hashCanonical(parsed.data),
    probabilityPolicy,
  }
  return { ...body, reportDigest: hashCanonical(body) }
}
