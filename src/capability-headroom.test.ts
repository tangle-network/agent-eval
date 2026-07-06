import { describe, expect, it } from 'vitest'
import {
  assertCapabilityHeadroom,
  capabilityHeadroom,
  type HeadroomInput,
} from './capability-headroom'

/**
 * The calibrate-before-measure gate: a task only counts toward a capability
 * A/B when the capability-absent baseline fails it. These pin the fail-closed
 * contract — unknown outcomes never manufacture headroom — and the go/no-go
 * assert that blocks a comparison the benchmark cannot see.
 */
describe('capabilityHeadroom — per-task classification', () => {
  const row = (taskId: string, baselineOutcome: HeadroomInput['baselineOutcome']) => ({
    taskId,
    baselineOutcome,
  })

  it('classifies gap / saturated / unknown from baseline outcomes', () => {
    const r = capabilityHeadroom([
      row('gap-task', 'fail'),
      row('gap-task', 'fail'),
      row('saturated-task', 'pass'),
      row('unknown-task', 'unknown'),
    ])
    expect(r.tasks).toEqual([
      { taskId: 'gap-task', n: 2, nKnown: 2, baselinePassRate: 0, headroom: 'gap' },
      { taskId: 'saturated-task', n: 1, nKnown: 1, baselinePassRate: 1, headroom: 'saturated' },
      {
        taskId: 'unknown-task',
        n: 1,
        nKnown: 0,
        baselinePassRate: Number.NaN,
        headroom: 'unknown',
      },
    ])
    expect(r.summary).toEqual({
      tasksWithGap: 1,
      tasksSaturated: 1,
      tasksUnknown: 1,
      repsUnknown: 1,
    })
  })

  it('fail-closed: unknown outcomes never count as failures (no manufactured gap)', () => {
    // 1 pass + 3 unknown: rate over KNOWN outcomes is 1 ⇒ saturated, not gap.
    const r = capabilityHeadroom([
      row('t', 'pass'),
      row('t', 'unknown'),
      row('t', 'unknown'),
      row('t', 'unknown'),
    ])
    expect(r.tasks[0]!.baselinePassRate).toBe(1)
    expect(r.tasks[0]!.headroom).toBe('saturated')
    expect(r.tasks[0]!.nKnown).toBe(1)
    expect(r.summary.repsUnknown).toBe(3)
  })

  it('fail-closed: an all-unknown task is unknown with NaN pass rate, never gap', () => {
    const r = capabilityHeadroom([row('t', 'unknown'), row('t', 'unknown')])
    expect(r.tasks[0]!.headroom).toBe('unknown')
    expect(r.tasks[0]!.nKnown).toBe(0)
    expect(Number.isNaN(r.tasks[0]!.baselinePassRate)).toBe(true)
    expect(r.summary.tasksWithGap).toBe(0)
    expect(r.summary.repsUnknown).toBe(2)
  })

  it('a single known failure among unknowns is enough for gap', () => {
    const r = capabilityHeadroom([row('t', 'fail'), row('t', 'unknown')])
    expect(r.tasks[0]!.headroom).toBe('gap')
    expect(r.tasks[0]!.n).toBe(2)
    expect(r.tasks[0]!.nKnown).toBe(1)
    expect(r.tasks[0]!.baselinePassRate).toBe(0)
  })

  it('surfaces thin evidence: 9 unknown reps + 1 known fail is a gap on nKnown = 1', () => {
    const rows: HeadroomInput[] = [
      row('t', 'fail'),
      ...Array.from({ length: 9 }, () => row('t', 'unknown')),
    ]
    const r = capabilityHeadroom(rows)
    expect(r.tasks[0]!).toEqual({
      taskId: 't',
      n: 10,
      nKnown: 1,
      baselinePassRate: 0,
      headroom: 'gap',
    })
    expect(r.summary.repsUnknown).toBe(9)
  })

  it('keepThreshold boundary: rate ≤ threshold is gap, above is saturated', () => {
    const rows = [row('t', 'pass'), row('t', 'fail')] // rate 0.5
    expect(capabilityHeadroom(rows, { keepThreshold: 0.5 }).tasks[0]!.headroom).toBe('gap')
    expect(capabilityHeadroom(rows, { keepThreshold: 0.49 }).tasks[0]!.headroom).toBe('saturated')
    // Default threshold 0: any pass saturates.
    expect(capabilityHeadroom(rows).tasks[0]!.headroom).toBe('saturated')
  })

  it('throws on empty input (a headroom verdict needs a baseline run)', () => {
    expect(() => capabilityHeadroom([])).toThrow(/no baseline rows/)
  })

  it('throws on an out-of-range keepThreshold', () => {
    expect(() => capabilityHeadroom([row('t', 'fail')], { keepThreshold: 1 })).toThrow(
      /keepThreshold must be in \[0, 1\)/,
    )
    expect(() => capabilityHeadroom([row('t', 'fail')], { keepThreshold: -0.1 })).toThrow(
      /keepThreshold/,
    )
  })

  it('throws on an unrecognized outcome value (rows are often projected from untyped records)', () => {
    const bad = [{ taskId: 't', baselineOutcome: 'passed' }] as unknown as HeadroomInput[]
    expect(() => capabilityHeadroom(bad)).toThrow(/unrecognized baselineOutcome 'passed'/)
  })
})

describe('assertCapabilityHeadroom — go/no-go guard', () => {
  it('passes when enough tasks have headroom', () => {
    const r = capabilityHeadroom([
      { taskId: 't1', baselineOutcome: 'fail' },
      { taskId: 't2', baselineOutcome: 'fail' },
      { taskId: 't3', baselineOutcome: 'pass' },
    ])
    expect(() => assertCapabilityHeadroom(r)).not.toThrow()
    expect(() => assertCapabilityHeadroom(r, { minTasksWithGap: 2 })).not.toThrow()
  })

  it('throws an actionable message when the benchmark cannot see the capability', () => {
    const r = capabilityHeadroom([
      { taskId: 't1', baselineOutcome: 'pass' },
      { taskId: 't2', baselineOutcome: 'unknown' },
    ])
    expect(() => assertCapabilityHeadroom(r)).toThrow(
      /only 0 of 2 task\(s\) have baseline headroom.*1 saturated.*1 unknown.*add tasks the baseline fails/s,
    )
  })

  it('throws when tasksWithGap is below a higher minTasksWithGap', () => {
    const r = capabilityHeadroom([
      { taskId: 't1', baselineOutcome: 'fail' },
      { taskId: 't2', baselineOutcome: 'pass' },
    ])
    expect(() => assertCapabilityHeadroom(r, { minTasksWithGap: 2 })).toThrow(/need ≥ 2/)
  })

  it('throws on a non-positive or non-integer minTasksWithGap', () => {
    const r = capabilityHeadroom([{ taskId: 't1', baselineOutcome: 'fail' }])
    expect(() => assertCapabilityHeadroom(r, { minTasksWithGap: 0 })).toThrow(/integer ≥ 1/)
    expect(() => assertCapabilityHeadroom(r, { minTasksWithGap: 1.5 })).toThrow(/integer ≥ 1/)
  })
})
