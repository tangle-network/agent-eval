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

export interface MapConcurrentRangeOptions<R> {
  count: number
  maxConcurrency: number
  label: string
  signal?: AbortSignal
  map(index: number, signal: AbortSignal): Promise<R>
}

/** Map an integer range with bounded work, cancellation, and first-error cleanup. */
export async function mapConcurrentRange<R>(options: MapConcurrentRangeOptions<R>): Promise<R[]> {
  if (!Number.isSafeInteger(options.count) || options.count < 0) {
    throw new Error(`${options.label} count must be a non-negative integer`)
  }
  if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
    throw new Error(`${options.label} maxConcurrency must be a positive integer`)
  }

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abortFromCaller()
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true })

  const results = new Array<R>(options.count)
  let nextIndex = 0
  let failed = false
  let firstFailure: unknown
  const workers = Array.from(
    { length: Math.min(options.maxConcurrency, options.count) },
    async () => {
      while (!controller.signal.aborted) {
        const index = nextIndex
        nextIndex += 1
        if (index >= options.count) return
        try {
          results[index] = await options.map(index, controller.signal)
        } catch (error) {
          if (!failed) {
            failed = true
            firstFailure = error
            controller.abort(error)
          }
          return
        }
      }
    },
  )

  try {
    await Promise.all(workers)
    if (options.signal?.aborted) throw abortError(options.signal, options.label)
    if (failed) throw firstFailure
    if (controller.signal.aborted) throw abortError(controller.signal, options.label)
    return results
  } finally {
    options.signal?.removeEventListener('abort', abortFromCaller)
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
  map: (item: T, index: number, signal: AbortSignal) => Promise<R>,
): Promise<R[]> {
  return mapConcurrentRange({
    count: items.length,
    maxConcurrency: concurrency,
    label: 'mapConcurrent',
    map(index, signal) {
      return map(items[index]!, index, signal)
    },
  })
}

function abortError(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`)
}
