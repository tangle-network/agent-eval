import { describe, expect, it, vi } from 'vitest'
import type { CellResult, MatrixAxis, MatrixCell } from '../../src/matrix'
import { runAgentMatrix } from '../../src/matrix'

function axis<V>(name: string, vals: Array<[string, V]>): MatrixAxis<V> {
  return { name, values: vals.map(([id, value]) => ({ id, value })) }
}

function ok(score: number, costUsd = 0.01, durationMs = 10): CellResult<{ ok: true }> {
  return {
    output: { ok: true },
    verdict: { valid: score >= 0.5, score },
    costUsd,
    durationMs,
  }
}

describe('runAgentMatrix — cartesian + scheduling', () => {
  it('expands 3 axes × 2 reps into the correct cartesian size', async () => {
    const a = axis('scenario', [
      ['s1', 'a'],
      ['s2', 'b'],
      ['s3', 'c'],
    ])
    const b = axis('profile', [
      ['p1', { id: 1 }],
      ['p2', { id: 2 }],
    ])
    const c = axis('thinking', [
      ['low', 'low'],
      ['med', 'medium'],
      ['high', 'high'],
      ['ultra', 'ultra'],
    ])

    const result = await runAgentMatrix({
      axes: [a, b, c] as MatrixAxis<unknown>[],
      reps: 2,
      runCell: async () => ok(0.7),
    })

    expect(result.summary.totalCells).toBe(3 * 2 * 4 * 2)
    expect(result.summary.runsExecuted).toBe(3 * 2 * 4 * 2)
    expect(result.summary.cellsSkipped).toBe(0)
    expect(result.cells).toHaveLength(3 * 2 * 4 * 2)
  })

  it('filter prunes cells BEFORE rep expansion', async () => {
    const scenario = axis('scenario', [
      ['easy', { hard: 1 }],
      ['hard', { hard: 5 }],
    ])
    const thinking = axis('thinking', [
      ['low', 'low'],
      ['high', 'high'],
    ])

    const result = await runAgentMatrix({
      axes: [scenario, thinking] as MatrixAxis<unknown>[],
      reps: 3,
      // Reject (hard scenario × low thinking) — 1 of 4 combinations is pruned.
      filter: (cell) => {
        const sc = cell.axes['scenario']?.value as { hard: number }
        const th = cell.axes['thinking']?.value as string
        return !(sc.hard === 5 && th === 'low')
      },
      runCell: async () => ok(0.6),
    })

    // 3 surviving combinations × 3 reps = 9.
    expect(result.summary.totalCells).toBe(9)
    expect(result.summary.runsExecuted).toBe(9)
    // 1 pruned combination × 3 reps = 3 filtered cells reported as skipped.
    expect(result.summary.cellsSkipped).toBe(3)
  })

  it('empty axis (values=[]) produces a zero-cell matrix without error', async () => {
    const result = await runAgentMatrix({
      axes: [axis('scenario', []), axis('profile', [['p1', { id: 1 }]])] as MatrixAxis<unknown>[],
      runCell: async () => ok(1),
    })
    expect(result.summary.totalCells).toBe(0)
    expect(result.summary.runsExecuted).toBe(0)
    expect(result.cells).toEqual([])
  })

  it('cost ceiling stops new schedules but lets in-flight finish', async () => {
    const sc = axis('scenario', [
      ['s1', 1],
      ['s2', 2],
      ['s3', 3],
      ['s4', 4],
      ['s5', 5],
      ['s6', 6],
    ])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      maxConcurrency: 2,
      costCeiling: 0.03,
      runCell: async () => {
        await new Promise((r) => setTimeout(r, 5))
        return ok(0.6, 0.02)
      },
    })

    expect(result.summary.totalCells).toBe(6)
    // Two in-flight when ceiling hits → at most ~2 more land after warning.
    expect(result.summary.runsExecuted).toBeGreaterThanOrEqual(2)
    expect(result.summary.runsExecuted).toBeLessThan(6)
    expect(result.summary.cellsSkipped).toBe(6 - result.summary.runsExecuted)
    expect(warn).toHaveBeenCalledWith('[matrix] cost ceiling reached')
    warn.mockRestore()
  })

  it('abort signal: in-flight cells abort, new ones suppressed', async () => {
    const ctrl = new AbortController()
    const sc = axis(
      'scenario',
      Array.from({ length: 10 }, (_, i) => [`s${i}`, i] as [string, number]),
    )

    let started = 0
    const promise = runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      maxConcurrency: 2,
      signal: ctrl.signal,
      runCell: async () => {
        started++
        await new Promise((r) => setTimeout(r, 20))
        return ok(0.7)
      },
    })

    // Let two start, then abort.
    await new Promise((r) => setTimeout(r, 5))
    ctrl.abort()

    const result = await promise
    expect(started).toBeLessThanOrEqual(2)
    expect(result.summary.cellsSkipped).toBeGreaterThan(0)
    expect(result.summary.runsExecuted + result.summary.cellsSkipped).toBe(10)
  })

  it('throw inside runCell becomes a CellResult.error — run continues', async () => {
    const sc = axis('scenario', [
      ['s1', 1],
      ['s2', 2],
      ['s3', 3],
    ])

    const result = await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      runCell: async (cell) => {
        if ((cell.axes['scenario']?.value as number) === 2) {
          throw new TypeError('boom')
        }
        return ok(0.9)
      },
    })

    expect(result.summary.runsExecuted).toBe(3)
    const errored = result.cells.find((c) => c.cell.axes['scenario']?.id === 's2')
    expect(errored?.runs[0]?.error?.kind).toBe('TypeError')
    expect(errored?.runs[0]?.error?.message).toBe('boom')
    expect(errored?.runs[0]?.verdict.score).toBe(0)
    expect(errored?.runs[0]?.verdict.valid).toBe(false)
    // Other cells unaffected.
    const ok1 = result.cells.find((c) => c.cell.axes['scenario']?.id === 's1')
    expect(ok1?.runs[0]?.verdict.score).toBe(0.9)
  })

  it('concurrency cap: at most N in-flight at any moment', async () => {
    let inFlight = 0
    let peak = 0
    const sc = axis(
      'scenario',
      Array.from({ length: 8 }, (_, i) => [`s${i}`, i] as [string, number]),
    )

    await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      maxConcurrency: 2,
      runCell: async () => {
        inFlight++
        if (inFlight > peak) peak = inFlight
        await new Promise((r) => setTimeout(r, 5))
        inFlight--
        return ok(0.6)
      },
    })

    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(0)
  })

  it('deterministic ordinal ordering across concurrent execution', async () => {
    const a = axis('a', [
      ['a1', 1],
      ['a2', 2],
    ])
    const b = axis('b', [
      ['b1', 1],
      ['b2', 2],
      ['b3', 3],
    ])
    // Variable delay so cells complete out of order.
    const result = await runAgentMatrix({
      axes: [a, b] as MatrixAxis<unknown>[],
      reps: 2,
      maxConcurrency: 4,
      runCell: async () => {
        await new Promise((r) => setTimeout(r, Math.random() * 10))
        return ok(0.7)
      },
    })

    const ordinals = result.cells.map((c) => c.cell.ordinal)
    const expected = Array.from({ length: 2 * 3 * 2 }, (_, i) => i)
    expect(ordinals).toEqual(expected)
  })

  it('onCellComplete fires for every executed cell exactly once', async () => {
    const sc = axis('scenario', [
      ['s1', 1],
      ['s2', 2],
      ['s3', 3],
    ])
    const seen = new Map<number, number>()

    await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      reps: 2,
      onCellComplete: (cell) => {
        seen.set(cell.ordinal, (seen.get(cell.ordinal) ?? 0) + 1)
      },
      runCell: async () => ok(0.5),
    })

    expect(seen.size).toBe(6)
    for (const count of seen.values()) expect(count).toBe(1)
  })

  it('aggregateBy filters which axes appear in byAxis', async () => {
    const scenario = axis('scenario', [
      ['s1', 1],
      ['s2', 2],
    ])
    const profile = axis('profile', [
      ['p1', { x: 1 }],
      ['p2', { x: 2 }],
    ])

    const result = await runAgentMatrix({
      axes: [scenario, profile] as MatrixAxis<unknown>[],
      aggregateBy: ['profile'],
      runCell: async () => ok(0.8),
    })

    expect(Object.keys(result.byAxis)).toEqual(['profile'])
    expect(result.byAxis['profile']).toBeDefined()
    expect(result.byAxis['scenario']).toBeUndefined()
  })

  it('aggregateBy default: every axis in axes is aggregated', async () => {
    const scenario = axis('scenario', [['s1', 1]])
    const profile = axis('profile', [['p1', { x: 1 }]])
    const thinking = axis('thinking', [['low', 'low']])

    const result = await runAgentMatrix({
      axes: [scenario, profile, thinking] as MatrixAxis<unknown>[],
      runCell: async () => ok(0.8),
    })

    expect(Object.keys(result.byAxis).sort()).toEqual(['profile', 'scenario', 'thinking'])
  })

  it('matrixId is a stable id-like string', async () => {
    const sc = axis('scenario', [['s1', 1]])
    const result = await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      runCell: async () => ok(1),
    })
    expect(result.matrixId).toMatch(/^mtx_[a-z0-9]+_[0-9a-f]{8}$/)
  })
})

describe('runAgentMatrix — MatrixCell shape', () => {
  it('cell.axes carries the picked value AND id from each axis', async () => {
    const scenario = axis('scenario', [['s1', { hard: 3 }]])
    const profile = axis('profile', [['p1', { kind: 'claude-code' }]])

    let captured: MatrixCell | undefined
    const result = await runAgentMatrix({
      axes: [scenario, profile] as MatrixAxis<unknown>[],
      runCell: async (cell) => {
        captured = cell
        return ok(0.5)
      },
    })

    expect(captured?.axes['scenario']?.id).toBe('s1')
    expect(captured?.axes['scenario']?.value).toEqual({ hard: 3 })
    expect(captured?.axes['profile']?.id).toBe('p1')
    expect(captured?.axes['profile']?.value).toEqual({ kind: 'claude-code' })

    // Verify byAxis keying matches the value id.
    expect(result.byAxis['scenario']?.['s1']).toBeDefined()
    expect(result.byAxis['profile']?.['p1']).toBeDefined()
  })
})
