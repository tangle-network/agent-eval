import { describe, expect, it } from 'vitest'
import {
  type AnalystFinding,
  makeFinding,
  makeProposalFinding,
  type ProposalFinding,
  type ProposalFindingOrigin,
} from '../../analyst/types'
import { inMemoryCampaignStorage } from '../storage'
import type { JudgeConfig, Scenario, SurfaceProposer } from '../types'
import { type RunOptimizationOptions, runOptimization } from './run-optimization'

interface TestScenario extends Scenario {
  kind: 'test'
}

interface TestArtifact {
  surface: string
}

const scenarios: TestScenario[] = [{ id: 'search-1', kind: 'test' }]
const qualityJudge: JudgeConfig<TestArtifact, TestScenario> = {
  name: 'quality',
  dimensions: [{ key: 'quality', description: 'candidate quality' }],
  score: () => ({ composite: 1, dimensions: { quality: 1 }, notes: '' }),
}

function finding(id: string): AnalystFinding {
  return makeFinding({
    analyst_id: 'proposal-input-test',
    severity: 'medium',
    area: 'quality',
    claim: id,
    confidence: 1,
    evidence_refs: [],
    id_basis: id,
    produced_at: '2026-07-28T00:00:00.000Z',
  })
}

function proposalFinding(
  id: string,
  proposalOrigin: ProposalFindingOrigin,
  derivedFromJudge = false,
): ProposalFinding {
  return makeProposalFinding({
    analyst_id: 'proposal-input-test',
    severity: 'medium',
    area: 'quality',
    claim: id,
    confidence: 1,
    evidence_refs: [],
    id_basis: id,
    produced_at: '2026-07-28T00:00:00.000Z',
    proposal_origin: proposalOrigin,
    derived_from_judge: derivedFromJudge,
  })
}

function options(
  proposer: SurfaceProposer<ProposalFinding>,
  overrides: Partial<RunOptimizationOptions<TestScenario, TestArtifact>> = {},
): RunOptimizationOptions<TestScenario, TestArtifact> {
  return {
    scenarios,
    baselineSurface: 'BASELINE',
    dispatchWithSurface: async (surface) => ({ surface: String(surface) }),
    judges: [qualityJudge],
    proposer,
    populationSize: 1,
    maxGenerations: 1,
    runDir: '/proposal-findings-test',
    storage: inMemoryCampaignStorage(),
    resumable: false,
    tracing: 'off',
    expectUsage: 'off',
    ...overrides,
  }
}

