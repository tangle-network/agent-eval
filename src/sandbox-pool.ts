/**
 * SandboxPool — bounded checkout/release pool for mutation slots.
 *
 * The composite-mutator's `code` channel needs an isolated workspace per
 * mutation attempt: a git worktree, a sandbox container, a tmpdir clone —
 * whatever the consumer's runtime is. Without a pool, every consumer
 * re-implements the same machinery (mint N slots, check one out per
 * mutation, reset before reuse, drain at the end, track utilisation for
 * the cost ledger). This primitive ships that machinery so consumers
 * supply only a `SlotFactory`.
 *
 * Generic over a slot resource `T` so the same pool serves git worktrees
 * (T = path), Tangle sandboxes (T = SandboxBox), or anything else with
 * the create/reset/destroy lifecycle.
 *
 * Concurrency: FIFO via the shared `Mutex` primitive. Each `checkout()`
 * either takes an idle slot or queues until one is released. Lifecycle
 * is single-process — multi-process pools need external coordination
 * (file locks, etc.) and are deliberately out of scope.
 */

import { Mutex } from './concurrency'

export interface PoolSlot<T> {
  /** Stable id assigned at slot creation. Use for telemetry / lineage. */
  readonly id: string
  /** Consumer-defined resource. */
  readonly resource: T
}

export interface SlotFactory<T> {
  /** Build a new slot. Called lazily as the pool grows up to `size`. */
  create(slotId: string): Promise<T>
  /**
   * Reset a slot to a clean state before reuse. Called BEFORE every
   * checkout returns it (including the first — so the factory's
   * `create` can leave the slot dirty and let `reset` normalise).
   * Optional; default is a no-op.
   */
  reset?(slot: PoolSlot<T>): Promise<void>
  /** Tear the slot down. Called by `drain()`. */
  destroy(slot: PoolSlot<T>): Promise<void>
}

export interface SandboxPool<T> {
  /**
   * Take a slot. If all slots are busy, the promise resolves when one
   * is released. Always pair with the returned `release` (or wrap with
   * `withSlot`).
   */
  checkout(): Promise<{ slot: PoolSlot<T>; release: () => void }>
  /**
   * Run `fn` with a checked-out slot, releasing on completion or throw.
   * The convenience wrapper most callers should use.
   */
  withSlot<R>(fn: (slot: PoolSlot<T>) => Promise<R>): Promise<R>
  /** Destroy every slot. Idempotent. */
  drain(): Promise<void>
  /** How many slots have been minted (≤ `size`). */
  poolSize(): number
  /** How many checkouts are currently outstanding. */
  activeCheckouts(): number
  /** Snapshot of busy/total durations for the cost ledger. */
  utilization(): { busyMs: number; totalMs: number; checkouts: number }
}

export interface CreateSandboxPoolOpts<T> {
  /** Maximum concurrent slots. Slots are minted on first need, not eagerly. */
  size: number
  factory: SlotFactory<T>
}

interface SlotState<T> {
  slot: PoolSlot<T>
  busy: boolean
}

