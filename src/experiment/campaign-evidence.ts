import type { AttestationProvenance } from '../attestation'
import { assertCampaignSplitIdentity, campaignCoverage } from '../campaign/coverage'
import { campaignMeasurementDigest } from '../campaign/provenance'
import { surfaceContentHash } from '../campaign/surface-identity'
import type { CampaignResult, MutableSurface, Scenario } from '../campaign/types'
import { hashCanonical } from '../ledger-core/canonical'
import { type CreateEvidenceReceiptInput, createEvidenceReceipt } from './evidence-receipt'

/** Caller-owned execution context. Eval never infers evaluator authority or environment identity. */
export type CampaignEvidenceContext = Pick<
  CreateEvidenceReceiptInput,
  | 'pursuitId'
  | 'evaluatorDigest'
  | 'environmentDigest'
  | 'authority'
  | 'experimentDigest'
  | 'observerDigest'
> & { provenance: Omit<AttestationProvenance, 'inputsHash'> }

/** Bind a complete measured campaign to its executed surface and actual outputs. */
export function createCampaignEvidenceReceipt<S extends Scenario, A>(input: {
  campaign: CampaignResult<A, S>
  surface: MutableSurface
  context: CampaignEvidenceContext
}) {
  const { campaign, surface, context } = input
  assertCampaignSplitIdentity(campaign.scenarios, campaign.reps, campaign.splitDigest)
  const coverage = campaignCoverage(campaign.cells, campaign.scenarios, campaign.reps, true)
  if (campaign.scenarios.length === 0 || !coverage.complete) {
    throw new Error('campaign evidence requires a complete, nonempty measurement')
  }
  const { provenance, ...binding } = context
  return createEvidenceReceipt(
    {
      ...binding,
      runId: campaign.runDir,
      candidateDigest: surfaceContentHash(surface),
      inputSetCommitment: campaign.splitDigest,
      outputDigest: hashCanonical(
        [...campaign.cells]
          .sort((a, b) => (a.cellId < b.cellId ? -1 : a.cellId > b.cellId ? 1 : 0))
          .map((cell) => ({ cellId: cell.cellId, artifact: cell.artifact })),
      ),
      resultDigest: campaignMeasurementDigest(campaign),
    },
    { ...provenance, inputsHash: campaign.splitDigest },
  )
}
