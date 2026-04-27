/**
 * SandboxPool tests — concurrency, capacity, reset/destroy lifecycle,
 * utilization tracking. The pool is generic so we use a string resource
 * for tests; real consumers will wire git worktrees / Tangle sandboxes /
 * etc as the resource type.
 */

import { describe, it, expect, vi } from 'vitest'
import { createSandboxPool, type SlotFactory } from '../src/sandbox-pool'

interface TestResource {
  id: string
  resetCount: number
  destroyed: boolean
}

function counterFactory(): { factory: SlotFactory<TestResource>; resources: TestResource[] } {
  const resources: TestResource[] = []
  return {
    resources,
    factory: {
      async create(slotId) {
        const r: TestResource = { id: slotId, resetCount: 0, destroyed: false }
        resources.push(r)
        return r
      },
      async reset(slot) {
        slot.resource.resetCount++
      },
      async destroy(slot) {
        slot.resource.destroyed = true
      },
    },
  }
}

describe('createSandboxPool', () => {
  it('mints slots lazily up to capacity', async () => {
    const { factory, resources } = counterFactory()
    const pool = createSandboxPool({ size: 3, factory })

    expect(pool.poolSize()).toBe(0)
    expect(resources.length).toBe(0)

    await pool.withSlot(async () => {})
    expect(pool.poolSize()).toBe(1)
    expect(resources.length).toBe(1)

    await pool.withSlot(async () => {})
    // Same slot reused after release.
    expect(pool.poolSize()).toBe(1)
    await pool.drain()
  })

  it('uses up to size concurrent slots, then queues', async () => {
    const { factory } = counterFactory()
    const pool = createSandboxPool({ size: 2, factory })

    let resolveFirst: (() => void) | null = null
    let resolveSecond: (() => void) | null = null
    const firstP = new Promise<void>((r) => (resolveFirst = r))
    const secondP = new Promise<void>((r) => (resolveSecond = r))

    const t1 = pool.withSlot(async (slot) => {
      void slot
      await firstP
      return 1
    })
    const t2 = pool.withSlot(async (slot) => {
      void slot
      await secondP
      return 2
    })

    // Pool should be at capacity (2 slots, both busy).
    await new Promise((r) => setTimeout(r, 5))
    expect(pool.poolSize()).toBe(2)
    expect(pool.activeCheckouts()).toBe(2)

    // Third checkout queues.
    let thirdResolved = false
    const t3 = pool.withSlot(async () => {
      thirdResolved = true
      return 3
    })
    await new Promise((r) => setTimeout(r, 5))
    expect(thirdResolved).toBe(false)

    // Release first → third runs.
    resolveFirst!()
    await t1
    await new Promise((r) => setTimeout(r, 10))
    // Eventually third resolves.
    resolveSecond!()
    const [r1, r2, r3] = await Promise.all([t1, t2, t3])
    expect([r1, r2, r3]).toEqual([1, 2, 3])
    await pool.drain()
  })

  it('calls reset() before reuse, never on first checkout', async () => {
    const { factory, resources } = counterFactory()
    const pool = createSandboxPool({ size: 1, factory })

    await pool.withSlot(async () => {})
    expect(resources[0].resetCount).toBe(1) // reset on release after first use
    await pool.withSlot(async () => {})
    // Second checkout reuses the same slot; reset fires after each release.
    expect(resources[0].resetCount).toBe(2)

    await pool.drain()
  })

  it('drain() destroys every slot', async () => {
    const { factory, resources } = counterFactory()
    const pool = createSandboxPool({ size: 2, factory })

    await Promise.all([
      pool.withSlot(async () => {}),
      pool.withSlot(async () => {}),
    ])
    expect(resources.filter((r) => !r.destroyed).length).toBe(2)

    await pool.drain()
    expect(resources.every((r) => r.destroyed)).toBe(true)
    expect(pool.poolSize()).toBe(0)
  })

  it('releases slots even when the user fn throws', async () => {
    const { factory } = counterFactory()
    const pool = createSandboxPool({ size: 1, factory })

    await expect(
      pool.withSlot(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')

    // Should be back to idle, reusable.
    let ran = false
    await pool.withSlot(async () => {
      ran = true
    })
    expect(ran).toBe(true)
    await pool.drain()
  })

  it('utilization() reports busyMs and checkout count', async () => {
    const { factory } = counterFactory()
    const pool = createSandboxPool({ size: 1, factory })

    await pool.withSlot(async () => {
      await new Promise((r) => setTimeout(r, 30))
    })
    const u = pool.utilization()
    expect(u.checkouts).toBe(1)
    expect(u.busyMs).toBeGreaterThanOrEqual(25)
    expect(u.totalMs).toBeGreaterThan(0)
    await pool.drain()
  })

  it('rejects size < 1 at construction', () => {
    const { factory } = counterFactory()
    expect(() => createSandboxPool({ size: 0, factory })).toThrow()
  })

  it('reset failures are warned + the pool keeps going', async () => {
    const failingFactory: SlotFactory<TestResource> = {
      async create(id) {
        return { id, resetCount: 0, destroyed: false }
      },
      async reset() {
        throw new Error('reset boom')
      },
      async destroy() {},
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const pool = createSandboxPool({ size: 1, factory: failingFactory })

    await pool.withSlot(async () => {})
    // Even though reset fails, the slot returns to idle.
    let ran = false
    await pool.withSlot(async () => {
      ran = true
    })
    expect(ran).toBe(true)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
    await pool.drain()
  })
})
