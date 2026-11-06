import { describe, expect, it } from 'vitest'
import { clusterBootstrap, placeboBand, sampleMedian } from '../src/statistics/index'
import { clusterBootstrapMean } from '../src/meta-eval/index'
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
    expect(() => placeboBand(replay, { ...options, boundaries: [0, 1] })).toThrow(/hour apart/)
  })
})
