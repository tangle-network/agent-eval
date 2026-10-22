/**
 * Matched-budget refusal and seal integrity: the refusal is an object inside
 * the verdict, and changing what is decided requires a new digest.
 */

import { describe, expect, it } from 'vitest'
import { defineExperiment, type ExperimentSpec } from '../../src/experiment/index'

const minimalSpec: ExperimentSpec = {
  id: 'seal-check',
  arms: [
    { id: 'control', role: 'control' },
    { id: 'candidate', role: 'treatment' },
  ],
  outcome: { kind: 'binary' },
  intervals: {
    'primary-95': {
      kind: 'cluster-bootstrap',
      clusterBy: 'taskName',
      value: 'diff',
      resamples: 1000,
      seed: 7,
      level: 0.95,
      method: 'percentile',
    },
  },
  decision: {
    kind: 'table',
    branches: [
      {
        when: { kind: 'interval-excludes-zero', interval: 'primary-95', sign: 'positive' },
        verdict: 'ship',
        report: ['primary-95'],
      },
      {
        when: {
          kind: 'not',
          of: { kind: 'interval-excludes-zero', interval: 'primary-95', sign: 'positive' },
        },
        verdict: 'hold',
        report: ['primary-95'],
      },
    ],
  },
}

describe('defineExperiment validation', () => {
  it('refuses a decision that reads an unregistered interval', () => {
    expect(() =>
      defineExperiment({
        ...minimalSpec,
        intervals: {},
      }),
    ).toThrow(/unregistered interval 'primary-95'/)
  })

  it('refuses a halt rule that references an unregistered gate', () => {
    expect(() =>
      defineExperiment({
        ...minimalSpec,
        halt: {
          when: { kind: 'any-gate-failed', gates: ['power-floor'] },
          action: 'refuse-spend',
          report: 'settling-n',
        },
      }),
    ).toThrow(/unregistered gate 'power-floor'/)
  })

  it('refuses a filter-of selection over an unknown base', () => {
    expect(() =>
      defineExperiment({
        ...minimalSpec,
        selections: {
          subset: {
            kind: 'filter-of',
            base: 'never-drawn',
            keep: { kind: 'compare', field: 'taskName', op: 'eq', value: 't' },
            order: { field: 'rowId', dir: 'asc' },
          },
        },
      }),
    ).toThrow(/unregistered base 'never-drawn'/)
  })

  it('refuses an experiment with no treatment arm', () => {
    expect(() =>
      defineExperiment({
        ...minimalSpec,
        arms: [{ id: 'only', role: 'control' }],
      }),
    ).toThrow(/at least one arm must have role treatment/)
  })

  it('freezes the validated spec', () => {
    const spec = defineExperiment(minimalSpec)
    expect(Object.isFrozen(spec)).toBe(true)
    expect(Object.isFrozen(spec.arms[0])).toBe(true)
  })
})

/** Produce a correctly hashed retired record to exercise scheme rejection. */