describe('runOptimization proposal findings', () => {
  it('rejects an unclassified static finding before candidate generation', async () => {
    let proposalCalls = 0
    let dispatchCalls = 0
    const proposer: SurfaceProposer<ProposalFinding> = {
      kind: 'must-not-run',
      async propose() {
        proposalCalls += 1
        return []
      },
    }

    const unclassified = finding('unclassified-finding')
    await expect(
      runOptimization(
        options(proposer, {
          findings: [unclassified] as unknown as ProposalFinding[],
          dispatchWithSurface: async (surface) => {
            dispatchCalls += 1
            return { surface: String(surface) }
          },
        }),
      ),
    ).rejects.toThrow(new RegExp(`proposal_origin.*${unclassified.finding_id}`))
    expect(proposalCalls).toBe(0)
    expect(dispatchCalls).toBe(0)
  })

  it('rejects a final-origin value passed from untyped JavaScript', async () => {
    let proposalCalls = 0
    const proposer: SurfaceProposer<ProposalFinding> = {
      kind: 'must-not-run',
      async propose() {
        proposalCalls += 1
        return []
      },
    }
    const finalFinding = {
      ...finding('final-finding'),
      proposal_origin: 'final',
    } as unknown as ProposalFinding

    await expect(runOptimization(options(proposer, { findings: [finalFinding] }))).rejects.toThrow(
      new RegExp(`proposal_origin.*${finalFinding.finding_id}`),
    )
    expect(proposalCalls).toBe(0)
  })

  it('checks fresh analysis before the next proposal', async () => {
    let proposalCalls = 0
    const proposer: SurfaceProposer<ProposalFinding> = {
      kind: 'must-not-run',
      async propose() {
        proposalCalls += 1
        return []
      },
    }
    const freshUnclassified = finding('fresh-unclassified')

    await expect(
      runOptimization(
        options(proposer, {
          findings: [proposalFinding('safe-seed', 'search')],
          analyzeGeneration: async () => [freshUnclassified] as unknown as ProposalFinding[],
        }),
      ),
    ).rejects.toThrow(new RegExp(`proposal_origin.*${freshUnclassified.finding_id}`))
    expect(proposalCalls).toBe(0)
  })

  it('passes search judge feedback and production observations unchanged', async () => {
    const allowed = [
      proposalFinding('search-feedback', 'search', true),
      proposalFinding('production-observation', 'production'),
    ]
    const proposer: SurfaceProposer<ProposalFinding> = {
      kind: 'inspect',
      async propose(context) {
        expect(context.findings).toEqual(allowed)
        return []
      },
    }

    await runOptimization(options(proposer, { findings: allowed }))
  })

  it('snapshots candidate context so a proposer cannot mutate loop state', async () => {
    const baseline = { kind: 'components' as const, components: { prompt: 'BASELINE' } }
    const proposer: SurfaceProposer<ProposalFinding> = {
      kind: 'mutation-attempt',
      async propose(context) {
        expect(Object.isFrozen(context)).toBe(true)
        expect(Object.isFrozen(context.history)).toBe(true)
        expect(Object.isFrozen(context.findings)).toBe(true)
        const surface = context.currentSurface
        if (typeof surface !== 'object' || surface.kind !== 'components') {
          throw new Error('expected a components surface')
        }
        expect(Object.isFrozen(surface)).toBe(true)
        expect(Object.isFrozen(surface.components)).toBe(true)
        expect(() => {
          ;(surface.components as Record<string, string>).prompt = 'MUTATED'
        }).toThrow(TypeError)
        return []
      },
    }

    const result = await runOptimization(
      options(proposer, {
        baselineSurface: baseline,
        findings: [proposalFinding('search-observation', 'search')],
      }),
    )

    expect(result.winnerSurface).toEqual(baseline)
  })

  it('snapshots the baseline before measuring or returning it', async () => {
    const baseline = { kind: 'components' as const, components: { prompt: 'BASELINE' } }
    const proposer: SurfaceProposer<ProposalFinding> = {
      kind: 'no-candidate',
      async propose() {
        return []
      },
    }

    const result = await runOptimization(options(proposer, { baselineSurface: baseline }))
    baseline.components.prompt = 'MUTATED AFTER RUN'

    expect(result.baselineSurface).not.toBe(baseline)
    expect(result.baselineSurface).toEqual({
      kind: 'components',
      components: { prompt: 'BASELINE' },
    })
    expect(result.winnerSurface).toBe(result.baselineSurface)
    expect(Object.isFrozen(result.baselineSurface)).toBe(true)
  })

  it('snapshots candidate outputs before measuring them', async () => {
    const candidate = {
      kind: 'components' as const,
      components: { prompt: 'CANDIDATE' },
    }
    const proposer: SurfaceProposer<ProposalFinding> = {
      kind: 'caller-owned-candidate',
      async propose() {
        return [candidate]
      },
    }

    const result = await runOptimization(options(proposer))
    const measured = result.generations[0]!.surfaces[0]!.surface
    candidate.components.prompt = 'MUTATED AFTER RETURN'

    expect(measured).not.toBe(candidate)
    expect(measured).toEqual({
      kind: 'components',
      components: { prompt: 'CANDIDATE' },
    })
    expect(Object.isFrozen(measured)).toBe(true)
  })
})
