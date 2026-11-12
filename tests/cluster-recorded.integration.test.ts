import { describe, expect, it } from 'vitest'
import { clusterBootstrapMean } from '../src/meta-eval/index'
import {
  clusterBootstrap,
  clusteredBinaryMde,
  clusteredPairedContrast,
  clusterJackknife,
  independentRiskDifference,
  placeboBand,
  sampleMedian,
  simulateClusteredBinaryContrast,
} from '../src/statistics/index'
import recorded from './fixtures/cluster-recorded.json'

// Numeric projection of wf-{stages,wall}-fresh.jsonl; original timestamps retained.
const rows = recorded.map((row) => ({ ...row, value: row.value ?? 0 }))
const cluster = (row: (typeof rows)[number]) => `${row.cell}:${Math.floor(row.ts / 600_000)}`
const mean = (sample: typeof rows) =>
  sample.reduce((sum, row) => sum + row.value, 0) / sample.length
const timestamp = (row: (typeof rows)[number]) => row.ts
const statistic = (before: typeof rows, after: typeof rows) => {
  const sorted = before
    .filter((row) => row.outcome === 'ok')
    .map((row) => row.value)
    .sort((a, b) => a - b)
  const cap = sorted[Math.floor((sorted.length - 1) * 0.99)]!
  const score = (arm: typeof rows) =>
    arm.reduce((sum, row) => sum + (row.outcome === 'ok' ? Math.min(cap, row.value) : cap), 0) /
    arm.length
  return score(after) - score(before)
}

