import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  exposeFinalEvidence,
  type FinalEvidencePolicy,
  reserveFinalEvidence,
} from '../../src/campaign/final-evidence'
import { compareOptimizationMethods } from '../../src/campaign/presets/compare-optimization-methods'
import { runImprovementLoop } from '../../src/campaign/presets/run-improvement-loop'
import { inMemoryCampaignStorage } from '../../src/campaign/storage'
import type { JudgeConfig, Scenario } from '../../src/campaign/types'
import { type SelfImproveProgressEvent, selfImprove } from '../../src/contract/self-improve'
import type { EvaluationClaim } from '../../src/experiment/claim'
import {
  FinalEvidenceError,
  type FinalEvidenceLedger,
  openFinalEvidenceLedger,
} from '../../src/experiment/final-evidence'
import { hashCanonical } from '../../src/ledger-core/canonical'

interface Case extends Scenario {
  sourceId: string
}
interface Artifact {
  quality: number
}
let dir: string
let ledger: FinalEvidenceLedger
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'final-evidence-campaign-'))
  ledger = openFinalEvidenceLedger({ path: join(dir, 'evidence.jsonl') })
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

const source = (id: string, sourceId = id): Case => ({ id, kind: 'fixture', sourceId })
const train = [source('train-1'), source('train-2'), source('select-1')]
const final = [source('final-1'), source('final-2')]
const judge: JudgeConfig<Artifact, Case> = {
  name: 'quality',
  dimensions: [{ key: 'quality', description: 'Observed quality' }],
  score: ({ artifact }) => ({
    composite: artifact.quality,
    dimensions: { quality: artifact.quality },
    notes: '',
  }),
}
const freeCost = {
  totalCostUsd: 0,
  costProvenance: { kind: 'observed' as const, usd: 0 },
  accountingComplete: true,
  incompleteReasons: [],
}
const gate = {
  name: 'fixture',
  decide: async () => ({ decision: 'hold' as const, reasons: ['fixture'], contributingGates: [] }),
}
function policy(requestId = 'run'): FinalEvidencePolicy {
  return {
    ledger,
    requestId,
    evaluatorDigest: hashCanonical('fixture-evaluator'),
  }
}
function claim(): EvaluationClaim {
  return {
    use: 'comparison',
    population: { id: 'incidents', description: 'New incidents' },
    samplingFrame: 'Incident queue',
    independentUnit: 'sourceId',
    generalization: 'new-units',
    minimumEffect: 0.05,
  }
}
async function record() {
  const result = await ledger.read()
  if (!result.succeeded) throw new Error(result.error.message)
  return result.value[0]!
}

