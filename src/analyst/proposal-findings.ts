import { ProposalFindingSchema } from './finding-scope'
import type { ProposalFinding } from './types'

/** True when a finding names a source candidate generation may learn from. */
function isProposalFinding(finding: unknown): finding is ProposalFinding {
  return ProposalFindingSchema.safeParse(finding).success
}

/**
 * Reject findings whose source has not been explicitly admitted for candidate
 * generation. Search feedback and observed production behavior are allowed;
 * final evaluation data has no allowed origin.
 */
export function assertProposalFindings(
  findings: unknown,
  context = 'proposal findings',
): ReadonlyArray<ProposalFinding> {
  if (!Array.isArray(findings)) {
    throw new TypeError(`${context}: expected an array`)
  }
  const rejected = findings.flatMap((finding, index) =>
    isProposalFinding(finding) ? [] : [findingLabel(finding, index)],
  )
  if (rejected.length > 0) {
    throw new Error(
      `${context}: every finding must match AnalystFinding and declare ` +
        `proposal_origin as search or production. ` +
        `Rejected findings: [${rejected.join(', ')}].`,
    )
  }
  return findings as ReadonlyArray<ProposalFinding>
}

function findingLabel(finding: unknown, index: number): string {
  if (typeof finding !== 'object' || finding === null) return `index ${index}`
  const id = (finding as { finding_id?: unknown }).finding_id
  return typeof id === 'string' && id.length > 0 ? id : `index ${index}`
}
