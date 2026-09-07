import { describe, expect, it } from 'vitest'
import { runCampaign } from '../campaign/run-campaign'
import { inMemoryCampaignStorage } from '../campaign/storage'
import { surfaceContentHash } from '../campaign/surface-identity'
import { createCampaignEvidenceReceipt } from './campaign-evidence'
import { verifyEvidenceReceipt } from './evidence-receipt'

const context = {
  pursuitId: 'learning-process',
  evaluatorDigest: `sha256:${'a'.repeat(64)}`,
  environmentDigest: `sha256:${'b'.repeat(64)}`,
  authority: { kind: 'candidate-self-report' as const, id: 'caller' },
  provenance: { modelVersions: {}, codeSha: 'c'.repeat(40), createdAt: '2026-09-07T00:00:00Z' },
}
async function measure() {
  return runCampaign({
    scenarios: [{ id: 'episode', kind: 'learning', initialState: 'immutable-state-1' }],
    dispatch: async () => ({ producedState: 'immutable-state-2', score: 1 }),
    judges: [
      {
        name: 'downstream',
        dimensions: [{ key: 'passed', description: 'official result' }],
        score: () => ({ dimensions: { passed: 1 }, composite: 1, notes: '' }),
      },
    ],
    runDir: 'mem://receipt-proof',
    storage: inMemoryCampaignStorage(),
    expectUsage: 'off',
  })
}

describe('campaign evidence receipts', () => {
  it('binds actual learning-episode inputs, outputs and measurement without inventing authority', async () => {
    const campaign = await measure()
    const surface = JSON.stringify({ learner: 'learning-method', specialist: 'solver' })
    const receipt = createCampaignEvidenceReceipt({ campaign, surface, context })
    expect(verifyEvidenceReceipt(receipt).valid).toBe(true)
    expect(receipt.binding).toMatchObject({
      candidateDigest: surfaceContentHash(surface),
      inputSetCommitment: campaign.splitDigest,
      runId: campaign.runDir,
      authority: context.authority,
    })
    expect(receipt.attestation.provenance.inputsHash).toBe(campaign.splitDigest)
    const changedOutput = structuredClone(campaign)
    changedOutput.cells[0]!.artifact.producedState = 'different-state'
    expect(
      createCampaignEvidenceReceipt({ campaign: changedOutput, surface, context }).binding
        .outputDigest,
    ).not.toBe(receipt.binding.outputDigest)
    const changedScore = structuredClone(campaign)
    changedScore.cells[0]!.judgeScores.downstream!.composite = 0
    expect(
      createCampaignEvidenceReceipt({ campaign: changedScore, surface, context }).binding
        .resultDigest,
    ).not.toBe(receipt.binding.resultDigest)
  })

  it('refuses missing cells, failed measurement, changed input identity and absent authority', async () => {
    const campaign = await measure()
    const input = { campaign, surface: 'candidate', context }
    expect(() =>
      createCampaignEvidenceReceipt({ ...input, campaign: { ...campaign, cells: [] } }),
    ).toThrow('complete')
    expect(() =>
      createCampaignEvidenceReceipt({
        ...input,
        campaign: { ...campaign, cells: [{ ...campaign.cells[0]!, error: 'checker failed' }] },
      }),
    ).toThrow('complete')
    expect(() =>
      createCampaignEvidenceReceipt({ ...input, campaign: { ...campaign, reps: 2 } }),
    ).toThrow('split digest')
    expect(() =>
      createCampaignEvidenceReceipt({
        ...input,
        context: { ...context, authority: { ...context.authority, id: '' } },
      }),
    ).toThrow()
  })
})
