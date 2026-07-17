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

/**
 * Map independent work with a fixed worker count while preserving input order.
 * After the first rejection, no new items start; already-running work is allowed
 * to settle before the returned promise rejects. Partial results are discarded.
 */
export async function mapConcurrent<T, R>(
  items: readonly T[],
  concurrency: number,
  map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error(`mapConcurrent: concurrency must be a positive integer, got ${concurrency}`)
  }
  if (items.length === 0) return []

  const results = new Array<R>(items.length)
  let nextIndex = 0
  let stopped = false
  let failed = false
  let failure: unknown

  const worker = async (): Promise<void> => {
    while (!stopped) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return

      try {
        results[index] = await map(items[index]!, index)
      } catch (error) {
        stopped = true
        if (!failed) {
          failed = true
          failure = error
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, () => worker()))
  if (failed) throw failure
  return results
}