describe('final evidence through campaign entrypoints', () => {
  it('keeps declared-unit regression data reusable and detects a large gain with eight binary pairs', async () => {
    const heldout = Array.from({ length: 8 }, (_, i) => source(`holdout-${i}`))
    const options = {
      scenarios: [...train, ...heldout],
      judge,
      baselineSurface: 'BASE',
      claim: claim(),
      storage: inMemoryCampaignStorage(),
      runDir: dir,
      model: 'fixture@2026-09-13',
      expectUsage: 'off' as const,
      budget: { holdoutScenarios: heldout },
      agent: async (surface: string | object) => ({ quality: surface === 'BASE' ? 0 : 1 }),
      method: { name: 'fixed', optimize: async () => ({ winnerSurface: 'WIN', cost: freeCost }) },
    }
    for (let run = 0; run < 2; run++) {
      const result = await selfImprove(options)
      expect(result.winner.surface).toBe('WIN')
      expect(result.lift).toBe(1)
      expect(result.gateDecision).toBe('ship')
      expect(result.claim?.independentUnit).toBe('sourceId')
      expect(result.finalEvidence).toBeUndefined()
    }
    const evidence = await ledger.read()
    expect(evidence).toEqual({ succeeded: true, value: [] })
  })

  it('returns the selected candidate and observed lift when a population-mean claim remains inconclusive', async () => {
    const heldout = Array.from({ length: 4 }, (_, i) => source(`holdout-${i}`))
    const result = await selfImprove({
      scenarios: [...train, ...heldout],
      judge,
      baselineSurface: 'BASE',
      claim: claim(),
      storage: inMemoryCampaignStorage(),
      runDir: dir,
      model: 'fixture@2026-09-13',
      expectUsage: 'off',
      budget: { holdoutScenarios: heldout },
      agent: async (surface, scenario) => ({
        quality: surface === 'BASE' ? 0.3 : 0.5 + Number(scenario.id.slice(-1)) * 0.01,
      }),
      method: { name: 'fixed', optimize: async () => ({ winnerSurface: 'WIN', cost: freeCost }) },
    })
    expect(result.winner.surface).toBe('WIN')
    expect(result.lift).toBeCloseTo(0.215)
    expect(result.gateDecision).toBe('hold')
  })

  it('retains a selected candidate that loses on final tasks and reports the regression', async () => {
    const heldout = Array.from({ length: 8 }, (_, i) => source(`holdout-${i}`))
    const result = await selfImprove({
      scenarios: [...train, ...heldout],
      judge,
      baselineSurface: 'BASE',
      claim: claim(),
      storage: inMemoryCampaignStorage(),
      runDir: dir,
      model: 'fixture@2026-09-13',
      expectUsage: 'off',
      budget: { holdoutScenarios: heldout },
      agent: async (surface) => ({ quality: surface === 'BASE' ? 1 : 0 }),
      method: {
        name: 'fixed',
        optimize: async () => ({ winnerSurface: 'SELECTED', cost: freeCost }),
      },
    })
    expect(result.winner.surface).toBe('SELECTED')
    expect(result.lift).toBe(-1)
    expect(result.gateDecision).toBe('hold')
    expect(result.provenance.heldOutLift).toBe(-1)
  })

  it('returns descriptive optimizer scores when final variants come from one source unit', async () => {
    const result = await compareOptimizationMethods<Case, Artifact>({
      trainScenarios: train.slice(0, 2),
      selectionScenarios: train.slice(2),
      testScenarios: [source('variant-a', 'one-source'), source('variant-b', 'one-source')],
      baselineSurface: 'BASE',
      judges: [judge],
      claim: claim(),
      methods: [
        { name: 'fixed', optimize: async () => ({ winnerSurface: 'WIN', cost: freeCost }) },
      ],
      dispatchWithSurface: async (surface) => ({ quality: surface === 'BASE' ? 0 : 1 }),
      runDir: dir,
      storage: inMemoryCampaignStorage(),
      expectUsage: 'off',
    })
    expect(result.best.winnerSurface).toBe('WIN')
    expect(result.best.winnerComposite).toBe(1)
    expect(result.best.unitScores).toHaveLength(1)
    expect(result.best.scenarioScores).toHaveLength(2)
    expect(result.best.decision).toMatchObject({ n: 1, sufficient: false, promote: false })
    expect(result.units).toMatchObject({ observations: 2, independentUnits: 1 })
  })

  it.each(['method', 'proposer'] as const)(
    'reserves before %s search and exposes before final dispatch',
    async (mode) => {
      let proposals = 0
      let finalCalls = 0
      const verifySearch = async () => {
        proposals += 1
        expect((await record()).exposure).toBeNull()
      }
      const options = {
        scenarios: [...train, ...final],
        judge,
        gate,
        baselineSurface: 'BASE',
        storage: inMemoryCampaignStorage(),
        runDir: join(dir, mode),
        model: 'fixture@2026-09-13',
        expectUsage: 'off' as const,
        budget: {
          holdoutScenarios: final,
          ...(mode === 'proposer' ? { generations: 1, populationSize: 1 } : {}),
        },
        claim: claim(),
        finalEvidence: policy(),
        agent: async (surface: string | object, scenario: Case) => {
          if (scenario.id.startsWith('final')) {
            finalCalls += 1
            expect((await record()).exposure?.measurement.candidateDigests).toEqual(
              [hashCanonical('BASE'), hashCanonical('WIN')].sort(),
            )
          }
          return { quality: surface === 'BASE' ? 0 : 1 }
        },
        ...(mode === 'method'
          ? {
              method: {
                name: 'fixed',
                optimize: async () => {
                  await verifySearch()
                  return { winnerSurface: 'WIN', cost: freeCost }
                },
              },
            }
          : {
              proposer: {
                kind: 'fixed',
                propose: async () => {
                  await verifySearch()
                  return ['WIN']
                },
              },
            }),
      }
      const result = await selfImprove(options)
      expect(proposals).toBeGreaterThan(0)
      expect(finalCalls).toBe(4)
      expect(result.finalEvidence?.record.exposure).not.toBeNull()
      await expect(selfImprove(options)).rejects.toThrow(/already exposed/)
      expect(finalCalls).toBe(4)
    },
  )

  it('blocks source overlap before either entrypoint can invoke an optimizer', async () => {
    let invoked = false
    const shared = [source('variant-a', 'same-source')]
    const heldout = [source('variant-b', 'same-source')]
    await expect(
      runImprovementLoop({
        scenarios: shared,
        holdoutScenarios: heldout,
        baselineSurface: 'BASE',
        judges: [judge],
        gate,
        autoOnPromote: 'none',
        runDir: dir,
        storage: inMemoryCampaignStorage(),
        dispatchWithSurface: async () => {
          invoked = true
          return { quality: 0 }
        },
        proposer: {
          kind: 'fixed',
          propose: async () => {
            invoked = true
            return ['WIN']
          },
        },
        claim: claim(),
        finalEvidence: policy(),
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/share independent units/)
    expect(invoked).toBe(false)
    expect((await ledger.read()).succeeded).toBe(true)
  })

  it('splits complete source families and snapshots caller policy during method search', async () => {
    const cases = Array.from({ length: 5 }, (_, family) =>
      Array.from({ length: 3 }, (_, variant) => source(`${family}:${variant}`, `family-${family}`)),
    ).flat()
    const original = policy()
    const declaredClaim = claim()
    const result = await selfImprove({
      scenarios: cases,
      judge,
      baselineSurface: 'BASE',
      storage: inMemoryCampaignStorage(),
      runDir: dir,
      model: 'fixture@2026-09-13',
      expectUsage: 'off',
      claim: declaredClaim,
      finalEvidence: original,
      agent: async () => ({ quality: 0 }),
      method: {
        name: 'same',
        optimize: async (input) => {
          const heldoutUnits = new Set((await record()).reservation.unitIds)
          const trainUnits = new Set(input.trainScenarios.map((row) => row.sourceId))
          expect(
            input.selectionScenarios.every(
              (row) => !trainUnits.has(row.sourceId) && !heldoutUnits.has(row.sourceId),
            ),
          ).toBe(true)
          expect(input.trainScenarios.every((row) => !heldoutUnits.has(row.sourceId))).toBe(true)
          original.requestId = 'mutated'
          declaredClaim.independentUnit = 'id'
          cases[0]!.sourceId = 'mutated'
          return { winnerSurface: input.baselineSurface, cost: freeCost }
        },
      },
    })
    expect(result.finalEvidence?.record.reservation.requestId).toBe('run')
    expect(result.finalEvidence?.claim.independentUnit).toBe('sourceId')
    expect(result.finalEvidence?.record.reservation.unitIds).toHaveLength(1)
    expect(result.raw.baselineOnHoldout.cells).toHaveLength(3)
  })

  it('keeps failed final execution consumed and exposes a control before scoring any arm', async () => {
    const selectedPolicy = policy()
    await expect(
      runImprovementLoop({
        scenarios: train,
        holdoutScenarios: final,
        baselineSurface: 'BASE',
        judges: [judge],
        gate,
        proposer: { kind: 'fixed', propose: async () => ['WIN'] },
        populationSize: 1,
        maxGenerations: 1,
        neutralize: () => 'CONTROL',
        claim: claim(),
        finalEvidence: selectedPolicy,
        dispatchWithSurface: async (surface, scenario) => {
          if (scenario.id.startsWith('final')) {
            expect((await record()).exposure?.measurement.candidateDigests).toHaveLength(3)
            throw new Error('final worker failed')
          }
          return { quality: surface === 'BASE' ? 0 : 1 }
        },
        runDir: dir,
        storage: inMemoryCampaignStorage(),
        autoOnPromote: 'none',
        expectUsage: 'off',
      }),
    ).rejects.toThrow(/incomplete/)
    expect((await record()).exposure).not.toBeNull()
    await expect(reserveFinalEvidence(policy('another-run'), claim(), final)).rejects.toThrow(
      /already reserved/,
    )
  })

  it('averages final variants within registered units before comparing optimizers', async () => {
    const test = [
      source('a1', 'a'),
      source('a2', 'a'),
      source('a3', 'a'),
      source('a4', 'a'),
      source('b1', 'b'),
      source('c1', 'c'),
    ]
    const result = await compareOptimizationMethods<Case, Artifact>({
      trainScenarios: train.slice(0, 2),
      selectionScenarios: train.slice(2),
      testScenarios: test,
      baselineSurface: 'BASE',
      judges: [judge],
      reps: 2,
      claim: claim(),
      finalEvidence: policy(),
      methods: [
        {
          name: 'fixed',
          optimize: async () => {
            expect((await record()).exposure).toBeNull()
            return { winnerSurface: 'WIN', cost: freeCost }
          },
        },
      ],
      dispatchWithSurface: async (surface, scenario) => {
        expect((await record()).exposure).not.toBeNull()
        return { quality: surface === 'WIN' && scenario.sourceId === 'a' ? 1 : 0 }
      },
      runDir: dir,
      storage: inMemoryCampaignStorage(),
      expectUsage: 'off',
    })
    expect(result.best.winnerComposite).toBeCloseTo(1 / 3)
    expect(result.best.scenarioScores).toHaveLength(6)
    expect(result.best.unitScores).toHaveLength(3)
    expect(result.best.decision).toMatchObject({ n: 3, sufficient: false, promote: false })
    expect(result.units).toMatchObject({ observations: 6, independentUnits: 3 })
    expect(result.pairedCellN).toBe(12)
    expect(result.finalEvidence?.record.exposure).not.toBeNull()
  })

  it.each(
    [
      {
        baselinePattern: 'zero',
        before: { a: 0, b: 0, c: 0 },
        after: { a: 1, b: 0, c: 0 },
        expectedBaseline: 0,
        expectedWinner: 1 / 3,
        expectedLift: 1 / 3,
        expectedSd: 0,
      },
      {
        baselinePattern: 'varying',
        before: { a: 0.2, b: 0.4, c: 0.6 },
        after: { a: 0.8, b: 0.4, c: 0.6 },
        expectedBaseline: 0.4,
        expectedWinner: 0.6,
        expectedLift: 0.2,
        expectedSd: 0.2,
      },
    ].flatMap((fixture) => (['method', 'proposer'] as const).map((mode) => ({ ...fixture, mode }))),
  )(
    'reports $mode means over gate units with a $baselinePattern baseline',
    async ({ mode, before, after, expectedBaseline, expectedWinner, expectedLift, expectedSd }) => {
      const heldout = [
        source('a1', 'a'),
        source('a2', 'a'),
        source('a3', 'a'),
        source('a4', 'a'),
        source('b1', 'b'),
        source('c1', 'c'),
      ]
      const events: SelfImproveProgressEvent[] = []
      const storage = inMemoryCampaignStorage()
      const result = await selfImprove({
        scenarios: [...train, ...heldout],
        judge,
        baselineSurface: 'BASE',
        claim: { ...claim(), minimumEffect: 0.1 },
        storage,
        runDir: dir,
        model: 'fixture@2026-09-13',
        expectUsage: 'off',
        budget: {
          holdoutScenarios: heldout,
          reps: 2,
          ...(mode === 'proposer' ? { generations: 1, populationSize: 1 } : {}),
        },
        agent: async (surface, scenario) => {
          const values = surface === 'BASE' ? before : after
          if (scenario.sourceId === 'a') return { quality: values.a }
          if (scenario.sourceId === 'b') return { quality: values.b }
          if (scenario.sourceId === 'c') return { quality: values.c }
          return { quality: surface === 'BASE' ? 0 : 1 }
        },
        ...(mode === 'method'
          ? {
              method: {
                name: 'fixed',
                optimize: async () => ({ winnerSurface: 'WIN', cost: freeCost }),
              },
            }
          : { proposer: { kind: 'fixed', propose: async () => ['WIN'] } }),
        onProgress: (event) => events.push(event),
      })

      expect(result.winner.surface).toBe('WIN')
      expect(result.baseline?.compositeMean).toBeCloseTo(expectedBaseline)
      expect(result.winner.compositeMean).toBeCloseTo(expectedWinner)
      expect(result.lift).toBeCloseTo(expectedLift)
      expect(result.insight?.lift?.delta).toBeCloseTo(expectedLift)
      expect(result.insight?.lift).toMatchObject({
        n: 3,
        pairedRunN: 12,
        independentUnitIds: ['a', 'b', 'c'],
      })
      expect(result.raw.gateResult.delta).toBeCloseTo(result.lift!)
      expect(
        result.raw.gateResult.contributingGates.find((gate) => gate.name === 'heldout-significance')
          ?.detail,
      ).toMatchObject({
        n: 3,
        pairedCellN: 12,
        unitIds: ['a', 'b', 'c'],
      })
      expect(result.winner.perScenario).toEqual({
        a1: after.a,
        a2: after.a,
        a3: after.a,
        a4: after.a,
        b1: after.b,
        c1: after.c,
      })
      expect(result.provenance.baselineHoldoutComposite).toBeCloseTo(expectedBaseline)
      expect(result.provenance.winnerHoldoutComposite).toBeCloseTo(expectedWinner)
      expect(result.provenance.heldOutLift).toBeCloseTo(result.lift!)
      expect(result.provenance.claim?.independentUnit).toBe('sourceId')
      const observations =
        result.mode === 'method'
          ? result.provenance.evidence.holdoutObservations
          : result.provenance.evidence.holdout.observations
      expect(observations).toEqual({
        pairedCellN: 12,
        unitIds: ['a', 'b', 'c'],
        unscoredCellIds: [],
        independentUnitByScenarioId: { a1: 'a', a2: 'a', a3: 'a', a4: 'a', b1: 'b', c1: 'c' },
      })
      expect(events.find((event) => event.kind === 'gate.decided')).toMatchObject({
        lift: result.lift,
      })
      const artifact = mode === 'method' ? 'method-provenance.json' : 'loop-provenance.json'
      expect(JSON.parse(storage.read(join(dir, artifact))!)).toEqual(result.provenance)
      if (result.mode === 'proposer') {
        expect(result.power).toMatchObject({ n: 3, deltaThreshold: 0.1 })
        expect(result.power?.baselineMean).toBeCloseTo(expectedBaseline)
        expect(result.power?.sd).toBeCloseTo(expectedSd)
        expect(events.find((event) => event.kind === 'power.estimated')).toMatchObject({ n: 3 })
      }
    },
  )

  it('does not collapse an unavailable ledger into an evidence conflict', async () => {
    const unavailable: FinalEvidenceLedger = {
      reserve: async () => ({
        succeeded: false,
        error: { kind: 'unavailable', message: 'storage offline' },
      }),
      expose: async () => {
        throw new Error('must not dispatch')
      },
      read: async () => ({ succeeded: true, value: [] }),
    }
    const operation = exposeFinalEvidence({ ...policy(), ledger: unavailable }, claim(), final, [
      'BASE',
    ])
    await expect(operation).rejects.toBeInstanceOf(FinalEvidenceError)
    await expect(operation).rejects.toMatchObject({ kind: 'unavailable' })
  })
})
