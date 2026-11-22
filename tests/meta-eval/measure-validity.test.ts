/**
 * Planted-truth integration tests for the measure validity study.
 *
 * Every scenario generates changes and later outcomes from `makeRng`, plants a
 * known relation, and checks the study through the public entries. Several
 * scenarios also compute what a naive full-sample correlation would say, to
 * show the planted trap is one that ranking by association falls into.
 */

import { describe, expect, it } from 'vitest'
import {
  type MeasureValidityPlanInput,
  sealMeasureValidityPlan,
  verifyMeasureValidityPlan,
} from '../../src/experiment'
import {
  type DeploymentOutcome,
  guardDrift,
  InMemoryOutcomeStore,
  type MeasuredChange,
  type MeasureOutcomeValidity,
  type MeasureValidityReport,
  measureValidityStudy,
} from '../../src/meta-eval'
import { rocAuc, spearmanR } from '../../src/statistics'
import { makeRng } from '../../src/statistics/internal'

const HOUR = 3_600_000
const DAY = 24 * HOUR

type Rng = () => number

function normal(rng: Rng): number {
  const u = Math.max(rng(), Number.EPSILON)
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * rng())
}

const sigmoid = (x: number) => 1 / (1 + Math.exp(-x))
const bernoulli = (rng: Rng, p: number) => (rng() < p ? 1 : 0)

interface Draw {
  change: MeasuredChange
  capturedAt: number
  outcomes: Record<string, number>
}

/** One change per hour; units drawn uniformly; outcomes arrive two to five days later. */
function changeAt(index: number, unit: string, rng: Rng, start = 0) {
  const at = start + index * HOUR
  return { id: `change-${start}-${index}`, at, unit, capturedAt: at + 2 * DAY + rng() * 3 * DAY }
}

function outcomeRows(draws: readonly Draw[]): DeploymentOutcome[] {
  return draws.map((draw) => ({
    runId: draw.change.id,
    capturedAt: draw.capturedAt,
    metrics: draw.outcomes,
  }))
}

async function study(
  draws: readonly Draw[],
  plan: Omit<MeasureValidityPlanInput, 'id'>,
): Promise<MeasureValidityReport> {
  const outcomes = new InMemoryOutcomeStore()
  for (const row of outcomeRows(draws)) await outcomes.append(row)
  return measureValidityStudy({
    plan: sealMeasureValidityPlan({ id: 'planted-truth', ...plan }),
    changes: draws.map((draw) => draw.change),
    outcomes,
  })
}

function pairOf(report: MeasureValidityReport, measure: string, outcome: string) {
  const found = report.pairs.find((pair) => pair.measure === measure && pair.outcome === outcome)
  if (!found) throw new Error(`no pair ${measure} x ${outcome}`)
  return found
}

function estimate(pair: MeasureOutcomeValidity): number {
  const value = pair.postCut.association?.estimate
  if (value === undefined) throw new Error(`pair ${pair.measure} has no post-cut estimate`)
  return value
}

