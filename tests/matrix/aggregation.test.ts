import { describe, expect, it } from 'vitest'
import type { CellResult, MatrixAxis } from '../../src/matrix'
import { runAgentMatrix } from '../../src/matrix'

function axis<V>(name: string, vals: Array<[string, V]>): MatrixAxis<V> {
  return { name, values: vals.map(([id, value]) => ({ id, value })) }
}

function mk(score: number, valid: boolean, costUsd = 0.01, durationMs = 10): CellResult<null> {
  return {
    output: null,
    verdict: { valid, score },
    costUsd,
    durationMs,
  }
}

describe('aggregation — AxisSummary math', () => {
  it('passRate, mean, p50, p90 over a single axis', async () => {
    const sc = axis('scenario', [
      ['s1', 1],
      ['s2', 2],
      ['s3', 3],
      ['s4', 4],
      ['s5', 5],
    ])
    const scores = [0.1, 0.4, 0.6, 0.8, 1.0]

    const result = await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      runCell: async (cell) => {
        const idx = (cell.axes.scenario?.value as number) - 1
        const s = scores[idx] as number
        return mk(s, s >= 0.5)
      },
    })

    expect(Object.keys(result.byAxis.scenario ?? {})).toHaveLength(5)
    // Aggregating across the whole run via overall summary:
    expect(result.summary.overallMeanScore).toBeCloseTo((0.1 + 0.4 + 0.6 + 0.8 + 1.0) / 5)
    expect(result.summary.overallPassRate).toBeCloseTo(3 / 5)
  })

  it('two cells with the same axis id aggregate into one bucket', async () => {
    const sc = axis('scenario', [['s1', 1]])

    const result = await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      reps: 4,
      runCell: async (cell) => {
        const s = cell.rep < 2 ? 0.4 : 0.8
        return mk(s, s >= 0.5)
      },
    })

    const bucket = result.byAxis.scenario?.s1
    expect(bucket).toBeDefined()
    expect(bucket?.cells).toBe(4)
    expect(bucket?.passRate).toBeCloseTo(0.5)
    expect(bucket?.meanScore).toBeCloseTo((0.4 + 0.4 + 0.8 + 0.8) / 4)
    expect(bucket?.p50Score).toBeCloseTo(0.6)
    expect(bucket?.p90Score).toBeCloseTo(0.8)
  })

  it('error cell contributes 0 to passRate AND meanScore', async () => {
    const sc = axis('scenario', [
      ['s1', 1],
      ['s2', 2],
    ])

    const result = await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      runCell: async (cell) => {
        if ((cell.axes.scenario?.value as number) === 2) throw new Error('explode')
        return mk(1, true)
      },
    })

    const bucket2 = result.byAxis.scenario?.s2
    expect(bucket2?.cells).toBe(1)
    expect(bucket2?.meanScore).toBe(0)
    expect(bucket2?.passRate).toBe(0)
    // Sanity: erroring did not corrupt the other bucket.
    expect(result.byAxis.scenario?.s1?.meanScore).toBe(1)
    expect(result.byAxis.scenario?.s1?.passRate).toBe(1)
  })

  it('byAxis omits axes not listed in aggregateBy', async () => {
    const a = axis('a', [['a1', 1]])
    const b = axis('b', [['b1', 1]])

    const result = await runAgentMatrix({
      axes: [a, b] as MatrixAxis<unknown>[],
      aggregateBy: ['a'],
      runCell: async () => mk(0.9, true),
    })

    expect(result.byAxis.a).toBeDefined()
    expect(result.byAxis.b).toBeUndefined()
  })

  it('label override drives the AxisSummary.axisValue label', async () => {
    const profile = axis('profile', [
      ['p1', { backend: 'claude-code' }],
      ['p2', { backend: 'codex' }],
    ])
    profile.label = (value) => (value as { backend: string }).backend

    const result = await runAgentMatrix({
      axes: [profile] as MatrixAxis<unknown>[],
      runCell: async () => mk(0.7, true),
    })

    expect(result.byAxis.profile?.p1?.axisValue).toBe('claude-code')
    expect(result.byAxis.profile?.p2?.axisValue).toBe('codex')
  })

  it('custom value types (e.g. Driver-like objects) aggregate by id, not value', async () => {
    // A "Driver" — opaque substrate object. The matrix never inspects it.
    const driverA = { name: 'refine', selector: () => 0 }
    const driverB = { name: 'fanout-vote', selector: () => 0 }

    const drivers = axis('driver', [
      ['refine', driverA],
      ['fanout', driverB],
    ])

    const result = await runAgentMatrix({
      axes: [drivers] as MatrixAxis<unknown>[],
      runCell: async (cell) => {
        const dv = cell.axes.driver?.value as { name: string }
        expect(typeof dv.name).toBe('string')
        return mk(0.8, true)
      },
    })

    expect(Object.keys(result.byAxis.driver ?? {}).sort()).toEqual(['fanout', 'refine'])
    expect(result.byAxis.driver?.refine?.meanScore).toBe(0.8)
  })
})
