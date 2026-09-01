import { describe, expect, it } from 'vitest'
import { buildCellSchedule, cellCachePath, cellDirectory } from './cell-schedule'
import type { Scenario } from './types'

const scenarios: Scenario[] = [
  { id: 'alpha', kind: 'test' },
  { id: 'beta', kind: 'test' },
]

describe('buildCellSchedule', () => {
  it('reads the cell grid with no run directory and no filesystem', () => {
    const schedule = buildCellSchedule(scenarios, 100, 2)

    expect(schedule.map((slot) => slot.cellId)).toEqual(['alpha:0', 'alpha:1', 'beta:0', 'beta:1'])
    expect(schedule.map((slot) => slot.cellSeed)).toEqual([100, 101, 102, 103])
    expect(schedule).toHaveLength(scenarios.length * 2)
  })

  it('gives every replicate of one seed group the same seed sequence', () => {
    const grouped: Scenario[] = [
      { id: 'control', kind: 'test', seedGroup: 'pair-1' },
      { id: 'candidate', kind: 'test', seedGroup: 'pair-1' },
      { id: 'unrelated', kind: 'test' },
    ]
    const schedule = buildCellSchedule(grouped, 10, 3)
    const seedsOf = (id: string) =>
      schedule.filter((slot) => slot.scenario.id === id).map((slot) => slot.cellSeed)

    // A paired comparison must see the same draw on both arms, so the two
    // members of a seed group share their per-replicate seeds.
    expect(seedsOf('control')).toEqual([10, 11, 12])
    expect(seedsOf('candidate')).toEqual([10, 11, 12])
    // A scenario outside the group takes the next group index.
    expect(seedsOf('unrelated')).toEqual([13, 14, 15])
  })

  it('is a pure function of the design', () => {
    expect(buildCellSchedule(scenarios, 7, 2)).toEqual(buildCellSchedule(scenarios, 7, 2))
    expect(buildCellSchedule(scenarios, 7, 2)).not.toEqual(buildCellSchedule(scenarios, 8, 2))
  })

  it('plans an empty grid when the design asks for no replicates', () => {
    expect(buildCellSchedule(scenarios, 1, 0)).toEqual([])
  })

  it('names a cell directory only when a caller supplies a run directory', () => {
    const [slot] = buildCellSchedule([{ id: 'a/b:c', kind: 'test' }], 1, 1)

    expect(slot?.cellId).toBe('a/b:c:0')
    expect(cellDirectory('/runs/r1', slot?.cellId ?? '')).toBe('/runs/r1/a_b_c_0')
    expect(cellCachePath('/runs/r1', slot?.cellId ?? '')).toBe(
      '/runs/r1/a_b_c_0/cached-result.json',
    )
  })
})
