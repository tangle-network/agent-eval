import { describe, expect, it } from 'vitest'
import { hashCanonical } from '../src/ledger-core/canonical'
import {
  auditEvaluator,
  type EvaluatorAuditInput,
  type EvaluatorAuditObservation,
} from '../src/meta-eval/evaluator-admission'

function controls(n: number): EvaluatorAuditObservation[] {
  return Array.from({ length: n }, (_, i) =>
    (['accept', 'reject'] as const).map((expected) => ({
      id: `${expected}-${i}`,
      independentUnitId: `source-${i}`,
      evidenceRef: `fixture:${expected}-${i}`,
      expected,
      observed: expected,
      exposure: 'fresh' as const,
    })),
  ).flat()
}
function audit(observations = controls(100)): EvaluatorAuditInput {
  return {
    evaluatorDigest: hashCanonical('judge-v1'),
    population: 'support answers',
    samplingFrame: 'independent audited incidents',
    authority: {
      evaluatorAuthorId: 'author',
      auditorId: 'auditor',
      independenceEvidenceRef: 'audit:access-record',
    },
    policy: { confidence: 0.95, maxFalseAcceptanceRate: 0.05, maxFalseRejectionRate: 0.05 },
    observations,
  }
}

describe('evaluator admission from independent controls', () => {
  it('admits accurate judgments only when both error bounds satisfy policy', () => {
    const report = auditEvaluator(audit())
    expect(report.verdict).toBe('admit')
    expect(report.falseAcceptance).toMatchObject({
      cases: 100,
      independentUnits: 100,
      errorRate: 0,
      verdict: 'pass',
    })
    expect(report.falseRejection.interval!.upper).toBeGreaterThan(0.04)
    expect(report.falseRejection.interval!.upper).toBeLessThan(0.05)
    expect(report.confidence).toBe(0.95)
    expect(report.intervalConfidence).toBe(0.975)
    expect(report.coverage).toMatchObject({
      cases: 200,
      independentUnits: 100,
      excludedCases: 0,
      unknownCases: 0,
    })
  })

  it.each(['accept', 'reject'] as const)('rejects an always-%s evaluator', (observed) => {
    const report = auditEvaluator(audit(controls(100).map((row) => ({ ...row, observed }))))
    expect(report.verdict).toBe('reject')
    const failed = observed === 'accept' ? report.falseAcceptance : report.falseRejection
    expect(failed).toMatchObject({ errorRate: 1, verdict: 'fail' })
  })

  it('does not manufacture evidence from repeated variants or missing judgments', () => {
    const duplicated = controls(100).map((row) => ({ ...row, independentUnitId: 'one-source' }))
    const report = auditEvaluator(audit(duplicated))
    expect(report.verdict).toBe('inconclusive')
    expect(report.falseAcceptance.independentUnits).toBe(1)
    expect(report.falseAcceptance.interval!.upper).toBeGreaterThan(0.98)
    const unknown = auditEvaluator(
      audit(controls(100).map((row) => ({ ...row, observed: 'unknown' }))),
    )
    expect(unknown.verdict).toBe('inconclusive')
    expect(unknown.falseAcceptance).toMatchObject({
      errorRate: null,
      unresolvedUnits: 100,
      interval: { lower: 0, upper: 1 },
    })
    expect(unknown.coverage.unknownCases).toBe(200)
  })

  it('can admit incomplete judgments when their worst-case error bounds still meet policy', () => {
    const input = audit(controls(200))
    input.observations[1]!.observed = 'unknown'
    const report = auditEvaluator(input)
    expect(report.verdict).toBe('admit')
    expect(report.falseAcceptance).toMatchObject({
      errorRate: null,
      unresolvedUnits: 1,
      unknownCases: 1,
      verdict: 'pass',
    })
    expect(report.falseAcceptance.interval!.upper).toBeLessThan(0.05)
    expect(report.reasons.join(' ')).toContain('worst case')
    expect(report.reasons.join(' ')).not.toContain('does not establish')
  })

  it('excludes every variant of a development source and retains the exclusion', () => {
    const input = audit()
    input.observations[0]!.exposure = 'development'
    const report = auditEvaluator(input)
    expect(report.exclusions).toHaveLength(2)
    expect(report.coverage).toMatchObject({
      cases: 200,
      eligibleCases: 198,
      eligibleIndependentUnits: 99,
      excludedCases: 2,
    })
    expect(auditEvaluator(audit([])).falseAcceptance.errorRate).toBeNull()
    expect(auditEvaluator(audit([])).falseAcceptance.interval).toBeNull()
  })

  it('counts a source mistake even when other variants pass', () => {
    const input = audit(controls(10))
    input.observations.push({ ...input.observations[0]!, id: 'bad-variant', observed: 'reject' })
    expect(auditEvaluator(input).falseRejection).toMatchObject({
      cases: 11,
      independentUnits: 10,
      errorUnits: 1,
      errorRate: 0.1,
    })
  })

  it('binds inputs and policy without retaining caller-owned references', () => {
    const input = audit()
    const report = auditEvaluator(input)
    expect(
      auditEvaluator({ ...input, observations: [...input.observations].reverse() }).reportDigest,
    ).toBe(report.reportDigest)
    input.policy.maxFalseAcceptanceRate = 0.1
    input.observations[0]!.observed = 'unknown'
    expect(report.policy.maxFalseAcceptanceRate).toBe(0.05)
    expect(report.coverage.unknownCases).toBe(0)
    expect(auditEvaluator(input).inputDigest).not.toBe(report.inputDigest)
    const { reportDigest, ...body } = report
    expect(hashCanonical(body)).toBe(reportDigest)
  })

  it('rejects duplicate observations and undeclared audit separation', () => {
    const input = audit()
    input.observations.push(input.observations[0]!)
    expect(() => auditEvaluator(input)).toThrow(/duplicate/)
    const sameAuthority = audit()
    sameAuthority.authority.auditorId = sameAuthority.authority.evaluatorAuthorId
    expect(() => auditEvaluator(sameAuthority)).toThrow(/separate declared audit authority/)
  })
})
