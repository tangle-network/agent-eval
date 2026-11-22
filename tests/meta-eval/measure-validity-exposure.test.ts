/**
 * Planted-truth integration tests for three traps of an observational
 * measure study: a measure that predicts only through exposure, an outcome
 * whose before-cut half is right-censored, and a within-unit estimate too
 * thin to test.
 */

import { describe, expect, it } from 'vitest'
import { makeRng } from '../../src/statistics/internal'
import {
  bernoulli,
  changeAt,
  DAY,
  type Draw,
  estimate,
  HOUR,
  normal,
  pairOf,
  type Rng,
  sigmoid,
  study,
} from './planted-changes'

describe('measureValidityStudy: exposure', () => {
  /**
   * A later fix is more likely for a bigger change (`size`, five sizes) and
   * less likely for a careful one. `linesTouched` reads size and nothing
   * else; `careScore` reads care. Size varies inside every unit, so the
   * within-unit statistic cannot tell the two apart.
   */
  function exposureChanges(rng: Rng): Draw[] {
    const draws: Draw[] = []
    for (let i = 0; i < 2000; i++) {
      const { capturedAt, ...change } = changeAt(i, `unit-${Math.floor(rng() * 60)}`, rng)
      const size = 1 + Math.floor(rng() * 5)
      const care = normal(rng)
      draws.push({
        change: {
          ...change,
          measures: {
            size,
            linesTouched: 20 * size + 4 * normal(rng),
            careScore: care + 0.3 * normal(rng),
          },
        },
        capturedAt,
        outcomes: { fixed: bernoulli(rng, sigmoid(-1.2 + 0.8 * (size - 3) - 0.9 * care)) },
      })
    }
    return draws
  }

  const plan = (exposure: boolean) => ({
    cut: 1000 * HOUR,
    level: 0.05,
    outcomes: [
      {
        id: 'fixed',
        direction: 'lower-is-better' as const,
        kind: 'binary' as const,
        ...(exposure ? { exposure: { measure: 'size' } } : {}),
      },
    ],
    measures: [{ id: 'size' }, { id: 'linesTouched' }, { id: 'careScore' }],
    resamples: 300,
  })

  it.each([5, 29, 61])(
    'labels a measure that predicts only through exposure and never climbs it (seed %i)',
    async (seed) => {
      const draws = exposureChanges(makeRng(seed))

      // Without an exposure the volume measure predicts, inside units too, and is offered to climb.
      const naive = await study(draws, plan(false))
      const naiveLines = pairOf(naive, 'linesTouched', 'fixed')
      expect(naiveLines.label).toBe('predicts')
      expect(naiveLines.postCut.withinUnitQValue!).toBeLessThanOrEqual(0.05)
      const naiveClimb = naive.selections[0]!.climb.map((row) => row.measure)
      expect(naiveClimb.some((measure) => measure === 'linesTouched' || measure === 'size')).toBe(
        true,
      )

      const report = await study(draws, plan(true))
      const exposure = report.exposures.find((row) => row.outcome === 'fixed')!
      expect(exposure.measure).toBe('size')
      expect(exposure.bins).toBe(10)
      // Edges from before the cut put each of the five sizes in its own bin.
      for (const size of [1, 2, 3, 4]) {
        expect(exposure.edges.some((edge) => edge >= size && edge < size + 1)).toBe(true)
      }

      const lines = pairOf(report, 'linesTouched', 'fixed')
      expect(lines.exposure).toBe('size')
      expect(estimate(lines)).toBeGreaterThan(0.6)
      expect(lines.postCut.withinUnit!.estimate).toBeGreaterThan(0.6)
      expect(Math.abs(lines.postCut.withinExposure!.estimate - 0.5)).toBeLessThan(0.05)
      expect(lines.postCut.withinExposureQValue!).toBeGreaterThan(0.05)
      expect(lines.label).toBe('predicts-through-exposure')
      expect(lines.reason).toBe('within-exposure-not-shown')

      const care = pairOf(report, 'careScore', 'fixed')
      expect(care.withinExposureDirection).toBe('higher')
      expect(care.postCut.withinExposure!.estimate).toBeGreaterThan(0.6)
      expect(care.postCut.withinExposureQValue!).toBeLessThanOrEqual(0.05)
      expect(care.label).toBe('predicts')

      const size = pairOf(report, 'size', 'fixed')
      expect(size.postCut.withinExposure).toBeNull()
      expect(report.withinExposureTested).toBe(2)

      const selection = report.selections[0]!
      expect(selection.climb.map((row) => row.measure)).toEqual(['careScore'])
      expect(selection.guards).toEqual([])
      expect(selection.excluded).toEqual(
        expect.arrayContaining([
          { measure: 'linesTouched', reason: 'through-exposure' },
          { measure: 'size', reason: 'exposure' },
        ]),
      )
    },
  )

  it('refuses an exposure that is not a planned measure', async () => {
    await expect(
      study([], {
        ...plan(false),
        outcomes: [
          {
            id: 'fixed',
            direction: 'lower-is-better',
            kind: 'binary',
            exposure: { measure: 'diffSize' },
          },
        ],
      }),
    ).rejects.toThrow(/exposure/)
  })
})

