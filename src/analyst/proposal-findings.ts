import { z } from 'zod'
import type { ProposalFinding } from './types'

const ProposalFindingSchema = z
  .object({
    schema_version: z.literal('1.0.0'),
    finding_id: z.string().min(1),
    analyst_id: z.string().min(1),
    produced_at: z.string().min(1),
    severity: z.enum(['critical', 'high', 'medium', 'low', 'info']),
    area: z.string().min(1),
    claim: z.string().min(1),
    rationale: z.string().optional(),
    evidence_refs: z.array(
      z
        .object({
          kind: z.enum(['span', 'event', 'artifact', 'finding', 'metric']),
          uri: z.string().min(1),
          excerpt: z.string().optional(),
        })
        .strict(),
    ),
    recommended_action: z.string().optional(),
    validation_plan: z.string().optional(),
    confidence: z.number().min(0).max(1),
    subject: z.string().optional(),
    derived_from_judge: z.boolean().optional(),
    metadata: z.record(z.string(), z.unknown()).optional(),
    proposal_origin: z.enum(['search', 'production']),
  })
  .strict() satisfies z.ZodType<ProposalFinding>

/** True when a finding names a source candidate generation may learn from. */
export function isProposalFinding(finding: unknown): finding is ProposalFinding {
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