describe('recorded create statistics public contract', () => {
  it('keeps unsupported deletion estimates and invalid paired evidence out of inference', () => {
    const success = recorded.find((row) => row.outcome === 'ok' && row.value !== null)!
    const failure = recorded.find((row) => row.outcome !== 'ok')!
    // Two observed outcomes, deliberately separated into one cluster each: the
    // successful-latency ratio loses its denominator when that cluster is removed.
    const sample = [success, failure].map((row, index) => ({ ...row, cluster: String(index) }))
    const result = clusterJackknife(
      sample,
      (row) => row.cluster,
      (items) => {
        const successful = items.filter((row) => row.outcome === 'ok')
        return successful.reduce((sum, row) => sum + (row.value ?? 0), 0) / successful.length
      },
    )
    expect(result).toEqual({ estimate: success.value, low: null, high: null, clusters: 2 })
    expect(
      clusteredPairedContrast(sample.map((row) => ({ cluster: row.cluster, delta: 0 }))),
    ).toMatchObject({ estimate: 0, low: 0, high: 0, pValue: 1 })
    expect(() =>
      clusteredPairedContrast([
        { cluster: 'a', delta: 1e308 },
        { cluster: 'b', delta: 1e308 },
      ]),
    ).toThrow(/total must be finite/)
    expect(
      clusterJackknife([0, 1], String, (items) =>
        items.length === 2 ? 0 : items[0] === 0 ? 1e308 : -1e308,
      ),
    ).toMatchObject({ estimate: 0, low: null, high: null })
    const design = { pairs: 20, clusters: 2, controlRate: 0.5, icc: 0.1, alpha: 0.05 }
    for (const invalid of [
      { pairs: 2.5 },
      { clusters: Infinity },
      { controlRate: 2 },
      { icc: -1 },
      { alpha: 0 },
      { power: 1 },
    ])
      expect(() => clusteredBinaryMde({ ...design, ...invalid })).toThrow()
    expect(() => simulateClusteredBinaryContrast({ ...design, reps: 0 })).toThrow(/reps/)
    for (const invalid of [NaN, Infinity, -Infinity]) {
      expect(() =>
        clusteredPairedContrast([
          { cluster: 'observed', delta: 0 },
          { cluster: 'missing', delta: invalid },
        ]),
      ).toThrow(/paired differences must be finite/)
    }
  })

  it('retains whole clusters and strata through the public percentile and mean APIs', () => {
    const counts = new Map<string, number>()
    for (const row of rows) counts.set(cluster(row), (counts.get(cluster(row)) ?? 0) + 1)
    const result = clusterBootstrap(
      rows,
      cluster,
      (sample) => {
        const drawn = new Map<string, number>()
        for (const row of sample) drawn.set(cluster(row), (drawn.get(cluster(row)) ?? 0) + 1)
        for (const [key, n] of drawn) expect(n % counts.get(key)!).toBe(0)
        const cells = new Map<string, number>()
        for (const key of drawn.keys())
          cells.set(
            key.split(':')[0]!,
            (cells.get(key.split(':')[0]!) ?? 0) + drawn.get(key)! / counts.get(key)!,
          )
        for (const cell of new Set(rows.map((row) => row.cell))) {
          expect(cells.get(cell)).toBe(
            [...counts.keys()].filter((key) => key.startsWith(`${cell}:`)).length,
          )
        }
        return sampleMedian(sample.map((row) => row.value))!
      },
      { strata: (row) => row.cell, resamples: 40, seed: 7 },
    )
    expect(result.clusters).toBe(counts.size)
    expect(result.low).toBeLessThanOrEqual(result.high)
    const projected = rows.map((row) => ({
      cluster: cluster(row),
      stratum: row.cell,
      value: row.value,
    }))
    const options = { resamples: 80, seed: 7 }
    expect(clusterBootstrapMean(projected, options)).toMatchObject({
      ...clusterBootstrap(rows, cluster, mean, { ...options, strata: (row) => row.cell }),
      mean: mean(rows),
      n: rows.length,
    })
  })

  it('refuses short recorded history and inverts a labeled replay at the sealed cluster count', () => {
    const options = { timestamp, cluster, statistic, clustersPerArm: 20, delta: -30 }
    expect(placeboBand(rows, options)).toMatchObject({
      status: 'uncalibrated',
      low: null,
      high: null,
    })
    // Constructed replay, NOT measured 72-hour history: one recorded value per ten-minute cluster.
    const successes = rows.filter((row) => row.outcome === 'ok')
    const failures = rows.filter((row) => row.outcome !== 'ok')
    const replayRows = successes.flatMap((row, i) => [row, ...failures.slice(i, i + 1)])
    const replay = Array.from({ length: 481 }, (_, i) => ({
      ...replayRows[i % replayRows.length]!,
      ts: i * 600_000,
      cell: 'replay',
    }))
    const band = placeboBand(replay, {
      ...options,
      statistic: (before, after) => {
        expect(new Set(before.map(cluster)).size).toBe(20)
        expect(new Set(after.map(cluster)).size).toBe(20)
        expect(Math.max(...before.map(timestamp))).toBeLessThan(Math.min(...after.map(timestamp)))
        return statistic(before, after)
      },
    })
    expect(band.status).toBe('calibrated')
    expect(band.K).toBeGreaterThanOrEqual(39)
    expect(band.low).toBe(-30 - band.q975!)
    expect(band.high).toBe(-30 - band.q025!)
    expect(
      placeboBand(replay, { ...options, boundaries: band.boundaries.slice(0, 38) }).status,
    ).toBe('uncalibrated')
    expect(placeboBand(replay, { ...options, steps: replay.map(timestamp) }).K).toBe(0)
    const overlapping = placeboBand(replay, {
      ...options,
      boundaries: [40 * 3_600_000],
      cluster: (row) => cluster(row.ts === 50 * 3_600_000 ? { ...row, ts: 40 * 3_600_000 } : row),
      clustersPerArm: 2,
      steps: [45 * 3_600_000],
    })
    expect(overlapping.boundaries).toEqual([])
    expect(() => placeboBand(replay, { ...options, boundaries: [0, 1] })).toThrow(/hour apart/)
  })
  it('compares independent recorded success counts without matching or discarding failed creates', () => {
    const selected = recorded.filter(
      (row) => row.cell === 'us1' && !row.outcome.startsWith('idempotent_'),
    )
    const before = selected.filter((row) => row.ts < 1793956897166),
      after = selected.filter((row) => row.ts >= 1793956897166)
    const successes = (arm: typeof recorded) => arm.filter((row) => row.outcome === 'ok').length
    const result = independentRiskDifference(
      successes(before),
      before.length,
      successes(after),
      after.length,
    )
    expect(result.before).toMatchObject({ successes: 20, n: 50 })
    expect(result.after).toMatchObject({ successes: 84, n: 192 })
    expect(result.delta).toBeCloseTo(0.0375, 12)
    expect(result.lower).toBeCloseTo(-0.11662676063921706, 7)
    expect(result.upper).toBeCloseTo(0.18017357821348098, 7)
    const swapped = independentRiskDifference(84, 192, 20, 50)
    expect(swapped.delta).toBeCloseTo(-result.delta!, 12)
    expect(swapped.lower).toBeCloseTo(-result.upper, 12)
    expect(swapped.upper).toBeCloseTo(-result.lower, 12)
    const guardExample = independentRiskDifference(972, 1000, 923, 1000)
    expect(guardExample.delta).toBeCloseTo(-0.049, 12)
    expect(guardExample.upper).toBeLessThan(-0.02)
  })

  it('matches Newcombe Table II method 10 and keeps empty or invalid arms explicit', () => {
    // Primary paper, pp876–877, Table II; table gives after minus before.
    for (const [after, afterN, before, beforeN, lower, upper] of [
      [56, 70, 48, 80, 0.0524, 0.3339],
      [9, 10, 3, 10, 0.1705, 0.809],
      [6, 7, 2, 7, 0.0582, 0.8062],
      [5, 56, 0, 29, -0.0381, 0.1926],
      [0, 10, 0, 20, -0.1611, 0.2775],
      [0, 10, 0, 10, -0.2775, 0.2775],
      [10, 10, 0, 20, 0.6791, 1],
      [10, 10, 0, 10, 0.6075, 1],
    ]) {
      const result = independentRiskDifference(before!, beforeN!, after!, afterN!)
      expect(result.lower).toBeCloseTo(lower!, 4)
      expect(result.upper).toBeCloseTo(upper!, 4)
    }
    for (const [before, beforeN, after, afterN] of [
      [0, 0, 0, 0],
      [0, 0, 1, 1],
      [1, 1, 0, 0],
    ]) {
      expect(independentRiskDifference(before!, beforeN!, after!, afterN!)).toMatchObject({
        delta: null,
        lower: -1,
        upper: 1,
      })
    }
    for (const [successes, n] of [
      [-1, 10],
      [11, 10],
      [1, 0],
      [NaN, 10],
      [1, 1.5],
      [0, Infinity],
      [0, Number.MAX_SAFE_INTEGER + 1],
    ]) {
      expect(() => independentRiskDifference(successes!, n!, 0, 0)).toThrow()
      expect(() => independentRiskDifference(0, 0, successes!, n!)).toThrow()
    }
    for (const confidence of [0, 1, NaN, Infinity]) {
      expect(() => independentRiskDifference(0, 0, 0, 0, confidence)).toThrow(/confidence/)
    }
  })
})
