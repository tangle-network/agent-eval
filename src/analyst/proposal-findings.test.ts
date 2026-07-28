import { describe, expect, it } from 'vitest'
import { assertProposalFindings, isProposalFinding } from './proposal-findings'
import { makeFinding, makeProposalFinding } from './types'

function finding(id: string) {
  return makeFinding({
    analyst_id: 'test-analysis',
    produced_at: '2026-07-28T00:00:00.000Z',
    severity: 'high',
    area: 'quality',
    claim: id,
    evidence_refs: [],
    confidence: 1,
  })
}

describe('proposal findings', () => {
  it.each(['search', 'production'] as const)('admits %s findings unchanged', (origin) => {
    const allowed = makeProposalFinding({
      analyst_id: 'test-analysis',
      produced_at: '2026-07-28T00:00:00.000Z',
      severity: 'high',
      area: 'quality',
      claim: `${origin} finding`,
      evidence_refs: [],
      confidence: 1,
      proposal_origin: origin,
    })

    expect(isProposalFinding(allowed)).toBe(true)
    expect(assertProposalFindings([allowed])).toEqual([allowed])
    expect(allowed.proposal_origin).toBe(origin)
  })

  it('rejects a finding with no allowed origin', () => {
    const unclassified = finding('unclassified')

    expect(isProposalFinding(unclassified)).toBe(false)
    expect(() => assertProposalFindings([unclassified])).toThrow(
      new RegExp(`proposal_origin.*${unclassified.finding_id}`),
    )
  })

  it('does not treat judge origin as final-case origin', () => {
    const searchFeedback = makeProposalFinding({
      analyst_id: 'search-judge',
      produced_at: '2026-07-28T00:00:00.000Z',
      severity: 'high',
      area: 'quality',
      claim: 'search feedback',
      evidence_refs: [],
      confidence: 1,
      derived_from_judge: true,
      proposal_origin: 'search',
    })

    expect(assertProposalFindings([searchFeedback])).toEqual([searchFeedback])
  })

  it('rejects malformed JavaScript input with a useful location', () => {
    expect(isProposalFinding(null)).toBe(false)
    expect(() => assertProposalFindings(null)).toThrow(/expected an array/)
    expect(() => assertProposalFindings([null])).toThrow(/Rejected findings: \[index 0\]/)
    expect(() => assertProposalFindings([{ proposal_origin: 'search' }])).toThrow(
      /Rejected findings: \[index 0\]/,
    )
  })
})
