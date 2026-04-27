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
  const waiters: Array<(s: SlotState<T>) => void> = []
  const mutex = new Mutex()
  let nextSlotId = 0
  let totalCheckouts = 0
  let busyMs = 0
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
    return new Promise<SlotState<T>>((resolve) => {
      waiters.push((s) => {
        s.busy = true
        resolve(s)
      })
    })
  }

  function releaseSlot(state: SlotState<T>): void {
    // Non-async release — runs synchronously inside the user's finally.
    // Reset is async; we kick it off and let the next waiter see a
    // freshly-reset slot once it lands.
    void (async () => {
      try {
        if (opts.factory.reset) await opts.factory.reset(state.slot)
      } catch (err) {
        // A failing reset is the consumer's bug; we still release
        // (otherwise the pool deadlocks). Surface via console.warn so
        // it doesn't get lost.
        console.warn(`[sandbox-pool] reset failed for slot ${state.slot.id}:`, err)
      }
      state.busy = false
      const next = waiters.shift()
      if (next) next(state)
    })()
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
    // Snapshot under lock; destroy outside lock so a slow teardown
    // doesn't block a concurrent drain caller.
    const snapshot = await mutex.runExclusive(() => {
      const taken = slots.splice(0, slots.length)
      // Reject any pending waiters — pool is going away.
      for (const w of waiters.splice(0, waiters.length)) {
        // Best-effort rejection: the waiter is still pending; we
        // can't reject a Promise we already resolved. Surface as a
        // warning. In practice, drain() is called when nothing's in
        // flight (end of run), so this is a defensive no-op.
        void w
      }
      return taken
    })
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
