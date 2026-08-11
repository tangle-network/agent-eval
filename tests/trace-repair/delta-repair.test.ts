import { describe, expect, it } from 'vitest'
import { deltaRepair, renderDeltaRepairReport } from '../../src/trace-repair/delta-repair'
import { declinedRowResult, measuredRowResult, rejectedRowResult } from './fixtures'

describe('Delta-repair is paired per row over every admitted row', () => {
  it('reports the mean of the per-row differences', () => {
    const report = deltaRepair([
      measuredRowResult('a', 1),
      measuredRowResult('b', 2 / 3),
      measuredRowResult('c', 0),
    ])
    expect(report.rows).toBe(3)
    expect(report.deltaRepair.mean).toBeCloseTo((1 + 2 / 3 + 0) / 3, 10)
    expect(report.interventionRate).toBeCloseTo((1 + 2 / 3 + 0) / 3, 10)
    expect(report.controlRate).toBe(0)
  })

  it('keeps rejected and declined rows in the denominator with a difference of zero', () => {
    const report = deltaRepair([
      measuredRowResult('a', 1),
      declinedRowResult('b'),
      rejectedRowResult('c'),
      measuredRowResult('d', 0),
    ])
    expect(report.rows).toBe(4)
    expect(report.deltaRepair.n).toBe(4)
    expect(report.deltaRepair.mean).toBeCloseTo(0.25, 10)
    expect(report.funnel.declined).toBe(1)
    expect(report.funnel.rejected).toBe(1)
    expect(report.funnel.t0Parsed).toBe(3)
    expect(report.measuredRows).toBe(2)
    expect(report.measuredOnly.mean).toBeCloseTo(0.5, 10)
  })

  it('counts the funnel cells the report prints', () => {
    const report = deltaRepair([
      measuredRowResult('a', 1),
      measuredRowResult('b', 1 / 3),
      declinedRowResult('c'),
    ])
    expect(report.funnel).toMatchObject({
      rows: 3,
      t1Reproduced: 2,
      t2Executed: 2,
      t3LocalFlip: 1,
      t4RepairFlipAny: 2,
      t4RepairFlipAll: 1,
    })
  })
})

describe('the interval reports what it can and cannot support', () => {
  it('is not gate-eligible below the minimum pair count', () => {
    const report = deltaRepair([measuredRowResult('a', 1), measuredRowResult('b', 0)])
    expect(report.deltaRepair.gateEligible).toBe(false)
    expect(report.threats.map((t) => t.id)).toContain('bootstrap-below-min-n')
  })

  it('is gate-eligible once enough rows are paired', () => {
    const rows = Array.from({ length: 24 }, (_, index) =>
      measuredRowResult(`row-${index}`, index % 3 === 0 ? 1 : 0),
    )
    const report = deltaRepair(rows, { seed: 7 })
    expect(report.deltaRepair.gateEligible).toBe(true)
    expect(report.threats.map((t) => t.id)).not.toContain('bootstrap-below-min-n')
    expect(report.deltaRepair.low).toBeLessThanOrEqual(report.deltaRepair.mean)
    expect(report.deltaRepair.high).toBeGreaterThanOrEqual(report.deltaRepair.mean)
  })

  it('is deterministic for a given seed', () => {
    const rows = Array.from({ length: 22 }, (_, index) =>
      measuredRowResult(`row-${index}`, index % 2 === 0 ? 1 : 1 / 3),
    )
    const first = deltaRepair(rows, { seed: 11 })
    const second = deltaRepair(rows, { seed: 11 })
    expect(first.deltaRepair).toEqual(second.deltaRepair)
  })

  it('names a zero-width interval as an absence of variation, not certainty', () => {
    const rows = Array.from({ length: 21 }, (_, index) => measuredRowResult(`row-${index}`, 1))
    const report = deltaRepair(rows, { seed: 3 })
    expect(report.deltaRepair.low).toBe(report.deltaRepair.high)
    expect(report.threats.map((t) => t.id)).toContain('zero-variance-interval')
  })
})

describe('threats travel with the number', () => {
  it('always names the position asymmetry between the arms', () => {
    const report = deltaRepair([measuredRowResult('a', 1)])
    const asymmetry = report.threats.find((t) => t.id === 'control-position-asymmetry')
    expect(asymmetry?.direction).toBe('understates')
  })

  it('names that admission conditioned the control to zero everywhere', () => {
    const report = deltaRepair([measuredRowResult('a', 1), measuredRowResult('b', 0)])
    expect(report.threats.map((t) => t.id)).toContain('admission-conditions-on-control-failure')
  })

  it('says when the control that produced that zero could not have rescued anything', () => {
    const inert = (rowId: string, rate: number) => ({
      ...measuredRowResult(rowId, rate),
      controlScreening: 'declared-inert' as const,
    })
    const report = deltaRepair([inert('a', 1), inert('b', 0)])
    const ids = report.threats.map((t) => t.id)
    expect(ids).toContain('control-cannot-rescue')
    // The stronger claim is not made alongside the weaker one: a control that
    // makes no model call did not screen the rows it left at zero.
    expect(ids).not.toContain('admission-conditions-on-control-failure')
    expect(report.threats.find((t) => t.id === 'control-cannot-rescue')?.statement).toMatch(
      /2\/2 rows/,
    )
  })

  it('names a denominator carried by rows where nothing ran', () => {
    const report = deltaRepair([
      measuredRowResult('a', 1),
      declinedRowResult('b'),
      declinedRowResult('c'),
    ])
    expect(report.threats.map((t) => t.id)).toContain('declines-carry-the-denominator')
  })

  it('names rollouts whose intervention failed after it had already run', () => {
    const row = measuredRowResult('a', 1 / 3)
    if (row.grade.outcome !== 'measured') throw new Error('unreachable')
    const withFailures = {
      ...row,
      grade: {
        ...row.grade,
        repair: { ...row.grade.repair, interventionFailures: 2 },
      },
    }
    const report = deltaRepair([withFailures])
    expect(report.threats.map((t) => t.id)).toContain('intervention-failures-present')
  })
})

describe('input integrity', () => {
  it('refuses an empty set of rows', () => {
    expect(() => deltaRepair([])).toThrow(/at least one graded row/)
  })

  it('refuses the same row twice', () => {
    expect(() => deltaRepair([measuredRowResult('a', 1), measuredRowResult('a', 0)])).toThrow(
      /twice/,
    )
  })
})

describe('the report shows every dimension it measured', () => {
  it('prints the funnel, one row per admitted row, and the threats', () => {
    const report = deltaRepair([
      measuredRowResult('a', 1),
      measuredRowResult('b', 1 / 3),
      declinedRowResult('c'),
      rejectedRowResult('d'),
    ])
    const markdown = renderDeltaRepairReport(report)
    for (const heading of ['# Delta-repair', '## Funnel', '## Rows', '## Threats']) {
      expect(markdown).toContain(heading)
    }
    for (const column of [
      'reproduction basis',
      'intervention exit',
      'local flip',
      'repair passes',
      'intervention failures',
      'prefix divergences',
      'P(int)',
      'P(ctl)',
      'delta',
      'wall ms',
    ]) {
      expect(markdown).toContain(column)
    }
    for (const rowId of ['a', 'b', 'c', 'd']) {
      expect(markdown).toMatch(new RegExp(`\\| ${rowId} \\|`))
    }
    expect(markdown).toContain('t1 reproduced (gate, pays nothing)')
    expect(markdown).toContain('rejected: k-out-of-range')
  })
})
