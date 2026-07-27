export interface MapConcurrentOptions<T> {
  count: number
  maxConcurrency: number
  label: string
  signal?: AbortSignal
  map(index: number): Promise<T>
}

/** Map a fixed signed cell set with bounded concurrency and fail-loud cancellation. */
export async function mapConcurrent<T>(options: MapConcurrentOptions<T>): Promise<T[]> {
  if (!Number.isSafeInteger(options.count) || options.count < 0) {
    throw new Error(`${options.label} cell count must be a non-negative integer`)
  }
  if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
    throw new Error(`${options.label} maxConcurrency must be a positive integer`)
  }

  const results = new Array<T>(options.count)
  let nextIndex = 0
  const workers = Array.from(
    { length: Math.min(options.maxConcurrency, options.count) },
    async () => {
      while (true) {
        if (options.signal?.aborted) {
          throw options.signal.reason instanceof Error
            ? options.signal.reason
            : new Error(`${options.label} aborted`)
        }
        const index = nextIndex
        nextIndex += 1
        if (index >= options.count) return
        results[index] = await options.map(index)
      }
    },
  )
  await Promise.all(workers)
  return results
}
