/**
 * A plan sealed before `format` existed verifies under the digest it was
 * sealed with and runs under the rules it was sealed with.
 *
 * `released` is the measure validity example's plan as the released code
 * resolved it, and its digest is the one that code printed for the example in
 * examples/measure-validity/README.md (commit a8d01edf). Replaying the
 * example's table must reproduce that README's labels and selection.
 */

import { describe, expect, it } from 'vitest'
import { DAY, generatedHistory, HOUR, storeOf, toChange } from '../../examples/measure-validity/history'
import {
  type MeasureValidityPlanInput,
  type SealedMeasureValidityPlan,
  sealMeasureValidityPlan,
  verifyMeasureValidityPlan,
} from '../../src/experiment'
import { measureValidityStudy } from '../../src/meta-eval'

const released: SealedMeasureValidityPlan = {
  plan: {
    id: 'which-numbers-predict-kept-changes',
    cut: 1000 * HOUR,
    level: 0.05,
    outcomes: [{ id: 'kept', direction: 'higher-is-better', kind: 'binary' }],
    measures: [
      { id: 'review_depth', cost: 2 },
      { id: 'review_depth_copy', cost: 2 },
      { id: 'test_delta', noise: 0.1, cost: 1 },
      { id: 'repo_size', cost: 1 },
      { id: 'hotfix', cost: 1 },
      ...Array.from({ length: 20 }, (_, i) => ({
        id: `noise_${String(i).padStart(2, '0')}`,
        cost: 1,
      })),
    ],
    minJoined: 100,
    minUnits: 20,
    minMinority: 20,
    resamples: 400,
    confidence: 0.95,
    reduction: 'latest',
    minSensitivity: 0.05,
    selection: { maxMeasures: 3, minGain: 0.01, maxRedundancy: 0.9 },
  },
  digest: '5b20e1012f4521137dfd3025309bfc68bcb2c9cd7b1b1ed64e88a1e0a949fad4',
  algo: 'sha256-rfc8785',
  sealedAt: '2026-11-22T00:00:00.000Z',
}

describe('measure validity plan format', () => {
  it('verifies a plan sealed before format existed', () => {
    expect(released.plan.format).toBeUndefined()
    expect(verifyMeasureValidityPlan(released)).toBe(true)
  })

  it('runs it under the rules it was sealed with', async () => {
    const rows = generatedHistory().table(2100, 0, 2100 * HOUR)
    const report = await measureValidityStudy({
      plan: released,
      changes: rows.map(toChange),
      outcomes: await storeOf(rows),
    })
    expect(report.planDigest).toBe(released.digest)
    expect(report.changes).toMatchObject({ preCut: 1000, postCut: 1100 })
    expect(report.tested).toBe(24)
    expect(report.admitted).toBe(3)
    const summary = (measure: string) => {
      const pair = report.pairs.find((row) => row.measure === measure)!
      return [
        pair.label,
        pair.reason,
        pair.postCut.association?.estimate.toFixed(3) ?? null,
        pair.postCut.withinUnit?.estimate.toFixed(3) ?? null,
        pair.movement?.label ?? null,
      ]
    }
    // The released README's output for this table.
    expect(summary('review_depth')).toEqual(['predicts', null, '0.749', '0.768', null])
    expect(summary('review_depth_copy')).toEqual(['predicts', null, '0.750', '0.768', null])
    expect(summary('test_delta')).toEqual([
      'predicts',
      null,
      '0.670',
      '0.658',
      'moves-with-outcome',
    ])
    expect(summary('repo_size')).toEqual([
      'predicts-pooled-only',
      'within-unit-not-shown',
      '0.631',
      '0.500',
      null,
    ])
    expect(summary('hotfix')).toEqual(['insufficient', 'too-little-variation', null, null, null])
    const noise = report.pairs.filter((row) => row.measure.startsWith('noise_'))
    expect(noise.filter((row) => row.label !== 'not-shown')).toEqual([])
    const selection = report.selections[0]!
    expect(selection.climb.map((row) => row.measure)).toEqual(['review_depth_copy', 'test_delta'])
    expect(selection.guards.map((row) => [row.measure, row.reason])).toEqual([
      ['review_depth', 'redundant'],
    ])
    expect(selection.excluded).toEqual([{ measure: 'repo_size', reason: 'pooled-only' }])
    expect(selection.composite.postCut?.estimate.toFixed(3)).toBe('0.794')
  })

  it('seals the same input now as format 2, under a different digest', () => {
    const input: MeasureValidityPlanInput = released.plan
    const sealed = sealMeasureValidityPlan(input, { sealedAt: released.sealedAt })
    expect(sealed.plan.format).toBe(2)
    expect(sealed.plan.selection.minEffect).toEqual({ auc: 0.05, spearman: 0.1 })
    expect(sealed.digest).not.toBe(released.digest)
    expect(verifyMeasureValidityPlan(sealed)).toBe(true)
  })

  it('refuses an unmarked plan that declares a rule the released format lacks', () => {
    const kept = released.plan.outcomes[0]!
    const tampered = [
      { ...released.plan, outcomes: [{ ...kept, windowMs: 14 * DAY }] },
      { ...released.plan, outcomes: [{ ...kept, exposure: { measure: 'repo_size', bins: 10 } }] },
      {
        ...released.plan,
        selection: { ...released.plan.selection, minEffect: { auc: 0.05, spearman: 0.1 } },
      },
      { ...released.plan, format: 3 },
    ]
    for (const plan of tampered) {
      expect(verifyMeasureValidityPlan({ ...released, plan } as SealedMeasureValidityPlan)).toBe(
        false,
      )
    }
  })
})
