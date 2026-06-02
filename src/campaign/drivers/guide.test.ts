import { describe, expect, it } from 'vitest'

import * as campaign from '../index'
import { DRIVER_GUIDE, type DriverName, selectDriver } from './guide'

const ALL: DriverName[] = [
  'gepa',
  'skillOpt',
  'ace',
  'memoryCuration',
  'halo',
  'traceAnalyst',
  'evolutionary',
]

describe('DRIVER_GUIDE', () => {
  it('covers every driver with a well-formed entry', () => {
    expect(Object.keys(DRIVER_GUIDE).sort()).toEqual([...ALL].sort())
    for (const name of ALL) {
      const e = DRIVER_GUIDE[name]
      expect(e.summary.length).toBeGreaterThan(20)
      expect(e.whenUse.length).toBeGreaterThan(20)
      expect(['low', 'medium', 'high']).toContain(e.cost)
    }
  })

  it('every guided driver is actually exported from the campaign barrel (drift guard)', () => {
    // If you add a driver to DRIVER_GUIDE, `${name}Driver` must exist — and a
    // new driver without a guide entry is caught by the coverage test above.
    for (const name of ALL) {
      expect(typeof (campaign as Record<string, unknown>)[`${name}Driver`]).toBe('function')
    }
  })
})

describe('selectDriver', () => {
  it('returns the goal-appropriate primary driver first', () => {
    expect(selectDriver({ goal: 'explore' })[0]!.name).toBe('gepa')
    expect(selectDriver({ goal: 'refine' })[0]!.name).toBe('skillOpt')
    expect(selectDriver({ goal: 'accumulate' })[0]!.name).toBe('ace')
    expect(selectDriver({ goal: 'benchmark' })[0]!.name).toBe('traceAnalyst')
  })

  it('every recommendation carries a reason', () => {
    for (const rec of selectDriver({ goal: 'explore' })) {
      expect(rec.reason).toContain(rec.entry.strategy)
    }
  })

  it('a surface filter narrows the picks', () => {
    const refinePrompt = selectDriver({ goal: 'refine', surface: 'prompt' })
    // refine ranks skillOpt (skill-doc) first, then gepa (prompt) — the filter
    // drops skillOpt, leaving gepa.
    expect(refinePrompt.map((r) => r.name)).toEqual(['gepa'])
  })

  it('never returns an empty pick — falls back to surface matches', () => {
    // 'accumulate' ranks ace+memoryCuration (playbook/memory); a skill-doc
    // filter matches neither, so it falls back to drivers on that surface.
    const recs = selectDriver({ goal: 'accumulate', surface: 'skill-doc' })
    expect(recs.length).toBeGreaterThan(0)
    expect(recs.every((r) => r.entry.surface === 'skill-doc' || r.entry.surface === 'any')).toBe(
      true,
    )
  })
})
