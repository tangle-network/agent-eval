import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { computeManifestHash } from '../../src/campaign/campaign-manifest'
import type { FinalEvidencePolicy } from '../../src/campaign/final-evidence'
import { defaultProductionGate } from '../../src/campaign/gates/default-production-gate'
import {
  compareOptimizationMethods,
  type OptimizationMethod,
} from '../../src/campaign/presets/compare-optimization-methods'
import { runFinalComparison } from '../../src/campaign/presets/run-final-comparison'
import { runImprovementLoop } from '../../src/campaign/presets/run-improvement-loop'
import { inMemoryCampaignStorage } from '../../src/campaign/storage'
import { surfaceDispatchRef } from '../../src/campaign/surface-identity'
import type { JudgeConfig, MutableSurface, Scenario } from '../../src/campaign/types'
import { selfImprove } from '../../src/contract/self-improve'
import type { EvaluationClaim } from '../../src/experiment/claim'
import {
  type FinalEvidenceLedger,
  openFinalEvidenceLedger,
} from '../../src/experiment/final-evidence'
import { hashCanonical } from '../../src/ledger-core/canonical'

interface Artifact {
  quality: number
}

const train: Scenario[] = ['train-1', 'train-2', 'selection'].map((id) => ({
  id,
  kind: 'fixture',
}))
const final: Scenario[] = Array.from({ length: 8 }, (_, index) => ({
  id: `final-${index}`,
  kind: 'fixture',
}))
const claim: EvaluationClaim = {
  use: 'comparison',
  population: { id: 'incidents', description: 'Independent incidents' },
  samplingFrame: 'Incident queue',
  independentUnit: 'id',
  generalization: 'new-units',
}
const evaluatorDigest = hashCanonical('artifact-quality-v1')
const freeCost = {
  totalCostUsd: 0,
  costProvenance: { kind: 'observed' as const, usd: 0 },
  accountingComplete: true,
  incompleteReasons: [],
}

let dir: string
let ledger: FinalEvidenceLedger
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'judge-snapshot-'))
  ledger = openFinalEvidenceLedger({ path: join(dir, 'evidence.jsonl') })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

function qualityJudge(): JudgeConfig<Artifact, Scenario> {
  return {
    name: 'quality',
    judgeVersion: 'v1',
    dimensions: [{ key: 'quality', description: 'Observed quality' }],
    appliesTo: () => true,
    score: ({ artifact }) => ({
      composite: artifact.quality,
      dimensions: { quality: artifact.quality },
      notes: '',
    }),
  }
}

function policy(owner: FinalEvidenceLedger = ledger): FinalEvidencePolicy {
  return { ledger: owner, requestId: 'comparison', evaluatorDigest }
}

