import { describe, expect, it } from 'vitest'
import { scoreAnalystFindings } from './benchmark'
import { badCase, corrected, failed, finding, root } from './benchmark-test-fixtures'
import { makeFinding } from './types'

describe('scoreAnalystFindings', () => {
  it('scores issue recall, finding precision, first-bad-step location, and citations separately', () => {
    const result = scoreAnalystFindings(badCase, [
      finding({ subject: 'failure-mode:tool-failure', evidence: [failed] }),
      finding({
        subject: 'failure-mode:unsupported-claim',
        evidence: [corrected],
      }),
      finding({ subject: 'failure-mode:invented', evidence: ['trace://run/span/missing'] }),
    ])
    expect(result.matchedIssueIds).toEqual(['tool-failure', 'unsupported-claim'])
    expect(result.issueRecall).toBe(1)
    expect(result.findingPrecision).toBeCloseTo(2 / 3)
    expect(result.f1).toBeCloseTo(0.8)
    expect(result.criticalStepAccuracy).toBe(1)
    expect(result.citationCoverage).toBe(1)
    expect(result.citationExcerptCoverage).toBe(0)
    expect(result.citationLabelAgreement).toBeCloseTo(2 / 3)
    expect(result.unlabeledEvidence).toHaveLength(1)
  })

  it('does not match negated or coincidental claim text', () => {
    const result = scoreAnalystFindings(badCase, [
      finding({ subject: 'failure-mode:not-a-timeout', evidence: [root] }),
    ])
    expect(result.matchedIssueIds).toEqual([])
    expect(result.issueRecall).toBe(0)
    expect(result.findingPrecision).toBe(0)
  })

  it('separates missing citations from invalid citations', () => {
    const uncited = makeFinding({
      analyst_id: 'test',
      area: 'failure-mode',
      subject: 'failure-mode:tool-failure',
      claim: 'The tool failed',
      severity: 'high',
      confidence: 1,
      evidence_refs: [],
    })
    const result = scoreAnalystFindings(badCase, [uncited])
    expect(result.citationCoverage).toBe(0)
    expect(result.citationLabelAgreement).toBe(0)
    expect(result.issueRecall).toBe(0)
  })

  it('matches findings and expected issues one-to-one', () => {
    const duplicate = finding({
      subject: 'failure-mode:tool-failure',
      evidence: [failed],
      idBasis: 'duplicate',
    })
    const result = scoreAnalystFindings(
      {
        id: 'one-to-one',
        expectedIssues: [
          { id: 'first', evidence: [{ kind: 'span', uri: failed }] },
          { id: 'second', evidence: [{ kind: 'span', uri: failed }] },
        ],
      },
      [finding({ subject: 'failure-mode:tool-failure', evidence: [failed] }), duplicate],
    )

    expect(result.matchedIssueIds).toEqual(['first', 'second'])
    expect(result.supportedFindingIndexes).toHaveLength(2)

    const oneFinding = scoreAnalystFindings(
      {
        id: 'one-prediction',
        expectedIssues: [
          { id: 'first', evidence: [{ kind: 'span', uri: failed }] },
          { id: 'second', evidence: [{ kind: 'span', uri: failed }] },
        ],
      },
      [finding({ subject: 'failure-mode:tool-failure', evidence: [failed] })],
    )
    expect(oneFinding.issueRecall).toBe(0.5)
    expect(oneFinding.supportedFindingIndexes).toEqual([0])
  })

  it('counts duplicate predictions as unsupported', () => {
    const result = scoreAnalystFindings(badCase, [
      finding({ subject: 'failure-mode:tool-failure', evidence: [failed] }),
      finding({
        subject: 'failure-mode:tool-failure',
        evidence: [failed],
        idBasis: 'duplicate',
      }),
    ])

    expect(result.issueRecall).toBe(0.5)
    expect(result.findingPrecision).toBe(0.5)
    expect(result.unsupportedFindingIndexes).toHaveLength(1)
  })

  it('uses the maximum-cardinality assignment that best localizes critical steps', () => {
    const wrongStep = finding({
      subject: 'failure-mode:tool-failure',
      evidence: [root],
      idBasis: 'wrong-step',
    })
    const criticalStep = finding({
      subject: 'failure-mode:tool-failure',
      evidence: [failed],
      idBasis: 'critical-step',
    })
    const result = scoreAnalystFindings(
      {
        id: 'critical-assignment',
        expectedIssues: [
          {
            id: 'tool-failure',
            subjects: ['failure-mode:tool-failure'],
            criticalEvidence: [{ kind: 'span', uri: failed }],
          },
        ],
        labeledEvidence: [
          { kind: 'span', uri: root },
          { kind: 'span', uri: failed },
        ],
      },
      [wrongStep, criticalStep],
    )

    expect(result.issueRecall).toBe(1)
    expect(result.criticalStepAccuracy).toBe(1)
    expect(result.supportedFindingIndexes).toEqual([1])
    expect(result.unsupportedFindingIndexes).toEqual([0])
  })

  it('scores critical-step location independently from issue identity', () => {
    const result = scoreAnalystFindings(
      {
        id: 'independent-critical-step',
        expectedIssues: [
          {
            id: 'wrong-category',
            areas: ['performance'],
            criticalEvidence: [{ kind: 'span', uri: failed }],
          },
        ],
      },
      [finding({ subject: 'failure-mode:tool-failure', evidence: [failed] })],
    )

    expect(result.issueRecall).toBe(0)
    expect(result.findingPrecision).toBe(0)
    expect(result.f1).toBe(0)
    expect(result.criticalStepAccuracy).toBe(1)
  })

  it('allows category-only labels and rejects labels with no matching field', () => {
    expect(
      scoreAnalystFindings(
        { id: 'category-label', expectedIssues: [{ id: 'failure', areas: ['failure-mode'] }] },
        [finding({ subject: 'failure-mode:tool-failure', evidence: [failed] })],
      ).issueRecall,
    ).toBe(1)
    expect(() =>
      scoreAnalystFindings({ id: 'bad-label', expectedIssues: [{ id: 'vague' }] }, []),
    ).toThrow(/must identify a finding/)
  })
})
