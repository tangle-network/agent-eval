import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  buildLoopProvenanceRecord,
  type JudgeConfig,
  type ProposedCandidate,
  runOptimization,
  type SurfaceProposer,
} from '../../src/campaign'
import { surfaceHash } from '../../src/campaign/surface-identity'

interface Scenario {
  id: string
  kind: string
}

// The attribution slot is the campaign loop's public extension surface for
// bring-your-own proposers: whatever typed record a proposer attaches must
// survive byte-for-byte to the measured candidate and the durable provenance,
// and the loop must never interpret it.
describe('candidate attribution rides the loop untouched', () => {
  it('threads a proposer-attached record to the generation record and loop provenance', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'attribution-'))
    const attribution = {
      schema: 'test.candidate-attribution.v1',
      payload: { reason: 'exact provenance survives', nested: { n: 1 } },
    }
    const proposer: SurfaceProposer = {
      kind: 'test-attribution',
      async propose(): Promise<ProposedCandidate[]> {
        return [
          {
            surface: 'Base prompt. Improved.',
            label: 'improved',
            rationale: 'test rationale',
            attribution,
          },
        ]
      },
    }
    const scenarios: Scenario[] = [{ id: 'task', kind: 'test' }]
    const judge: JudgeConfig<{ text: string }, Scenario> = {
      name: 'improved-present',
      dimensions: [{ key: 'present', description: 'improvement present' }],
      score: ({ artifact }) => {
        const score = artifact.text.includes('Improved.') ? 1 : 0
        return { dimensions: { present: score }, composite: score, notes: '' }
      },
    }
    try {
      const result = await runOptimization<Scenario, { text: string }>({
        scenarios,
        baselineSurface: 'Base prompt.',
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        proposer,
        populationSize: 1,
        maxGenerations: 1,
        promoteTopK: 1,
        runDir,
      })
      const generation = result.generations[0]!
      expect(generation.record.candidates[0]!.attribution).toEqual(attribution)

      const provenance = buildLoopProvenanceRecord({
        runId: 'attribution-roundtrip',
        runDir,
        timestamp: '2026-08-28T00:00:00.000Z',
        baselineSurface: 'Base prompt.',
        winnerSurface: result.winnerSurface,
        baselineSearchCampaign: result.baselineCampaign,
        generations: [
          {
            generationIndex: generation.record.generationIndex,
            candidates: generation.record.candidates,
            promoted: generation.record.promoted,
            surfaces: generation.surfaces.map(({ surfaceHash: hash, surface, campaign }) => ({
              surfaceHash: hash,
              surface,
              campaign,
            })),
          },
        ],
        gate: { decision: 'hold', reasons: [], contributingGates: [] },
        baselineOnHoldout: result.baselineCampaign,
        winnerOnHoldout: generation.surfaces[0]!.campaign,
        costReceipts: [],
        totalCostUsd: 0,
        totalDurationMs: 1,
      })
      expect(provenance.candidates[0]!.attribution).toEqual(attribution)
      expect(provenance.candidates[0]!.parentSurfaceHash).toBe(surfaceHash('Base prompt.'))
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })

  it('a bare-surface proposer yields candidates with no attribution key at all', async () => {
    const runDir = mkdtempSync(join(tmpdir(), 'attribution-bare-'))
    const proposer: SurfaceProposer = {
      kind: 'test-bare',
      async propose() {
        return ['Base prompt. Improved.']
      },
    }
    const scenarios: Scenario[] = [{ id: 'task', kind: 'test' }]
    const judge: JudgeConfig<{ text: string }, Scenario> = {
      name: 'improved-present',
      dimensions: [{ key: 'present', description: 'improvement present' }],
      score: ({ artifact }) => {
        const score = artifact.text.includes('Improved.') ? 1 : 0
        return { dimensions: { present: score }, composite: score, notes: '' }
      },
    }
    try {
      const result = await runOptimization<Scenario, { text: string }>({
        scenarios,
        baselineSurface: 'Base prompt.',
        dispatchWithSurface: async (surface) => ({ text: String(surface) }),
        judges: [judge],
        proposer,
        populationSize: 1,
        maxGenerations: 1,
        promoteTopK: 1,
        runDir,
      })
      const candidate = result.generations[0]!.record.candidates[0]!
      expect('attribution' in candidate).toBe(false)
    } finally {
      rmSync(runDir, { recursive: true, force: true })
    }
  })
})
