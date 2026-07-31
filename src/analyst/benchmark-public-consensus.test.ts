import { describe, expect, it } from 'vitest'
import type {
  CodeTraceFailureBlock,
  CodeTraceStepAssignment,
} from './benchmark-public-adapters'
import { consensusCodeTraceBlocks } from './benchmark-public-consensus'

function block(overrides: Partial<CodeTraceFailureBlock> = {}): CodeTraceFailureBlock {
  return {
    firstStep: 2,
    lastStep: 2,
    consequenceStep: 2,
    escapeStatus: 'unescaped',
    severity: 'high',
    claim: 'The step is incorrect.',
    confidence: 0.5,
    ...overrides,
  }
}

function assign(owner: CodeTraceFailureBlock, steps: number[]): CodeTraceStepAssignment[] {
  return steps.map((step) => ({ step, block: owner }))
}

describe('consensusCodeTraceBlocks', () => {
  it('keeps steps in at least ceil(k/2) samples and drops the rest', () => {
    const wide = block({ firstStep: 2, lastStep: 4, consequenceStep: 4, confidence: 0.6 })
    const narrow = block({ firstStep: 2, lastStep: 3, consequenceStep: 3, confidence: 0.7 })
    const lone = block({ firstStep: 6, lastStep: 6, consequenceStep: 6, confidence: 0.9 })
    const { blocks, decision } = consensusCodeTraceBlocks([
      assign(wide, [2, 3, 4]),
      assign(narrow, [2, 3]),
      assign(lone, [6]),
    ])

    expect(decision.threshold).toBe(2)
    expect(decision.stepVotes).toEqual([
      { step: 2, votes: 2, kept: true },
      { step: 3, votes: 2, kept: true },
      { step: 4, votes: 1, kept: false },
      { step: 6, votes: 1, kept: false },
    ])
    expect(blocks).toHaveLength(1)
    expect(blocks[0]).toMatchObject({ firstStep: 2, lastStep: 3 })
  })

  it('reassembles non-adjacent surviving steps into separate blocks', () => {
    const early = block({ firstStep: 2, lastStep: 3, consequenceStep: 3 })
    const late = block({ firstStep: 5, lastStep: 5, consequenceStep: 5 })
    const { blocks } = consensusCodeTraceBlocks([
      [...assign(early, [2, 3]), ...assign(late, [5])],
      [...assign(early, [2, 3]), ...assign(late, [5])],
    ])

    expect(blocks.map((entry) => [entry.firstStep, entry.lastStep])).toEqual([
      [2, 3],
      [5, 5],
    ])
  })

  it('borrows metadata from the max-overlap contributor and averages confidence', () => {
    const dominant = block({
      firstStep: 2,
      lastStep: 3,
      consequenceStep: 5,
      escapeStatus: 'escaped',
      severity: 'medium',
      claim: 'The dominant block claim.',
      confidence: 0.4,
      rationale: 'Dominant rationale.',
      metadata: { sourceFindingId: 'dominant-finding' },
    })
    const minor = block({
      firstStep: 3,
      lastStep: 3,
      consequenceStep: 3,
      severity: 'critical',
      claim: 'The minor block claim.',
      confidence: 0.9,
    })
    const { blocks, decision } = consensusCodeTraceBlocks([
      assign(dominant, [2, 3]),
      [...assign(minor, [3]), { step: 2, block: block({ confidence: 0.8 }) }],
    ])

    expect(blocks).toHaveLength(1)
    // Contributors: dominant overlaps 2 steps; the two single-step blocks
    // overlap 1 each. Max overlap wins the donor role despite its lower
    // confidence; the emitted confidence is the mean of all three.
    expect(blocks[0]).toMatchObject({
      firstStep: 2,
      lastStep: 3,
      consequenceStep: 5,
      escapeStatus: 'escaped',
      severity: 'medium',
      claim: 'The dominant block claim.',
      rationale: 'Dominant rationale.',
    })
    expect(blocks[0]!.confidence).toBeCloseTo((0.4 + 0.8 + 0.9) / 3, 10)
    expect(blocks[0]!.metadata).toMatchObject({
      sourceFindingId: 'dominant-finding',
      consensus_samples: 2,
      consensus_threshold: 1,
      consensus_contributors: 3,
      consensus_donor_sample: 0,
    })
    expect(decision.blocks[0]!.donor).toMatchObject({ sample: 0, overlapSteps: 2 })
    expect(decision.blocks[0]!.contributors).toHaveLength(3)
  })

  it('breaks an equal-overlap tie toward the higher-confidence block', () => {
    const timid = block({ confidence: 0.3, claim: 'Timid claim.' })
    const confident = block({
      confidence: 0.9,
      claim: 'Confident claim.',
      escapeStatus: 'escaped',
    })
    const { blocks, decision } = consensusCodeTraceBlocks([
      assign(timid, [2]),
      assign(confident, [2]),
    ])

    expect(blocks[0]).toMatchObject({ claim: 'Confident claim.', escapeStatus: 'escaped' })
    expect(blocks[0]!.confidence).toBeCloseTo(0.6, 10)
    expect(decision.blocks[0]!.donor.sample).toBe(1)
  })

  it('keeps the earlier sample when overlap and confidence tie exactly', () => {
    const first = block({ claim: 'First sample claim.' })
    const second = block({ claim: 'Second sample claim.' })
    const { decision } = consensusCodeTraceBlocks([assign(first, [2]), assign(second, [2])])

    expect(decision.blocks[0]!.donor.sample).toBe(0)
  })

  it('returns no blocks when no step reaches the threshold', () => {
    const { blocks, decision } = consensusCodeTraceBlocks([
      assign(block({ firstStep: 2, lastStep: 2 }), [2]),
      assign(block({ firstStep: 3, lastStep: 3, consequenceStep: 3 }), [3]),
      assign(block({ firstStep: 5, lastStep: 5, consequenceStep: 5 }), [5]),
    ])

    expect(blocks).toEqual([])
    expect(decision.stepVotes.every((entry) => !entry.kept)).toBe(true)
  })

  it('refuses fewer than two samples and duplicate step assignments', () => {
    expect(() => consensusCodeTraceBlocks([assign(block(), [2])])).toThrow(
      /at least two samples/,
    )
    const owner = block()
    expect(() =>
      consensusCodeTraceBlocks([
        [
          { step: 2, block: owner },
          { step: 2, block: block({ claim: 'Duplicate owner.' }) },
        ],
        assign(block(), [2]),
      ]),
    ).toThrow(/step 2 to more than one block/)
  })
})
