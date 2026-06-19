import { describe, expect, it, vi } from 'vitest'
import { createSandboxPool, type SlotFactory } from './sandbox-pool'

// A tick helper: let queued microtasks (the async release IIFE) drain.
const flush = () => new Promise((r) => setTimeout(r, 0))

describe('createSandboxPool reset-failure handling', () => {
  it('destroys and replaces a slot whose reset failed — never recycles it dirty', async () => {
    const created: string[] = []
    const destroyed: string[] = []
    let resetCalls = 0

    const factory: SlotFactory<string> = {
      async create(slotId) {
        created.push(slotId)
        return `res-${slotId}`
      },
      async reset() {
        resetCalls++
        // Fail the reset on the FIRST release. A dirty slot must not be
        // handed to the next waiter; it must be destroyed and replaced.
        if (resetCalls === 1) throw new Error('reset blew up')
      },
      async destroy(slot) {
        destroyed.push(slot.id)
      },
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const pool = createSandboxPool({ size: 1, factory })

      const a = await pool.checkout()
      const firstId = a.slot.id
      a.release()
      await flush()

      // The dirty slot must have been destroyed, not recycled.
      expect(destroyed).toContain(firstId)

      // The next checkout must hand back a FRESH slot (new id), proving the
      // pool did not recycle the dirty one.
      const b = await pool.checkout()
      expect(b.slot.id).not.toBe(firstId)
      expect(created.length).toBe(2)
      b.release()
      await flush()
    } finally {
      warn.mockRestore()
    }
  })

  it('a waiter queued behind a failing-reset slot is satisfied by a fresh slot', async () => {
    let resetCalls = 0
    const factory: SlotFactory<number> = {
      async create() {
        return resetCalls
      },
      async reset() {
        resetCalls++
        if (resetCalls === 1) throw new Error('reset failed')
      },
      async destroy() {},
    }

    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const pool = createSandboxPool({ size: 1, factory })

      const a = await pool.checkout()
      // Queue a second checkout while the only slot is busy.
      const waiterP = pool.checkout()
      // Release the first; its reset fails → slot destroyed → waiter must
      // be served by a freshly minted slot rather than hang forever.
      a.release()

      const b = await waiterP
      expect(b.slot.id).toBeDefined()
      b.release()
      await flush()
    } finally {
      warn.mockRestore()
    }
  })

  it('a successful reset recycles the same slot (no needless churn)', async () => {
    const destroyed: string[] = []
    const factory: SlotFactory<string> = {
      async create(slotId) {
        return slotId
      },
      async reset() {},
      async destroy(slot) {
        destroyed.push(slot.id)
      },
    }
    const pool = createSandboxPool({ size: 1, factory })

    const a = await pool.checkout()
    const id = a.slot.id
    a.release()
    await flush()

    const b = await pool.checkout()
    expect(b.slot.id).toBe(id)
    expect(destroyed).not.toContain(id)
    b.release()
    await flush()
  })

  it('drain rejects a pending waiter instead of hanging forever', async () => {
    const factory: SlotFactory<string> = {
      async create(slotId) {
        return slotId
      },
      async reset() {},
      async destroy() {},
    }
    const pool = createSandboxPool({ size: 1, factory })

    const a = await pool.checkout()
    const waiterP = pool.checkout()
    // Drain while a is still held and a waiter is queued.
    await pool.drain()
    await expect(waiterP).rejects.toThrow(/drained/)
    a.release()
    await flush()
  })

  it('does not raise an unhandled rejection when destroy also fails', async () => {
    let resetCalls = 0
    const factory: SlotFactory<string> = {
      async create(slotId) {
        return slotId
      },
      async reset() {
        resetCalls++
        if (resetCalls === 1) throw new Error('reset failed')
      },
      async destroy() {
        throw new Error('destroy failed too')
      },
    }
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const unhandled: unknown[] = []
    const onUnhandled = (e: unknown) => unhandled.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      const pool = createSandboxPool({ size: 1, factory })
      const a = await pool.checkout()
      a.release()
      await flush()
      await flush()
      expect(unhandled).toHaveLength(0)
    } finally {
      process.off('unhandledRejection', onUnhandled)
      warn.mockRestore()
    }
  })
})
