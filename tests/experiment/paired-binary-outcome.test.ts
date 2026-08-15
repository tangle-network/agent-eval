/**
 * A binary outcome, carried end to end through a sealed experiment.
 *
 * The spec below is the shape `scripts/tb-gated-stop-ab.ts` registers: a
 * `binary` outcome, a `paired-mean-diff` over the boolean `passed` field, a
 * task-clustered bootstrap, and the four-branch decision table those two feed.
 * The suite runs that path on evidence rows whose `passed` field is a boolean,
 * because that is the type an injected test suite reports.
 */

import { describe, expect, it } from 'vitest'
import { ValidationError } from '../../src/errors'
import {
  computeEstimand,
  type EvidenceRecord,
  type ExperimentSpec,
  openSealedExperiment,
  sealExperiment,
} from '../../src/experiment/index'

const gatedStopSpec: ExperimentSpec = {
  id: 'gated-stop-binary-outcome',
  hypothesis:
    'A gated continuation recovers more failed rows than a blind continuation on the same budget.',
  arms: [
    { id: 'blind-continue', role: 'control', policyDigest: 'pinned-continuation@v2' },
    { id: 'gated-continue', role: 'treatment', policyDigest: 'pinned-continuation@v2' },
  ],
  outcome: {
    kind: 'binary',
    source: 'injected-suite',
    digestVerified: true,
    pass: 'reward-file-contains-1',
    droppedRollouts: 'forbidden',
  },
  estimands: {
    pairedContrast: {
      kind: 'paired-mean-diff',
      armField: 'arm',
      treatment: 'gated-continue',
      control: 'blind-continue',
      pairBy: 'rowId',
      value: 'passed',
      missing: 'zero-diff',
    },
  },
  intervals: {
    pairedContrast95: {
      kind: 'cluster-bootstrap',
      clusterBy: 'taskName',
      resamples: 2_000,
      seed: 20260814,
      level: 0.95,
      method: 'percentile',
    },
  },
  decision: {
    kind: 'table',
    branches: [
      {
        when: {
          kind: 'all',
          of: [
            { kind: 'interval-excludes-zero', interval: 'pairedContrast95', sign: 'positive' },
            { kind: 'obligation-met', obligation: 'matched-realized-tokens' },
          ],
        },
        verdict: 'gated-stop-survives',
        report: ['pairedContrast', 'pairedContrast95'],
      },
      {
        when: {
          kind: 'all',
          of: [
            { kind: 'interval-excludes-zero', interval: 'pairedContrast95', sign: 'negative' },
            { kind: 'obligation-met', obligation: 'matched-realized-tokens' },
          ],
        },
        verdict: 'gated-stop-dies',
        report: ['pairedContrast', 'pairedContrast95'],
      },
      {
        when: { kind: 'interval-includes-zero', interval: 'pairedContrast95' },
        verdict: 'no-effect-resolved-at-this-n',
        report: ['pairedContrast', 'pairedContrast95'],
      },
      {
        when: {
          kind: 'not',
          of: { kind: 'obligation-met', obligation: 'matched-realized-tokens' },
        },
        verdict: 'contrast-refused-unmatched-budget',
        report: ['pairedContrast95'],
      },
    ],
  },
  obligations: [
    {
      id: 'matched-realized-tokens',
      appliesToVerdicts: ['gated-stop-survives', 'gated-stop-dies'],
      control: 'realized prompt and completion tokens agree within 5 % between arms',
    },
  ],
  seedDerivation: { from: ['seed', 'rowId', 'rolloutIndex'] },
  seed: 20260814,
}

/** Eight tasks, two rows each: 16 pairs, clustered by task. */
const TASKS = ['t0', 't1', 't2', 't3', 't4', 't5', 't6', 't7'] as const

/** Treatment passes the first row of every task, and the second row of t0..t2. */
function treatmentPassed(task: string, row: number): boolean {
  return row === 0 || task === 't0' || task === 't1' || task === 't2'
}

/** Control passes only the second row of t0 and t1. */
function controlPassed(task: string, row: number): boolean {
  return row === 1 && (task === 't0' || task === 't1')
}

function booleanRows(): EvidenceRecord[] {
  const rows: EvidenceRecord[] = []
  for (const taskName of TASKS) {
    for (const row of [0, 1]) {
      const rowId = `${taskName}-r${row}`
      rows.push({ rowId, taskName, arm: 'gated-continue', passed: treatmentPassed(taskName, row) })
      rows.push({ rowId, taskName, arm: 'blind-continue', passed: controlPassed(taskName, row) })
    }
  }
  return rows
}

