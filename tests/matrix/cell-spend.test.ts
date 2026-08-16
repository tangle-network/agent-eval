import { describe, expect, it, vi } from 'vitest'
import type { MatrixAxis } from '../../src/matrix'
import { readCellSpend, runAgentMatrix, withCellSpend } from '../../src/matrix'

function axis<V>(name: string, vals: Array<[string, V]>): MatrixAxis<V> {
  return { name, values: vals.map(([id, value]) => ({ id, value })) }
}

describe('withCellSpend / readCellSpend', () => {
  it('round-trips spend through a thrown Error', () => {
    const err = withCellSpend(new TypeError('boom'), {
      costUsd: 0.42,
      durationMs: 1200,
      kind: 'estimated',
    })
    expect(err).toBeInstanceOf(TypeError)
    expect(readCellSpend(err)).toEqual({ costUsd: 0.42, durationMs: 1200, kind: 'estimated' })
  })

  it('keeps the carrier off enumerable keys so error logging is unchanged', () => {
    const err = withCellSpend(new Error('boom'), { costUsd: 1, durationMs: 2, kind: 'observed' })
    expect(Object.keys(err as object)).toEqual([])
  })

  it('wraps a primitive throw so its spend is never dropped', () => {
    const wrapped = withCellSpend('exploded', { costUsd: 0.5, durationMs: 9, kind: 'estimated' })
    expect(wrapped).toBeInstanceOf(Error)
    expect((wrapped as Error).message).toContain('exploded')
    expect((wrapped as Error).cause).toBe('exploded')
    expect(readCellSpend(wrapped)?.costUsd).toBe(0.5)
  })

  it('the outer frame overwrites an inner carrier', () => {
    const inner = withCellSpend(new Error('boom'), { costUsd: 1, durationMs: 5, kind: 'estimated' })
    const outer = withCellSpend(inner, { costUsd: 3, durationMs: 12, kind: 'uncaptured' })
    expect(outer).toBe(inner)
    expect(readCellSpend(outer)).toEqual({ costUsd: 3, durationMs: 12, kind: 'uncaptured' })
  })

  it('rejects an amount that would disable the cost ceiling', () => {
    expect(() =>
      withCellSpend(new Error('x'), { costUsd: Number.NaN, durationMs: 1, kind: 'observed' }),
    ).toThrow(/costUsd must be a finite number/)
    expect(() =>
      withCellSpend(new Error('x'), { costUsd: -1, durationMs: 1, kind: 'observed' }),
    ).toThrow(/costUsd must be a finite number/)
    expect(() =>
      withCellSpend(new Error('x'), {
        costUsd: 1,
        durationMs: Number.POSITIVE_INFINITY,
        kind: 'observed',
      }),
    ).toThrow(/durationMs must be a finite number/)
  })

  it('reads a malformed carrier as absent', () => {
    const err = new Error('x') as unknown as Record<string, unknown>
    err.__agentEvalCellSpend = { costUsd: 'lots', durationMs: 1, kind: 'observed' }
    expect(readCellSpend(err)).toBeUndefined()
  })
})

