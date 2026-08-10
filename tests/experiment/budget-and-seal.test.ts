/**
 * Matched-budget refusal and seal integrity: the refusal is an object inside
 * the verdict, and changing what is decided requires a new digest.
 */

import { describe, expect, it } from 'vitest'
import {
  assertMatchedBudgets,
  defineExperiment,
  type ExperimentSpec,
  MatchedBudgetError,
  type MatchedBudgetRule,
  openSealedExperiment,
  SealIntegrityError,
  sealExperiment,
  verifyMatchedBudgets,
  verifySealedExperiment,
} from '../../src/experiment/index'

const rule: MatchedBudgetRule = {
  measure: 'realized-tokens',
  tolerance: 0.05,
  onFail: 'refuse-contrast',
}

describe('verifyMatchedBudgets', () => {
  it('matches arms within the registered tolerance', () => {
    const verdict = verifyMatchedBudgets(rule, [
      { armId: 'B', realizedTokens: 100_000 },
      { armId: 'C', realizedTokens: 96_500 },
    ])
    expect(verdict.matched).toBe(true)
    expect(verdict.refusal).toBeNull()
    expect(verdict.maxRelativeGap).toBeCloseTo(0.035, 10)
  })

  it('refuses arms that diverge past the tolerance — the refusal is in the artifact', () => {
    const verdict = verifyMatchedBudgets(rule, [
      { armId: 'B', realizedTokens: 100_000 },
      { armId: 'C', realizedTokens: 80_000 },
    ])
    expect(verdict.matched).toBe(false)
    expect(verdict.refusal).not.toBeNull()
    expect(verdict.refusal!.onFail).toBe('refuse-contrast')
    expect(verdict.refusal!.reason).toContain('20.0%')
    expect(verdict.widestPair).toEqual(['C', 'B'])
    expect(() =>
      assertMatchedBudgets(rule, [
        { armId: 'B', realizedTokens: 100_000 },
        { armId: 'C', realizedTokens: 80_000 },
      ]),
    ).toThrow(MatchedBudgetError)
  })

  it('refuses fewer than two arms and corrupt token counts', () => {
    expect(() => verifyMatchedBudgets(rule, [{ armId: 'B', realizedTokens: 10 }])).toThrow(
      MatchedBudgetError,
    )
    expect(() =>
      verifyMatchedBudgets(rule, [
        { armId: 'B', realizedTokens: -1 },
        { armId: 'C', realizedTokens: 10 },
      ]),
    ).toThrow(/invalid realized tokens/)
  })

  it('treats two zero-spend arms as matched', () => {
    const verdict = verifyMatchedBudgets(rule, [
      { armId: 'B', realizedTokens: 0 },
      { armId: 'C', realizedTokens: 0 },
    ])
    expect(verdict.matched).toBe(true)
  })
})

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

describe('seal integrity', () => {
  it('a tampered seal is rejected before any executor is handed out', async () => {
    const sealed = await sealExperiment(minimalSpec)
    const tampered = {
      ...sealed,
      spec: structuredClone({
        ...minimalSpec,
        decision: {
          kind: 'table' as const,
          branches: [
            {
              // the tampered rule inverts the registered sign
              when: {
                kind: 'interval-excludes-zero' as const,
                interval: 'primary-95',
                sign: 'negative' as const,
              },
              verdict: 'ship',
              report: [],
            },
            {
              when: {
                kind: 'not' as const,
                of: {
                  kind: 'interval-excludes-zero' as const,
                  interval: 'primary-95',
                  sign: 'negative' as const,
                },
              },
              verdict: 'hold',
              report: [],
            },
          ],
        },
      }),
    }
    expect(await verifySealedExperiment(tampered)).toBe(false)
    await expect(openSealedExperiment(tampered)).rejects.toThrow(SealIntegrityError)
  })

  it('a decision table that is not total throws instead of inventing a verdict', async () => {
    const sealed = await sealExperiment({
      ...minimalSpec,
      decision: {
        kind: 'table',
        branches: [
          {
            when: { kind: 'interval-excludes-zero', interval: 'primary-95', sign: 'positive' },
            verdict: 'ship',
            report: [],
          },
        ],
      },
    })
    const registered = await openSealedExperiment(sealed)
    expect(() =>
      registered.decide({
        intervals: { 'primary-95': { lower: -0.2, upper: 0.1 } },
        quantities: {},
        obligationsMet: {},
      }),
    ).toThrow(/not total/)
  })

  it('executors refuse rules the experiment never registered', async () => {
    const sealed = await sealExperiment(minimalSpec)
    const registered = await openSealedExperiment(sealed)
    expect(() => registered.halt([])).toThrow(/registered no halt rule/)
    expect(() => registered.matchedBudgets([])).toThrow(/registered no matched-budget rule/)
    expect(() => registered.estimate('missing', [])).toThrow(/registered no estimand 'missing'/)
    expect(() => registered.runUniformPassBudget([1])).toThrow(/registered no budget rule/)
  })

  it('gate evidence of the wrong kind is refused, not coerced', async () => {
    const sealed = await sealExperiment({
      ...minimalSpec,
      gates: {
        identity: { kind: 'identity', field: 'served-model', op: 'basename-eq', onFail: 'abort' },
      },
    })
    const registered = await openSealedExperiment(sealed)
    expect(() =>
      registered.gate('identity', { kind: 'oracle-determinism', repsByState: {} }),
    ).toThrow(/registered as identity but received oracle-determinism/)
  })
})