describe('measureValidityStudy: held-out prediction', () => {
  it.each([3, 17, 42])(
    'admits a measure that truly predicts, on changes after the cut only (seed %i)',
    async (seed) => {
      const rng = makeRng(seed)
      const draws: Draw[] = []
      for (let i = 0; i < 900; i++) {
        const { capturedAt, ...change } = changeAt(i, `unit-${Math.floor(rng() * 90)}`, rng)
        const signal = normal(rng)
        const measures: Record<string, number> = { signal }
        // Present on about one change in ten: too few joined changes after the cut.
        if (rng() < 0.1) measures.rare = normal(rng)
        draws.push({
          change: { ...change, measures },
          capturedAt,
          outcomes: {
            // Lower is better: a higher signal predicts fewer reverts.
            reverted: bernoulli(rng, sigmoid(-0.5 - 1.5 * signal)),
            retention: 0.6 * signal + normal(rng),
          },
        })
      }
      const report = await study(draws, {
        cut: 450 * HOUR,
        level: 0.05,
        outcomes: [
          { id: 'reverted', direction: 'lower-is-better', kind: 'binary' },
          { id: 'retention', direction: 'higher-is-better', kind: 'continuous' },
        ],
        measures: [{ id: 'signal' }, { id: 'rare' }],
        resamples: 300,
      })

      const reverted = pairOf(report, 'signal', 'reverted')
      expect(reverted.label).toBe('predicts')
      expect(reverted.statistic).toBe('auc')
      expect(reverted.direction).toBe('higher')
      expect(estimate(reverted)).toBeGreaterThan(0.6)
      expect(reverted.postCut.association!.low).toBeGreaterThan(0.5)
      expect(reverted.postCut.qValue!).toBeLessThanOrEqual(0.05)
      const retention = pairOf(report, 'signal', 'retention')
      expect(retention.label).toBe('predicts')
      expect(retention.statistic).toBe('spearman')
      expect(estimate(retention)).toBeGreaterThan(0.2)

      // Direction came only from changes before the cut whose outcome was known by the cut.
      expect(reverted.preCut.n).toBeLessThan(450)
      expect(report.excludedObservations.capturedAfterCutForPreCutChange).toBeGreaterThan(0)
      expect(reverted.postCut.n).toBe(450)
      expect(reverted.leadTimeMs!.min).toBeGreaterThanOrEqual(2 * DAY)

      // Too few joined changes is insufficient, never a failure.
      const rare = pairOf(report, 'rare', 'reverted')
      expect(rare.label).toBe('insufficient')
      expect(rare.reason).toBe('below-minimum-count')
      expect(rare.postCut.association).toBeNull()
      expect(report.tested).toBe(2)
      expect(report.claim.causal).toBe(false)
    },
  )

  it('runs only under an intact seal', async () => {
    const sealed = sealMeasureValidityPlan({
      id: 'sealed-plan',
      cut: 10 * HOUR,
      level: 0.05,
      outcomes: [{ id: 'kept', direction: 'higher-is-better', kind: 'binary' }],
      measures: [{ id: 'signal' }],
    })
    expect(verifyMeasureValidityPlan(sealed)).toBe(true)
    expect(sealed.plan.minJoined).toBe(100)
    const tampered = { ...sealed, plan: { ...sealed.plan, level: 0.2 } }
    expect(verifyMeasureValidityPlan(tampered)).toBe(false)
    await expect(
      measureValidityStudy({ plan: tampered, changes: [], outcomes: new InMemoryOutcomeStore() }),
    ).rejects.toThrow(/seal/)
  })
})

describe('measureValidityStudy: false discoveries across many measures', () => {
  it('keeps 200 noise measures within the false-discovery level where a per-pair test admits about ten', async () => {
    const seeds = [5, 6, 7, 8, 9]
    let noiseAdmitted = 0
    const naiveCounts: number[] = []
    const noiseIds = Array.from({ length: 200 }, (_, i) => `noise-${String(i).padStart(3, '0')}`)
    for (const seed of seeds) {
      const rng = makeRng(seed)
      const draws: Draw[] = []
      for (let i = 0; i < 640; i++) {
        const { capturedAt, ...change } = changeAt(i, `unit-${Math.floor(rng() * 64)}`, rng)
        const planted = normal(rng)
        const measures: Record<string, number> = { planted }
        for (const id of noiseIds) measures[id] = normal(rng)
        draws.push({
          change: { ...change, measures },
          capturedAt,
          outcomes: { accepted: bernoulli(rng, sigmoid(2 * planted)) },
        })
      }
      const report = await study(draws, {
        cut: 320 * HOUR,
        level: 0.05,
        outcomes: [{ id: 'accepted', direction: 'higher-is-better', kind: 'binary' }],
        measures: [{ id: 'planted' }, ...noiseIds.map((id) => ({ id }))],
        resamples: 200,
      })
      expect(report.tested).toBe(201)
      expect(pairOf(report, 'planted', 'accepted').label).toBe('predicts')
      const noise = report.pairs.filter((pair) => pair.measure.startsWith('noise-'))
      noiseAdmitted += noise.filter((pair) => pair.label === 'predicts').length
      naiveCounts.push(
        noise.filter((pair) => (pair.postCut.association?.pValue ?? 1) < 0.05).length,
      )
    }
    // Under the global null, BH at 0.05 admits anything in about one study in twenty.
    expect(noiseAdmitted).toBeLessThanOrEqual(1)
    const naiveMean = naiveCounts.reduce((sum, count) => sum + count, 0) / naiveCounts.length
    expect(naiveMean).toBeGreaterThanOrEqual(5)
    expect(naiveMean).toBeLessThanOrEqual(15)
  })
})

