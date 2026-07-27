export interface MapConcurrentOptions<T> {
  count: number
  maxConcurrency: number
  label: string
  signal?: AbortSignal
  map(index: number, signal: AbortSignal): Promise<T>
}

export interface MapPairedConcurrentOptions<T> {
  count: number
  maxConcurrency: number
  label: string
  signal?: AbortSignal
  map(index: number, arm: 'baseline' | 'candidate', signal: AbortSignal): Promise<T>
}

/** Map a fixed signed cell set with bounded concurrency and fail-loud cancellation. */
export async function mapConcurrent<T>(options: MapConcurrentOptions<T>): Promise<T[]> {
  if (!Number.isSafeInteger(options.count) || options.count < 0) {
    throw new Error(`${options.label} cell count must be a non-negative integer`)
  }
  if (!Number.isSafeInteger(options.maxConcurrency) || options.maxConcurrency < 1) {
    throw new Error(`${options.label} maxConcurrency must be a positive integer`)
  }

  const controller = new AbortController()
  const abortFromCaller = () => controller.abort(options.signal?.reason)
  if (options.signal?.aborted) abortFromCaller()
  else options.signal?.addEventListener('abort', abortFromCaller, { once: true })

  const results = new Array<T>(options.count)
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

/** Map both arms while bounding the actual executions, not the number of pairs. */
export async function mapPairedConcurrent<T>(
  options: MapPairedConcurrentOptions<T>,
): Promise<Array<{ baseline: T; candidate: T }>> {
  if (!Number.isSafeInteger(options.count) || options.count < 0) {
    throw new Error(`${options.label} pair count must be a non-negative integer`)
  }
  if (options.count > Math.floor(Number.MAX_SAFE_INTEGER / 2)) {
    throw new Error(`${options.label} pair count is too large to schedule both arms`)
  }
  const executions = await mapConcurrent({
    count: options.count * 2,
    maxConcurrency: options.maxConcurrency,
    label: options.label,
    ...(options.signal ? { signal: options.signal } : {}),
    map(flatIndex, signal) {
      const index = Math.floor(flatIndex / 2)
      const arm = flatIndex % 2 === 0 ? 'baseline' : 'candidate'
      return options.map(index, arm, signal)
    },
  })

  return Array.from({ length: options.count }, (_, index) => ({
    baseline: executions[index * 2]!,
    candidate: executions[index * 2 + 1]!,
  }))
}

function abortError(signal: AbortSignal, label: string): Error {
  return signal.reason instanceof Error ? signal.reason : new Error(`${label} aborted`)
}