describe('runAgentMatrix — a failed cell is billed for what it spent', () => {
  it('counts the spend of a cell that pays and then throws', async () => {
    const sc = axis('scenario', [
      ['s1', 1],
      ['s2', 2],
    ])

    const result = await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      runCell: async (cell) => {
        if ((cell.axes.scenario?.value as number) === 2) {
          throw withCellSpend(new Error('provider 500 after two paid calls'), {
            costUsd: 0.4,
            durationMs: 1500,
            kind: 'estimated',
          })
        }
        return {
          output: { ok: true },
          verdict: { valid: true, score: 1 },
          costUsd: 0.1,
          durationMs: 10,
        }
      },
    })

    const errored = result.cells.find((c) => c.cell.axes.scenario?.id === 's2')?.runs[0]
    expect(errored?.error?.message).toBe('provider 500 after two paid calls')
    expect(errored?.costUsd).toBe(0.4)
    expect(errored?.durationMs).toBe(1500)
    expect(errored?.costProvenance).toEqual({ kind: 'estimated', usd: 0.4 })
    expect(result.summary.totalCostUsd).toBeCloseTo(0.5, 10)
    expect(result.summary.costUncapturedCells).toBe(0)
    expect(result.byAxis.scenario?.s2?.totalCostUsd).toBe(0.4)
  })

  it('halts the run when partial spend from failed cells crosses the ceiling', async () => {
    const sc = axis(
      'scenario',
      Array.from({ length: 6 }, (_, i) => [`s${i}`, i] as [string, number]),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let started = 0

    const result = await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      maxConcurrency: 1,
      costCeiling: 0.5,
      runCell: async () => {
        started++
        throw withCellSpend(new Error('spent then failed'), {
          costUsd: 0.3,
          durationMs: 20,
          kind: 'observed',
        })
      },
    })

    // Two failed cells spend 0.6 > 0.5 — the third must never be scheduled.
    expect(started).toBe(2)
    expect(result.summary.runsExecuted).toBe(2)
    expect(result.summary.cellsSkipped).toBe(4)
    expect(result.summary.totalCostUsd).toBeCloseTo(0.6, 10)
    expect(warn).toHaveBeenCalledWith('[matrix] cost ceiling reached')
    warn.mockRestore()
  })

  it('marks a throw that reports no spend as uncaptured, not as a measured zero', async () => {
    const sc = axis('scenario', [['s1', 1]])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      runCell: async () => {
        throw new Error('no idea what this cost')
      },
    })

    const run = result.cells[0]?.runs[0]
    expect(run?.costUsd).toBe(0)
    expect(run?.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
    expect(result.summary.costUncapturedCells).toBe(1)
    expect(result.byAxis.scenario?.s1?.costUncapturedCells).toBe(1)
    expect(warn).toHaveBeenCalledWith(
      '[matrix] 1 cell reported no spend for a failure — totalCostUsd and the cost ceiling under-count this run',
    )
    warn.mockRestore()
  })

  it('carries an uncaptured subtotal without claiming it is the total', async () => {
    const sc = axis('scenario', [['s1', 1]])
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      costCeiling: 0.2,
      runCell: async () => {
        throw withCellSpend(new Error('judge cost unknown'), {
          costUsd: 0.25,
          durationMs: 30,
          kind: 'uncaptured',
        })
      },
    })

    const run = result.cells[0]?.runs[0]
    expect(run?.costUsd).toBe(0.25)
    expect(run?.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
    // The known subtotal still counts toward the ceiling.
    expect(result.summary.totalCostUsd).toBe(0.25)
    expect(result.summary.costUncapturedCells).toBe(1)
    warn.mockRestore()
  })

  it('fails a cell whose reported cost cannot be billed instead of killing the ceiling', async () => {
    const sc = axis(
      'scenario',
      Array.from({ length: 4 }, (_, i) => [`s${i}`, i] as [string, number]),
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const result = await runAgentMatrix({
      axes: [sc] as MatrixAxis<unknown>[],
      maxConcurrency: 1,
      costCeiling: 0.5,
      runCell: async (cell) => ({
        output: { ok: true },
        verdict: { valid: true, score: 1 },
        costUsd: (cell.axes.scenario?.value as number) === 0 ? Number.NaN : 0.6,
        durationMs: 10,
      }),
    })

    const poisoned = result.cells[0]?.runs[0]
    expect(poisoned?.error?.kind).toBe('RangeError')
    expect(poisoned?.error?.message).toContain('costUsd')
    expect(poisoned?.costProvenance).toEqual({ kind: 'uncaptured', usd: null })
    // A NaN in the cumulative sum would make `>= ceiling` false forever; the
    // ceiling must still stop the run on the next real cell.
    expect(Number.isFinite(result.summary.totalCostUsd)).toBe(true)
    expect(result.summary.runsExecuted).toBe(2)
    expect(result.summary.cellsSkipped).toBe(2)
    warn.mockRestore()
  })
})