describe('measureValidityStudy: traps a full-sample correlation falls into', () => {
  it.each([2, 13, 31])(
    'does not admit a measure that predicts before the cut and reverses after it (seed %i)',
    async (seed) => {
      const rng = makeRng(seed)
      const draws: Draw[] = []
      const cutIndex = 650
      for (let i = 0; i < 1000; i++) {
        const { capturedAt, ...change } = changeAt(i, `unit-${Math.floor(rng() * 100)}`, rng)
        const m = normal(rng)
        const slope = i < cutIndex ? 2.5 : -1.5
        draws.push({
          change: { ...change, measures: { m } },
          capturedAt,
          outcomes: { accepted: bernoulli(rng, sigmoid(slope * m)) },
        })
      }
      const naive = rocAuc(
        draws.map((draw) => draw.change.measures.m!),
        draws.map((draw) => draw.outcomes.accepted!),
      )
      expect(naive!).toBeGreaterThan(0.55)

      const report = await study(draws, {
        cut: cutIndex * HOUR,
        level: 0.05,
        outcomes: [{ id: 'accepted', direction: 'higher-is-better', kind: 'binary' }],
        measures: [{ id: 'm' }],
        resamples: 300,
      })
      const pair = pairOf(report, 'm', 'accepted')
      expect(pair.direction).toBe('higher')
      expect(pair.label).toBe('not-shown')
      expect(pair.reason).toBe('direction-reversed')
      expect(estimate(pair)).toBeLessThan(0.5)
      expect(report.admitted).toBe(0)
    },
  )

  it.each([4, 21, 77])(
    'resamples whole units: a coincidence among 24 units passes a row resample and not a unit resample (seed %i)',
    async (seed) => {
      const rng = makeRng(seed)
      const units = 24
      const a = Array.from({ length: units }, () => normal(rng))
      // Plant a unit-level coincidence of about 0.25 rank correlation; the population has none.
      let b: number[] = []
      for (let attempt = 0; attempt < 10_000; attempt++) {
        b = a.map(() => normal(rng))
        const rho = spearmanR(a, b)
        if (rho >= 0.2 && rho <= 0.3) break
      }
      expect(spearmanR(a, b)).toBeGreaterThanOrEqual(0.2)
      const draws: Draw[] = []
      for (let k = 0; k < 40; k++) {
        for (let u = 0; u < units; u++) {
          const at = (k * units + u) * HOUR
          draws.push({
            change: {
              id: `change-${k}-${u}`,
              at,
              unit: `unit-${u}`,
              measures: { m: a[u]! + 0.3 * normal(rng) },
            },
            capturedAt: at + DAY,
            outcomes: { retention: b[u]! + 0.3 * normal(rng) },
          })
        }
      }
      const plan = {
        cut: 20 * units * HOUR,
        level: 0.05,
        outcomes: [
          { id: 'retention', direction: 'higher-is-better', kind: 'continuous' } as const,
        ],
        measures: [{ id: 'm' }],
        resamples: 400,
      }
      const byUnit = pairOf(await study(draws, plan), 'm', 'retention')
      const byRow = pairOf(
        await study(
          draws.map((draw) => ({ ...draw, change: { ...draw.change, unit: draw.change.id } })),
          plan,
        ),
        'm',
        'retention',
      )
      expect(byRow.postCut.units).toBe(480)
      expect(byRow.label).toBe('predicts')
      expect(byUnit.postCut.units).toBe(24)
      expect(byUnit.direction).toBe('higher')
      expect(byUnit.label).toBe('not-shown')
      expect(byUnit.postCut.association!.standardError).toBeGreaterThan(
        2 * byRow.postCut.association!.standardError,
      )
    },
  )

  it.each([8, 19, 55])(
    'reports a missing measure as coverage; filling it with zero would admit it (seed %i)',
    async (seed) => {
      const rng = makeRng(seed)
      const missing: Draw[] = []
      const zeroFilled: Draw[] = []
      for (let i = 0; i < 1000; i++) {
        const { capturedAt, ...change } = changeAt(i, `unit-${Math.floor(rng() * 100)}`, rng)
        const accepted = bernoulli(rng, 0.65)
        // The value carries no signal; only its absence does, because it is recorded
        // mostly for changes that went on to be accepted.
        const recorded = rng() < (accepted ? 0.9 : 0.35)
        const value = 5 + 5 * rng()
        missing.push({
          change: { ...change, measures: recorded ? { reviewed: value } : {} },
          capturedAt,
          outcomes: { accepted },
        })
        zeroFilled.push({
          change: { ...change, measures: { reviewed: recorded ? value : 0 } },
          capturedAt,
          outcomes: { accepted },
        })
      }
      const plan = {
        cut: 500 * HOUR,
        level: 0.05,
        outcomes: [{ id: 'accepted', direction: 'higher-is-better', kind: 'binary' } as const],
        measures: [{ id: 'reviewed' }],
        resamples: 300,
      }
      const asMissing = await study(missing, plan)
      const coverage = asMissing.coverage.find((row) => row.measure === 'reviewed')!
      expect(coverage.changes).toBe(1000)
      expect(coverage.share).toBeGreaterThan(0.5)
      expect(coverage.share).toBeLessThan(0.85)
      expect(coverage.postCut.measured).toBeLessThan(coverage.postCut.changes)
      expect(pairOf(asMissing, 'reviewed', 'accepted').label).not.toBe('predicts')

      const asZero = await study(zeroFilled, plan)
      expect(asZero.coverage.find((row) => row.measure === 'reviewed')!.share).toBe(1)
      expect(pairOf(asZero, 'reviewed', 'accepted').label).toBe('predicts')
    },
  )
})

