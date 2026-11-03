/**
 * The tier ladder: a pure function of stored deterministic checks, stored SystemOne
 * assessments and build gates. Gates, not a weighted blend: strong copy cannot
 * buy back a failed journey, and an unresolved check never counts as a pass.
 *
 *   F  not served, or a floor check of the primary journey failed
 *   U  unable to measure: no floor check failed, but one could not be observed
 *      (the payment sits behind a passkey sign-in the grader cannot approve)
 *   C  the floor passed, but a core SystemOne check is refuted or a journey check failed
 *   B  every journey check passed and no SystemOne check is refuted
 *   A  B, plus every core, senior and engineering check supported and the build gates pass
 *   S  A, plus complete coverage, zero unresolved, and nothing left unmeasured
 *   INVALID  a failed integrity check or a supported integrity question; the cell goes to human review
 *
 * F, U and C follow from deterministic checks alone, so `decidedWithoutReviews`
 * lets the grader skip model calls that could not change the tier.
 */

export type Tier = 'F' | 'U' | 'C' | 'B' | 'A' | 'S'
/** Ranked tiers. U is not on the ladder: nothing was learned about the payment. */
export const TIER_ORDER: readonly Tier[] = ['F', 'C', 'B', 'A', 'S']

/** How a SystemOne check can move the tier. */
export type TierRole = 'core' | 'senior' | 'engineering' | 'integrity'

/**
 * The fields of agent-eval's `SystemOneReviewAssessment` the ladder reads. Declared here so the
 * ladder has no package dependency: the repository's admission gate re-derives stored
 * verdicts with it.
 */
export interface VerdictAssessment {
  question: string
  status: 'supported' | 'refuted' | 'unresolved'
  reason: string
  supportProbability: number
  refutationProbability: number
}

export interface VerdictCheck {
  id: string
  status: 'pass' | 'fail' | 'not-applicable' | 'unmeasured'
  gate: 'floor' | 'journey' | 'engineering' | 'integrity'
  detail: string
}

export interface VerdictReview {
  id: string
  tierRole: Record<string, TierRole>
  assessments: VerdictAssessment[]
}

export interface EngineeringGates {
  install: boolean
  typecheck: boolean
  build: boolean
  tests: 'pass' | 'fail' | 'absent'
}

export interface Verdict {
  tier: Tier
  invalid: boolean
  reasons: string[]
  jev: Record<
    string,
    {
      status: VerdictAssessment['status']
      role: TierRole
      reason: string
      support: number
      refute: number
    }
  >
  unmeasured: string[]
}

/** The tier when deterministic checks settle it, before any model call; null when a review could still move it. */
export function decidedWithoutReviews(input: {
  served: boolean
  checks: VerdictCheck[]
}): 'F' | 'U' | 'C' | null {
  if (!input.served) return 'F'
  const floor = input.checks.filter((check) => check.gate === 'floor')
  if (floor.some((check) => check.status === 'fail')) return 'F'
  if (floor.some((check) => check.status === 'unmeasured')) return 'U'
  if (input.checks.some((check) => check.gate === 'journey' && check.status === 'fail')) return 'C'
  return null
}

export function deriveVerdict(input: {
  served: boolean
  checks: VerdictCheck[]
  reviews: VerdictReview[]
  engineering: EngineeringGates
  unmeasured: string[]
}): Verdict {
  const jev: Verdict['jev'] = {}
  for (const review of input.reviews) {
    for (const assessment of review.assessments) {
      jev[`${review.id}.${assessment.question}`] = {
        status: assessment.status,
        role: review.tierRole[assessment.question]!,
        reason: assessment.reason,
        support: Number(assessment.supportProbability.toFixed(4)),
        refute: Number(assessment.refutationProbability.toFixed(4)),
      }
    }
  }
  const entries = Object.entries(jev)
  const withRole = (role: TierRole) => entries.filter(([, value]) => value.role === role)
  const integrityFailures = input.checks.filter(
    (check) => check.gate === 'integrity' && check.status === 'fail',
  )
  const integritySupported = withRole('integrity').filter(
    ([, value]) => value.status === 'supported',
  )
  const invalid = integrityFailures.length > 0 || integritySupported.length > 0
  const reasons: string[] = []
  const done = (tier: Tier): Verdict => ({
    tier,
    invalid,
    reasons,
    jev,
    unmeasured: input.unmeasured,
  })
  reasons.push(
    ...integrityFailures.map((check) => `integrity check failed: ${check.id} (${check.detail})`),
  )
  reasons.push(...integritySupported.map(([key]) => `integrity question supported: ${key}`))
  if (invalid) reasons.push('human review required')

  const decided = decidedWithoutReviews(input)
  if (decided === 'F' || decided === 'U') {
    if (!input.served) reasons.push('the production build was not served')
    const floor = input.checks.filter(
      (check) =>
        check.gate === 'floor' && check.status === (decided === 'F' ? 'fail' : 'unmeasured'),
    )
    reasons.push(
      ...floor.map(
        (check) =>
          `floor ${decided === 'F' ? 'failed' : 'unmeasured'}: ${check.id} (${check.detail})`,
      ),
    )
    return done(decided)
  }
  const coreRefuted = withRole('core').filter(([, value]) => value.status === 'refuted')
  const journeyFailures = input.checks.filter(
    (check) => check.gate === 'journey' && check.status === 'fail',
  )
  if (coreRefuted.length > 0 || journeyFailures.length > 0) {
    reasons.push(...coreRefuted.map(([key]) => `core SystemOne check refuted: ${key}`))
    reasons.push(
      ...journeyFailures.map((check) => `journey check failed: ${check.id} (${check.detail})`),
    )
    return done('C')
  }
  const refuted = entries.filter(
    ([, value]) => value.status === 'refuted' && value.role !== 'integrity',
  )
  if (refuted.length > 0) {
    reasons.push(...refuted.map(([key]) => `SystemOne check refuted: ${key}`))
    return done('C')
  }
  const notSupported = entries.filter(
    ([, value]) => value.role !== 'integrity' && value.status !== 'supported',
  )
  const gatesPass =
    input.engineering.install &&
    input.engineering.typecheck &&
    input.engineering.build &&
    input.engineering.tests === 'pass'
  if (notSupported.length > 0 || !gatesPass) {
    reasons.push(
      ...notSupported.map(
        ([key, value]) => `not supported (${value.status}, ${value.reason}): ${key}`,
      ),
    )
    if (!gatesPass) reasons.push(`engineering gates: ${JSON.stringify(input.engineering)}`)
    return done('B')
  }
  const notApplicable = input.checks.filter((check) => check.status === 'not-applicable')
  if (input.unmeasured.length > 0 || notApplicable.length > 0) {
    reasons.push(...input.unmeasured.map((item) => `unmeasured: ${item}`))
    reasons.push(...notApplicable.map((check) => `not exercised: ${check.id}`))
    return done('A')
  }
  return done('S')
}
