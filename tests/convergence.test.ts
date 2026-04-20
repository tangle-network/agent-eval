import { describe, it, expect } from 'vitest'
import { ConvergenceTracker } from '../src/convergence'
import type { DriverState } from '../src/types'

const emptyState: DriverState = {
  tasks: 0,
  events: 0,
  proposals: { pending: 0, approved: 0, rejected: 0 },
  vaultFiles: [],
  codeBlocks: 0,
  generations: 0,
}

describe('ConvergenceTracker', () => {
  it('tracks completion percentage over turns', () => {
    const tracker = new ConvergenceTracker([
      { name: 'tasks', check: (s) => s.tasks >= 3 },
      { name: 'events', check: (s) => s.events >= 1 },
    ])

    const r1 = tracker.record(1, { ...emptyState, tasks: 1 })
    expect(r1.completionPercent).toBe(0)
    expect(r1.complete).toBe(false)

    const r2 = tracker.record(2, { ...emptyState, tasks: 3 })
    expect(r2.completionPercent).toBe(50)

    const r3 = tracker.record(3, { ...emptyState, tasks: 3, events: 1 })
    expect(r3.completionPercent).toBe(100)
    expect(r3.complete).toBe(true)
  })

  it('produces convergence curve', () => {
    const tracker = new ConvergenceTracker([
      { name: 'tasks', check: (s) => s.tasks >= 2 },
    ])

    tracker.record(1, { ...emptyState, tasks: 0 })
    tracker.record(2, { ...emptyState, tasks: 1 })
    tracker.record(3, { ...emptyState, tasks: 2 })

    expect(tracker.getCurve()).toEqual([0, 0, 100])
  })

  it('finds turn to completion', () => {
    const tracker = new ConvergenceTracker([
      { name: 'done', check: (s) => s.tasks >= 1 },
    ])

    tracker.record(1, emptyState)
    tracker.record(2, emptyState)
    tracker.record(3, { ...emptyState, tasks: 1 })

    expect(tracker.getTurnToCompletion()).toBe(3)
  })

  it('returns null when never completed', () => {
    const tracker = new ConvergenceTracker([
      { name: 'impossible', check: () => false },
    ])

    tracker.record(1, emptyState)
    expect(tracker.getTurnToCompletion()).toBeNull()
  })

  it('handles empty criteria as 100% complete', () => {
    const tracker = new ConvergenceTracker([])
    const r = tracker.record(1, emptyState)
    expect(r.completionPercent).toBe(100)
    expect(r.complete).toBe(true)
  })

  it('uses partial credit via progress function', () => {
    const tracker = new ConvergenceTracker([
      {
        name: 'tasks',
        check: (s) => s.tasks >= 5,
        progress: (s) => s.tasks / 5,
      },
      {
        name: 'events',
        check: (s) => s.events >= 2,
      },
    ])

    // 2/5 tasks = 0.4 credit, 0 events = 0 credit → 20%
    const r1 = tracker.record(1, { ...emptyState, tasks: 2 })
    expect(r1.completionPercent).toBeCloseTo(20)
    expect(r1.complete).toBe(false)
    expect(r1.criteriaStatus.tasks).toBeCloseTo(0.4)
    expect(r1.criteriaStatus.events).toBe(false)

    // 5/5 tasks = 1.0 credit, 2 events = 1 credit → 100%
    const r2 = tracker.record(2, { ...emptyState, tasks: 5, events: 2 })
    expect(r2.completionPercent).toBe(100)
    expect(r2.complete).toBe(true)
  })

  it('clamps progress to [0, 1]', () => {
    const tracker = new ConvergenceTracker([
      {
        name: 'over',
        check: () => true,
        progress: () => 1.5,
      },
    ])

    const r = tracker.record(1, emptyState)
    expect(r.completionPercent).toBe(100)
  })
})
