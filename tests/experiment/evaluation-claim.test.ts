import { describe, expect, it } from 'vitest'
import {
  defineEvaluationClaim,
  type EvaluationClaim,
  summarizeEvaluationUnits,
} from '../../src/experiment/claim'
import {
  amendExperiment,
  defineExperiment,
  type ExperimentSpec,
  openSealedExperiment,
  type SealedExperiment,
  sealExperiment,
} from '../../src/experiment/define'

const claim: EvaluationClaim = {
  use: 'comparison',
  population: { id: 'incidents', description: 'New support incidents' },
  samplingFrame: 'A random sample from the incident queue',
  independentUnit: 'source.id',
  generalization: 'new-units',
  minimumEffect: 0.05,
}

function spec(): ExperimentSpec {
  return {
    id: 'claimed-comparison',
    claim,
    arms: [{ id: 'candidate', role: 'treatment' }],
    outcome: { kind: 'binary' },
    intervals: {
      gain: {
        kind: 'cluster-bootstrap',
        clusterBy: 'source.id',
        value: 'value',
        resamples: 1000,
        seed: 7,
        level: 0.95,
        method: 'percentile',
      },
      rate: { kind: 'clopper-pearson', level: 0.95 },
    },
    decision: { kind: 'report-only', estimands: [], intervals: ['gain', 'rate'] },
  }
}

describe('registered evaluation claims', () => {
  it('distinguishes repeated observations from independent evidence', async () => {
    const experiment = await openSealedExperiment(await sealExperiment(spec()))
    const replicas = Array.from({ length: 100 }, () => ({ source: { id: 'incident-1' }, value: 1 }))
    expect(experiment.units(replicas)).toMatchObject({ observations: 100, independentUnits: 1 })
    expect(() => experiment.interval('gain', { kind: 'rows', rows: replicas })).toThrow(
      /2 clusters/,
    )
    const independent = replicas.map((row, i) => ({
      ...row,
      source: { id: `incident-${i}` },
      value: i % 2,
    }))
    const measured = experiment.interval('gain', { kind: 'rows', rows: independent })
    expect(measured.units).toMatchObject({ observations: 100, independentUnits: 100 })
    expect(measured.lower).toBeLessThan(0.5)
    expect(measured.upper).toBeGreaterThan(0.5)
  })

  it('refuses an estimator that resamples variants instead of source units', () => {
    const registration = spec()
    registration.intervals!.gain = {
      kind: 'cluster-bootstrap',
      clusterBy: 'id',
      value: 'value',
      resamples: 1000,
      seed: 7,
      level: 0.95,
      method: 'percentile',
    }
    expect(() => defineExperiment(registration)).toThrow(/must resample 'source.id'/)
  })

  it('requires power at the claimed minimum effect', () => {
    const registration = spec()
    registration.gates = {
      power: {
        kind: 'power-floor',
        target: 0.8,
        minimumEffect: 0.5,
        effectGrid: [0.05, 0.5],
        sim: { trials: 100, resamples: 1000, seed: 7 },
      },
    }
    expect(() => defineExperiment(registration)).toThrow(/differs from the evaluation claim/)
  })

  it('requires one identified independent trial for a new-unit binomial interval', async () => {
    const experiment = await openSealedExperiment(await sealExperiment(spec()))
    for (const unitIds of [undefined, ['a'], ['a', 'a'], ['a', ' b']]) {
      expect(() =>
        experiment.interval('rate', { kind: 'binomial', trials: 2, successes: 1, unitIds }),
      ).toThrow(/unique unitId/)
    }
    const rate = experiment.interval('rate', {
      kind: 'binomial',
      trials: 2,
      successes: 1,
      unitIds: ['a', 'b'],
    })
    expect(rate.units?.independentUnits).toBe(2)
    expect(rate.lower).toBeGreaterThan(0)
    expect(rate.upper).toBeLessThan(1)
  })

  it('captures the seal before any asynchronous work or caller mutation', async () => {
    const input: SealedExperiment = JSON.parse(JSON.stringify(await sealExperiment(spec())))
    const opening = openSealedExperiment(input)
    input.spec.claim!.independentUnit = 'variant'
    input.spec.intervals!.rate = { kind: 'clopper-pearson', level: 0.5 }
    const experiment = await opening
    expect(experiment.sealed.spec.claim?.independentUnit).toBe('source.id')
    expect(
      experiment.interval('rate', {
        kind: 'binomial',
        trials: 2,
        successes: 1,
        unitIds: ['a', 'b'],
      }).level,
    ).toBe(0.95)
    expect(Object.isFrozen(experiment.sealed.spec.intervals)).toBe(true)
  })

  it('rejects ambiguous identities instead of normalizing sealed metadata', () => {
    expect(() =>
      defineEvaluationClaim({ ...claim, population: { ...claim.population, id: ' incidents' } }),
    ).toThrow()
    expect(() => summarizeEvaluationUnits(claim, [{ source: {} }])).toThrow(/source.id/)
    expect(() => summarizeEvaluationUnits(claim, [{ source: { id: ' ' } }])).toThrow(/source.id/)
  })

  it('captures the prior seal and requested amendment before asynchronous verification', async () => {
    const input: SealedExperiment = JSON.parse(JSON.stringify(await sealExperiment(spec())))
    const initialDigest = input.initialDigest
    const requested = { spec: spec(), reason: 'registered change', blind: ['outcomes'] }
    const pending = amendExperiment(input, requested)
    input.initialDigest = '0'.repeat(64)
    input.amendments.push({ at: 'invented', reason: 'invented', blind: [], digest: 'a'.repeat(64) })
    requested.spec.intervals!.rate = { kind: 'clopper-pearson', level: 0.5 }
    requested.reason = 'changed after verification began'
    requested.blind.length = 0
    const amended = await pending
    expect(amended.initialDigest).toBe(initialDigest)
    expect(amended.amendments).toHaveLength(1)
    expect(amended.amendments[0]).toMatchObject({
      reason: 'registered change',
      blind: ['outcomes'],
    })
    expect(amended.spec.intervals!.rate).toEqual({ kind: 'clopper-pearson', level: 0.95 })
  })
})