describe('comparison judge snapshots', () => {
  it('does not promote identical outputs after the caller changes its judge between final arms', async () => {
    const judge = qualityJudge()
    const score = judge.score
    let originalCalls = 0
    judge.score = (input) => {
      originalCalls += 1
      if (originalCalls === final.length) {
        judge.score = () => ({ composite: 1, dimensions: { quality: 1 }, notes: '' })
        judge.judgeVersion = 'v2'
      }
      return score(input)
    }

    const result = await runFinalComparison({
      baselineSurface: 'BASE',
      winnerSurface: 'WIN',
      scenarios: final,
      dispatchWithSurface: async () => ({ quality: 0 }),
      judges: [judge],
      maxConcurrency: 1,
      gate: defaultProductionGate({ holdoutScenarios: final, deltaThreshold: 0 }),
      claim,
      finalEvidence: policy(),
      storage: inMemoryCampaignStorage(),
      runDir: dir,
      expectUsage: 'off',
    })

    expect(judge.judgeVersion).toBe('v2')
    expect(originalCalls).toBe(16)
    for (const campaign of [result.baselineOnHoldout, result.winnerOnHoldout]) {
      expect(campaign.cells).toHaveLength(8)
      for (const cell of campaign.cells) {
        expect(cell.artifact.quality).toBe(0)
        expect(cell.judgeScores.quality?.composite).toBe(0)
      }
    }
    expect(result.gateResult).toMatchObject({ decision: 'hold', delta: 0 })
    expect(result.finalEvidence?.record.exposure?.measurement.evaluatorDigest).toBe(evaluatorDigest)
  })

  it('preserves prototype callbacks, getter metadata, private receivers, and their original cache identity', async () => {
    class Dimension {
      get key() {
        return 'quality'
      }

      get description() {
        return 'Observed quality'
      }
    }
    class ClassJudge implements JudgeConfig<Artifact, Scenario> {
      #quality = 0

      get name() {
        return 'quality'
      }

      get dimensions() {
        return [new Dimension()]
      }

      appliesTo() {
        return this.#quality === 0
      }

      score() {
        return {
          composite: this.#quality,
          dimensions: { quality: this.#quality },
          notes: '',
        }
      }
    }
    const judge = new ClassJudge()
    const dispatchRef = 'class-judge-fixture'
    const expectedManifest = computeManifestHash({
      scenarios: final,
      judges: [
        {
          name: judge.name,
          dimensions: [{ key: 'quality', description: 'Observed quality' }],
          score: judge.score,
          appliesTo: judge.appliesTo,
        },
      ],
      dispatchRef: surfaceDispatchRef('BASE', dispatchRef),
      seed: 42,
      reps: 1,
    })
    const result = await runFinalComparison({
      baselineSurface: 'BASE',
      winnerSurface: 'WIN',
      scenarios: final,
      dispatchWithSurface: async () => ({ quality: 0 }),
      dispatchRef,
      judges: [judge],
      gate: defaultProductionGate({ holdoutScenarios: final, deltaThreshold: 0 }),
      storage: inMemoryCampaignStorage(),
      runDir: dir,
      expectUsage: 'off',
    })

    expect(result.baselineOnHoldout.manifestHash).toBe(expectedManifest)
    expect(result.winnerOnHoldout.cells).toHaveLength(8)
    expect(
      result.winnerOnHoldout.cells.every((cell) => cell.judgeScores.quality?.composite === 0),
    ).toBe(true)
    expect(result.gateResult).toMatchObject({ decision: 'hold', delta: 0 })
  })

  it.each(['method', 'proposer', 'loop', 'comparison'] as const)(
    'captures %s judges before the first reservation can yield to caller changes',
    async (mode) => {
      const judge = qualityJudge()
      const judges = [judge]
      let changed = false
      const changingLedger: FinalEvidenceLedger = {
        ...ledger,
        reserve: async (reservation) => {
          if (!changed) {
            changed = true
            judge.name = 'changed'
            judge.judgeVersion = 'v2'
            judge.dimensions[0]!.key = 'changed'
            judge.dimensions[0]!.description = 'Changed description'
            judge.score = () => ({ composite: 1, dimensions: { changed: 1 }, notes: '' })
            judge.appliesTo = () => false
            judges.length = 0
          }
          return ledger.reserve(reservation)
        },
      }
      const method: OptimizationMethod<Scenario, Artifact> = {
        name: 'fixed',
        optimize: async (input) => {
          expect(input.judges[0]).toMatchObject({
            name: 'quality',
            judgeVersion: 'v1',
            dimensions: [{ key: 'quality', description: 'Observed quality' }],
          })
          expect(input.judges[0]?.appliesTo?.(final[0]!)).toBe(true)
          return { winnerSurface: 'WIN', cost: freeCost }
        },
      }
      const agent = async (surface: MutableSurface, scenario: Scenario): Promise<Artifact> => ({
        quality: scenario.id.startsWith('final-') || surface === 'BASE' ? 0 : 1,
      })
      const common = {
        baselineSurface: 'BASE',
        claim,
        finalEvidence: policy(changingLedger),
        storage: inMemoryCampaignStorage(),
        runDir: dir,
        expectUsage: 'off' as const,
      }

      if (mode === 'comparison') {
        const result = await compareOptimizationMethods({
          ...common,
          trainScenarios: train.slice(0, 2),
          selectionScenarios: train.slice(2),
          testScenarios: final,
          methods: [method],
          judges,
          dispatchWithSurface: agent,
        })
        expect(result.best).toMatchObject({
          winnerSurface: 'WIN',
          baselineComposite: 0,
          winnerComposite: 0,
          lift: 0,
          decision: { promote: false },
        })
      } else if (mode === 'loop') {
        const result = await runImprovementLoop({
          ...common,
          scenarios: train,
          holdoutScenarios: final,
          judges,
          dispatchWithSurface: agent,
          proposer: { kind: 'fixed', propose: async () => ['WIN'] },
          gate: defaultProductionGate({ holdoutScenarios: final, deltaThreshold: 0 }),
          populationSize: 1,
          maxGenerations: 1,
          autoOnPromote: 'none',
        })
        expect(result.winnerSurface).toBe('WIN')
        expect(result.gateResult).toMatchObject({ decision: 'hold', delta: 0 })
      } else {
        const result = await selfImprove({
          ...common,
          scenarios: [...train, ...final],
          judge,
          agent,
          model: 'fixture@2026-09-13',
          budget: {
            holdoutScenarios: final,
            ...(mode === 'proposer' ? { generations: 1, populationSize: 1 } : {}),
          },
          ...(mode === 'method'
            ? { method }
            : { proposer: { kind: 'fixed', propose: async () => ['WIN'] } }),
        })
        expect(result.winner.surface).toBe('WIN')
        expect(result.lift).toBe(0)
        expect(result.gateDecision).toBe('hold')
      }
      expect(changed).toBe(true)
      const stored = await ledger.read()
      if (!stored.succeeded) throw new Error(stored.error.message)
      expect(stored.value[0]?.exposure?.measurement.evaluatorDigest).toBe(evaluatorDigest)
    },
  )
})