describe('measureValidityStudy: movement under change', () => {
  it.each([6, 23, 64])(
    'labels a measure that predicts across items but never moves under change (seed %i)',
    async (seed) => {
      const rng = makeRng(seed)
      const draws: Draw[] = []
      for (let i = 0; i < 1000; i++) {
        const { capturedAt, ...change } = changeAt(i, `unit-${Math.floor(rng() * 100)}`, rng)
        const size = normal(rng)
        const before = normal(rng)
        const delta = normal(rng)
        draws.push({
          change: {
            ...change,
            measures: { size, effort: before + delta },
            movements: {
              size: { before: size, after: size },
              effort: { before, after: before + delta },
            },
          },
          capturedAt,
          outcomes: { merged: bernoulli(rng, sigmoid(1.5 * size + 2 * delta)) },
        })
      }
      const report = await study(draws, {
        cut: 500 * HOUR,
        level: 0.05,
        outcomes: [{ id: 'merged', direction: 'higher-is-better', kind: 'binary' }],
        measures: [
          { id: 'size', noise: 0.05 },
          { id: 'effort', noise: 0.05 },
        ],
        resamples: 300,
      })
      const size = pairOf(report, 'size', 'merged')
      expect(size.label).toBe('predicts')
      expect(size.movement!.label).toBe('insensitive')
      expect(size.movement!.sensitivity!.estimate).toBe(0)
      const effort = pairOf(report, 'effort', 'merged')
      expect(effort.label).toBe('predicts')
      expect(effort.movement!.label).toBe('moves-with-outcome')
      expect(effort.movement!.sensitivity!.estimate).toBeGreaterThan(0.9)
      expect(effort.movement!.agreement!.estimate).toBeGreaterThan(0.6)
      expect(report.movementTested).toBe(1)

      const selection = report.selections.find((row) => row.outcome === 'merged')!
      expect(selection.excluded).toEqual([{ measure: 'size', reason: 'insensitive' }])
      expect(selection.climb.map((row) => row.measure)).toEqual(['effort'])
      expect(selection.guards).toEqual([])
    },
  )

  it('refuses a movement for a measure whose noise the plan does not declare', async () => {
    const draws: Draw[] = [
      {
        change: {
          id: 'only',
          at: 0,
          unit: 'u',
          measures: { m: 1 },
          movements: { m: { before: 0, after: 1 } },
        },
        capturedAt: DAY,
        outcomes: { kept: 1 },
      },
    ]
    await expect(
      study(draws, {
        cut: HOUR,
        level: 0.05,
        outcomes: [{ id: 'kept', direction: 'higher-is-better', kind: 'binary' }],
        measures: [{ id: 'm' }],
      }),
    ).rejects.toThrow(/noise/)
  })
})

