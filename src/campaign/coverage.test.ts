import { describe, expect, it } from 'vitest'

import {
  assertCampaignDesign,
  assertCampaignSplitIdentity,
  campaignCoverage,
  campaignScenarioIdentity,
  campaignSplitDigest,
  campaignSplitDigestFromIdentities,
} from './coverage'
import type { CampaignCellResult, Scenario } from './types'

const scenarios: Scenario[] = [
  { id: 'first', kind: 'fixture', tags: ['a'] },
  { id: 'second', kind: 'fixture', tags: ['b'] },
]

describe('campaign design identity', () => {
  it('binds the full scenario payload and replicate count', () => {
    const digest = campaignSplitDigest(scenarios, 1)
    expect(campaignSplitDigest(scenarios, 1)).toBe(digest)
    expect(
      campaignSplitDigest([{ ...scenarios[0]!, tags: ['changed'] }, scenarios[1]!], 1),
    ).not.toBe(digest)
    expect(campaignSplitDigest(scenarios, 2)).not.toBe(digest)
    const identities = scenarios.map(campaignScenarioIdentity)
    expect(campaignSplitDigestFromIdentities(identities, 1)).toBe(digest)
    expect(() => assertCampaignSplitIdentity(identities, 1, digest)).not.toThrow()
    expect(() =>
      assertCampaignSplitIdentity(
        [{ ...identities[0]!, scenarioDigest: `sha256:${'0'.repeat(64)}` }, identities[1]!],
        1,
        digest,
      ),
    ).toThrow(/does not match/)
  })

  it('rejects ambiguous scenario payloads instead of hashing a lossy coercion', () => {
    expect(() => campaignSplitDigest([{ ...scenarios[0]!, weight: Number.NaN }], 1)).toThrow(
      /non-finite number/,
    )
  })

  it('rejects duplicate scenario ids and invalid replicate counts', () => {
    expect(() => assertCampaignDesign([scenarios[0]!, { ...scenarios[0]! }], 1)).toThrow(
      /duplicate scenario id/,
    )
    expect(() => assertCampaignDesign(scenarios, 0)).toThrow(/positive safe integer/)
    expect(() => assertCampaignDesign(scenarios, 1.5)).toThrow(/positive safe integer/)
  })

  it('marks a cell whose id contradicts its scenario and rep as incomplete', () => {
    const cell = {
      cellId: 'first:0',
      scenarioId: 'second',
      rep: 0,
      artifact: {},
      judgeScores: { quality: { composite: 1, dimensions: { quality: 1 }, notes: '' } },
      costUsd: 0,
      tokenUsage: { input: 0, output: 0 },
      durationMs: 1,
      seed: 1,
      cached: false,
    } satisfies CampaignCellResult<unknown>

    const coverage = campaignCoverage([cell], [scenarios[0]!], 1, true)
    expect(coverage.complete).toBe(false)
    expect(coverage.unscorableCells).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: 'campaign cell id does not match scenario id and rep' }),
      ]),
    )
  })
})
