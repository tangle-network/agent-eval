import { describe, expect, it } from 'vitest'
import {
  BELIEF_DECISION_KINDS,
  BELIEF_EVALUATION_CRITERIA,
  BELIEF_EVIDENCE_QUALITIES,
  BELIEF_EVIDENCE_SOURCES,
  isBeliefDecisionKind,
  isBeliefEvidenceSource,
} from './types'

describe('belief-state taxonomy', () => {
  it('keeps decision kinds focused on decision boundaries, not whole-agent state', () => {
    expect(BELIEF_DECISION_KINDS).toEqual([
      'continue',
      'verify',
      'ask',
      'retry',
      'stop',
      'memory-write',
      'memory-read',
      'tool-select',
      'skill-select',
      'workflow-select',
      'surface-promote',
    ])
    expect(isBeliefDecisionKind('verify')).toBe(true)
    expect(isBeliefDecisionKind('chain-of-thought')).toBe(false)
  })

  it('keeps evidence sources narrow while allowing quality to vary', () => {
    expect(BELIEF_EVIDENCE_SOURCES).toEqual([
      'run',
      'span',
      'event',
      'finding',
      'memory',
      'knowledge',
      'policy',
    ])
    expect(BELIEF_EVIDENCE_QUALITIES).toEqual([
      'direct',
      'derived',
      'self-reported',
      'unverified',
      'stale',
      'contradicted',
    ])
    expect(isBeliefEvidenceSource('memory')).toBe(true)
    expect(isBeliefEvidenceSource('tool_result')).toBe(false)
  })

  it('names the long-term evaluation criteria and reason codes without duplicates', () => {
    expect(BELIEF_EVALUATION_CRITERIA.map((criterion) => criterion.id)).toEqual([
      'capture-integrity',
      'decision-completeness',
      'evidence-quality',
      'outcome-quality',
      'calibration',
      'accepted-region-risk',
      'policy-value',
      'ope-support',
      'memory-health',
      'surface-attribution',
      'generalization',
      'promotion',
    ])

    const reasonCodes = BELIEF_EVALUATION_CRITERIA.flatMap((criterion) => criterion.reasonCodes)
    expect(new Set(reasonCodes).size).toBe(reasonCodes.length)
    expect(reasonCodes).toContain('memory-poisoning-risk')
    expect(reasonCodes).toContain('behavior-propensity-missing')
    expect(reasonCodes).toContain('negative-control-failed')
  })
})