/** The same evidence with the outcome hand-encoded as 1 and 0. */
function encodedRows(): EvidenceRecord[] {
  return booleanRows().map((row) => ({ ...row, passed: row.passed === true ? 1 : 0 }))
}

/** One difference per pair, the row shape the clustered bootstrap resamples. */
function pairDifferenceRows(): EvidenceRecord[] {
  const rows: EvidenceRecord[] = []
  for (const taskName of TASKS) {
    for (const row of [0, 1]) {
      const treatment = treatmentPassed(taskName, row) ? 1 : 0
      const control = controlPassed(taskName, row) ? 1 : 0
      rows.push({ rowId: `${taskName}-r${row}`, taskName, diff: treatment - control })
    }
  }
  return rows
}

describe('paired-mean-diff over a binary outcome', () => {
  it('reads boolean pass/fail as the risk difference', () => {
    const result = computeEstimand(gatedStopSpec.estimands!.pairedContrast!, booleanRows())
    // 9 of 16 pairs improve; none regress.
    expect(result.numerator).toBe(9)
    expect(result.denominator).toBe(16)
    expect(result.value).toBeCloseTo(9 / 16, 12)
  })

  it('gives the identical number whether the caller encodes the outcome or not', () => {
    const fromBooleans = computeEstimand(gatedStopSpec.estimands!.pairedContrast!, booleanRows())
    const fromNumbers = computeEstimand(gatedStopSpec.estimands!.pairedContrast!, encodedRows())
    expect(fromBooleans).toEqual(fromNumbers)
  })

  it('keeps zero-diff semantics when one arm never answered a pair', () => {
    const rows = booleanRows().filter(
      (row) => !(row.rowId === 't0-r0' && row.arm === 'blind-continue'),
    )
    // t0-r0 kept its passing treatment side, so the sum is unchanged.
    const result = computeEstimand(gatedStopSpec.estimands!.pairedContrast!, rows)
    expect(result.numerator).toBe(9)
    expect(result.denominator).toBe(16)
  })

  it.each([
    ['a string', 'true'],
    ['null', null],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['an absent field', undefined],
  ])('rejects %s in the outcome field', (_label, value) => {
    const rows = booleanRows().map((row) =>
      row.rowId === 't3-r1' && row.arm === 'gated-continue' ? { ...row, passed: value } : row,
    )
    expect(() => computeEstimand(gatedStopSpec.estimands!.pairedContrast!, rows)).toThrow(
      ValidationError,
    )
    expect(() => computeEstimand(gatedStopSpec.estimands!.pairedContrast!, rows)).toThrow(
      /is not a finite number or a boolean on pair 't3-r1'/,
    )
  })
})

describe('the sealed gated-stop path, from boolean rows to a verdict', () => {
  it('estimates, brackets, and decides without the caller re-encoding anything', async () => {
    const sealed = await sealExperiment(gatedStopSpec, { sealedAt: '2026-08-14T00:00:00Z' })
    const registered = await openSealedExperiment(sealed)

    const estimate = registered.estimate('pairedContrast', booleanRows())
    expect(estimate.value).toBeCloseTo(9 / 16, 12)

    const interval = registered.interval('pairedContrast95', {
      kind: 'rows',
      rows: pairDifferenceRows(),
      value: 'diff',
    })
    // Every task cluster carries at least one improved pair and no regression,
    // so no resample of whole clusters can reach zero.
    expect(interval.lower).toBeGreaterThan(0)
    expect(interval.upper).toBeLessThanOrEqual(1)
    expect(interval.level).toBe(0.95)

    const outcome = registered.decide({
      intervals: { pairedContrast95: { lower: interval.lower, upper: interval.upper } },
      quantities: {},
      obligationsMet: { 'matched-realized-tokens': true },
    })
    expect(outcome.verdict).toBe('gated-stop-survives')
    expect(outcome.report).toEqual(['pairedContrast', 'pairedContrast95'])
  })

  it('brackets a boolean pass rate directly, with the same reading', async () => {
    const sealed = await sealExperiment(gatedStopSpec, { sealedAt: '2026-08-14T00:00:00Z' })
    const registered = await openSealedExperiment(sealed)
    const treatmentRows = booleanRows().filter((row) => row.arm === 'gated-continue')
    const interval = registered.interval('pairedContrast95', {
      kind: 'rows',
      rows: treatmentRows,
      value: 'passed',
    })
    // 11 of 16 treatment rows pass, so the bootstrap sits inside (0, 1).
    expect(interval.lower).toBeGreaterThan(0)
    expect(interval.upper).toBeLessThanOrEqual(1)
  })
})