describe('measureValidityStudy: right-censored outcomes', () => {
  const WINDOW = 14 * DAY

  /**
   * A change is fixed within 14 days or not. A fix is recorded when it
   * happens and a clean change when its window closes, so changes in the last
   * 14 days before the cut show their fixes and not their clean outcomes.
   * The measure's recorded scale drifts upward before the cut; its own
   * signal truly favors the clean outcome.
   */
  function censoredChanges(rng: Rng) {
    const step = 0.4 * HOUR
    const cut = 1200 * step
    const draws: Draw[] = []
    for (let i = 0; i < 2200; i++) {
      const at = i * step
      const signal = normal(rng)
      const fixed = bernoulli(rng, sigmoid(1 - signal))
      draws.push({
        change: {
          id: `change-${i}`,
          at,
          unit: `unit-${Math.floor(rng() * 40)}`,
          measures: { m: (8 * Math.min(at, cut)) / cut + signal },
        },
        capturedAt: fixed ? at + rng() * WINDOW : at + WINDOW,
        outcomes: { fixed },
      })
    }
    return { draws, cut }
  }

  it.each([4, 18, 73])(
    'counts a change before the cut only once its window has closed (seed %i)',
    async (seed) => {
      const { draws, cut } = censoredChanges(makeRng(seed))
      const plan = (windowMs?: number) => ({
        cut,
        level: 0.05,
        outcomes: [
          {
            id: 'fixed',
            direction: 'lower-is-better' as const,
            kind: 'binary' as const,
            ...(windowMs === undefined ? {} : { windowMs }),
          },
        ],
        measures: [{ id: 'm' }],
        resamples: 300,
      })

      // Without a window the open-window fixes reverse the direction before the cut.
      const censored = pairOf(await study(draws, plan()), 'm', 'fixed')
      expect(censored.direction).toBe('lower')
      expect(censored.label).toBe('not-shown')
      expect(censored.reason).toBe('direction-reversed')

      const report = await study(draws, plan(WINDOW))
      const openAtCut = draws.filter(
        (draw) =>
          draw.change.at < cut && draw.change.at + WINDOW > cut && draw.capturedAt <= cut,
      ).length
      expect(openAtCut).toBeGreaterThan(100)
      expect(report.excludedObservations.windowOpenAtCut).toBe(openAtCut)
      const pair = pairOf(report, 'm', 'fixed')
      expect(pair.preCut.n).toBe(
        draws.filter((draw) => draw.change.at + WINDOW <= cut).length,
      )
      expect(pair.direction).toBe('higher')
      expect(pair.label).toBe('predicts')
    },
  )
})

describe('measureValidityStudy: within-unit estimate', () => {
  /** Units named by `unitOf`; a strong change-level predictor. */
  function changes(rng: Rng, unitOf: (index: number) => string): Draw[] {
    const draws: Draw[] = []
    for (let i = 0; i < 600; i++) {
      const { capturedAt, ...change } = changeAt(i, unitOf(i), rng)
      const signal = normal(rng)
      draws.push({
        change: { ...change, measures: { m: signal + 0.3 * normal(rng) } },
        capturedAt,
        outcomes: { kept: bernoulli(rng, sigmoid(1.5 * signal)) },
      })
    }
    return draws
  }
  const plan = {
    cut: 300 * HOUR,
    level: 0.05,
    outcomes: [{ id: 'kept', direction: 'higher-is-better' as const, kind: 'binary' as const }],
    measures: [{ id: 'm' }],
    resamples: 300,
  }

  it.each([9, 41])(
    'reports the within-unit estimate from two comparable units and says it is untested (seed %i)',
    async (seed) => {
      // A third of the changes fall in two shared units; every other change is its own unit.
      const draws = changes(makeRng(seed), (i) => (i % 3 === 0 ? `shared-${i % 2}` : `own-${i}`))
      const report = await study(draws, plan)
      const pair = pairOf(report, 'm', 'kept')
      const within = pair.postCut.withinUnit!
      expect(within.units).toBe(2)
      expect(within.estimate).toBeGreaterThan(0.6)
      expect(Number.isFinite(within.low) && Number.isFinite(within.high)).toBe(true)
      expect(pair.postCut.withinUnitQValue).toBeNull()
      expect(report.withinUnitTested).toBe(0)
      expect(pair.label).toBe('predicts')
      expect(pair.reason).toBe('within-unit-untested')
    },
  )

  it('says an admitted pair with no comparable unit is untested within units', async () => {
    const report = await study(
      changes(makeRng(9), (i) => `own-${i}`),
      plan,
    )
    const pair = pairOf(report, 'm', 'kept')
    expect(pair.postCut.withinUnit).toBeNull()
    expect(pair.label).toBe('predicts')
    expect(pair.reason).toBe('within-unit-untested')
  })
})
