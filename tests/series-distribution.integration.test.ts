import { readFileSync } from 'node:fs'
import {
  type SeriesDistributionOptions,
  summarizeNumberSeries,
  ValidationError,
} from '@tangle-network/agent-eval'
import { expect, it } from 'vitest'

interface LatencyRecord {
  run_id: string
  scenario_id: string
  iteration: number
  total_ms: number
}

const fixture = JSON.parse(
  readFileSync(new URL('./fixtures/series-latency-records.json', import.meta.url), 'utf8'),
) as { source: string; records: LatencyRecord[] }

// The consumer imports the built public package, groups recorded measurements,
// and persists a report. A missing export or non-JSON number breaks this flow.
function report(records: LatencyRecord[], options?: SeriesDistributionOptions) {
  const groups = new Map<string, number[]>()
  for (const row of records) {
    const values = groups.get(row.scenario_id) ?? []
    values.push(row.total_ms)
    groups.set(row.scenario_id, values)
  }
  return JSON.parse(
    JSON.stringify({
      source: fixture.source,
      groups: Object.fromEntries(
        [...groups].map(([scenario, values]) => [scenario, summarizeNumberSeries(values, options)]),
      ),
      unmeasured: summarizeNumberSeries([], options),
    }),
  )
}

const options: SeriesDistributionOptions = {
  percentiles: [0, 50, 95, 99.9, 100],
  medianInterval: { criticalValue: 1.96 },
}

it('round-trips grouped observed latency tails and rank-band evidence through the public package', () => {
  const result = report(fixture.records, options)
  expect(result.source).toBe(fixture.source)
  expect(result.unmeasured).toBeNull()
  expect(result.groups['lifecycle.create-and-delete']).toEqual({
    n: 20,
    min: 222,
    p50: 1234,
    p90: 9760,
    max: 25703,
    sum: 99906,
    percentiles: { 0: 222, 50: 1234, 95: 17095, 99.9: 25703, 100: 25703 },
    medianInterval: {
      method: 'normal-order-statistics',
      criticalValue: 1.96,
      sampleSize: 20,
      lowRank: 5,
      highRank: 16,
      low: 1052,
      high: 8348,
    },
  })
  expect(result.groups['lifecycle.bare-mode']).toMatchObject({
    n: 8,
    p50: 284,
    percentiles: { 50: 284, 95: 334 },
    medianInterval: { sampleSize: 8, lowRank: 1, highRank: 8, low: 223, high: 334 },
  })
  expect(report(fixture.records).groups['lifecycle.create-and-delete']).toEqual({
    n: 20,
    min: 222,
    p50: 1234,
    p90: 9760,
    max: 25703,
    sum: 99906,
  })
  expect(
    report(fixture.records.slice(0, 1), options).groups['lifecycle.create-and-delete'],
  ).toMatchObject({
    medianInterval: { sampleSize: 1, lowRank: 1, highRank: 1, low: 1052, high: 1052 },
  })
})

it('refuses invalid report options even without measurements and rejects unrepresentable JSON numbers', () => {
  for (const percentile of [-1, 101, Number.NaN, Infinity]) {
    expect(() => report([], { percentiles: [percentile] })).toThrow(ValidationError)
  }
  for (const criticalValue of [-1, Number.NaN, Infinity]) {
    expect(() => report([], { medianInterval: { criticalValue } })).toThrow(ValidationError)
  }
  for (const total_ms of [Number.NaN, Infinity, -Infinity]) {
    expect(() => report([{ ...fixture.records[0]!, total_ms }], options)).toThrow(ValidationError)
  }
  expect(() =>
    report(
      [
        { ...fixture.records[0]!, total_ms: Number.MAX_VALUE },
        { ...fixture.records[1]!, total_ms: Number.MAX_VALUE },
      ],
      options,
    ),
  ).toThrow(ValidationError)
})
