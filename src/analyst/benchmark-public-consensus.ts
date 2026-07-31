import type { CodeTraceFailureBlock, CodeTraceStepAssignment } from './benchmark-public-adapters'

/**
 * One sample block's contribution to a consensus block, in the shape the
 * decision record persists: block coordinates plus how many consensus steps
 * the block's accepted steps cover.
 */
export interface CodeTraceConsensusContributor {
  sample: number
  firstStep: number
  lastStep: number
  consequenceStep: number
  confidence: number
  overlapSteps: number
}

export interface CodeTraceConsensusBlockDecision {
  firstStep: number
  lastStep: number
  consequenceStep: number
  escapeStatus: 'escaped' | 'unescaped'
  /** Mean confidence across every contributor. */
  confidence: number
  donor: CodeTraceConsensusContributor
  contributors: CodeTraceConsensusContributor[]
}

/** The full voting record: every step any sample accepted, and what won. */
export interface CodeTraceConsensusDecision {
  samples: number
  threshold: number
  stepVotes: Array<{ step: number; votes: number; kept: boolean }>
  blocks: CodeTraceConsensusBlockDecision[]
}

/**
 * Step-level majority vote across independent analyst samples.
 *
 * Each sample's accepted, evidence-resolved steps count as one vote per step.
 * Steps present in at least ceil(k/2) samples survive; surviving steps are
 * reassembled into contiguous consensus blocks. Each consensus block borrows
 * its metadata (consequence step, escape status, claim, severity, rationale)
 * from the contributing sample block with the largest step overlap — ties go
 * to the higher-confidence block, then to the earlier sample — while its
 * confidence is the mean across every contributor. The returned blocks still
 * pass through the shared expansion, so width, count, and evidence rules are
 * enforced there, never assumed here.
 */
export function consensusCodeTraceBlocks(
  sampleAssignments: ReadonlyArray<readonly CodeTraceStepAssignment[]>,
): { blocks: CodeTraceFailureBlock[]; decision: CodeTraceConsensusDecision } {
  const samples = sampleAssignments.length
  if (samples < 2) {
    throw new RangeError('step-level consensus requires at least two samples')
  }
  const threshold = Math.ceil(samples / 2)
  const votesByStep = new Map<number, number>()
  sampleAssignments.forEach((assignments, sample) => {
    const seen = new Set<number>()
    for (const { step } of assignments) {
      if (!Number.isSafeInteger(step) || step < 0) {
        throw new RangeError(`sample ${sample} assigned a non-step value: ${step}`)
      }
      if (seen.has(step)) {
        throw new Error(`sample ${sample} assigned step ${step} to more than one block`)
      }
      seen.add(step)
      votesByStep.set(step, (votesByStep.get(step) ?? 0) + 1)
    }
  })
  const stepVotes = [...votesByStep]
    .sort(([left], [right]) => left - right)
    .map(([step, votes]) => ({ step, votes, kept: votes >= threshold }))
  const keptSteps = stepVotes.filter((entry) => entry.kept).map((entry) => entry.step)

  const blocks: CodeTraceFailureBlock[] = []
  const blockDecisions: CodeTraceConsensusBlockDecision[] = []
  for (const segment of contiguousSegments(keptSteps)) {
    const contributors = segmentContributors(sampleAssignments, segment)
    // Every kept step carries >= threshold sample votes, so a segment always
    // has at least one contributor.
    const donor = contributors.reduce(betterDonor)
    const confidence =
      contributors.reduce((sum, contributor) => sum + contributor.block.confidence, 0) /
      contributors.length
    blocks.push({
      firstStep: segment.firstStep,
      lastStep: segment.lastStep,
      consequenceStep: donor.block.consequenceStep,
      escapeStatus: donor.block.escapeStatus,
      severity: donor.block.severity,
      claim: donor.block.claim,
      confidence,
      ...(donor.block.rationale === undefined ? {} : { rationale: donor.block.rationale }),
      ...(donor.block.recommendedAction === undefined
        ? {}
        : { recommendedAction: donor.block.recommendedAction }),
      metadata: {
        ...donor.block.metadata,
        consensus_samples: samples,
        consensus_threshold: threshold,
        consensus_contributors: contributors.length,
        consensus_donor_sample: donor.sample,
      },
    })
    blockDecisions.push({
      firstStep: segment.firstStep,
      lastStep: segment.lastStep,
      consequenceStep: donor.block.consequenceStep,
      escapeStatus: donor.block.escapeStatus,
      confidence,
      donor: publicContributor(donor),
      contributors: contributors.map(publicContributor),
    })
  }
  return { blocks, decision: { samples, threshold, stepVotes, blocks: blockDecisions } }
}

interface SegmentContributor {
  sample: number
  block: CodeTraceFailureBlock
  overlapSteps: number
}

/**
 * All (sample, block) pairs whose accepted steps intersect the segment,
 * ordered by sample then by first overlapping step — the deterministic
 * tie-break order for donor selection.
 */
function segmentContributors(
  sampleAssignments: ReadonlyArray<readonly CodeTraceStepAssignment[]>,
  segment: { firstStep: number; lastStep: number },
): SegmentContributor[] {
  const contributors: SegmentContributor[] = []
  sampleAssignments.forEach((assignments, sample) => {
    const overlapByBlock = new Map<CodeTraceFailureBlock, number>()
    for (const { step, block } of assignments) {
      if (step < segment.firstStep || step > segment.lastStep) continue
      overlapByBlock.set(block, (overlapByBlock.get(block) ?? 0) + 1)
    }
    for (const [block, overlapSteps] of overlapByBlock) {
      contributors.push({ sample, block, overlapSteps })
    }
  })
  return contributors
}

function betterDonor(left: SegmentContributor, right: SegmentContributor): SegmentContributor {
  if (right.overlapSteps !== left.overlapSteps) {
    return right.overlapSteps > left.overlapSteps ? right : left
  }
  if (right.block.confidence !== left.block.confidence) {
    return right.block.confidence > left.block.confidence ? right : left
  }
  // Remaining ties keep the earlier contributor: lower sample index, then the
  // block whose first overlapping step comes first (construction order).
  return left
}

function publicContributor(contributor: SegmentContributor): CodeTraceConsensusContributor {
  return {
    sample: contributor.sample,
    firstStep: contributor.block.firstStep,
    lastStep: contributor.block.lastStep,
    consequenceStep: contributor.block.consequenceStep,
    confidence: contributor.block.confidence,
    overlapSteps: contributor.overlapSteps,
  }
}

function contiguousSegments(
  sortedSteps: readonly number[],
): Array<{ firstStep: number; lastStep: number }> {
  const segments: Array<{ firstStep: number; lastStep: number }> = []
  for (const step of sortedSteps) {
    const current = segments[segments.length - 1]
    if (current && step === current.lastStep + 1) {
      current.lastStep = step
      continue
    }
    segments.push({ firstStep: step, lastStep: step })
  }
  return segments
}
