import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/errors'
import { computeInterval, type IntervalSpec } from '../../src/experiment/ast'
import {
  defineExperiment,
  type ExperimentSpec,
  openSealedExperiment,
  sealExperiment,
} from '../../src/experiment/define'

const interval: Extract<IntervalSpec, { kind: 'cluster-bootstrap' }> = {
  kind: 'cluster-bootstrap',
  clusterBy: 'source',
  value: 'adverse',
  resamples: 1_000,
  seed: 7,
  level: 0.95,
  method: 'percentile',
}

function registration(effect: IntervalSpec = interval): ExperimentSpec {
  return {
    id: 'interval-integrity',
    arms: [{ id: 'candidate', role: 'treatment' }],
    outcome: { kind: 'bounded-score', min: -1, max: 1, orientation: 'higher-is-better' },
    intervals: { effect },
    decision: { kind: 'report-only', estimands: [], intervals: ['effect'] },
  }
}

const rows = Array.from({ length: 30 }, (_, index) => ({
  source: `incident-${index}`,
  favourable: 0.1 + index / 1_000,
  adverse: -0.1 - index / 1_000,
}))

describe('registered interval integrity', () => {
  it('binds the measured field to the seal and refuses an execution-time replacement', async () => {
    const sealed = await sealExperiment(registration())
    const experiment = await openSealedExperiment(sealed)
    expect(experiment.interval('effect', { kind: 'rows', rows }).upper).toBeLessThan(0)
    const unsealedSelector = { kind: 'rows' as const, rows, value: 'favourable' }
    expect(() => experiment.interval('effect', unsealedSelector)).toThrow(
      /register value in the interval spec/,
    )

    const changed = await sealExperiment(registration({ ...interval, value: 'favourable' }))
    expect(changed.digest).not.toBe(sealed.digest)
    const amended = await openSealedExperiment(changed)
    expect(amended.interval('effect', { kind: 'rows', rows }).lower).toBeGreaterThan(0)
  })

  it.each([
    { patch: { level: 0 }, message: 'level' },
    { patch: { level: 1 }, message: 'level' },
    { patch: { level: Number.NaN }, message: 'level' },
    { patch: { level: Number.POSITIVE_INFINITY }, message: 'level' },
    { patch: { resamples: 0 }, message: 'resamples' },
    { patch: { resamples: -1 }, message: 'resamples' },
    { patch: { resamples: 1.5 }, message: 'resamples' },
    { patch: { resamples: Number.MAX_SAFE_INTEGER }, message: 'resamples' },
    { patch: { seed: Number.NaN }, message: 'seed' },
    { patch: { seed: Number.POSITIVE_INFINITY }, message: 'seed' },
    { patch: { seed: 1.5 }, message: 'seed' },
    { patch: { clusterBy: '' }, message: 'clusterBy' },
    { patch: { clusterBy: 'source..id' }, message: 'clusterBy' },
    { patch: { clusterBy: ' source' }, message: 'clusterBy' },
    { patch: { value: undefined }, message: 'value' },
    { patch: { value: '' }, message: 'value' },
    { patch: { value: 'score.' }, message: 'value' },
    { patch: { method: 'unregistered-method' }, message: 'method' },
  ])(
    'refuses malformed $message both before sealing and at direct execution',
    ({ patch, message }) => {
      // Untyped JSON and JavaScript callers can supply values outside the declared union.
      const invalid = { ...interval, ...patch } as IntervalSpec
      expect(() => defineExperiment(registration(invalid))).toThrow(message)
      expect(() => computeInterval(invalid, { kind: 'rows', rows })).toThrow(ValidationError)
    },
  )

  it.each([undefined, null, {}, [], Number.NaN, ''])(
    'refuses an unidentified cluster: %j',
    (source) => {
      expect(() =>
        computeInterval(interval, {
          kind: 'rows',
          rows: [...rows, { source, adverse: 0 }],
        }),
      ).toThrow(/cluster field 'source'/)
    },
  )

  it('keeps numeric and string cluster identities distinct', () => {
    const result = computeInterval(interval, {
      kind: 'rows',
      rows: [
        { source: 1, adverse: 0 },
        { source: '1', adverse: 1 },
      ],
    })
    expect(result).toEqual({ lower: 0, upper: 1, level: 0.95 })
  })

  it('refuses arithmetic overflow instead of returning an infinite interval', () => {
    expect(() =>
      computeInterval(interval, {
        kind: 'rows',
        rows: [
          { source: 'a', adverse: Number.MAX_VALUE },
          { source: 'b', adverse: Number.MAX_VALUE },
        ],
      }),
    ).toThrow(/overflowed/)
  })

  it.each([
    { successes: 1.5, trials: 2 },
    { successes: 0, trials: 0 },
    { successes: 3, trials: 2 },
    { successes: 1, trials: Number.POSITIVE_INFINITY },
    { successes: 1, trials: Number.MAX_SAFE_INTEGER + 1 },
  ])('refuses invalid binomial counts before computing tails: %j', (counts) => {
    expect(() =>
      computeInterval(
        { kind: 'clopper-pearson', level: 0.95 },
        {
          kind: 'binomial',
          ...counts,
        },
      ),
    ).toThrow(ValidationError)
  })

  it.each([0, 1, Number.NaN, Number.POSITIVE_INFINITY])(
    'refuses invalid binomial confidence %s',
    (level) => {
      const spec: IntervalSpec = { kind: 'clopper-pearson', level }
      expect(() => defineExperiment(registration(spec))).toThrow(/level/)
      expect(() => computeInterval(spec, { kind: 'binomial', successes: 1, trials: 2 })).toThrow(
        /level/,
      )
    },
  )
})
