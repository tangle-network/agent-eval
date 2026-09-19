import { describe, expect, it } from 'vitest'
import { hashCanonical } from '../src/ledger-core/canonical'
import {
  auditEvaluator,
  auditProbabilityPolicy,
  type ProbabilityPolicyAuditInput,
} from '../src/meta-eval/index'

function input(): ProbabilityPolicyAuditInput {
  return {
    evaluatorDigest: hashCanonical({ classifier: 'fixture-v1' }),
    population: 'frozen product tasks',
    samplingFrame: 'heldout-v1',
    authority: {
      evaluatorAuthorId: 'builder',
      auditorId: 'reviewer',
      independenceEvidenceRef: 'artifact:independent-review',
    },
    policy: { confidence: 0.95, maxFalseAcceptanceRate: 0.1, maxFalseRejectionRate: 0.1 },
    thresholds: { rejectAtOrBelow: 0.25, acceptAtOrAbove: 0.75 },
    observations: [
      {
        id: 'reject',
        independentUnitId: 'r',
        evidenceRef: 'artifact:r',
        expected: 'reject',
        exposure: 'fresh',
        acceptProbability: 0.25,
      },
      {
        id: 'accept',
        independentUnitId: 'a',
        evidenceRef: 'artifact:a',
        expected: 'accept',
        exposure: 'fresh',
        acceptProbability: 0.75,
      },
      {
        id: 'middle',
        independentUnitId: 'm',
        evidenceRef: 'artifact:m',
        expected: 'accept',
        exposure: 'fresh',
        acceptProbability: 0.5,
      },
      {
        id: 'missing',
        independentUnitId: 'n',
        evidenceRef: 'artifact:n',
        expected: 'reject',
        exposure: 'fresh',
        acceptProbability: null,
      },
    ],
  }
}

