import { z } from 'zod'
import { ValidationError } from '../errors'
import { type ComputedInterval, computeInterval } from '../experiment/ast'
import { compareCodeUnits, hashCanonical, type LedgerHash } from '../ledger-core/canonical'

const identity = z
  .string()
  .min(1)
  .refine((value) => value.trim() === value)
const policySchema = z
  .object({
    confidence: z.number().finite().gt(0).lt(1),
    maxFalseAcceptanceRate: z.number().finite().min(0).lt(1),
    maxFalseRejectionRate: z.number().finite().min(0).lt(1),
  })
  .strict()

/** Register both error limits before inspecting audit judgments. */
export type EvaluatorAdmissionPolicy = z.infer<typeof policySchema>

const observationSchema = z
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
export type EvaluatorAuditObservation = z.infer<typeof observationSchema>

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
    policy: policySchema,
    observations: z.array(observationSchema),
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
  const ids = new Set<string>()
  for (const row of audit.observations) {
    if (ids.has(row.id))
      throw new ValidationError(`duplicate evaluator audit observation '${row.id}'`)
    ids.add(row.id)
  }
  audit.observations.sort((a, b) => compareCodeUnits(a.id, b.id))
  const developmentUnits = new Set(
    audit.observations
      .filter((row) => row.exposure === 'development')
      .map((row) => row.independentUnitId),
  )
  const eligible = audit.observations.filter((row) => !developmentUnits.has(row.independentUnitId))
  const exclusions = audit.observations
    .filter((row) => developmentUnits.has(row.independentUnitId))
    .map((row) => ({
      id: row.id,
      independentUnitId: row.independentUnitId,
      reason: 'development-exposure' as const,
    }))
  const intervalConfidence = 1 - (1 - audit.policy.confidence) / 2
  if (intervalConfidence >= 1)
    throw new ValidationError(
      'evaluator audit confidence is too close to one for simultaneous intervals',
    )
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
