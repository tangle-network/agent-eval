import { describe, expect, it } from 'vitest'
import {
  auditEvaluator,
  evaluatorAdmissionPolicySchema,
  evaluatorAuditObservationSchema,
  planEvaluatorAudit,
} from '../../src/meta-eval'

const policy = { confidence: 0.95, maxFalseAcceptanceRate: 0.1, maxFalseRejectionRate: 0.1 }
const controls = (count: number) =>
  Array.from({ length: count }, (_, i) => ({
    id: `case-${i}`,
    independentUnitId: `unit-${i}`,
    expected: i % 2 ? ('accept' as const) : ('reject' as const),
    exposure: 'fresh' as const,
  }))
describe('audit planning uses the admission rule without creating judgments', () => {
  it('reports required controls before a corpus exists', () => {
    const result = planEvaluatorAudit({ policy })
    expect(result.sufficient).toBe(false)
    for (const rate of [result.falseAcceptance, result.falseRejection]) {
      expect(rate.minimumIndependentUnits).toBe(42)
      expect(rate.additionalIndependentUnits).toBe(42)
      expect(rate.bestPossibleUpperBound).toBeNull()
    }
    expect(result).not.toHaveProperty('reportDigest')
    expect(result).not.toHaveProperty('verdict')
  })
  it('identifies why the 78-case pilot could not establish admission', () => {
    const result = planEvaluatorAudit({ policy, controls: controls(78) })
    expect(result.sufficient).toBe(false)
    expect(result.falseAcceptance.additionalIndependentUnits).toBe(3)
    expect(result.falseRejection.additionalIndependentUnits).toBe(3)
  })
  it('agrees with zero-error audit decisions at the boundary', () => {
    for (const count of [0, 2, 78, 82, 84, 86, 100]) {
      const roster = controls(count)
      const plan = planEvaluatorAudit({ policy, controls: roster })
      const actual = auditEvaluator({
        evaluatorDigest: `sha256:${'1'.repeat(64)}`,
        population: 'fixture',
        samplingFrame: 'fixed',
        authority: {
          evaluatorAuthorId: 'author',
          auditorId: 'audit',
          independenceEvidenceRef: 'fixture:separate',
        },
        policy,
        observations: roster.map((row) => ({
          ...row,
          evidenceRef: `fixture:${row.id}`,
          observed: row.expected,
        })),
      })
      expect(plan.sufficient).toBe(actual.verdict === 'admit')
      expect(plan.falseAcceptance.bestPossibleUpperBound).toBe(
        actual.falseAcceptance.interval?.upper ?? null,
      )
      expect(plan.falseRejection.bestPossibleUpperBound).toBe(
        actual.falseRejection.interval?.upper ?? null,
      )
    }
  })
  it('excludes development source units and does not count repeated variants', () => {
    const roster = controls(84)
    const plan = planEvaluatorAudit({
      policy,
      controls: [
        ...roster,
        { ...roster[0]!, id: 'variant' },
        { ...roster[0]!, id: 'exposed', exposure: 'development' },
      ],
    })
    expect(plan.falseAcceptance.independentUnits).toBe(41)
    expect(plan.falseRejection.independentUnits).toBe(42)
    expect(plan.sufficient).toBe(false)
  })
  it('cannot establish zero error probability from a finite control set', () => {
    const result = planEvaluatorAudit({
      policy: { ...policy, maxFalseAcceptanceRate: 0 },
      controls: controls(100),
    })
    expect(result.falseAcceptance.minimumIndependentUnits).toBeNull()
    expect(result.falseAcceptance.additionalIndependentUnits).toBeNull()
    expect(result.sufficient).toBe(false)
  })
  it('shares strict schemas and rejects duplicated identities or invented observations', () => {
    expect(evaluatorAdmissionPolicySchema.safeParse({ ...policy, anything: true }).success).toBe(
      false,
    )
    expect(evaluatorAuditObservationSchema.shape.observed.parse('unknown')).toBe('unknown')
    const [row] = controls(1)
    expect(() => planEvaluatorAudit({ policy, controls: [row!, row!] })).toThrow('duplicate')
    expect(() =>
      planEvaluatorAudit({ policy, controls: [{ ...row!, observed: 'accept' } as never] }),
    ).toThrow()
  })
})