export function createSandboxPool<T>(opts: CreateSandboxPoolOpts<T>): SandboxPool<T> {
  if (opts.size < 1) throw new Error(`sandbox pool size must be >= 1 (got ${opts.size})`)

  const slots: SlotState<T>[] = []
  interface Waiter {
    resolve: (s: SlotState<T>) => void
    reject: (err: unknown) => void
  }
  const waiters: Waiter[] = []
  const mutex = new Mutex()
  let nextSlotId = 0
  let totalCheckouts = 0
  let busyMs = 0
  let drained = false
  const startedAt = Date.now()

  /**
   * Acquire — atomic across `mutex`. Either find an idle slot, mint a
   * new one (if under capacity), or queue. The mutex bounds at the
   * search/mint boundary; the actual create() runs OUTSIDE the lock so
   * a slow factory doesn't starve other waiters.
   */
  async function acquireSlot(): Promise<SlotState<T>> {
    let mintId: string | undefined
    const ready = await mutex.runExclusive(async () => {
      const idle = slots.find((s) => !s.busy)
      if (idle) {
        idle.busy = true
        return idle
      }
      if (slots.length < opts.size) {
        // Reserve a slot ID synchronously so concurrent acquireSlot
        // calls don't all decide to mint past the cap.
        mintId = `slot_${nextSlotId++}`
        return null
      }
      return null
    })
    if (ready) return ready
    if (mintId !== undefined) {
      const resource = await opts.factory.create(mintId)
      const state: SlotState<T> = {
        slot: { id: mintId, resource },
        busy: true,
      }
      await mutex.runExclusive(() => {
        slots.push(state)
      })
      return state
    }
    // All slots busy + at cap: queue.
    return new Promise<SlotState<T>>((resolve, reject) => {
      waiters.push({ resolve, reject })
    })
  }

  /**
   * Hand `state` (clean + idle) to the next queued waiter, or leave it
   * idle if none are waiting. Caller must have already marked the slot
   * not-busy. Runs under no lock; waiters are FIFO.
   */
  function handOffCleanSlot(state: SlotState<T>): void {
    const next = waiters.shift()
    if (next) {
      state.busy = true
      next.resolve(state)
    }
  }

  /**
   * Wake a queued waiter when a slot was destroyed (so capacity freed up
   * but no clean slot is on hand). The waiter re-enters acquisition and
   * mints a fresh slot. Any acquisition failure is routed to that waiter
   * — never dropped on the floor.
   */
  function wakeWaiterToMint(): void {
    const next = waiters.shift()
    if (!next) return
    acquireSlot().then(next.resolve, next.reject)
  }

  /**
   * Release a checked-out slot. Reset is async; we kick it off and the
   * slot only becomes available to the next waiter once reset lands
   * CLEAN. If reset fails, the slot is dirty — destroy and remove it
   * rather than recycle a corrupted workspace to the next waiter, then
   * free the capacity so a fresh slot can be minted. The whole flow is
   * awaited inside one IIFE whose rejection is caught, so a failed
   * destroy can't surface as an unhandled rejection.
   */
  function releaseSlot(state: SlotState<T>): void {
    void (async () => {
      try {
        if (opts.factory.reset) {
          await opts.factory.reset(state.slot)
        }
        state.busy = false
        if (!drained) handOffCleanSlot(state)
      } catch (resetErr) {
        // Dirty slot: do NOT recycle it. Remove from the pool and tear it
        // down, then wake a waiter to mint a clean replacement.
        await mutex.runExclusive(() => {
          const i = slots.indexOf(state)
          if (i !== -1) slots.splice(i, 1)
        })
        try {
          await opts.factory.destroy(state.slot)
        } catch (destroyErr) {
          console.warn(
            `[sandbox-pool] destroy of dirty slot ${state.slot.id} failed after reset error:`,
            destroyErr,
          )
        }
        console.warn(
          `[sandbox-pool] reset failed for slot ${state.slot.id} — slot destroyed, not recycled:`,
          resetErr,
        )
        if (!drained) wakeWaiterToMint()
      }
    })().catch((err) => {
      // Defense in depth: nothing above should throw out here, but if it
      // does, surface it instead of producing an unhandled rejection.
      console.warn(`[sandbox-pool] release of slot ${state.slot.id} faulted:`, err)
    })
  }

  async function checkout(): Promise<{ slot: PoolSlot<T>; release: () => void }> {
    const state = await acquireSlot()
    const checkoutStart = Date.now()
    totalCheckouts++
    return {
      slot: state.slot,
      release: () => {
        busyMs += Date.now() - checkoutStart
        releaseSlot(state)
      },
    }
  }

  async function withSlot<R>(fn: (slot: PoolSlot<T>) => Promise<R>): Promise<R> {
    const { slot, release } = await checkout()
    try {
      return await fn(slot)
    } finally {
      release()
    }
  }

  async function drain(): Promise<void> {
    drained = true
    // Snapshot under lock; destroy outside lock so a slow teardown
    // doesn't block a concurrent drain caller.
    const { snapshot, pending } = await mutex.runExclusive(() => {
      const taken = slots.splice(0, slots.length)
      const queued = waiters.splice(0, waiters.length)
      return { snapshot: taken, pending: queued }
    })
    // Reject any pending waiters — the pool is going away, so their
    // checkout promise can never be satisfied. Failing loud beats leaving
    // a caller hung on an awaited checkout() forever.
    for (const w of pending) {
      w.reject(new Error('sandbox pool drained while a checkout was pending'))
    }
    await Promise.allSettled(snapshot.map((s) => opts.factory.destroy(s.slot)))
  }

  function utilization() {
    return {
      busyMs,
      totalMs: Date.now() - startedAt,
      checkouts: totalCheckouts,
    }
  }

  return {
    checkout,
    withSlot,
    drain,
    poolSize: () => slots.length,
    activeCheckouts: () => slots.filter((s) => s.busy).length,
    utilization,
  }
}