describe('frozen probability policy audit', () => {
  it('maps threshold boundaries and preserves unknown decisions using the existing audit', () => {
    const source = input()
    const report = auditProbabilityPolicy(source)
    expect(report.observations.map(({ id, observed }) => [id, observed])).toEqual([
      ['accept', 'accept'],
      ['middle', 'unknown'],
      ['missing', 'unknown'],
      ['reject', 'reject'],
    ])
    const existing = auditEvaluator({
      evaluatorDigest: report.evaluatorDigest,
      population: source.population,
      samplingFrame: source.samplingFrame,
      authority: source.authority,
      policy: source.policy,
      observations: report.observations,
    })
    expect(report.falseAcceptance).toEqual(existing.falseAcceptance)
    expect(report.falseRejection).toEqual(existing.falseRejection)
    expect(report.verdict).toBe(existing.verdict)
    expect(report.verdict).toBe('inconclusive')
    expect(report.falseAcceptance.errorRate).toBeNull()
    expect(report.falseAcceptance.unknownCases).toBe(1)
    expect(report.coverage.unknownCases).toBe(2)
    expect(report.probabilityPolicy.sourceEvaluatorDigest).toBe(source.evaluatorDigest)
  })

  it('retains evidence and exact probabilities for independently reproducing the mapping', () => {
    const source = input()
    const original = JSON.stringify(source)
    const report = auditProbabilityPolicy(source)
    expect(
      report.probabilityPolicy.observations.find((row) => row.id === 'missing')?.acceptProbability,
    ).toBeNull()
    expect(report.observations.find((row) => row.id === 'reject')?.evidenceRef).toBe('artifact:r')
    const { reportDigest, ...body } = report
    expect(reportDigest).toBe(hashCanonical(body))
    expect(JSON.stringify(source)).toBe(original)
    expect(auditProbabilityPolicy(JSON.parse(JSON.stringify(source)))).toEqual(report)
  })

  it('versions mapping changes and binds raw probabilities even when classifications stay the same', () => {
    const source = input()
    const first = auditProbabilityPolicy(source)
    source.thresholds.acceptAtOrAbove = 0.7
    const second = auditProbabilityPolicy(source)
    expect(second.evaluatorDigest).not.toBe(first.evaluatorDigest)
    expect(second.inputDigest).not.toBe(first.inputDigest)
    expect(second.observations).toEqual(first.observations)
    source.observations[1]!.acceptProbability = 0.9
    const third = auditProbabilityPolicy(source)
    expect(third.evaluatorDigest).toBe(second.evaluatorDigest)
    expect(third.inputDigest).not.toBe(second.inputDigest)
    expect(third.reportDigest).not.toBe(second.reportDigest)
    expect(third.observations).toEqual(second.observations)
  })

  it('is order-independent and does not let fresh siblings hide development exposure', () => {
    const source = input()
    source.observations.push({ ...source.observations[1]!, id: 'dev', exposure: 'development' })
    const report = auditProbabilityPolicy(source)
    expect(report.exclusions.map((row) => row.id)).toEqual(['accept', 'dev'])
    source.observations.reverse()
    expect(auditProbabilityPolicy(source)).toEqual(report)
  })

  it('does not admit empty or entirely missing observations', () => {
    const source = input()
    source.observations = []
    expect(auditProbabilityPolicy(source).verdict).toBe('inconclusive')
    source.observations = input().observations.map((row) => ({ ...row, acceptProbability: null }))
    const report = auditProbabilityPolicy(source)
    expect(report.verdict).toBe('inconclusive')
    expect(report.falseAcceptance.interval?.upper).toBe(1)
    expect(report.falseRejection.interval?.upper).toBe(1)
  })

  it('retains the independent-unit denominator instead of treating repeated variants as new proof', () => {
    const source = input()
    source.observations = Array.from({ length: 50 }, (_, i) => ({
      ...source.observations[0]!,
      id: `variant-${i}`,
      acceptProbability: 0.1,
    }))
    const report = auditProbabilityPolicy(source)
    expect(report.falseAcceptance.cases).toBe(50)
    expect(report.falseAcceptance.independentUnits).toBe(1)
    expect(report.verdict).toBe('inconclusive')
  })

  it('can admit enough correct independent controls and reject a confidently wrong rule', () => {
    const source = input()
    const reject = source.observations[0]!
    const accept = source.observations[1]!
    source.observations = Array.from({ length: 200 }, (_, i) => ({
      ...(i % 2 ? accept : reject),
      id: `case-${i}`,
      independentUnitId: `source-${i}`,
    }))
    expect(auditProbabilityPolicy(source).verdict).toBe('admit')
    source.observations = source.observations.map((row) => ({ ...row, acceptProbability: 0.99 }))
    expect(auditProbabilityPolicy(source).verdict).toBe('reject')
  })

  it.each([-0.01, 1.01, Number.NaN, Infinity, undefined, '0.5'])(
    'rejects an invalid probability %s',
    (value) => {
      const source = input()
      Reflect.set(source.observations[0]!, 'acceptProbability', value)
      expect(() => auditProbabilityPolicy(source)).toThrow(/invalid probability policy audit/)
    },
  )

  it.each([
    { rejectAtOrBelow: 0.8, acceptAtOrAbove: 0.7 },
    { rejectAtOrBelow: 0.5, acceptAtOrAbove: 0.5 },
    { rejectAtOrBelow: -1, acceptAtOrAbove: 1 },
    { rejectAtOrBelow: 0, acceptAtOrAbove: Infinity },
  ])('refuses overlapping or invalid thresholds', (thresholds) => {
    expect(() => auditProbabilityPolicy({ ...input(), thresholds })).toThrow()
  })

  it('inherits duplicate-id and audit-authority refusal without relaxing those guards', () => {
    const source = input()
    source.observations.push({ ...source.observations[0]! })
    expect(() => auditProbabilityPolicy(source)).toThrow(/duplicate/)
    source.observations.pop()
    source.authority.auditorId = source.authority.evaluatorAuthorId
    expect(() => auditProbabilityPolicy(source)).toThrow(/separate/)
  })

  it('requires explicit probabilities and refuses a prefilled observed decision', () => {
    const source = input()
    Reflect.set(source.observations[0]!, 'observed', 'accept')
    expect(() => auditProbabilityPolicy(source)).toThrow()
  })
})