describe('measureValidityStudy: selection and guards', () => {
  function latentChanges(
    rng: Rng,
    count: number,
    unitCount: number,
    start: number,
    shape: { qMean: number; gamed?: string },
  ): Draw[] {
    const draws: Draw[] = []
    for (let i = 0; i < count; i++) {
      const { capturedAt, ...change } = changeAt(
        i,
        `unit-${start}-${Math.floor(rng() * unitCount)}`,
        rng,
        start,
      )
      const q = shape.qMean + normal(rng)
      const a = q + 0.6 * normal(rng)
      const measures: Record<string, number> = {
        a,
        aCopy: a + 0.02 * normal(rng),
        b: q + 0.7 * normal(rng),
        g: q + 0.7 * normal(rng),
      }
      if (shape.gamed) measures[shape.gamed] = measures[shape.gamed]! + 2
      draws.push({ change: { ...change, measures }, capturedAt, outcomes: { kept: bernoulli(rng, sigmoid(2 * q)) } })
    }
    return draws
  }

  it.each([10, 33, 71])(
    'drops a redundant copy, returns guards, and fires the drift check only on a gamed measure (seed %i)',
    async (seed) => {
      const rng = makeRng(seed)
      const draws = latentChanges(rng, 1200, 120, 0, { qMean: 0 })
      const report = await study(draws, {
        cut: 600 * HOUR,
        level: 0.05,
        outcomes: [{ id: 'kept', direction: 'higher-is-better', kind: 'binary' }],
        measures: [
          { id: 'a', cost: 1 },
          { id: 'aCopy', cost: 1 },
          { id: 'b', cost: 5 },
          { id: 'g', cost: 2 },
        ],
        resamples: 300,
        selection: { maxMeasures: 2, minGain: 0.005 },
      })
      for (const measure of ['a', 'aCopy', 'b', 'g']) {
        expect(pairOf(report, measure, 'kept').label).toBe('predicts')
      }
      const selection = report.selections.find((row) => row.outcome === 'kept')!
      const climbed = selection.climb.map((row) => row.measure)
      expect(climbed).toHaveLength(2)
      const copy = climbed.includes('a') ? 'a' : 'aCopy'
      const partner = copy === 'a' ? 'aCopy' : 'a'
      expect(climbed).toContain(copy)
      expect(climbed).not.toContain(partner)
      const redundant = selection.guards.find((row) => row.measure === partner)!
      expect(redundant.reason).toBe('redundant')
      expect(redundant.redundantWith).toBe(copy)
      expect(redundant.correlation!).toBeGreaterThan(0.95)
      expect(selection.guards).toHaveLength(2)
      for (const row of selection.climb) {
        expect(row.cost).toBe(row.measure === 'b' ? 5 : row.measure === 'g' ? 2 : 1)
        expect(row.leadTimeMs!.median).toBeGreaterThanOrEqual(2 * DAY)
        expect(row.leadTimeMs!.median).toBeLessThanOrEqual(5 * DAY)
      }
      const composite = selection.composite.postCut!
      for (const row of selection.climb) {
        expect(composite.estimate).toBeGreaterThan(estimate(pairOf(report, row.measure, 'kept')))
      }

      const later = 2000 * HOUR
      const gamedMeasure = climbed[0]!
      const gamed = latentChanges(rng, 300, 60, later, { qMean: 0, gamed: gamedMeasure })
      const genuine = latentChanges(rng, 300, 60, later, { qMean: 1 })
      const drift = async (batch: Draw[]) => {
        const outcomes = new InMemoryOutcomeStore()
        for (const row of outcomeRows(batch)) await outcomes.append(row)
        return guardDrift({
          report,
          outcome: 'kept',
          batch: batch.map((draw) => draw.change),
          outcomes,
          tolerance: 0.5,
        })
      }
      const gamedDrift = await drift(gamed)
      expect(gamedDrift.status).toBe('drift')
      expect(gamedDrift.measures.find((row) => row.measure === gamedMeasure)!.status).toBe('drift')
      // The outcome did not follow the gamed measure.
      expect(Math.abs(gamedDrift.outcomeShift!.estimate)).toBeLessThan(0.1)

      const genuineDrift = await drift(genuine)
      expect(genuineDrift.status).toBe('no-drift')
      expect(genuineDrift.measures.every((row) => row.status === 'within-tolerance')).toBe(true)
      expect(genuineDrift.outcomeShift!.low).toBeGreaterThan(0)
    },
  )
})
