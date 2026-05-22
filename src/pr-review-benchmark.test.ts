import { describe, expect, it } from 'vitest'
import {
  type PrReviewAuditCase,
  scorePrReviewComments,
  scorePrReviewSource,
  summarizePrReviewBenchmark,
} from './pr-review-benchmark'

const AUDIT_CASE: PrReviewAuditCase = {
  id: 'agent-dev-container-123',
  repo: 'tangle-network/agent-dev-container',
  prNumber: 123,
  comments: [
    {
      id: 'donovan-1',
      source: 'donovan',
      path: 'src/auth/session.ts',
      line: 42,
      severity: 'high',
      outcome: 'fixed',
      body: 'Fix this session owner check: empty owner ids currently pass and allow cross-team access.',
    },
    {
      id: 'donovan-2',
      source: 'donovan',
      path: 'src/auth/session.ts',
      line: 80,
      severity: 'low',
      outcome: 'noise',
      body: 'Maybe rename this local variable.',
    },
    {
      id: 'opus-1',
      source: 'claude-opus-4.7-high',
      path: 'src/auth/session.ts',
      line: 41,
      severity: 'critical',
      outcome: 'accepted',
      body: 'Add a fail-closed guard for blank ownerId before authorizeSession returns success.',
    },
    {
      id: 'kimi-1',
      source: 'kimi',
      body: 'Looks fine overall.',
    },
  ],
  referenceFindings: [
    {
      id: 'blank-owner-bypass',
      title: 'blank owner bypasses session authorization',
      severity: 'high',
      path: 'src/auth/session.ts',
      line: 42,
      keywords: ['ownerId', 'authorizeSession', 'fail-closed', 'cross-team'],
      sourceCommentIds: ['donovan-1', 'opus-1'],
    },
  ],
}

describe('PR review benchmark', () => {
  it('scores a source against accepted/fixed reference findings', () => {
    const score = scorePrReviewSource(AUDIT_CASE, 'claude-opus-4.7-high')

    expect(score.referenceCount).toBe(1)
    expect(score.commentCount).toBe(1)
    expect(score.matchedFindings).toEqual([
      expect.objectContaining({
        referenceId: 'blank-owner-bypass',
        commentId: 'opus-1',
      }),
    ])
    expect(score.recall).toBe(1)
    expect(score.precision).toBe(1)
    expect(score.actionability).toBe(1)
    expect(score.severityCalibration).toBe(1)
    expect(score.lowNoise).toBe(1)
    expect(score.aggregate).toBe(1)
  })

  it('penalizes noise and unactionable comments while preserving recall credit', () => {
    const score = scorePrReviewSource(AUDIT_CASE, 'donovan')

    expect(score.recall).toBe(1)
    expect(score.precision).toBe(0.5)
    expect(score.actionability).toBe(0.5)
    expect(score.lowNoise).toBe(0.5)
    expect(score.aggregate).toBeGreaterThan(0.6)
    expect(score.aggregate).toBeLessThan(1)
    expect(score.notes).toContain('1 comment(s) labelled rejected/duplicate/noise')
  })

  it('scores unmatched comments as low precision when no human labels exist', () => {
    const score = scorePrReviewSource(AUDIT_CASE, 'kimi')

    expect(score.recall).toBe(0)
    expect(score.precision).toBe(0)
    expect(score.actionability).toBe(0)
    expect(score.notes).toContain('no reference findings matched')
    expect(score.notes).toContain('comments were not actionable enough for a PR reviewer benchmark')
  })

  it('can score synthetic candidate comments without mutating the audit case', () => {
    const score = scorePrReviewComments(
      AUDIT_CASE,
      [
        {
          id: 'candidate-1',
          source: 'gpt-5.5-high',
          path: 'src/auth/session.ts',
          line: 43,
          severity: 'medium',
          body: 'Change authorizeSession to reject blank ownerId so cross-team access fails closed.',
        },
      ],
      'gpt-5.5-high',
    )

    expect(score.matchedFindings).toHaveLength(1)
    expect(score.recall).toBe(1)
    expect(score.precision).toBe(1)
    expect(score.severityCalibration).toBe(1)
  })

  it('summarizes benchmark scores by source', () => {
    const summary = summarizePrReviewBenchmark([
      scorePrReviewSource(AUDIT_CASE, 'donovan'),
      scorePrReviewSource(AUDIT_CASE, 'claude-opus-4.7-high'),
      scorePrReviewSource(AUDIT_CASE, 'kimi'),
    ])

    expect(summary.map((row) => row.source)).toEqual(['claude-opus-4.7-high', 'donovan', 'kimi'])
    expect(summary[0]).toMatchObject({
      source: 'claude-opus-4.7-high',
      caseCount: 1,
      commentCount: 1,
      aggregateMean: 1,
    })
  })
})
