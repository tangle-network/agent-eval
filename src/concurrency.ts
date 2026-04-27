/**
 * concurrency — small primitives the evolution loop needs.
 *
 * `Mutex` is a zero-dep async lock with FIFO fairness. The evolution loop
 * uses it to serialise checkout/build/commit sequences inside a single
 * pool slot, and to gate concurrent JSONL writers (see
 * `lockedJsonlReferenceReplayStore`).
 *
 * Deliberately minimal — no priority queue, no timeouts. If you need
 * those, swap to `async-mutex` at the call site.
 */

export class Mutex {
  private locked = false
  private readonly waiters: Array<() => void> = []

  async acquire(): Promise<() => void> {
    if (!this.locked) {
      this.locked = true
      return () => this.release()
    }
    return new Promise<() => void>((resolve) => {
      this.waiters.push(() => {
        resolve(() => this.release())
      })
    })
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next()
    } else {
      this.locked = false
    }
  }

  async runExclusive<T>(fn: () => Promise<T> | T): Promise<T> {
    const release = await this.acquire()
    try {
      return await fn()
    } finally {
      release()
    }
  }

  /** True iff someone holds the lock right now. Diagnostics only. */
  get isLocked(): boolean {
    return this.locked
  }

  /** Pending waiter count. Diagnostics only. */
  get pending(): number {
    return this.waiters.length
  }
}
